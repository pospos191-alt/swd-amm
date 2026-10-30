// "Ask the explorer": the search box also understands short plain questions, in
// English and Thai, offline and rule based (no AI service, nothing leaves the page):
//   "largest transfers today"       -> #/ask/largest?s=86400
//   "biggest ZETAPHY holders seen"  -> #/ask/holders
//   "txs of 0x… last hour"          -> #/ask/txs?address=0x…&s=3600
//   "failed txs"                    -> #/ask/failed
//   "is 0x… safe?" / "ที่อยู่นี้ปลอดภัยไหม 0x…" -> #/ask/risk?address=0x…
//   "quantum 0x…" / "flow of 0x…"   -> #/quantum/0x… / #/flow/0x…
// Anything else returns null and the normal search runs. The answers come from the
// same bounded scan as the rest of the explorer (no indexer), and say which blocks.
import { h } from './dom.js';
import { toAddress, anyAddressLower, formatZtphy, formatUnits, groupDigits, short, tokenText, percent } from './format.js';
import { decodeTransfer, TOPICS } from './evm.js';

const ADDRESS = /(0x[0-9a-fA-F]{40}|zetaphy1[02-9ac-hj-np-z]{38})\b/i;
const UNITS = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1, วินาที: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60, นาที: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, ชั่วโมง: 3600, 'ชม.': 3600, ชม: 3600,
  d: 86400, day: 86400, days: 86400, วัน: 86400,
};

/** A time or block window in a question: { s: seconds } | { b: blocks } | null. */
export function parseWindow(q) {
  const s = q.toLowerCase();
  let m = /(?<![0-9a-z])(\d{1,5})\s*(blocks?|บล็อก)/.exec(s);
  if (m) return { b: Number(m[1]) };
  m = /(?<![0-9a-z])(\d{1,4})\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|วินาที|นาที|ชั่วโมง|ชม\.?|วัน|[smhd])(?![a-z])/.exec(s);
  if (m) return { s: Number(m[1]) * (UNITS[m[2]] ?? UNITS[m[2].replace(/\.$/, '')] ?? 60) };
  if (/\b(today|24 ?h|last day|past day)\b|วันนี้|24 ?ชั่วโมง/.test(s)) return { s: 86400 };
  if (/\b(last|past|this) hour\b|\bhour\b|ชั่วโมง(ที่)?(แล้ว|ล่าสุด|นี้|ที่ผ่านมา)|ชม\.? ?ล่าสุด/.test(s)) return { s: 3600 };
  if (/\b(last|past) (minute|few minutes)\b|เมื่อกี้|เมื่อสักครู่/.test(s)) return { s: 600 };
  return null;
}

const RULES = [
  { kind: 'risk', needs: 'address', re: /\b(safe|safety|risk|risky|flag|flagged|trust|trusted|dangerous|danger|legit)\b|ปลอดภัย|เสี่ยง|อันตราย|ติดธง|น่าเชื่อถือ|ไว้ใจ/ },
  { kind: 'quantum', re: /\b(quantum|post-quantum|pq|ml-dsa|exposed|exposure)\b|ควอนตัม|กุญแจสาธารณะ/ },
  { kind: 'flow', needs: 'address', re: /\b(flow|flows|follow|trace|money|where did|went|sent to|fund)\b|เงินไหล|ไหลไป|ติดตามเงิน|เส้นทางเงิน|โอนไปไหน/ },
  { kind: 'failed', re: /\b(fail|failed|failing|failure|error|errors|reverted|revert)\b|ไม่สำเร็จ|ล้มเหลว|ผิดพลาด|ล้ม/ },
  { kind: 'holders', re: /\b(holders?|richest|rich list|whales?|top balances?|largest balances?|biggest balances?)\b|ผู้ถือ|รวยที่สุด|ถือมากที่สุด|วาฬ/ },
  { kind: 'largest', re: /\b(largest|biggest|top|large|big|huge|max)\b.*\b(transfers?|txs?|transactions?|payments?|moves?)\b|\b(transfers?|txs?|transactions?)\b.*\b(largest|biggest|top)\b|โอน.*(ใหญ่|มาก|สูง)|(ใหญ่|มาก)ที่สุด/ },
  { kind: 'txs', needs: 'address', re: /\b(txs?|transactions?|activity|history|transfers?|sent|received)\b|ธุรกรรม|รายการ|ประวัติ|ทำอะไร/ },
];

/**
 * A question -> { kind, route (without '#/'), address?, window? } or null when it is not one.
 * Plain block numbers, hashes and addresses are left to the normal search.
 */
