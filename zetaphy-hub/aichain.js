// The hub's "On-chain AI" tab: a web view of the AI-map items that had only a command line (docs/future/*.md):
//   #3  NeuroScore (on-chain risk score): the active model and the score of a token you type; "Rescore" (anyone)
//       when the stored score was computed with an older model
//   #14 CosignCommittee (AI co-signer, FROST): members, threshold, the FROST group key; check a FROST signature
//   #18 the cross-chain security oracle: its sender, and the way to the Immunity tab where its coverage is measured
//   #32 HackInsurance (testnet only): the pool, your shares, the open claims; deposit / withdraw, and the steps
//       anyone may take on a claim (payout after the dispute window, expire after the vote window)
//   #34 UsefulIssuance: the buckets, what each holds, the overflow; "Pay out overflow" (anyone)
//   #35 ModelEpochs: the model version in force at the current block and the next scheduled one
// Raw eth_call with hand-encoded selectors (like assist.js); everything shown goes in with textContent; no inline
// styles (CSP style-src 'self'). Each card says plainly when its contract is not deployed yet (hub-config.json).
import { withFallback } from './i18n.js';
import { AICHAIN } from './aichain-i18n.js';
import { parseZeta } from './chainlib.js';

export const AC = (lang) => withFallback(AICHAIN, lang);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const body = (h) => String(h ?? '').replace(/^0x/, '');
export const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => body(a).toLowerCase().padStart(64, '0');
const isAddr = (a) => ADDR.test(String(a ?? ''));

/** keccak256 of each signature, first 4 bytes (checked against ethers in test/aichain.test.mjs). */
export const SEL = {
  // NeuroScore
  version: '0x54fd4d50', model: '0x75044588', scoreOf: '0x133af456', scoreRecord: '0x3632ffc9', rescore: '0x49368816',
  // CosignCommittee
  members: '0xbdd4d18d', threshold: '0x42cde4e8', frostKeyX: '0x747a688a', frostKeyParity: '0xf9490b3f', governance: '0x5aa6e675', isValidFrost: '0x68b77125',
  // HackInsurance
  assets: '0x71a97305', totalShares: '0x3a98ef39', activeCover: '0x59c89931', premiumBps: '0x185a78b8', maxCoverBps: '0x92ed6e4b', quorum: '0x1703a018',
  voteWindow: '0x6d430747', disputeWindow: '0x117f5f92', shares: '0xce7c2ac2', pendingShares: '0x2d9d5336', withdrawReadyAt: '0xec8c4f94',
  claimCount: '0x8da4d3c9', coverCount: '0xfeb0b8f5', claims: '0xa888c2cd', payoutOf: '0xdd14fde2',
  deposit: '0xd0e30db0', requestWithdraw: '0x745400c9', withdraw: '0x3ccfd60b', payout: '0xe1152343', expire: '0xbf81bf43',
  // UsefulIssuance
  buckets: '0x37ea2b91', pendingOverflow: '0xd394c845', overflow: '0x004264c3', sweepOverflow: '0x4a937427',
  // ModelEpochs
  current: '0x9fa6a6e3', count: '0x06661abd', versionByIndex: '0xb4187e81', epochLength: '0x57d775f8', minDelay: '0xc63c4e9b',
};
/** topic0 of NeuroScore.Scored(address indexed token, uint32 indexed version, int64 score, uint8 level, bytes32 featuresHash, bytes features). */
export const SCORED_TOPIC = '0xcb4fd71c048521cdee0bc7cb6becf95dfc54b8e1d0ca2dce01abbc3b1120e117';

// ---------------------------------------------------------------- ABI words

