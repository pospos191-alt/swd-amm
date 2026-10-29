#!/usr/bin/env node
// Risk forecasts, Proof of Foresight, Data DAO, detector pool and arena (docs/future/markets.md).
// TESTNET ONLY. Read-only commands need no key; sending ones read the key from the file in KEYFILE
// (never printed) and only send with --send (otherwise they print what they would do).
//
//   node scripts/markets.js export   --forecasts 0x… [--out rows.jsonl] [--votes votes.json]
//        final risk forecasts -> labelled rows (JSONL) and the list zetaphy-neuro/ml/data/votes.js reads
//   node scripts/markets.js keeper   --forecasts 0x… [--send]
//        pokes open questions, proposes answers, finalizes undisputed ones, scores Foresight events
//   node scripts/markets.js commit   --foresight 0x… --event <id> --model <name> --p <basis points> [--send]
//   node scripts/markets.js reveal   --foresight 0x… --event <id> --model <name> --p <basis points> [--send]
//        the salt is derived from the key + event + model, so nothing has to be stored between the two
//   node scripts/markets.js dao-root --report report.json --budget <ZETAPHY> --dao 0x… --round <n> [--chain-id 77390] [--out root.json]
//        Data DAO attribution report -> rewards merkle root + every claim's proof (posting it is the poster's job)
//   node scripts/markets.js detectors-submit --summary summary.json --pool 0x… --foresight 0x… --uri-base <url> [--stake 1] [--send]
//        registers mutate.js's children: a Foresight model id per spec, then the organism with its stake
//   node scripts/markets.js detectors-parents --pool 0x… --dir <population folder> [--top 8] [--out parents.json]
//        the best living organisms (last round Brier) whose spec is in the folder: mutate.js parents
//   node scripts/markets.js detectors-commit --predictions preds.json --foresight 0x… [--send]
//        commits each organism's forecast (mutate.js --predict output, rows with "event") for open events
//   node scripts/markets.js detectors-round --pool 0x… --foresight 0x… (--forecasts 0x<RiskForecasts> | --events events.json)
//          --dir <population folder> --rows a.jsonl[,b.jsonl] [--held held.jsonl] [--n 6] [--stake 1] --uri-base <url>
//          [--out manifest.json] [--no-breed] [--send]
//        one pass of the whole detector loop (src/detectorloop.js): breed once per pool round on held-out rows,
//        submit the children, commit forecasts for open events (features read with Neuro from ZETAPHY), reveal
//        (p recovered from the commitment), score resolved events, settle the pool round. Without --send: a plan
//   node scripts/markets.js arena-fetch --arena 0x… --round <n> [--out round.json]
//        reads the revealed entries and downloads their content (https:// or ipfs://, 100 kB max)
//   node scripts/markets.js arena-commit   --arena 0x… --round <n> --result result.json [--send]
//   node scripts/markets.js arena-reveal   --arena 0x… --round <n> --result result.json [--send]
//        a bonded runner's sealed result (k-of-n: a quorum of the round's seats must reveal the same result);
//        the salt is derived from the key, so the reveal needs only the same result.json
//   node scripts/markets.js arena-finalize --arena 0x… --round <n> [--send]      anyone, after the reveals
//   node scripts/markets.js arena-check    --arena 0x… --round <n> --result result.json [--challenge] [--send]
//        compares a local judging with the on-chain result; --challenge posts the challenge bond if they differ
//   node scripts/markets.js arena-settle   --arena 0x… --round <n> [--send]      anyone, after the challenge window
//
// env: ZETAPHY_RPC (default https://rpc.sawasdeecoin.com), KEYFILE (sending commands), IPFS_GATEWAY.
import { readFileSync, writeFileSync } from 'node:fs';
import { JsonRpcProvider, Wallet, NonceManager, Contract, parseEther, formatEther, getAddress } from 'ethers';
import { artifact, readQuestions, exportRows, toJsonl, foresightCommitment, derivedSalt, modelIdOf, rewardsTree, rewardsFromReport, arenaResultKey, arenaResultCommitment, arenaResultSalt } from '../src/markets.js';

const CHAIN_ID = 77390n;
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const need = (name) => opt(name) ?? die(`--${name} is required`);
const flag = (name) => args.includes(`--${name}`);
const die = (m) => { console.error(m); process.exit(1); };
const addr = (name) => { try { return getAddress(need(name)); } catch { return die(`--${name}: not an address`); } };

async function provider() {
  const p = new JsonRpcProvider(process.env.ZETAPHY_RPC || 'https://rpc.sawasdeecoin.com', CHAIN_ID, { staticNetwork: true });
  if (BigInt(await p.send('eth_chainId', [])) !== CHAIN_ID) die('not the ZETAPHY testnet (chain 77390): these contracts are testnet only');
  return p;
}
const keyText = () => readFileSync(process.env.KEYFILE || die('KEYFILE is not set'), 'utf8').trim();
// a NonceManager: several transactions in one run must not reuse a nonce the provider cached
const signer = (p) => new NonceManager(new Wallet(keyText(), p));