export function parseQuestion(input) {
  const q = String(input ?? '').trim().slice(0, 300);
  if (!q || /^\S+$/.test(q) && (ADDRESS.test(q) || /^(0x)?[0-9a-f]{64}$/i.test(q) || /^#?\d+$/.test(q))) return null;
  const lower = q.toLowerCase();
  const m = ADDRESS.exec(q);
  const address = m ? toAddress(m[1])?.hex ?? null : null;
  const window = parseWindow(lower.replace(new RegExp(ADDRESS.source, 'gi'), ' ').replace(/0x[0-9a-f]+/g, ' '));
  for (const r of RULES) {
    if (!r.re.test(lower)) continue;
    if (r.needs === 'address' && !address) continue;
    const p = new URLSearchParams();
    if (address) p.set('address', address);
    if (window?.s) p.set('s', String(window.s));
    if (window?.b) p.set('b', String(window.b));
    const qs = p.toString();
    if (r.kind === 'quantum') return { kind: 'quantum', route: address ? `quantum/${address}` : 'quantum', address };
    if (r.kind === 'flow') return { kind: 'flow', route: `flow/${address}`, address };
    return { kind: r.kind, route: `ask/${r.kind}${qs ? `?${qs}` : ''}`, address, window };
  }
  // an address with a time window and no other word: its transactions
  if (address && window) return { kind: 'txs', route: `ask/txs?address=${address}&${window.s ? `s=${window.s}` : `b=${window.b}`}`, address, window };
  return null;
}

/** Blocks to scan for a window, from the measured block time; capped at `max`. */
export function windowBlocks(win, blockTime, max) {
  const n = win?.b ? win.b : win?.s ? Math.ceil(win.s / Math.max(0.2, blockTime || 5)) : null;
  if (n == null) return { n: max, capped: false, whole: true };
  return { n: Math.max(1, Math.min(n, max)), capped: n > max, whole: false };
}

/** Largest native transfers first (ties: newer first). */
export function largestNative(txs, k = 25) {
  return txs.filter((x) => x.ok !== false && x.value != null && BigInt(x.value) > 0n)
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : Number(b.height) - Number(a.height))).slice(0, k);
}

/** Addresses seen in scanned txs (from, to, and every address a message names), bounded. */
export function seenAddresses(txs, max = 40) {
  const out = new Set();
  for (const x of txs) {
    for (const a of [x.from, x.to, ...(x.addresses ?? [])]) {
      const l = anyAddressLower(a);
      if (l && !String(a).startsWith('zetaphyvaloper')) out.add(l);
      if (out.size >= max) return [...out];
    }
  }
  return [...out];
}

// ---- the answer page: #/ask/<kind>?… ----

