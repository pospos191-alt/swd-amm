// Gas and fees (#/gas): the base fee of the next block, priority-fee suggestions
// (slow / normal / fast = the median of the 10th / 50th / 90th percentile tips of recent
// non-empty blocks, from eth_feeHistory), what common actions cost in ZETAPHY at those
// prices, and the base fee burned over the scanned blocks (base fee × gas used).
import { TTL } from './rpc.js';
import { toBig, formatUnits, formatZtphy, groupDigits } from './format.js';

export const PERCENTILES = [10, 50, 90];
export const SPEEDS = ['slow', 'normal', 'fast'];
export const WINDOWS = [20, 50, 100];
// Typical gas of common actions (approximate: real contracts vary).
export const ACTIONS = [
  ['gasActTransfer', 21000n], ['gasActErc20', 65000n], ['gasActSwap', 160000n], ['gasActNftMint', 120000n], ['gasActApprove', 46000n],
];

/** Median of BigInts (lower middle for an even count); null when empty. */
export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => (a > b ? 1 : a < b ? -1 : 0));
  return s[Math.floor((s.length - 1) / 2)];
}

/**
 * eth_feeHistory answer -> { baseFee (next block's), oldest, blocks: [{ number, baseFee, ratio, rewards }], slow, normal, fast }
 * Each speed: { tip, maxFee (2 × base fee + tip, what wallets set), price (base fee + tip, what is paid now) }.
 * Empty blocks (gas used 0) are left out of the tip median; with none left, `fallbackTip` is used.
 */
export function feeSuggestions(hist, fallbackTip = 0n) {
  const bases = (hist?.baseFeePerGas ?? []).map((x) => toBig(x) ?? 0n);
  const ratios = (hist?.gasUsedRatio ?? []).map(Number);
  const rewards = (hist?.reward ?? []).map((r) => (Array.isArray(r) ? r.map((x) => toBig(x) ?? 0n) : []));
  const oldest = Number(toBig(hist?.oldestBlock) ?? 0n);
  const blocks = ratios.map((ratio, i) => ({ number: oldest + i, baseFee: bases[i] ?? 0n, ratio, rewards: rewards[i] ?? [] }));
  const baseFee = bases.length ? bases[bases.length - 1] : 0n;
  const out = { baseFee, oldest, blocks };
  SPEEDS.forEach((sp, k) => {
    const tips = blocks.filter((b) => b.ratio > 0 && b.rewards[k] != null).map((b) => b.rewards[k]);
    const tip = median(tips) ?? BigInt(fallbackTip);
    out[sp] = { tip, maxFee: 2n * baseFee + tip, price: baseFee + tip };
  });
  return out;
}

/** Base fee burned over the history: Σ baseFee × (gasUsedRatio × gasLimit), in azetaphy (an estimate when the limit is assumed constant). */
export function burnedEstimate(hist, gasLimit) {
  const lim = BigInt(gasLimit ?? 0n);
  const bases = (hist?.baseFeePerGas ?? []).map((x) => toBig(x) ?? 0n);
  let sum = 0n;
  (hist?.gasUsedRatio ?? []).forEach((r, i) => {
    const ppm = BigInt(Math.max(0, Math.round(Number(r) * 1e6)));
    sum += ((bases[i] ?? 0n) * lim * ppm) / 1000000n;
  });
  return sum;
}

/** Cost of each common action at a gas price (azetaphy per gas): [{ key, gas, cost }]. */
export const actionCosts = (price) => ACTIONS.map(([key, gas]) => ({ key, gas, cost: gas * BigInt(price) }));

export const gwei = (wei) => `${formatUnits(wei, 9, { maxFrac: 4 })} gwei`;

export async function pageGas(c, view) {
  const { t, h, api } = c;
  const sel = h('select', { class: 'lang-select win-select', 'aria-label': t('gasWindow') }, ...WINDOWS.map((n) => h('option', { value: String(n) }, t('vdLastN', { n }))));
  sel.value = '20';
  const body = h('div', null, c.loading());
  c.append(view, h('h1', null, t('gasTitle')), c.card(null, h('div', { class: 'row' }, h('label', null, t('gasWindow'), ' ', sel)), body));
  async function load(n) {
    c.fill(body, c.loading());
    try {
      const [hist, tipNow, latestBlock, price] = await Promise.all([
        api.evm('eth_feeHistory', ['0x' + n.toString(16), 'latest', PERCENTILES], TTL.latest),
        api.evm('eth_maxPriorityFeePerGas', [], TTL.latest).then(toBig).catch(() => null),
        api.evm('eth_getBlockByNumber', ['latest', false], TTL.latest).catch(() => null),
        api.evm('eth_gasPrice', [], TTL.latest).then(toBig).catch(() => null),
      ]);
      const f = feeSuggestions(hist, tipNow ?? 0n);
      const gasLimit = toBig(latestBlock?.gasLimit) ?? 0n;
      const burned = burnedEstimate(hist, gasLimit);
      const last = f.blocks.length ? f.blocks[f.blocks.length - 1].number : 0;
      const speedCard = (sp) => h('div', { class: `stat gas-${sp}` }, h('div', { class: 'stat-label' }, t(`gas_${sp}`)),
        h('div', { class: 'stat-value' }, gwei(f[sp].price)), h('div', { class: 'stat-sub' }, `${t('gasTip')} ${gwei(f[sp].tip)} · ${t('gasMaxFee')} ${gwei(f[sp].maxFee)}`));
      c.fill(body,
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'stat-label' }, t('gasBaseFee')), h('div', { class: 'stat-value gas-base' }, gwei(f.baseFee)),
            h('div', { class: 'stat-sub' }, price != null ? `${t('gasNodePrice')} ${gwei(price)}` : '')),
          ...SPEEDS.map(speedCard)),
        h('h2', null, t('gasCostsTitle')),
        c.table([t('gasAction'), t('gasUnits'), ...SPEEDS.map((sp) => t(`gas_${sp}`))], ACTIONS.map(([key, gas]) => [
          t(key), groupDigits(gas.toString()), ...SPEEDS.map((sp) => formatZtphy(gas * f[sp].price, { maxFrac: 8 })),
        ])),
        c.note(t('gasCostsNote')),
        h('h2', null, t('gasBurnTitle')),
        c.kv([
          [t('gasBurned'), h('strong', { class: 'gas-burned' }, formatZtphy(burned, { maxFrac: 8 }))],
          [t('gasRange'), f.blocks.length ? h('span', null, c.blockLink(String(f.oldest)), ' – ', c.blockLink(String(last))) : '—'],
          [t('gasLimit'), gasLimit ? groupDigits(gasLimit.toString()) : '—'],
          [t('gasAvgUsed'), f.blocks.length ? `${(f.blocks.reduce((s, b) => s + b.ratio, 0) / f.blocks.length * 100).toFixed(2)}%` : '—'],
        ]),
        c.note(t('gasBurnNote')),
        h('details', null, h('summary', null, t('gasPerBlock')), c.table([t('block'), t('gasBaseFee'), t('gasUsedPct'), ...PERCENTILES.map((p) => `p${p}`)],
          [...f.blocks].reverse().map((b) => [c.blockLink(String(b.number)), gwei(b.baseFee), `${(b.ratio * 100).toFixed(1)}%`, ...PERCENTILES.map((_, k) => (b.rewards[k] != null ? gwei(b.rewards[k]) : '—'))]))),
      );
    } catch (e) { c.fill(body, c.errorBox(e), c.note(t('gasUnavailable'))); }
  }
  sel.addEventListener('change', () => load(Number(sel.value)));
  await load(20);
}