/** The 32-byte words of an answer, with readers for each type. */
export function words(hex) {
  const h = body(hex);
  const w = (i) => {
    const s = h.slice(i * 64, (i + 1) * 64);
    if (s.length !== 64) throw new Error('short answer');
    return s;
  };
  const u = (i) => BigInt(`0x${w(i)}`);
  return {
    n: Math.floor(h.length / 64), w, u,
    num: (i) => Number(u(i)),
    int: (i) => { const v = u(i); return v >= 1n << 255n ? v - (1n << 256n) : v; },
    bool: (i) => u(i) !== 0n,
    addr: (i) => `0x${w(i).slice(24)}`,
    b32: (i) => `0x${w(i)}`,
    /** dynamic bytes whose offset is in word i (offsets count from `base` bytes) */
    bytes: (i, base = 0) => { const o = (Number(u(i)) + base) * 2; const len = Number(BigInt(`0x${h.slice(o, o + 64)}`)); return `0x${h.slice(o + 64, o + 64 + len * 2)}`; },
    /** a string (UTF-8) whose offset is in word i */
    str: (i) => { const o = Number(u(i)) * 2; const len = Number(BigInt(`0x${h.slice(o, o + 64)}`)); return utf8(h.slice(o + 64, o + 64 + len * 2)); },
    /** a dynamic array of static structs (`size` words each) whose offset is in word i */
    arr: (i, size = 1) => { const o = Number(u(i)) / 32; const len = Number(u(o)); return Array.from({ length: len }, (_, k) => o + 1 + k * size); },
  };
}
const utf8 = (hex) => new TextDecoder().decode(Uint8Array.from((hex.match(/../g) ?? []).map((b) => parseInt(b, 16))));
/** A bytes32 holding short ASCII text (a model id like "nml-b4c35477f7b1"): its printable characters. */
export const ascii32 = (b32) => (body(b32).match(/../g) ?? []).map((b) => parseInt(b, 16)).filter((b) => b >= 0x20 && b < 0x7f).map((b) => String.fromCharCode(b)).join('');
/** The tail of a dynamic `bytes` argument (length word, then the data padded to 32 bytes). */
const bytesTail = (hex) => { const b = body(hex); return word(b.length / 2) + b.padEnd(Math.ceil(b.length / 64) * 64, '0'); };

/** One eth_call through the hub's evmCall (throws on a revert). */
const call = (evmCall, to, data) => evmCall('eth_call', [{ to, data }, 'latest']);

// ---------------------------------------------------------------- #3 NeuroScore

export const LEVELS = ['minimal', 'low', 'medium', 'high'];
/** model(v)'s answer -> { hash, modelId, nFeatures, low, medium, high, activatedAt }. */
export function readModel(hex) {
  const a = words(hex);
  return { hash: a.b32(0), modelId: ascii32(a.b32(1)), nFeatures: a.num(2), low: a.int(3), medium: a.int(4), high: a.int(5), activatedAt: a.num(6) };
}
export const scoreOfData = (token) => SEL.scoreOf + addrWord(token);
export const scoreRecordData = (token) => SEL.scoreRecord + addrWord(token);
/** scoreOf(token): { known, score, level } (known = false: never scored, or only with an older model). */
export function readScoreOf(hex) { const a = words(hex); return { known: a.bool(0), score: a.int(1), level: a.num(2) }; }
/** scoreRecord(token): { score, version, level, time, featuresHash } whatever model it was computed with. */
export function readScoreRecord(hex) { const a = words(hex); return { score: a.int(0), version: a.num(1), level: a.num(2), time: a.num(3), featuresHash: a.b32(4) }; }
/** The score is a calibrated logit times 1e7: p = sigmoid(score / 1e7). */
export const probOf = (score) => 1 / (1 + Math.exp(-Number(score) / 1e7));
/** A Scored log -> { token, version, score, level, featuresHash, features }. */
export function readScoredLog(log) {
  const a = words(log.data);
  return { token: `0x${body(log.topics[1]).slice(24)}`, version: Number(BigInt(log.topics[2])), score: a.int(0), level: a.num(1), featuresHash: a.b32(2), features: a.bytes(3) };
}
export const rescoreData = (token, features) => SEL.rescore + addrWord(token) + word(64) + bytesTail(features);

