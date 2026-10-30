// A training-market worker (docs/future/useful-work-training.md): takes a seat and trains its shard, re-runs
// the segments it is drawn to spot-check, evaluates candidates on the revealed held-out rows, and seals every
// answer (commit, then reveal). Chain access goes through `market` ({ send(fn, args, value), call(fn, args) }:
// the in-memory chain's contract handle in the simulation and the tests, an ethers Contract adapter on a
// node), and published trees through `store` (a Map: content-addressed by treesHash, standing in for IPFS /
// an HTTP blob store).
//
// Behaviours, for the simulation:
//   honest  — does the work;
//   cheater — trains its first `honestSegments` segments, then makes up the rest (trees and digests that look
//             fine but were never trained) to save compute; verifies others honestly;
//   copier  — does no work at all: copies another worker's sealed commitment and tries to reveal its answer
//             once it is public (training, spot-checks and evaluation alike).
import { randomBytes } from 'node:crypto';
import { k, T, shardOf, heldoutRows } from './core.js';

const salt = () => '0x' + randomBytes(32).toString('hex');
const ZERO = '0x' + '00'.repeat(32);
const lower = (x) => String(x).toLowerCase();

export class TrainWorker {
  constructor({ name, address, market, store, behaviour = 'honest', honestSegments = 2, log = () => {} }) {
    Object.assign(this, { name, address: lower(address), market, store, behaviour, honestSegments, log });
    this.tasks = new Map(); // id -> local state
    this.work = { trainedSegments: 0, verifiedSegments: 0, evaluations: 0 };
  }

  st(id) {
    if (!this.tasks.has(id)) this.tasks.set(id, { answers: new Map() });
    return this.tasks.get(id);
  }

  // ---------------------------------------------------------------- training
  async takeSeat(id) {
    await this.market.send('takeSeat', [id]);
    this.st(id).job = Number(await this.market.call('seatOf', [id, this.address])) - 1;
    return this.st(id).job;
  }

  /** Trains (or fakes, or skips) the seat's shard and commits. `others`: the workers already committed (copier). */
  async trainAndCommit(id, spec, base, others = []) {
    const s = this.st(id);
    if (this.behaviour === 'copier') {
      const victim = others.find((w) => w.st(id).commitment);
      s.copiedFrom = victim;
      s.commitment = victim.st(id).commitment; // the sealed bytes are public; what they hide is not
      await this.market.send('commitTraining', [id, s.commitment]);
      this.log(`${this.name}: copied ${victim.name}'s sealed commitment (no training)`);
      return;
    }
    const sh = shardOf(spec, base.model, s.job);
    const o = { ...T.TRAIN_DEFAULTS, ...spec.train };
    const C = o.trees / o.every;
    let trees, digests;
    if (this.behaviour === 'cheater') {
      ({ trees, digests } = T.trainSegments(k, { S: sh.S, spec, shard: s.job, toSeg: this.honestSegments }));
      // the rest is made up: the last honest tree, its leaves nudged, with a transcript of zeros
      for (let seg = this.honestSegments; seg < C; seg++) {
        const segTrees = [];
        for (let t = 0; t < o.every; t++) segTrees.push(trees[trees.length - 1].map((v, i) => (i % 5 === 4 ? T.snap(v * 0.9) : v)));
        trees.push(...segTrees);
        digests.push(T.segmentDigest(k, seg, segTrees, new Array(o.every * 4).fill(0)));
      }
      this.work.trainedSegments += this.honestSegments;
      this.log(`${this.name}: trained ${this.honestSegments}/${C} segments, faked ${C - this.honestSegments}`);
    } else {
      ({ trees, digests } = T.trainSegments(k, { S: sh.S, spec, shard: s.job, toSeg: C }));
      this.work.trainedSegments += C;
    }
    Object.assign(s, { trees, digests, root: T.rootOf(k, digests), treesHash: T.treesHash(k, trees), salt: salt() });
    s.commitment = T.trainCommitment(k, s.root, s.treesHash, this.address, s.salt, id);
    this.store.set(s.treesHash, trees); // published: verifiers re-run segments from it
    await this.market.send('commitTraining', [id, s.commitment]);
  }