export async function pageAsk(view, param, ui) {
  const { t, chain, cfg, card, note, table, addrLink, hashLink, blockLink, txTable, slot, loading } = ui;
  const [kind, query = ''] = String(param ?? '').split('?');
  const p = new URLSearchParams(query);
  const a = p.get('address') ? toAddress(p.get('address')) : null;
  const win = p.get('b') ? { b: Number(p.get('b')) } : p.get('s') ? { s: Number(p.get('s')) } : null;
  if (!['largest', 'holders', 'txs', 'failed', 'risk'].includes(kind) || (['txs', 'risk'].includes(kind) && !a)) { view.append(ui.errorBox(t('askUnknown'))); return; }
  const what = t(`askKind_${kind}`, { a: a ? short(a.hex, 8, 6) : '', w: win ? windowText(t, win) : t('askWholeScan') });
  view.append(h('h1', null, t('askTitle')), h('p', { class: 'ask-understood' }, t('askUnderstood'), ' ', h('strong', null, what)));
  if (kind === 'risk') {
    view.append(h('p', null, addrLink(a.hex, { full: true })));
    const acc = await chain.account(a);
    view.append(ui.riskSummary(a, acc), ui.quantumCard(a, acc));
    return;
  }
  const body = h('div', null, loading()); view.append(body);
  const st = await chain.status();
  const bt = await blockTime(chain, st);
  const w = windowBlocks(win, bt, cfg.maxScanBlocks);
  const n = w.whole ? cfg.scanBlocks : w.n;
  const r = await chain.recentTxs(st.height, n);
  const scope = note(t('askScope', { from: groupDigits(r.from), to: groupDigits(r.to), bt: bt.toFixed(1) }) + (w.capped ? ` ${t('askCapped', { max: groupDigits(cfg.maxScanBlocks) })}` : '') + (r.complete ? '' : ` ${t('scanIncomplete')}`), 'info');
  const parts = [];
  if (kind === 'failed' || kind === 'txs') {
    let list = r.txs;
    if (a) list = list.filter((x) => x.addresses?.has?.(a.lower) || anyAddressLower(x.from) === a.lower || anyAddressLower(x.to) === a.lower);
    if (kind === 'failed') list = list.filter((x) => x.ok === false);
    parts.push(card(null, txTable(list.slice(0, 100), { empty: t('askNothing') })));
  } else if (kind === 'largest') {
    const top = largestNative(r.txs);
    parts.push(card(t('askLargestNative'), table([t('txHash'), t('block'), t('fromTo'), t('value')], top.map((x) => [hashLink(x.hash), blockLink(x.height),
      h('span', { class: 'fromto' }, x.from ? addrLink(x.from) : '—', ' → ', x.to ? addrLink(x.to) : '—'), formatZtphy(x.value, { maxFrac: 4 })]), { empty: t('askNothing') })));
    parts.push(card(t('askLargestTokens'), slot(largestTokens(ui, Number(r.from), Number(r.to)), (x) => x)));
  } else if (kind === 'holders') {
    const addrs = seenAddresses(r.txs, 40);
    const bals = await Promise.all(addrs.map((x) => chain.evmCall('eth_getBalance', [x, 'latest']).then((v) => BigInt(v)).catch(() => null)));
    const rows = addrs.map((x, i) => ({ x, b: bals[i] })).filter((y) => y.b != null).sort((p1, p2) => (p2.b > p1.b ? 1 : p2.b < p1.b ? -1 : (p1.x < p2.x ? -1 : 1)));
    const total = rows.reduce((s, y) => s + y.b, 0n);
    parts.push(card(null, table(['#', t('address'), t('balance'), t('askShare')], rows.slice(0, 25).map((y, i) => [String(i + 1), addrLink(y.x), formatZtphy(y.b, { maxFrac: 2 }), percent(y.b, total || 1n)]), { empty: t('askNothing') }),
      note(t('askHoldersNote', { n: groupDigits(addrs.length) }), 'warn')));
  }
  body.replaceChildren(...parts, scope);
}

async function largestTokens(ui, from, to) {
  const { t, chain, table, hashLink, addrLink, routeLink } = ui;
  const logs = await chain.evmCall('eth_getLogs', [{ fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16), topics: [[TOPICS.transfer]] }]).catch(() => []);
  const trs = (Array.isArray(logs) ? logs : []).map((l) => ({ l, tr: decodeTransfer(l) })).filter((x) => x.tr?.standard === 'erc20' && !x.tr.mint && !x.tr.burn);
  const tokens = [...new Set(trs.map((x) => x.tr.token))].slice(0, 6);
  const infos = new Map(await Promise.all(tokens.map(async (k) => [k, await ui.tokenInfo(k).catch(() => ({}))])));
  const rows = [];
  for (const k of tokens) {
    const i = infos.get(k) ?? {};
    trs.filter((x) => x.tr.token === k).sort((p, q) => (q.tr.amount > p.tr.amount ? 1 : q.tr.amount < p.tr.amount ? -1 : 0)).slice(0, 5).forEach(({ l, tr }) => rows.push([
      routeLink(`token/${k}`, tokenText(i.symbol, 16, short(k, 6, 4))), hashLink(l.transactionHash),
      h('span', { class: 'fromto' }, addrLink(tr.from), ' → ', addrLink(tr.to)),
      i.decimals != null ? formatUnits(tr.amount, i.decimals, { maxFrac: 4 }) : groupDigits(tr.amount.toString())]));
  }
  return table([t('token'), t('txHash'), t('fromTo'), t('value')], rows, { empty: t('askNothing') });
}

/** Seconds per block, measured over the last ≤100 blocks (5 s when it cannot be read). */
async function blockTime(chain, st) {
  const H = Number(st.height); const back = Math.min(100, H - 1);
  if (back < 1) return 5;
  try {
    const b = await chain.block(H - back);
    const dt = (Date.parse(st.time) - Date.parse(b.block.header.time)) / 1000 / back;
    return Number.isFinite(dt) && dt > 0.05 ? dt : 5;
  } catch { return 5; }
}

function windowText(t, w) {
  if (w.b) return t('askWinBlocks', { n: groupDigits(w.b) });
  if (w.s % 86400 === 0) return t('askWinDays', { n: w.s / 86400 });
  if (w.s % 3600 === 0) return t('askWinHours', { n: w.s / 3600 });
  return t('askWinMinutes', { n: Math.max(1, Math.round(w.s / 60)) });
}