/** The active model (null: none activated yet). */
export async function readNeuroScore(evmCall, addr) {
  const version = Number(BigInt(await call(evmCall, addr, SEL.version)));
  return { version, model: version ? readModel(await call(evmCall, addr, SEL.model + word(version))) : null };
}
/** What the chain says about `token`: { current: scoreOf, record: scoreRecord, stale } (stale: scored with an older model). */
export async function readTokenScore(evmCall, addr, token, version) {
  const current = readScoreOf(await call(evmCall, addr, scoreOfData(token)));
  const record = readScoreRecord(await call(evmCall, addr, scoreRecordData(token)));
  return { current, record, stale: !current.known && record.version !== 0 && record.version !== version };
}
/** The feature vector last posted for `token` (from its Scored logs) with the stored hash; null when not found. */
export async function findFeatures(evmCall, addr, token, featuresHash) {
  const logs = await evmCall('eth_getLogs', [{ address: addr, fromBlock: '0x0', toBlock: 'latest', topics: [SCORED_TOPIC, `0x${addrWord(token)}`] }]);
  for (const l of [...(logs ?? [])].reverse()) {
    try { const s = readScoredLog(l); if (s.featuresHash.toLowerCase() === String(featuresHash).toLowerCase()) return s.features; } catch { /* not ours */ }
  }
  return null;
}

// ---------------------------------------------------------------- #14 CosignCommittee

/** An address[] answer (members()). */
export function readAddresses(hex) { const a = words(hex); return a.arr(0).map((i) => a.addr(i)); }
/** The SEC1-compressed FROST group key (null: none set). */
export const frostKey = (x, parity) => (BigInt(x) === 0n ? null : `0x0${2 + Number(parity)}${word(x)}`);
export const isValidFrostData = (digest, sig) => SEL.isValidFrost + body(digest).padStart(64, '0') + word(64) + bytesTail(sig);
export async function readCommittee(evmCall, addr) {
  const [m, t, x, p, g] = await Promise.all([SEL.members, SEL.threshold, SEL.frostKeyX, SEL.frostKeyParity, SEL.governance].map((s) => call(evmCall, addr, s)));
  return { members: readAddresses(m), threshold: Number(BigInt(t)), frostKey: frostKey(BigInt(x), BigInt(p)), governance: `0x${body(g).slice(24)}` };
}
/** Whether `sig` (65 bytes, RFC 9591) is the committee's FROST signature of the 32-byte `digest` (a free read). */
export async function checkFrost(evmCall, addr, digest, sig) {
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(digest) || !/^(0x)?[0-9a-fA-F]{130}$/.test(sig)) throw new Error('format');
  return BigInt(await call(evmCall, addr, isValidFrostData(digest, sig))) !== 0n;
}

// ---------------------------------------------------------------- #32 HackInsurance