  async revealTraining(id) {
    const s = this.st(id);
    if (this.behaviour === 'copier') {
      // the victim's reveal is public now (its transaction): replay it as our own
      const v = s.copiedFrom.st(id);
      try {
        await this.market.send('revealTraining', [id, v.root, v.treesHash, `blob:${v.treesHash}`, v.salt]);
      } catch (e) { s.revealError = e.message; this.log(`${this.name}: copied reveal refused (${e.message})`); }
      return;
    }
    await this.market.send('revealTraining', [id, s.root, s.treesHash, `blob:${s.treesHash}`, s.salt]);
  }

  /** After the verifiers sealed: the trainer opens its per-segment digests. */
  async openCheckpoints(id) {
    const s = this.st(id);
    if (s.digests && !s.opened) { await this.market.send('openCheckpoints', [id, s.digests]); s.opened = true; }
  }

  // ---------------------------------------------------------------- spot-checks and evaluation
  /** The checks (indexes) this worker is drawn for: [{ check, job, segment, eval }]. */
  async assignments(id) {
    const checks = await this.market.call('checksOf', [id]);
    const out = [];
    for (let c = 0; c < checks.length; c++) {
      const vs = (await this.market.call('verifiersOf', [id, c])).map(lower);
      if (vs.includes(this.address)) out.push({ check: c, job: Number(checks[c].job), segment: Number(checks[c].segment), eval: Number(checks[c].job) === 255 });
    }
    return out;
  }

  async #seal(id, check, answer, peers) {
    const s = this.st(id);
    if (this.behaviour === 'copier') {
      const peer = peers.find((p) => p !== this && p.st(id).answers.has(check));
      if (!peer) return;
      const commitment = await this.market.call('commits', [id, check, peer.address]);
      s.answers.set(check, { copiedFrom: peer });
      await this.market.send('commitAnswer', [id, check, commitment]);
      return;
    }
    const sl = salt();
    s.answers.set(check, { answer, salt: sl });
    await this.market.send('commitAnswer', [id, check, T.verifyCommitment(k, answer, this.address, sl, id, check)]);
  }

  /** Re-runs every segment this worker is drawn to check and seals its own digest. */
  async verify(id, spec, base, peers = []) {
    for (const a of await this.assignments(id)) {
      if (a.eval) continue;
      let answer = null;
      if (this.behaviour !== 'copier') {
        const job = await this.market.call('getJob', [id, a.job]);
        const published = this.store.get(lower(job.treesHash)) ?? null;
        const sh = shardOf(spec, base.model, a.job);
        answer = T.verifySegment(k, { S: sh.S, spec, shard: a.job, published, committedTreesHash: job.treesHash, segment: a.segment });
        this.work.verifiedSegments++;
      }
      await this.#seal(id, a.check, answer, peers);
    }
  }

  /** On the evaluation check: the candidate from the passed jobs, measured on the revealed held-out rows. */
  async evaluate(id, spec, base, peers = []) {
    const a = (await this.assignments(id)).find((x) => x.eval);
    if (!a) return null;
    let answer = null;
    if (this.behaviour !== 'copier') {
      const task = await this.market.call('getTask', [id]);
      const jobs = [];
      for (let j = 0; j < Number(task.jobCount); j++) {
        let job;
        try { job = await this.market.call('getJob', [id, j]); } catch { break; }
        if (Number(job.status) === 1) jobs.push({ treesHash: lower(job.treesHash), trees: this.store.get(lower(job.treesHash)) });
      }
      const cand = T.candidateOf(k, base.model, base.hash, jobs);
      if (cand.id !== lower(task.candidate)) throw new Error(`${this.name}: candidate ${cand.id} is not the market's ${task.candidate}`);
      const m = T.evaluate(base.model, cand.model, heldoutRows(spec, task.heldoutSeed));
      this.st(id).metrics = m;
      answer = T.evalAnswer(k, m);
      this.work.evaluations++;
    }
    await this.#seal(id, a.check, answer, peers);
    return this.st(id).metrics ?? null;
  }

  /** Reveals every sealed answer of this task (a copier replays its victim's reveal, which fails). */
  async revealAnswers(id) {
    for (const [check, a] of this.st(id).answers) {
      if (a.revealed || a.error) continue;
      const src = a.copiedFrom ? a.copiedFrom.st(id).answers.get(check) : a;
      try {
        await this.market.send('revealAnswer', [id, check, src.answer, src.salt]);
        a.revealed = true;
      } catch (e) { a.error = e.message; if (a.copiedFrom) this.log(`${this.name}: copied answer on check ${check} refused (${e.message})`); else throw e; }
    }
  }
}

export { ZERO };
