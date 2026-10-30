// Token holders of an ERC-20 (#/token/<address>/holders), with no indexer:
//   1. read the token's Transfer logs over a recent window of blocks, in 500-block
//      eth_getLogs ranges (bounded: at most MAX_WINDOWS ranges), and add up each
//      address's net change in that window;
//   2. the addresses that gained the most are only candidates (older balances are not in
//      the window), so each candidate's balance is read live with balanceOf;
//   3. top holders, % of the total supply, top-10 concentration, a distribution bar, and a
//      warning when the owner (owner()) or the first mint's recipient holds most of it.
// The page always says from which block the window starts.
import { TTL } from './rpc.js';
import { TOPICS, SEL, decodeTransfer, decodeUint, callData, topicAddress } from './evm.js';
import { groupDigits, formatUnits, tokenText, toAddress } from './format.js';

export const RANGE = 500;
export const MAX_WINDOWS = 40; // 20,000 blocks
export const WINDOW_CHOICES = [1000, 5000, 20000];
export const MAX_CANDIDATES = 40;
const ZERO = '0x0000000000000000000000000000000000000000';

/** [lo, hi] ranges of at most `size` blocks covering [from, to], newest first. */
export function logWindows(from, to, size = RANGE) {
  const out = [];
  for (let hi = Number(to); hi >= Number(from); hi -= size) out.push([Math.max(Number(from), hi - size + 1), hi]);
  return out;
}

/**
 * Net change of every address over ERC-20 Transfer logs of `token`:
 * { net: Map(lower 0x -> BigInt), transfers, firstMint: { to, block } | null, minted, burned }.
 * Logs of another contract, ERC-721 / 1155 logs and malformed logs are ignored.
 */