export const CLAIM_STATES = ['none', 'voting', 'approved', 'rejected', 'expired', 'disputed', 'paid', 'overturned'];
const OPEN = new Set(['voting', 'approved', 'disputed']);
/** claims(i)'s answer -> the claim. */
export function readClaim(hex) {
  const a = words(hex);
  return {
    coverId: a.num(0), claimant: a.addr(1), state: CLAIM_STATES[a.num(2)] ?? 'none', approvals: a.num(3), rejections: a.num(4),
    filedAt: a.num(5), decidedAt: a.num(6), loss: a.u(7), bond: a.u(8), evidenceHash: a.b32(9), reportHash: a.b32(10), disputer: a.addr(11), disputeBond: a.u(12),
  };
}
/** What anyone may do on a claim now: 'payout' (approved, dispute window over), 'expire' (vote window over), or null. */
export function claimAction(c, now, { voteWindow, disputeWindow }) {
  if (c.state === 'approved' && now >= c.decidedAt + disputeWindow) return 'payout';
  if (c.state === 'voting' && now > c.filedAt + voteWindow) return 'expire';
  return null;
}
/** The pool, its parameters, the last `last` claims (open ones first in `open`) and, with `account`, its shares. */
export async function readInsurance(evmCall, addr, { account = null, last = 50 } = {}) {
  const num = async (s) => BigInt(await call(evmCall, addr, s));
  const [assets, totalShares, activeCover, premiumBps, maxCoverBps, quorum, voteWindow, disputeWindow, claimCount, coverCount] = await Promise.all(
    [SEL.assets, SEL.totalShares, SEL.activeCover, SEL.premiumBps, SEL.maxCoverBps, SEL.quorum, SEL.voteWindow, SEL.disputeWindow, SEL.claimCount, SEL.coverCount].map(num));
  const blk = await evmCall('eth_getBlockByNumber', ['latest', false]).catch(() => null);
  const now = blk?.timestamp ? Number(BigInt(blk.timestamp)) : Math.floor(Date.now() / 1000);
  const n = Number(claimCount);
  const ids = Array.from({ length: Math.min(n, last) }, (_, i) => n - 1 - i);
  const claims = await Promise.all(ids.map(async (id) => ({ id, ...readClaim(await call(evmCall, addr, SEL.claims + word(id))) })));
  const win = { voteWindow: Number(voteWindow), disputeWindow: Number(disputeWindow) };
  const open = claims.filter((c) => OPEN.has(c.state)).map((c) => ({ ...c, action: claimAction(c, now, win) }));
  for (const c of open) if (c.state === 'approved') c.payout = await num(SEL.payoutOf + word(c.id)).catch(() => null);
  let me = null;
  if (isAddr(account)) {
    const [s, p, r] = await Promise.all([SEL.shares, SEL.pendingShares, SEL.withdrawReadyAt].map((x) => num(x + addrWord(account))));
    me = { shares: s, pending: p, readyAt: Number(r), value: totalShares ? (s * assets) / totalShares : 0n, canWithdraw: p > 0n && now >= Number(r) };
  }
  return {
    now, assets, totalShares, activeCover, capacity: (assets * maxCoverBps) / 10000n, premiumBps: Number(premiumBps), quorum: Number(quorum), ...win,
    claimCount: n, coverCount: Number(coverCount), open, me,
  };
}

// ---------------------------------------------------------------- #34 UsefulIssuance

/** buckets()'s answer -> [{ sink, bps, cap, accrued }]. */
export function readBuckets(hex) { const a = words(hex); return a.arr(0, 4).map((i) => ({ sink: a.addr(i), bps: a.num(i + 1), cap: a.u(i + 2), accrued: a.u(i + 3) })); }
export async function readIssuance(evmCall, addr) {
  const [b, p, o, bal] = await Promise.all([call(evmCall, addr, SEL.buckets), call(evmCall, addr, SEL.pendingOverflow), call(evmCall, addr, SEL.overflow), evmCall('eth_getBalance', [addr, 'latest'])]);
  const buckets = readBuckets(b);
  return { buckets, accrued: buckets.reduce((s, x) => s + x.accrued, 0n), sharedBps: buckets.reduce((s, x) => s + x.bps, 0), pendingOverflow: BigInt(p), overflow: `0x${body(o).slice(24)}`, balance: BigInt(bal) };
}

// ---------------------------------------------------------------- #35 ModelEpochs

