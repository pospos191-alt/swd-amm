// "Do useful work" on the Mine page (mine.js loads this file when the mode is chosen; it imports Neuro
// from ./neuro/src/, which exists in dist/ only). Two jobs a browser can do, both in Web Workers:
//   - scan jobs (UsefulWork): a PoW stamp buys seats; Neuro's code-only rules scan of each job's
//     contract; the answers go on-chain sealed (commitMany), are revealed when the seats are full
//     (revealMany) and paid when 2 of 3 agree (settle, withdraw);
//   - bug hunting (BugBounty): a coverage-guided fuzz of a bounty's test contract in an in-page EVM
//     (vendor/evm.js, fuzz-core.js) against the spec's invariants; a finding is committed sealed,
//     revealed one block later, and paid after runners replay it. Each finding can be saved as a
//     reproducer (JSON: the steps, the seed, a per-step trace; `zetaphy work verify-finding` replays it).
// The addresses come from hub-config.json (build.mjs: the launch state + zetaphy-network/deployments/
// useful-work-77390.json written by `zetaphy deploy-useful-work`). Not there yet: both run as practice
// (nothing sent, nothing paid). Deployed but paused (the deploy default, until a timelock vote opens
// them): practice too, with a notice saying so.
// Nothing runs until a button is pressed; leaving or redrawing the page stops everything (stopWork).
import { withFallback } from './i18n.js';
import { WORK } from './work-i18n.js';
import { keccak256 } from './neuro/src/keccak.js';
import {
  calldata, decodeArgs, named, JOB_TUPLE, JOB_FIELDS, PARAM_FIELDS, PARAM_TYPES, BOUNTY_TUPLE, BOUNTY_FIELDS,
  jobCommitment, findingCommitment, randomSalt, parseBytes32String, keccakHex, toHex,
} from './work-core.js';
import { findingBytes, specHash } from './fuzz-core.js';
import { powPrefix, nonceHex } from './mine-core.js';

const STORE = 'zetaphy:work:v1';
const FINDING_TOPIC = keccakHex(keccak256, new TextEncoder().encode('FindingCommitted(uint256,uint256,address)'));
let live = null; // { workers: Set<Worker>, stopped }