/** Sends (with --send) or prints a planned call; checks it with a static call first either way. */
async function act(c, fn, fnArgs, { value = 0n, label } = {}) {
  try {
    await c[fn].staticCall(...fnArgs, { value });
  } catch (e) {
    return { label: label ?? fn, skipped: e.shortMessage ?? e.message };
  }
  if (!flag('send')) return { label: label ?? fn, planned: true };
  const tx = await c[fn](...fnArgs, { value });
  const r = await tx.wait();
  return { label: label ?? fn, tx: r.hash };
}

const commands = {
  async export() {
    const at = addr('forecasts');
    const p = await provider();
    const rows = exportRows(await readQuestions(p, at), { contract: at });
    const out = opt('out', null);
    if (out) writeFileSync(out, toJsonl(rows)); else process.stdout.write(toJsonl(rows));
    const votes = opt('votes', null);
    if (votes) writeFileSync(votes, JSON.stringify(rows.map((r) => ({ chain: r.chain, address: r.address, flagged: r.flagged, source: r.id })), null, 1) + '\n');
    console.error(`${rows.length} resolved questions exported`);
  },

  async keeper() {
    const at = addr('forecasts');
    const p = await provider();
    const wallet = flag('send') ? signer(p) : null;
    const rf = new Contract(at, artifact('RiskForecasts').abi, wallet ?? p);
    const now = (await p.getBlock('latest')).timestamp;
    const disputeWindow = Number(await rf.disputeWindow());
    const qs = await readQuestions(p, at);
    const done = [];
    for (const q of qs) {
      if (q.status === 'open') {
        const r = await act(rf, 'propose', [q.id], { label: `propose ${q.id}` });
        if (!r.skipped) { done.push(r); continue; }
        if (now <= q.deadline + 7 * 86400) done.push(await act(rf, 'poke', [q.id], { label: `poke ${q.id}` }));
      } else if (q.status === 'proposed') {
        const st = await rf.states(q.id);
        if (now >= Number(st.proposedAt) + disputeWindow) done.push(await act(rf, 'finalize', [q.id], { label: `finalize ${q.id}` }));
      }
    }
    console.log(JSON.stringify({ questions: qs.length, actions: done.filter((d) => !d.skipped), send: flag('send') }, null, 1));
  },

  async commit() { await foresight(false); },
  async reveal() { await foresight(true); },

  async 'dao-root'() {
    const report = JSON.parse(readFileSync(need('report'), 'utf8'));
    if (report.format !== 'neuro-dao-attribution/1') die('--report: not a zetaphy-neuro/ml/dao/attribute.js report');
    const rewards = rewardsFromReport(report, parseEther(need('budget')));
    const tree = rewardsTree({ dao: addr('dao'), chainId: BigInt(opt('chain-id', '77390')), round: BigInt(need('round')), rewards });
    const out = { dao: addr('dao'), chainId: opt('chain-id', '77390'), round: need('round'), root: tree.root, total: tree.total.toString(), totalZetaphy: formatEther(tree.total), method: report.method, claims: tree.claims };
    const file = opt('out', null);
    if (file) writeFileSync(file, JSON.stringify(out, null, 1) + '\n');
    console.log(JSON.stringify({ root: out.root, total: out.total, accounts: Object.keys(out.claims).length }));
  },

  async 'detectors-submit'() {
    const p = await provider();
    const wallet = flag('send') ? signer(p) : null;
    const fs = new Contract(addr('foresight'), artifact('ForesightRegistry').abi, wallet ?? p);
    const pool = new Contract(addr('pool'), artifact('DetectorPool').abi, wallet ?? p);
    const summary = JSON.parse(readFileSync(need('summary'), 'utf8'));
    const stake = parseEther(opt('stake', '1'));
    const base = need('uri-base').replace(/\/$/, '');
    const parentOf = Object.fromEntries((summary.parents ?? []).map((x) => [x.specHash, x.organism]));
    const out = [];
    for (const ch of summary.children ?? []) {
      const modelId = modelIdOf(`detector ${ch.specHash}`);
      out.push(await act(fs, 'registerModel', [modelId], { label: `model ${ch.name}` }));
      out.push(await act(pool, 'register', [modelId, ch.specHash, parentOf[ch.parent] ?? 0, `${base}/${ch.specHash.slice(2, 18)}.json`], { value: stake, label: `organism ${ch.name}` }));
    }
    console.log(JSON.stringify(out, null, 1));
  },

  async 'detectors-parents'() {
    // living organisms, best last-round Brier first, with their spec from the population folder
    // (specs are content-addressed: <first 16 hex of specHash>.json); unknown specs are skipped
    const dir = need('dir');
    const p = await provider();
    const pool = new Contract(addr('pool'), artifact('DetectorPool').abi, p);
    const n = Number(await pool.aliveCount());
    const list = [];
    for (let i = 0; i < n; i++) {
      const id = Number(await pool.aliveIds(i));
      const o = await pool.organism(id);
      let spec = null;
      try { spec = JSON.parse(readFileSync(`${dir}/${o.specHash.slice(2, 18)}.json`, 'utf8')); } catch { /* not ours */ }
      if (spec) list.push({ organism: id, brier: Number(o.lastBrier) / 1e8 || null, spec });
    }
    list.sort((a, b) => (a.brier ?? 1) - (b.brier ?? 1));
    const top = list.slice(0, Number(opt('top', '8')));
    writeFileSync(opt('out', 'parents.json'), JSON.stringify(top, null, 1) + '\n');
    console.log(`${top.length} parents of ${n} living organisms -> ${opt('out', 'parents.json')}`);
  },

  async 'detectors-commit'() {
    const p = await provider();
    const wallet = flag('send') ? signer(p) : null;
    const fs = new Contract(addr('foresight'), artifact('ForesightRegistry').abi, wallet ?? p);
    const preds = JSON.parse(readFileSync(need('predictions'), 'utf8'));
    const key = keyText();
    const out = [];
    for (const row of preds.filter((r) => r.event != null)) {
      for (const [specHash, bps] of Object.entries(row.p)) {
        const modelId = modelIdOf(`detector ${specHash}`);
        const salt = derivedSalt(key, row.event, modelId);
        out.push(await act(fs, 'commit', [row.event, modelId, foresightCommitment(row.event, modelId, bps, salt)], { label: `commit ${row.event} ${specHash.slice(0, 10)} ${bps}` }));
      }
    }
    console.log(JSON.stringify(out, null, 1));
  },

  async 'arena-fetch'() {
    const p = await provider();
    const arena = new Contract(addr('arena'), artifact('RedBlueArena').abi, p);
    const round = BigInt(need('round'));
    const [nRed, nBlue] = await arena.counts(round);
    const entries = async (side, n) => {
      const list = [];
      for (let i = 0; i < Number(n); i++) {
        const e = await arena.entry(round, side, i);
        const item = { index: i, author: e.author, revealed: e.revealed, contentHash: e.contentHash, uri: e.uri };
        if (e.revealed) { try { item.content = await fetchContent(e.uri); } catch (err) { item.fetchError = String(err.message); } }
        list.push(item);
      }
      return list;
    };
    const j = await arena.judging(round);
    const out = { round: Number(round), arena: arena.target, sandbox: j.sandbox, red: await entries(0, nRed), blue: await entries(1, nBlue) };
    writeFileSync(opt('out', 'round.json'), JSON.stringify(out, null, 1) + '\n');
    console.log(`round ${round}: ${out.red.length} red, ${out.blue.length} blue entries -> ${opt('out', 'round.json')}`);
  },

  async 'detectors-round'() {
    const { detectorRound } = await import('../src/detectorloop.js');
    const p = await provider();
    const wallet = signer(p);
    const readJsonl = (paths) => paths.split(',').filter(Boolean).flatMap((f) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))).filter((r) => r.label === 0 || r.label === 1);
    const events = opt('events', null) ? JSON.parse(readFileSync(opt('events'), 'utf8')) : null;
    const known = new Map((events ?? []).filter((e) => e.f).map((e) => [String(e.token).toLowerCase(), e.f]));
    const featuresOf = async (token) => known.get(String(token).toLowerCase()) ?? liveFeatures(token);
    const m = await detectorRound({
      signer: wallet, foresight: addr('foresight'), pool: addr('pool'), forecasts: opt('forecasts', null), events: events?.map(({ eventId, token }) => ({ eventId, token })) ?? null,
      featuresOf, privateKey: keyText(), dir: need('dir'), rows: readJsonl(need('rows')), held: opt('held', null) ? readJsonl(opt('held')) : null,
      n: Number(opt('n', '6')), stake: parseEther(opt('stake', '1')), uriBase: opt('uri-base', ''), breed: !flag('no-breed'), dryRun: !flag('send'),
      out: opt('out', null), log: (l) => console.error(l),
    });
    console.log(JSON.stringify({ round: m.round, children: m.breed?.children.length ?? 0, predictions: m.predictions.length, sent: m.actions.filter((a) => a.tx).length,
      planned: m.actions.filter((a) => a.planned).length, skipped: m.actions.filter((a) => a.skipped).length }));
  },

  async 'arena-commit'() { await arenaRunner('commit'); },
  async 'arena-reveal'() { await arenaRunner('reveal'); },
  async 'arena-check'() { await arenaRunner('check'); },
  async 'arena-finalize'() {
    const p = await provider();
    const arena = new Contract(addr('arena'), artifact('RedBlueArena').abi, flag('send') ? signer(p) : p);
    console.log(JSON.stringify(await act(arena, 'finalize', [BigInt(need('round'))]), null, 1));
  },
  async 'arena-settle'() {
    const p = await provider();
    const arena = new Contract(addr('arena'), artifact('RedBlueArena').abi, flag('send') ? signer(p) : p);
    console.log(JSON.stringify(await act(arena, 'settle', [BigInt(need('round'))]), null, 1));
  },
};