/** current() / versionAt(h)'s answer -> { found, index, hash, activation, uri }. */
export function readCurrent(hex) { const a = words(hex); return { found: a.bool(0), index: a.num(1), hash: a.b32(2), activation: a.num(3), uri: a.str(4) }; }
/** versionByIndex(i)'s answer -> { index, hash, activation, scheduledAt, uri }. */
export function readVersion(hex, index) { const a = words(hex); return { index, hash: a.b32(0), activation: a.num(1), scheduledAt: a.num(2), uri: a.str(3) }; }
/** The version in force now and the next scheduled one (null: none). */
export async function readEpochs(evmCall, addr) {
  const [blockHex, cur, cnt, el, md] = await Promise.all([evmCall('eth_blockNumber', []), call(evmCall, addr, SEL.current), call(evmCall, addr, SEL.count), call(evmCall, addr, SEL.epochLength), call(evmCall, addr, SEL.minDelay)]);
  const block = Number(BigInt(blockHex));
  const current = readCurrent(cur);
  const count = Number(BigInt(cnt));
  const ni = current.found ? current.index + 1 : 0;
  const next = ni < count ? readVersion(await call(evmCall, addr, SEL.versionByIndex + word(ni)), ni) : null;
  return { block, count, epochLength: Number(BigInt(el)), minDelay: Number(BigInt(md)), current: current.found ? current : null, next };
}

// ---------------------------------------------------------------- the page

const card = (ctx, id, n, title, tip, ...kids) => ctx.el('div', { class: 'card ac-card', id, 'data-item': n },
  ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: `#${n} · ${title}` }), tip ? ctx.el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }) : null), ...kids);