export function rebuildBalances(logs, token) {
  const tk = String(token).toLowerCase();
  const net = new Map(); let transfers = 0; let firstMint = null; let minted = 0n; let burned = 0n;
  const add = (a, v) => net.set(a, (net.get(a) ?? 0n) + v);
  const sorted = [...logs].sort((a, b) => Number(BigInt(a.blockNumber ?? 0) - BigInt(b.blockNumber ?? 0)) || Number(BigInt(a.logIndex ?? 0) - BigInt(b.logIndex ?? 0)));
  const seen = new Set(); // overlapping ranges must not count a log twice
  for (const l of sorted) {
    if (String(l.address ?? '').toLowerCase() !== tk) continue;
    const key = `${l.transactionHash}:${l.logIndex}:${l.blockNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const tr = decodeTransfer(l);
    if (!tr || tr.standard !== 'erc20') continue;
    transfers++;
    const from = tr.from.toLowerCase(); const to = tr.to.toLowerCase();
    if (from !== ZERO) add(from, -tr.amount); else { minted += tr.amount; if (!firstMint) firstMint = { to, block: Number(BigInt(l.blockNumber ?? 0)) }; }
    if (to !== ZERO) add(to, tr.amount); else burned += tr.amount;
  }
  return { net, transfers, firstMint, minted, burned };
}

/** Candidates to confirm with balanceOf: addresses that ended the window up, the biggest gains first. */
export function pickCandidates(net, max = MAX_CANDIDATES, extra = []) {
  const up = [...net].filter(([a, v]) => v > 0n && a !== ZERO).sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0)).map(([a]) => a);
  const out = [];
  for (const a of [...extra.map((x) => String(x).toLowerCase()), ...up]) if (a && a !== ZERO && !out.includes(a)) out.push(a);
  return out.slice(0, max);
}

/**
 * Holders [{ address, balance }] sorted by balance -> { top: [{ address, balance, share }], top10Share, shownShare }
 * share: % of the supply (number, 2 decimals).
 */
export function distribution(holders, supply, n = 25) {
  const s = BigInt(supply ?? 0n);
  const share = (b) => (s > 0n ? Number((b * 10000n) / s) / 100 : 0);
  const sorted = holders.filter((x) => x.balance > 0n).sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : 0));
  const top = sorted.slice(0, n).map((x) => ({ ...x, share: share(x.balance) }));
  const sum = (k) => sorted.slice(0, k).reduce((m, x) => m + x.balance, 0n);
  return { top, top10Share: share(sum(10)), shownShare: share(sum(n)) };
}

/** Owner / deployer concentration flag: 'most' (>= 50 % of supply), 'top' (largest holder), or null. */
export function ownerFlag(dist, ownerLower) {
  if (!ownerLower) return null;
  const me = dist.top.find((x) => x.address === ownerLower);
  if (!me) return null;
  if (me.share >= 50) return 'most';
  if (dist.top[0]?.address === ownerLower) return 'top';
  return null;
}

/** Transfer logs of `token` in [from, to], 500 blocks per eth_getLogs (newest first). onProgress(done, total). */
export async function scanTransfers(evm, token, from, to, onProgress) {
  const ws = logWindows(from, to).slice(0, MAX_WINDOWS);
  const out = []; let done = 0;
  for (const [lo, hi] of ws) {
    const logs = await evm('eth_getLogs', [{ address: token, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16), topics: [TOPICS.transfer] }], TTL.minute);
    if (Array.isArray(logs)) out.push(...logs);
    onProgress?.(++done, ws.length);
  }
  return { logs: out, from: ws.length ? ws[ws.length - 1][0] : from, to };
}

// ---- the page ----

export async function pageHolders(c, view, tokenParam) {
  const { t, h, chain, api } = c;
  const a = toAddress(decodeURIComponent(tokenParam ?? ''));
  if (!a) { c.append(view, c.errorBox(t('badAddress'))); return; }
  const st = await chain.status();
  const info = await c.tokenInfo(a.hex);
  const name = `${tokenText(info.name, 40)} (${tokenText(info.symbol, 16)})`;
  c.append(view, [h('h1', null, t('holdTitle'), ': ', h('span', { class: 'token-name' }, name)), h('p', null, c.routeLink(`token/${a.hex}`, `← ${t('tokenPage')}`))]);
  if (info.standard !== 'erc20') { c.append(view, c.note(t('holdOnlyErc20'), 'warn'), info.standard === 'erc721' || info.standard === 'erc1155' ? c.routeLink(`nft/${a.hex}`, t('nftOpenGallery')) : null); return; }
  const latest = Number(st.height);
  const sel = h('select', { class: 'lang-select win-select', 'aria-label': t('holdWindow') }, ...WINDOW_CHOICES.map((n) => h('option', { value: String(n) }, t('vdLastN', { n: groupDigits(n) }))));
  sel.value = '5000';
  const body = h('div');
  const run = h('button', { type: 'button', on: { click: () => go(Number(sel.value)) } }, t('holdRun'));
  c.append(view, c.card(null, c.note(t('holdIntro', { n: RANGE, max: groupDigits(RANGE * MAX_WINDOWS) }), 'info'), h('div', { class: 'row' }, h('label', null, t('holdWindow'), ' ', sel), run), body));
  const fmt = (v) => (info.decimals != null ? formatUnits(v, info.decimals, { maxFrac: 4 }) : groupDigits(v.toString()));
  let token = 0;
  async function go(n) {
    const my = ++token;
    const prog = h('p', { class: 'loading', role: 'status' }, t('loading'));
    c.fill(body, prog);
    try {
      const from = Math.max(1, latest - n + 1);
      const scan = await scanTransfers(api.evm, a.hex, from, latest, (d, all) => { prog.textContent = t('holdScanning', { d, n: all }); });
      const rb = rebuildBalances(scan.logs, a.hex);
      let owner = null;
      try { owner = topicAddress(await chain.ethCall(a.hex, '0x' + SEL.owner))?.toLowerCase() ?? null; } catch { owner = null; }
      const deployer = rb.firstMint?.to ?? null;
      const cands = pickCandidates(rb.net, MAX_CANDIDATES, [owner, deployer].filter(Boolean));
      prog.textContent = t('holdConfirming', { n: cands.length });
      const holders = await Promise.all(cands.map(async (x) => {
        let bal = null;
        try { bal = decodeUint(await chain.ethCall(a.hex, callData.balanceOf(x))); } catch { bal = null; }
        return { address: x, balance: bal ?? 0n };
      }));
      if (my !== token) return;
      const supply = info.totalSupply ?? 0n;
      const dist = distribution(holders, supply, 25);
      const flagOwner = ownerFlag(dist, owner);
      const flagDeployer = deployer && deployer !== owner ? ownerFlag(dist, deployer) : null;
      const bar = h('div', { class: 'dist-bar', role: 'img', 'aria-label': t('holdTop10', { p: dist.top10Share.toFixed(2) }) });
      dist.top.slice(0, 10).forEach((x, i) => { const d = h('div', { class: `dist-seg dist-${i % 5}`, title: `${x.address} · ${x.share.toFixed(2)}%` }); d.style.width = `${Math.min(100, x.share)}%`; bar.append(d); });
      const tag = (x) => [x.address === owner ? c.badge(t('holdOwner'), 'warn') : null, x.address === deployer ? c.badge(t('holdFirstMint'), 'warn') : null];
      c.fill(body,
        c.note(t('holdFromBlock', { from: groupDigits(scan.from), to: groupDigits(scan.to), n: groupDigits(rb.transfers) }), 'info'),
        scan.from > from ? c.note(t('holdCapped', { max: groupDigits(RANGE * MAX_WINDOWS) }), 'warn') : null,
        flagOwner === 'most' || flagDeployer === 'most' ? c.note(t('holdOwnerMost', { who: flagOwner === 'most' ? t('holdOwner') : t('holdFirstMint') }), 'warn')
          : flagOwner === 'top' || flagDeployer === 'top' ? c.note(t('holdOwnerTop', { who: flagOwner === 'top' ? t('holdOwner') : t('holdFirstMint') }), 'warn') : null,
        c.kv([
          [t('totalSupply'), `${fmt(supply)} ${tokenText(info.symbol, 16)}`],
          [t('holdConcentration'), h('strong', { class: 'top10' }, `${dist.top10Share.toFixed(2)}%`)],
          [t('holdCandidates'), groupDigits(cands.length)],
          owner ? [t('holdOwner'), c.addrLink(owner)] : null,
        ]),
        bar,
        c.table(['#', t('address'), t('balance'), t('holdShare')], dist.top.map((x, i) => [String(i + 1), h('span', null, c.addrLink(x.address), ' ', tag(x)), fmt(x.balance), `${x.share.toFixed(2)}%`]), { empty: t('holdNone') }),
        c.note(t('holdNote')));
    } catch (e) { if (my === token) c.fill(body, c.errorBox(e)); }
  }
  go(Number(sel.value));
}