/** Neuro's ML features of a token on ZETAPHY (read-only, like the runners' scan; no trade simulation). */
async function liveFeatures(token) {
  const [{ readContract }, { extractFeatures }, { sparse, SIM_SEED }] = await Promise.all([
    import('../../zetaphy-neuro/src/reader.js'), import('../../zetaphy-neuro/ml/features.js'), import('../../zetaphy-neuro/ml/lib/pipeline.js')]);
  const rpc = process.env.ZETAPHY_RPC || 'https://rpc.sawasdeecoin.com';
  const chainConfig = { kind: 'evm', id: 77390, name: 'ZETAPHY testnet', rpcs: [rpc] };
  const report = await readContract('zetaphy', String(token).toLowerCase(), { chainConfig, sourcify: false, simulate: false, simSeed: SIM_SEED });
  const p = new JsonRpcProvider(rpc, CHAIN_ID, { staticNetwork: true });
  const code = await p.getCode(token);
  const impl = report.proxy?.implementation;
  return sparse(extractFeatures({ report, code, logicCode: impl ? await p.getCode(impl) : null }));
}

/** A runner's side of a round: commit / reveal its result.json (arena.js output), or check it against the chain. */
async function arenaRunner(mode) {
  const p = await provider();
  const wallet = flag('send') || mode !== 'check' ? signer(p) : null;
  const arena = new Contract(addr('arena'), artifact('RedBlueArena').abi, wallet ?? p);
  const round = BigInt(need('round'));
  const res = JSON.parse(readFileSync(need('result'), 'utf8'));
  if (String(res.round) !== String(round)) die('the result is for another round');
  const j = await arena.judging(round);
  if (String(res.sandbox).toLowerCase() !== String(j.sandbox).toLowerCase()) die(`judged in sandbox ${res.sandbox}, the round wants ${j.sandbox}`);
  const args = [BigInt(res.args.redValid), BigInt(res.args.redEvaded), res.args.blueScore.map(Number)];
  const key = arenaResultKey(j.sandbox, args);
  if (mode === 'check') {
    const r = await arena.rounds(round);
    const same = r.judged && j.resultKey === key;
    const out = { round: Number(round), judged: r.judged, onChain: j.resultKey, local: key, same };
    if (!same && r.judged && flag('challenge')) out.challenge = await act(arena, 'challenge', [round, ...args], { value: await arena.challengeBond() });
    console.log(JSON.stringify(out, null, 1));
    return;
  }
  const me = await wallet.getAddress();
  const salt = arenaResultSalt(keyText(), arena.target, round);
  const r = mode === 'commit'
    ? await act(arena, 'commitResult', [round, arenaResultCommitment(arena.target, round, me, key, salt)])
    : await act(arena, 'revealResult', [round, ...args, salt]);
  console.log(JSON.stringify({ round: Number(round), key, ...r }, null, 1));
}