const kv = (ctx, rows) => ctx.el('dl', { class: 'kv3' }, rows.filter(Boolean).flatMap(([k, v, mono]) => [ctx.el('dt', { text: k }), ctx.el('dd', { class: mono ? 'mono' : null, text: String(v) })]));
const when = (ctx, t) => { const d = new Date(t * 1000); return t && Number.isFinite(d.getTime()) ? d.toLocaleString(ctx.lang === 'en' ? 'en-GB' : ctx.lang) : '–'; };
const say = (ctx, box, text, cls = 'dim') => box?.replaceChildren(ctx.el('p', { class: cls, text }));
const errText = (e) => String(e?.message ?? e).slice(0, 160);
const pctBps = (bps) => `${(Number(bps) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
const zeta = (ctx, v) => `${ctx.formatZeta(v)} ZTPHY`;

/** Sends `data` to `to` from the connected wallet, writes the outcome in `out`, then reloads the page's state. */
async function act(ctx, root, out, to, data, action, value = 0n) {
  const L = AC(ctx.lang);
  try { say(ctx, out, L.sending); await ctx.send(to, data, action, value); say(ctx, out, L.done, 'msg ok'); page.refresh(root, ctx); } catch (e) { say(ctx, out, errText(e), 'warnline'); }
}

const page = {
  render(root, ctx) {
    const L = AC(ctx.lang);
    const el = ctx.el;
    const c = ctx.cfg.contracts ?? {};
    // #3: a token's score
    const tokIn = el('input', { id: 'ac-token', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', 'aria-label': L.scoreToken });
    const tokOut = el('div', { id: 'ac-score-out', class: 'small', role: 'status' });
    const tokForm = el('form', { class: 'row', id: 'ac-score-form', autocomplete: 'off' }, tokIn, el('button', { type: 'submit', class: 'btn', text: L.scoreRead }));
    tokForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const addr = c.neuroScore;
      const token = tokIn.value.trim();
      if (!isAddr(addr)) return say(ctx, tokOut, L.notDeployed);
      if (!isAddr(token)) return say(ctx, tokOut, L.badAddress, 'warnline');
      say(ctx, tokOut, '…');
      try {
        const { version } = await readNeuroScore(ctx.evmCall, addr);
        if (!version) return say(ctx, tokOut, L.scoreNoModel);
        const s = await readTokenScore(ctx.evmCall, addr, token, version);
        if (s.current.known) {
          return tokOut.replaceChildren(el('p', { class: `msg ac-level lv-${LEVELS[s.current.level]}`, 'data-level': LEVELS[s.current.level], text: L.scoreIs(L.level[LEVELS[s.current.level]], `${(probOf(s.current.score) * 100).toFixed(1)}%`) }),
            kv(ctx, [[L.scoreModel, `v${version}`], [L.scoreTime, when(ctx, s.record.time)], [L.scoreFeatures, s.record.featuresHash, true]]),
            el('p', { class: 'dim', text: L.scoreNote }));
        }
        if (!s.stale) return say(ctx, tokOut, L.scoreNone);
        const kids = [el('p', { class: 'warnline', 'data-level': 'stale', text: L.scoreStale(`v${s.record.version}`, `v${version}`) })];
        const features = await findFeatures(ctx.evmCall, addr, token, s.record.featuresHash).catch(() => null);
        if (features) {
          const out = el('p', { class: 'small', role: 'status' });
          kids.push(el('button', { type: 'button', class: 'btn sm', id: 'ac-rescore', text: L.rescore,
            onclick: () => act(ctx, root, out, addr, rescoreData(token, features), L.rescoreAction(ctx.short(token))) }), out);
        }
        tokOut.replaceChildren(...kids);
      } catch (err) { say(ctx, tokOut, errText(err), 'warnline'); }
    });
    // #14: check a FROST signature
    const dIn = el('input', { id: 'ac-digest', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: L.frostDigest, 'aria-label': L.frostDigest });
    const sIn = el('input', { id: 'ac-sig', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: L.frostSig, 'aria-label': L.frostSig });
    const fOut = el('div', { id: 'ac-frost-out', class: 'small', role: 'status' });
    const fForm = el('form', { class: 'ac-form', id: 'ac-frost-form', autocomplete: 'off' }, dIn, sIn, el('button', { type: 'submit', class: 'btn sm', text: L.frostCheck }));
    fForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!isAddr(c.cosignCommittee)) return say(ctx, fOut, L.notDeployed);
      try {
        const ok = await checkFrost(ctx.evmCall, c.cosignCommittee, dIn.value.trim(), sIn.value.trim());
        say(ctx, fOut, ok ? L.frostValid : L.frostInvalid, ok ? 'msg ok' : 'warnline');
      } catch (err) { say(ctx, fOut, err.message === 'format' ? L.frostFormat : errText(err), 'warnline'); }
    });
    // #32: deposit
    const amtIn = el('input', { id: 'ac-amount', class: 'mono', inputmode: 'decimal', autocomplete: 'off', placeholder: '10', 'aria-label': L.insAmount });
    const depOut = el('p', { id: 'ac-dep-out', class: 'small', role: 'status' });
    const depForm = el('form', { class: 'row', id: 'ac-dep-form', autocomplete: 'off' }, amtIn, el('button', { type: 'submit', class: 'btn sm', text: L.insDeposit }));
    depForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!isAddr(c.hackInsurance)) return say(ctx, depOut, L.notDeployed);
      let v;
      try { v = parseZeta(amtIn.value); if (v === 0n) throw new Error('amount'); } catch { return say(ctx, depOut, L.badAmount, 'warnline'); }
      act(ctx, root, depOut, c.hackInsurance, SEL.deposit, L.insDepositAction(ctx.formatZeta(v)), v);
    });
    const oracle = c.neuroOracleSender ?? ctx.cfg.immune?.sender;
    root.replaceChildren(el('p', { class: 'dim small sp-intro', text: L.intro }),
      el('div', { class: 'grid3 ac-grid' },
        card(ctx, 'ac-score', 3, L.scoreTitle, L.scoreTip, el('div', { class: 'ac-state', 'data-for': 'neuroScore' }, el('p', { class: 'dim', text: '…' })), tokForm, tokOut),
        card(ctx, 'ac-cosign', 14, L.cosignTitle, L.cosignTip, el('div', { class: 'ac-state', 'data-for': 'cosignCommittee' }, el('p', { class: 'dim', text: '…' })),
          el('h3', { text: L.frostCheckTitle }), fForm, fOut),
        card(ctx, 'ac-oracle', 18, L.oracleTitle, L.oracleTip,
          isAddr(oracle) ? kv(ctx, [[L.oracleSender, oracle, true]]) : el('p', { class: 'dim', 'data-state': 'not-deployed', text: L.notDeployed }),
          el('p', { class: 'small', text: L.oracleWhere }),
          el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn sm', id: 'ac-open-immune', text: L.oracleOpen, onclick: () => ctx.show('immune') }))),
        card(ctx, 'ac-ins', 32, L.insTitle, L.insTip, el('p', { class: 'warnline small', text: L.insTestnet }),
          el('div', { class: 'ac-state', 'data-for': 'hackInsurance' }, el('p', { class: 'dim', text: '…' })),
          el('h3', { text: L.insDepositTitle }), depForm, depOut),
        card(ctx, 'ac-iss', 34, L.issTitle, L.issTip, el('div', { class: 'ac-state', 'data-for': 'usefulIssuance' }, el('p', { class: 'dim', text: '…' }))),
        card(ctx, 'ac-epochs', 35, L.epTitle, L.epTip, el('div', { class: 'ac-state', 'data-for': 'modelEpochs' }, el('p', { class: 'dim', text: '…' })))));
  },

  async refresh(root, ctx) {
    const L = AC(ctx.lang);
    const el = ctx.el;
    const c = ctx.cfg.contracts ?? {};
    const box = (k) => root.querySelector(`.ac-state[data-for="${k}"]`);
    const draw = async (key, fn) => {
      const b = box(key);
      if (!b) return;
      if (!isAddr(c[key])) { b.replaceChildren(el('p', { class: 'dim', 'data-state': 'not-deployed', text: L.notDeployed })); return; }
      try { b.replaceChildren(...(await fn(c[key])).filter(Boolean)); b.dataset.state = 'live'; } catch (e) { b.replaceChildren(el('p', { class: 'warnline', text: `${L.readFailed}: ${errText(e)}` })); }
    };
    await Promise.all([
      draw('neuroScore', async (a) => {
        const s = await readNeuroScore(ctx.evmCall, a);
        if (!s.model) return [kv(ctx, [[L.contract, a, true]]), el('p', { class: 'dim', text: L.scoreNoModel })];
        const m = s.model;
        return [kv(ctx, [[L.contract, a, true], [L.scoreModel, `v${s.version}${m.modelId ? ` · ${m.modelId}` : ''}`], [L.scoreHash, ctx.short(m.hash, 10, 8), true],
          [L.scoreSince, when(ctx, m.activatedAt)], [L.scoreLevels, [m.low, m.medium, m.high].map((x) => `${(probOf(x) * 100).toFixed(1)}%`).join(' / ')]])];
      }),
      draw('cosignCommittee', async (a) => {
        const k = await readCommittee(ctx.evmCall, a);
        return [kv(ctx, [[L.contract, a, true], [L.cosignThreshold, L.cosignOf(k.threshold, k.members.length)], [L.cosignFrost, k.frostKey ? ctx.short(k.frostKey, 10, 8) : L.cosignNoFrost, Boolean(k.frostKey)]]),
          el('ul', { class: 'ac-list small mono' }, k.members.map((m) => el('li', { text: m })))];
      }),
      draw('hackInsurance', async (a) => {
        const p = await readInsurance(ctx.evmCall, a, { account: ctx.account?.() });
        const rows = [[L.contract, a, true], [L.insPool, zeta(ctx, p.assets)], [L.insCover, `${zeta(ctx, p.activeCover)} / ${zeta(ctx, p.capacity)}`],
          [L.insPremium, L.insPerYear(pctBps(p.premiumBps))], [L.insQuorum, String(p.quorum)], [L.insClaims, L.insClaimCount(p.open.length, p.claimCount)]];
        if (p.me) rows.push([L.insMine, zeta(ctx, p.me.value)]);
        const kids = [kv(ctx, rows)];
        if (p.me && (p.me.shares > 0n || p.me.pending > 0n)) {
          const out = el('p', { class: 'small', role: 'status' });
          const btns = [];
          if (p.me.pending > 0n && p.me.canWithdraw) btns.push(el('button', { type: 'button', class: 'btn sm', id: 'ac-withdraw', text: L.insWithdraw, onclick: () => act(ctx, root, out, a, SEL.withdraw, L.insWithdraw) }));
          else if (p.me.pending > 0n) kids.push(el('p', { class: 'dim small', text: L.insWithdrawAt(when(ctx, p.me.readyAt)) }));
          else btns.push(el('button', { type: 'button', class: 'btn ghost sm', id: 'ac-request', text: L.insRequest, onclick: () => act(ctx, root, out, a, SEL.requestWithdraw + word(p.me.shares), L.insRequest) }));
          kids.push(el('div', { class: 'row' }, ...btns), out);
        }
        if (p.open.length) {
          kids.push(el('table', { class: 'tbl ac-claims' }, el('tbody', {}, p.open.map((k) => {
            const out = el('span', { class: 'small', role: 'status' });
            const btn = k.action ? el('button', { type: 'button', class: 'btn sm', 'data-action': k.action, text: L.claimAct[k.action],
              onclick: () => act(ctx, root, out, a, SEL[k.action] + word(k.id), `${L.claimAct[k.action]} #${k.id}`) }) : null;
            return el('tr', { 'data-claim': k.id, 'data-state': k.state },
              el('td', { class: 'mono', text: `#${k.id}` }),
              el('td', { text: `${L.claimState[k.state]} · ${k.approvals}/${p.quorum}` }),
              el('td', { class: 'num', text: zeta(ctx, k.payout ?? k.loss) }),
              el('td', {}, btn, out));
          }))));
        } else kids.push(el('p', { class: 'dim small', text: L.insNoClaims }));
        return kids;
      }),
      draw('usefulIssuance', async (a) => {
        const s = await readIssuance(ctx.evmCall, a);
        const out = el('p', { class: 'small', role: 'status' });
        return [kv(ctx, [[L.contract, a, true], [L.issBalance, zeta(ctx, s.balance)], [L.issAccrued, zeta(ctx, s.accrued)], [L.issOverflow, `${zeta(ctx, s.pendingOverflow)} → ${ctx.short(s.overflow)}`]]),
          s.buckets.length ? el('table', { class: 'tbl ac-buckets' }, el('tbody', {}, s.buckets.map((b) => el('tr', { 'data-sink': b.sink },
            el('td', { class: 'mono', text: ctx.short(b.sink) }), el('td', { class: 'num', text: pctBps(b.bps) }), el('td', { class: 'num', text: `${ctx.formatZeta(b.accrued)} / ${ctx.formatZeta(b.cap)}` })))))
            : el('p', { class: 'dim small', text: L.issNoBuckets }),
          el('p', { class: 'dim small', text: L.issNote }),
          s.pendingOverflow > 0n ? el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn ghost sm', id: 'ac-sweep', text: L.issSweep, onclick: () => act(ctx, root, out, a, SEL.sweepOverflow, L.issSweep) })) : null, out];
      }),
      draw('modelEpochs', async (a) => {
        const s = await readEpochs(ctx.evmCall, a);
        const v = (x) => `#${x.index} · ${ctx.short(x.hash, 10, 8)}`;
        return [kv(ctx, [[L.contract, a, true], [L.epBlock, s.block.toLocaleString('en-US')], [L.epLength, L.epBlocks(s.epochLength)],
          [L.epNow, s.current ? v(s.current) : L.epNone, Boolean(s.current)], s.current ? [L.epFrom, L.epAtBlock(s.current.activation.toLocaleString('en-US'))] : null,
          s.current?.uri ? [L.epManifest, s.current.uri, true] : null,
          [L.epNext, s.next ? v(s.next) : L.epNoNext, Boolean(s.next)], s.next ? [L.epFrom, L.epIn(s.next.activation.toLocaleString('en-US'), Math.max(0, s.next.activation - s.block).toLocaleString('en-US'))] : null]),
        el('p', { class: 'dim small', text: L.epNote })];
      }),
    ]);
  },
};

export default page;