export function stopWork() {
  if (!live) return;
  live.stopped = true;
  for (const w of live.workers) w.terminate();
  live = null;
}
const session = () => (live ??= { workers: new Set(), stopped: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fill = (s, o) => s.replace(/\{(\w)\}/g, (_, k) => String(o[k] ?? ''));

function load() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch { return {}; } }
function save(st) { try { localStorage.setItem(STORE, JSON.stringify(st)); } catch { /* private mode: salts live in memory only */ } }

function worker(onmessage) {
  const s = session();
  const w = new Worker(new URL('./work-worker.js', import.meta.url), { type: 'module' });
  s.workers.add(w);
  w.onmessage = ({ data }) => onmessage(data);
  return w;
}
/** One scan in the worker: resolves { verdict, level, findings } or rejects. */
function scanIn(job) {
  return new Promise((resolve, reject) => {
    const w = worker((d) => { w.terminate(); live?.workers.delete(w); d.error ? reject(new Error(d.error)) : resolve(d); });
    w.postMessage({ scan: job });
  });
}

export function renderWork(host, ctx) {
  stopWork();
  const L = withFallback(WORK, ctx.lang);
  const el = ctx.el;
  const C = ctx.cfg?.contracts ?? {};
  const uw = C.usefulWork, bb0 = C.bugBounty, rep = C.workerReputation;
  let bb = bb0;
  let practice = !uw;
  const $ = (id) => document.getElementById(id);
  const say = (id, text, cls = '') => { const n = $(id); if (n) { n.textContent = text; n.className = `msg ${cls}`; } };
  const call = async (to, sig, args, types) => decodeArgs(types, await ctx.evmCall('eth_call', [{ to, data: calldata(keccak256, sig, args) }, 'latest']));
  const send = (to, sig, args, action, value = 0n) => ctx.send(to, calldata(keccak256, sig, args), action, value);
  const zt = (x) => `${ctx.formatZeta(BigInt(x), 4)} ZTPHY`;
  const row = (label, id, tip) => el('tr', {}, el('th', { scope: 'row', text: label, 'data-tip': tip ?? null }), el('td', {}, el('span', { id, class: 'mono', text: '–' })));

  host.replaceChildren(
    el('div', { class: 'mn-grid wk-grid' },
      el('div', { class: 'card wk-card', id: 'wk-scan' },
        el('h2', { text: L.title }),
        el('p', { class: 'small', text: L.intro }),
        el('p', { class: 'small warnline', text: L.notMoney }),
        practice ? el('p', { class: 'small notice', id: 'wk-practice', text: L.notDeployed }) : el('p', { class: 'small notice', id: 'wk-paused', hidden: true, text: L.paused }),
        el('h3', { text: L.scanH }),
        el('ol', { class: 'howto small' }, L.scanHow.map((t) => el('li', {}, el('p', { text: t })))),
        practice ? null : el('table', { class: 'mn-table' }, el('tbody', {},
          row(L.openJobs, 'wk-open'), row(L.credits, 'wk-credits'), row(L.owed, 'wk-owed'), row(L.score, 'wk-score', L.tipScore))),
        el('div', { class: 'row wrap' },
          el('button', { type: 'button', class: 'btn', id: 'wk-scan-go', text: practice ? L.practiceScan : L.startScan, onclick: () => (practice ? practiceScan() : scanRun()) }),
          practice ? null : el('button', { type: 'button', class: 'btn ghost', id: 'wk-withdraw', text: L.withdraw, onclick: () => withdraw() })),
        el('p', { class: 'msg', id: 'wk-scan-msg', role: 'status', 'aria-live': 'polite' }),
        el('div', { id: 'wk-scan-out' })),
      el('div', { class: 'card wk-card', id: 'wk-hunt' },
        el('h2', { text: L.huntH }),
        el('p', { class: 'small', text: L.huntIntro }),
        el('p', { class: 'small dim', text: L.vulnNote }),
        el('table', { class: 'mn-table' }, el('tbody', {}, row(L.bounty, 'wk-bounty'), row(L.reward, 'wk-reward'), row(L.runs, 'wk-runs'), row(L.coverage, 'wk-cov', L.tipCoverage))),
        el('div', { class: 'row wrap' },
          el('button', { type: 'button', class: 'btn', id: 'wk-hunt-go', text: L.startHunt, onclick: () => huntToggle() }),
          el('button', { type: 'button', class: 'btn ghost', id: 'wk-submit', hidden: true, text: L.submit, onclick: () => submitFinding() }),
          el('button', { type: 'button', class: 'btn ghost', id: 'wk-repro', hidden: true, text: L.saveRepro, onclick: () => saveRepro() })),
        el('p', { class: 'msg', id: 'wk-hunt-msg', role: 'status', 'aria-live': 'polite' }),
        el('ul', { class: 'small wk-kinds', id: 'wk-kinds', hidden: true }),
        el('pre', { class: 'mono small wk-finding', id: 'wk-finding', hidden: true }))));

  const showVerdicts = (rows) => $('wk-scan-out')?.replaceChildren(el('table', { class: 'mn-table wk-results' }, el('tbody', {},
    ...rows.flatMap((r) => [
      el('tr', {}, el('th', { scope: 'row', text: L.verdict }), el('td', {}, el('span', { class: 'mono wk-verdict', 'data-tip': r.verdict, text: ctx.short(r.verdict, 10, 8) }))),
      el('tr', {}, el('th', { scope: 'row', text: L.level }), el('td', { class: 'wk-level', text: String(r.level ?? '–') })),
      el('tr', {}, el('th', { scope: 'row', text: L.findings }), el('td', { class: 'small mono', text: (r.findings ?? []).join(', ') })),
    ]))));

  // ---------------------------------------------------------------- scan jobs
  async function practiceScan() {
    $('wk-scan-go').disabled = true;
    try {
      const job = await (await fetch('bounties/sample-scan.json')).json();
      say('wk-scan-msg', fill(L.scanning, { n: 1 }));
      const r = await scanIn({ chain: job.chain, target: job.target, code: job.code, codeHash: job.codeHash });
      showVerdicts([r]);
      say('wk-scan-msg', fill(L.doneScan, { n: 1 }), 'ok');
    } catch (e) { say('wk-scan-msg', `${L.failed}: ${e.message}`, 'bad'); }
    if ($('wk-scan-go')) $('wk-scan-go').disabled = false;
  }

  async function refresh(me) {
    try {
      const [open] = await call(uw, 'openJobs(uint256,uint256)', [0n, 50n], ['uint256[]']);
      if ($('wk-open')) $('wk-open').textContent = String(open.length);
      if (!me) return;
      const [seats] = await call(uw, 'credits(address)', [me], ['uint32', 'uint64']);
      const [owed] = await call(uw, 'owed(address)', [me], ['uint256']);
      if ($('wk-credits')) $('wk-credits').textContent = String(seats);
      if ($('wk-owed')) $('wk-owed').textContent = zt(owed);
      if (rep && $('wk-score')) $('wk-score').textContent = `${(await call(rep, 'scoreOf(address)', [me], ['uint256']))[0]} / 1000`;
    } catch { /* the numbers stay as they were */ }
  }

  /** A PoW stamp in 2 workers (mine-worker.js, the faucet's search), then the stamp transaction. */
  async function stamp(me, P) {
    say('wk-scan-msg', L.stamping);
    const bn = Number(BigInt(await ctx.evmCall('eth_blockNumber', [])));
    const h = BigInt(bn - 1);
    const [seed] = await call(uw, 'stampSeed(uint256)', [h], ['bytes32']);
    const chainId = BigInt(await ctx.evmCall('eth_chainId', []));
    const prefix = powPrefix(chainId, seed, me);
    const s = session();
    const nonce = await new Promise((resolve, reject) => {
      const ws = [0, 1].map(() => new Worker(new URL('./mine-worker.js', import.meta.url), { type: 'module' }));
      const his = crypto.getRandomValues(new Uint32Array(ws.length));
      const end = () => ws.forEach((w) => { w.terminate(); s.workers.delete(w); });
      ws.forEach((w, i) => {
        s.workers.add(w);
        w.onmessage = ({ data }) => { if (data.found) { end(); resolve(BigInt(nonceHex(data.found.hi, data.found.lo))); } };
        w.onerror = () => { end(); reject(new Error('worker')); };
        w.postMessage({ job: { gen: 1, prefix, bits: Number(P.stampBits), hi: his[i] } });
      });
    });
    say('wk-scan-msg', L.stampSend);
    await send(uw, 'stamp(uint256,uint64)', [h, nonce], 'UsefulWork.stamp');
  }

  async function scanRun() {
    const btn = $('wk-scan-go');
    btn.disabled = true;
    const s = session();
    try {
      const me = ctx.account?.() || await ctx.connect();
      const P = named(PARAM_FIELDS, await call(uw, 'params()', [], PARAM_TYPES));
      let [seats, until] = await call(uw, 'credits(address)', [me], ['uint32', 'uint64']);
      if (seats === 0n || Number(until) * 1000 < Date.now()) { await stamp(me, P); [seats] = await call(uw, 'credits(address)', [me], ['uint32', 'uint64']); }
      const [open] = await call(uw, 'openJobs(uint256,uint256)', [0n, 50n], ['uint256[]']);
      const take = [];
      for (const id of open) {
        if (take.length >= Math.min(3, Number(seats))) break;
        const [c] = await call(uw, 'commitments(uint256,address)', [id, me], ['bytes32']);
        if (/^0x0+$/.test(c)) take.push(id);
      }
      const st = load();
      st.jobs ??= {};
      if (take.length) {
        say('wk-scan-msg', fill(L.scanning, { n: take.length }));
        const ids = [], cs = [], shown = [];
        let deposit = 0n;
        for (const id of take) {
          const job = named(JOB_FIELDS, (await call(uw, 'getJob(uint256)', [id], [JOB_TUPLE]))[0]);
          const chain = parseBytes32String(job.chain);
          const code = chain === 'zetaphy' ? await ctx.evmCall('eth_getCode', [job.target, 'latest']) : undefined;
          try {
            const r = await scanIn({ chain, target: job.target, code, codeHash: job.codeHash });
            const salt = randomSalt();
            st.jobs[`${uw}:${id}`] = { id: String(id), verdict: r.verdict, salt, me };
            ids.push(id); cs.push(jobCommitment(keccak256, r.verdict, me, salt, id)); deposit += job.deposit; shown.push(r);
          } catch { /* code changed or unreadable: skip this job */ }
          if (s.stopped) return;
        }
        if (ids.length) {
          save(st); // the salts first: without them the deposit is lost
          showVerdicts(shown);
          say('wk-scan-msg', fill(L.committing, { d: ctx.formatZeta(deposit, 4) }));
          await send(uw, 'commitMany(uint256[],bytes32[])', [ids, cs], `UsefulWork.commitMany (${ids.length})`, deposit);
        }
      } else if (!Object.keys(st.jobs).some((k) => k.startsWith(`${uw}:`))) {
        say('wk-scan-msg', L.noJobs);
        return;
      }
      // reveal and settle what this browser has sealed, until every job is settled
      let answered = 0;
      for (;;) {
        if (s.stopped) return;
        const mine = Object.entries(load().jobs ?? {}).filter(([k, v]) => k.startsWith(`${uw}:`) && v.me === me);
        if (!mine.length) break;
        const reveal = [];
        for (const [key, v] of mine) {
          const id = BigInt(v.id);
          const [ph] = await call(uw, 'phase(uint256)', [id], ['uint8']);
          if (ph === 3n) { const st2 = load(); delete st2.jobs[key]; save(st2); answered++; continue; }
          const [mv] = await call(uw, 'verdicts(uint256,address)', [id, me], ['bytes32']);
          if (ph === 1n && /^0x0+$/.test(mv)) reveal.push(v);
          if (ph === 2n) { say('wk-scan-msg', L.settling); await send(uw, 'settle(uint256)', [id], `UsefulWork.settle #${id}`); }
        }
        if (reveal.length) {
          say('wk-scan-msg', L.revealing);
          await send(uw, 'revealMany(uint256[],bytes32[],bytes32[])', [reveal.map((v) => BigInt(v.id)), reveal.map((v) => v.verdict), reveal.map((v) => v.salt)], `UsefulWork.revealMany (${reveal.length})`);
        } else {
          say('wk-scan-msg', fill(L.waitingReveal, { m: Math.ceil((Number(P.commitWindow) + Number(P.revealWindow)) / 60) }));
          await sleep(5000);
        }
        await refresh(me);
      }
      say('wk-scan-msg', fill(L.doneScan, { n: answered }), 'ok');
      await refresh(me);
    } catch (e) {
      say('wk-scan-msg', `${L.failed}: ${e.message}`, 'bad');
    } finally {
      if ($('wk-scan-go')) $('wk-scan-go').disabled = false;
    }
  }

  async function withdraw() {
    try {
      const me = ctx.account?.() || await ctx.connect();
      await send(uw, 'withdraw()', [], 'UsefulWork.withdraw');
      await refresh(me);
    } catch (e) { say('wk-scan-msg', `${L.failed}: ${e.message}`, 'bad'); }
  }

  // ---------------------------------------------------------------- bug hunting
  let hunt = null; // { spec, bountyId, worker, finding }
  async function pickBounty() {
    if (!bb) {
      const text = await (await fetch('bounties/vulnerable-vault.json')).text();
      return { spec: JSON.parse(text), specText: text, bountyId: null, reward: null };
    }
    const [n] = await call(bb, 'bountyCount()', [], ['uint256']);
    const now = Date.now() / 1000;
    for (let i = n - 1n; i >= 0n && i >= n - 10n; i--) {
      const b = named(BOUNTY_FIELDS, (await call(bb, 'getBounty(uint256)', [i], [BOUNTY_TUPLE]))[0]);
      if (b.paid || b.refunded || Number(b.deadline) < now || !/^bounties\/[\w.-]+\.json$/.test(b.specURI)) continue;
      const text = await (await fetch(b.specURI)).text();
      if (specHash(keccak256, text).toLowerCase() !== b.specHash.toLowerCase()) throw new Error(L.specBad);
      return { spec: JSON.parse(text), specText: text, bountyId: i, reward: b.reward };
    }
    throw new Error(L.noJobs);
  }

  const showFinding = (f) => {
    $('wk-finding').textContent = f.steps.map((s) => `${s.via ? `[${L.viaHook}] ` : ''}${s.sig}${s.args.length ? ` ${s.args.join(', ')}` : ''}${s.value !== '0' ? ` {value: ${s.value}}` : ''}${s.reenter ? ` ↺ ${s.reenter.sig} ×${s.reenter.times}` : ''}`).join('\n');
    $('wk-finding').hidden = false;
  };
  const kindName = (k) => L.kinds[k] ?? k;

  async function huntToggle() {
    const btn = $('wk-hunt-go');
    if (hunt?.worker) { hunt.worker.terminate(); live?.workers.delete(hunt.worker); hunt.worker = null; btn.textContent = L.startHunt; if (!hunt.found?.length) say('wk-hunt-msg', ''); return; }
    for (const id of ['wk-submit', 'wk-repro', 'wk-finding', 'wk-kinds']) $(id).hidden = true;
    $('wk-kinds').replaceChildren();
    try {
      hunt = await pickBounty();
      hunt.found = [];
      $('wk-bounty').textContent = hunt.bountyId == null ? hunt.spec.name : `#${hunt.bountyId} · ${hunt.spec.name}`;
      $('wk-reward').textContent = hunt.reward == null ? '–' : zt(hunt.reward);
    } catch (e) { say('wk-hunt-msg', e.message, 'bad'); return; }
    btn.textContent = L.stopHunt;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0];
    say('wk-hunt-msg', fill(L.hunting, { n: seed }));
    hunt.worker = worker((d) => {
      if (d.fuzzRuns) {
        $('wk-runs').textContent = String(d.fuzzRuns);
        if (d.coverage) $('wk-cov').textContent = `${d.coverage.pct}% · ${d.coverage.edges} ${L.edges}`;
        return;
      }
      if (d.found) {
        hunt.found.push(d);
        if (d.coverage) $('wk-cov').textContent = `${d.coverage.pct}% · ${d.coverage.edges} ${L.edges}`;
        // the finding to submit: one where the attacker gains coins first, else the first one found
        const best = hunt.found.find((x) => x.kinds.includes('attacker-profit')) ?? hunt.found[0];
        hunt.finding = best.found;
        hunt.repro = best.repro;
        $('wk-kinds').append(el('li', {}, el('b', { text: d.kinds.map(kindName).join(' + ') }), el('span', { class: 'dim', text: ` · ${fill(L.atRun, { n: d.runs })}` })));
        $('wk-kinds').hidden = false;
        say('wk-hunt-msg', best.kinds.includes('attacker-profit') ? fill(L.found, { p: ctx.formatZeta(BigInt(best.profit), 4) }) : fill(L.foundKinds, { k: best.kinds.map(kindName).join(' + ') }), 'ok');
        showFinding(best.found);
        $('wk-submit').hidden = hunt.bountyId == null; // practice: nothing to submit to
        $('wk-repro').hidden = false;
        return;
      }
      hunt.worker?.terminate(); live?.workers.delete(hunt.worker); hunt.worker = null;
      btn.textContent = L.startHunt;
      if (d.error) { say('wk-hunt-msg', `${L.failed}: ${d.error}`, 'bad'); return; }
      $('wk-runs').textContent = String(d.runs);
      if (d.coverage) $('wk-cov').textContent = `${d.coverage.pct}% · ${d.coverage.edges} ${L.edges}`;
      if (!hunt.found.length) say('wk-hunt-msg', fill(L.notFound, { n: d.runs }));
    });
    hunt.worker.postMessage({ fuzz: { spec: hunt.spec, specText: hunt.specText, seed, runs: 20000 } });
  }

  function saveRepro() {
    if (!hunt?.repro) return;
    const blob = new Blob([hunt.repro], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `zetaphy-repro-${keccakHex(keccak256, findingBytes(hunt.finding)).slice(2, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  async function submitFinding() {
    if (!hunt?.finding || hunt.bountyId == null) return;
    const b = $('wk-submit');
    b.disabled = true;
    try {
      const me = ctx.account?.() || await ctx.connect();
      const bytes = findingBytes(hunt.finding);
      const fh = keccakHex(keccak256, bytes);
      const salt = randomSalt();
      const st = load();
      st.findings ??= {};
      st.findings[`${bb}:${hunt.bountyId}:${fh}`] = { bounty: String(hunt.bountyId), salt, me, finding: hunt.finding };
      save(st);
      const [dep] = await call(bb, 'findingDeposit()', [], ['uint128']);
      const hash = await send(bb, 'commitFinding(uint256,bytes32)', [hunt.bountyId, findingCommitment(keccak256, fh, me, salt, hunt.bountyId)], 'BugBounty.commitFinding', dep);
      const rc = await ctx.evmCall('eth_getTransactionReceipt', [hash]);
      const log = rc?.logs?.find((l) => l.topics?.[0]?.toLowerCase() === FINDING_TOPIC);
      if (!log) throw new Error('no FindingCommitted');
      const fid = BigInt(log.topics[1]);
      const at = BigInt(rc.blockNumber);
      say('wk-hunt-msg', L.submitted);
      while (BigInt(await ctx.evmCall('eth_blockNumber', [])) <= at) await sleep(2000);
      await send(bb, 'revealFinding(uint256,bytes,bytes32)', [fid, toHex(bytes), salt], `BugBounty.revealFinding #${fid}`);
      say('wk-hunt-msg', L.revealed, 'ok');
      b.hidden = true;
    } catch (e) { say('wk-hunt-msg', `${L.failed}: ${e.message}`, 'bad'); }
    b.disabled = false;
  }

  // deployed but still paused (the deploy default): practice until governance opens it
  if (!practice) {
    (async () => {
      let paused = false;
      try { paused = (await call(uw, 'paused()', [], ['bool']))[0]; } catch { /* an older deployment without pause */ }
      // bounties may stay paused on their own: hunt as practice then
      try { if (bb && (await call(bb, 'paused()', [], ['bool']))[0]) bb = null; } catch { /* idem */ }
      if (paused) {
        practice = true;
        bb = null;
        if ($('wk-paused')) $('wk-paused').hidden = false;
        const go = $('wk-scan-go');
        if (go) { go.textContent = L.practiceScan; go.onclick = () => practiceScan(); }
        if ($('wk-withdraw')) $('wk-withdraw').hidden = true;
      } else refresh(ctx.account?.() || null);
    })();
  }
}