async function foresight(isReveal) {
  const p = await provider();
  const wallet = flag('send') ? signer(p) : null;
  const fs = new Contract(addr('foresight'), artifact('ForesightRegistry').abi, wallet ?? p);
  const event = BigInt(need('event'));
  const modelId = modelIdOf(need('model'));
  const bps = Number(need('p'));
  const salt = derivedSalt(keyText(), event, modelId);
  const r = isReveal
    ? await act(fs, 'reveal', [event, modelId, bps, salt])
    : await act(fs, 'commit', [event, modelId, foresightCommitment(event, modelId, bps, salt)]);
  console.log(JSON.stringify({ event: event.toString(), modelId, ...r }));
}

/** An entry's content: https:// (or ipfs:// through a gateway), at most 100 kB, as text. */
async function fetchContent(uri) {
  const url = uri.startsWith('ipfs://') ? `${(process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/').replace(/\/?$/, '/')}${uri.slice(7)}` : uri;
  if (!url.startsWith('https://')) throw new Error('only https:// and ipfs:// URIs');
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 100_000) throw new Error('over 100 kB');
  return new TextDecoder().decode(buf);
}

if (!commands[cmd]) die(`usage: node scripts/markets.js <${Object.keys(commands).join('|')}> … (see the top of this file)`);
await commands[cmd]();
