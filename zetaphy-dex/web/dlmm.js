// The DLMM tab of the DEX page (UNAUDITED contracts, testnet only): pick a
// pair and bin step, see the bins around the price, add liquidity over a
// range (spot / curve / bid-ask), remove it, and swap through the DLMM
// router. Uses the page's own wallet, RPC, Neuro checks and transaction flow
// (passed in by app.js); every text goes in with textContent. The DLMM
// contracts come from deployments.json (contracts.dlmmFactory,
// contracts.dlmmRouter); without them the tab says so and does nothing.

import { encodeDlmmCall, decodeWords, dlmmErrorName, displayPrice, idFromPrice, distribute, minAfter } from './lib/dlmm.js';
import { parseUnits, formatUnits, isAddress, ZERO_ADDRESS } from './lib/abi.js';

const TEXT = {
  th: {
    title: 'DLMM · สภาพคล่องแบบแบ่งช่องราคา', unaudited: '⚠️ ส่วนนี้ใหม่และยังไม่ผ่านการตรวจสอบความปลอดภัย (UNAUDITED) ใช้บน testnet เท่านั้น',
    notDeployed: 'ยังไม่ได้ deploy DLMM บนเครือข่ายนี้', pair: 'คู่เหรียญ', binStep: 'bin step', load: 'โหลด',
    noPair: 'ยังไม่มีพูลนี้: การเพิ่มสภาพคล่องครั้งแรกจะสร้างพูลที่ราคาเริ่มต้นที่คุณกำหนด', empty: 'พูลยังว่าง: ผู้ฝากรายแรกกำหนดราคา',
    active: 'active bin {id} · ราคา 1 {x} = {p} {y}', fee: 'ค่าธรรมเนียมพื้นฐาน {f}% (+ค่าตามความผันผวน)', reserves: 'ในพูล: {x} · {y}',
    addTitle: 'เพิ่มสภาพคล่อง', below: 'จำนวน bin ใต้ราคา', above: 'จำนวน bin เหนือราคา', shape: 'รูปแบบ', spot: 'Spot (เท่ากัน)', curve: 'Curve (กระจุกใกล้ราคา)', bidask: 'Bid-Ask (ห่างราคามากขึ้น)',
    startPrice: 'ราคาเริ่มต้น ({y} ต่อ 1 {x})', approve: 'อนุญาต {sym}', add: 'เพิ่มสภาพคล่อง', adding: 'กำลังเพิ่มสภาพคล่อง…',
    preview: '{n} bin · ใช้ {x} + {y}', posTitle: 'สภาพคล่อง DLMM ของฉัน (พูลนี้)', noPos: 'ยังไม่มีสภาพคล่องในพูลนี้', connect: 'เชื่อมกระเป๋าเพื่อดู',
    posLine: '{n} bin ({lo} … {hi}) · ถอนได้ประมาณ {x} + {y}', remove: 'ถอน {p}%', removing: 'กำลังถอน…', approveRouter: 'อนุญาตให้ router ถอนหุ้นของคุณในพูลนี้ (setApprovalForAll)…',
    revoke: 'ยกเลิกสิทธิ์ router', swapTitle: 'แลกเปลี่ยนผ่าน DLMM', amountIn: 'จำนวนที่จ่าย', quote: 'ได้รับประมาณ {out} {sym} · ขั้นต่ำ {min}', swap: 'แลกเปลี่ยน', swapping: 'กำลังแลกเปลี่ยน…',
    enforced: 'ปฏิเสธ: ธงของ Neuro สำหรับ {sym} มีผลบังคับ', ack: 'ฉันอ่านคำเตือนของ Neuro แล้ว', needAck: 'ติ๊กยืนยันคำเตือนของ Neuro ก่อน', badAmount: 'จำนวนไม่ถูกต้อง',
    tooWide: 'ช่วงกว้างได้ไม่เกิน 100 bin', chart: 'bin รอบราคา (ฟ้า = {x}, ม่วง = {y})', failed: 'ไม่สำเร็จ: {msg}',
    err_IdSlippage: 'ราคาเลื่อนไปหลาย bin เกินที่ยอมรับ ลองใหม่', err_InsufficientXAmount: 'ราคาเปลี่ยน: เหรียญ X ที่ใช้น้อยกว่าขั้นต่ำ', err_InsufficientYAmount: 'ราคาเปลี่ยน: เหรียญ Y ที่ใช้น้อยกว่าขั้นต่ำ',
    err_ZeroShares: 'จำนวนใน bin หนึ่งน้อยเกินไป (หรือ active bin ต้องการทั้งสองเหรียญตามสัดส่วน)', err_SingleSidedViolation: 'bin เหนือราคารับได้แค่ X, ใต้ราคารับได้แค่ Y',
    err_OutOfLiquidity: 'สภาพคล่องไม่พอสำหรับจำนวนนี้', err_TooManyBinsCrossed: 'ต้องข้ามมากกว่า 100 bin: แบ่งเป็นหลายครั้ง', err_FeeOnTransferNotSupported: 'DLMM ไม่รองรับเหรียญที่หักค่าธรรมเนียมเมื่อโอน',
    err_NotApproved: 'ยังไม่ได้อนุญาตให้ router ถอนหุ้น', err_InsufficientShares: 'หุ้นไม่พอ', err_PriceOutOfRange: 'ราคานี้อยู่นอกช่วงที่รองรับ', err_PresetNotEnabled: 'bin step นี้ยังไม่เปิดใช้',
    err_InsufficientOutputAmount: 'ราคาเปลี่ยนเกินกว่าที่ยอมรับ ลองใหม่', err_Expired: 'หมดเวลาธุรกรรมแล้ว ลองใหม่', err_ZeroAmount: 'จำนวนเป็นศูนย์', err_BalanceBelowReserves: 'ยอดเหรียญของพูลลดลงเอง (เหรียญ rebase): ไม่รองรับ',
  },
  en: {
    title: 'DLMM · binned liquidity', unaudited: '⚠️ New and UNAUDITED. Testnet only.',
    notDeployed: 'DLMM is not deployed on this network yet', pair: 'Pair', binStep: 'bin step', load: 'Load',
    noPair: 'No such pool yet: the first deposit creates it at the starting price you set', empty: 'The pool is empty: the first depositor sets the price',
    active: 'active bin {id} · price 1 {x} = {p} {y}', fee: 'base fee {f}% (+ volatility fee)', reserves: 'In the pool: {x} · {y}',
    addTitle: 'Add liquidity', below: 'bins below the price', above: 'bins above the price', shape: 'Shape', spot: 'Spot (flat)', curve: 'Curve (near the price)', bidask: 'Bid-Ask (away from the price)',
    startPrice: 'Starting price ({y} per 1 {x})', approve: 'Approve {sym}', add: 'Add liquidity', adding: 'Adding liquidity…',
    preview: '{n} bins · uses {x} + {y}', posTitle: 'My DLMM liquidity (this pool)', noPos: 'No liquidity in this pool yet', connect: 'Connect a wallet to see it',
    posLine: '{n} bins ({lo} … {hi}) · about {x} + {y} to withdraw', remove: 'Remove {p}%', removing: 'Removing…', approveRouter: 'Allowing the router to burn your shares in this pool (setApprovalForAll)…',
    revoke: 'Revoke the router', swapTitle: 'Swap through the DLMM', amountIn: 'You pay', quote: 'About {out} {sym} · minimum {min}', swap: 'Swap', swapping: 'Swapping…',
    enforced: 'Refused: Neuro\'s flag on {sym} is enforced', ack: 'I have read Neuro\'s warning', needAck: 'Tick the Neuro acknowledgement first', badAmount: 'Invalid amount',
    tooWide: 'At most 100 bins', chart: 'bins around the price (blue = {x}, purple = {y})', failed: 'Failed: {msg}',
    err_IdSlippage: 'The price moved more bins than allowed. Try again.', err_InsufficientXAmount: 'The price moved: X used below the minimum', err_InsufficientYAmount: 'The price moved: Y used below the minimum',
    err_ZeroShares: 'An amount is too small for a bin (or the active bin needs both tokens in its ratio)', err_SingleSidedViolation: 'Bins above the price take only X, below only Y',
    err_OutOfLiquidity: 'Not enough liquidity for this amount', err_TooManyBinsCrossed: 'More than 100 bins to cross: split the trade', err_FeeOnTransferNotSupported: 'The DLMM does not support fee-on-transfer tokens',
    err_NotApproved: 'The router is not allowed to burn your shares yet', err_InsufficientShares: 'Not enough shares', err_PriceOutOfRange: 'That price is outside the supported range', err_PresetNotEnabled: 'That bin step is not enabled',
    err_InsufficientOutputAmount: 'The price moved more than your slippage allows. Try again.', err_Expired: 'The transaction deadline passed. Try again.', err_ZeroAmount: 'Zero amount', err_BalanceBelowReserves: 'The pool\'s token balance shrank on its own (rebasing token): not supported',
  },
};
const CHART_BINS = 20;
const MAX_SCAN = 200;
const MIN_ID = -(1 << 23) + 1;

/** @param ctx  helpers from app.js (state, $, el, setStatus, rpc, sendTx, errorText, revertData, neuroFresh, renderNeuro, needsAck, balanceOf, allowance, isNative, keyOf, tokenByKey, tokenByAddress, NATIVE, deadline, openWallets) */
export function createDlmmTab(ctx) {
  const { state, $, el } = ctx;
  const tt = (k, v = {}) => (TEXT[state.lang]?.[k] ?? TEXT.en[k] ?? k).replace(/\{(\w+)\}/g, (_, x) => String(v[x] ?? ''));
  const c = () => state.cfg?.contracts ?? {};
  const deployedDlmm = () => isAddress(c().dlmmFactory ?? '') && isAddress(c().dlmmRouter ?? '');
  const call = async (to, sig, types, values, out) => decodeWords(out, await ctx.rpc('eth_call', [{ to, data: encodeDlmmCall(sig, types, values) }, 'latest']));
  const fmt = (v, d) => formatUnits(v, d, 6);
  const errText = (e) => {
    const name = dlmmErrorName(ctx.revertData(e));
    return name && name !== 'TokenEnforced' && name !== 'RegistryUnavailable' && TEXT.en[`err_${name}`] ? tt(`err_${name}`) : ctx.errorText(e);
  };
  let built = false;
  let builtLang = null;
  let info = null; // the loaded pair
  let seq = 0;

  // ------------------------------------------------------------ DOM

  function build() {
    const root = $('dlmm-root');
    const tokOpts = () => state.tokens.map((x) => el('option', { value: ctx.keyOf(x), text: `${x.symbol} · ${x.name}` }));
    const sel = (id, opts) => el('select', { id }, ...opts);
    const num = (id, val) => el('input', { id, inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', value: val ?? '', placeholder: '0.0' });
    root.replaceChildren(
      el('div', { class: 'card' },
        el('h2', { text: tt('title') }),
        el('p', { class: 'warn-line', text: tt('unaudited') }),
        el('p', { class: 'hint', id: 'dl-deployed', text: deployedDlmm() ? '' : tt('notDeployed') }),
        el('div', { class: 'row' }, sel('dl-a', tokOpts()), sel('dl-b', tokOpts()), el('label', { class: 'hint', for: 'dl-step', text: tt('binStep') }), sel('dl-step', []),
          el('button', { type: 'button', class: 'ghost small', id: 'dl-load', text: tt('load') })),
        el('p', { class: 'hint', id: 'dl-info' }),
        el('p', { class: 'hint', id: 'dl-chart-label' }),
        el('div', { class: 'dl-chart', id: 'dl-chart' })),
      el('div', { class: 'card' },
        el('h2', { text: tt('addTitle') }),
        el('div', { class: 'field' }, el('div', { class: 'field-top' }, el('label', { for: 'dl-amt-x', id: 'dl-lbl-x', text: 'X' }), el('span', { class: 'hint', id: 'dl-bal-x' })), el('div', { class: 'row' }, num('dl-amt-x'))),
        el('div', { class: 'field' }, el('div', { class: 'field-top' }, el('label', { for: 'dl-amt-y', id: 'dl-lbl-y', text: 'Y' }), el('span', { class: 'hint', id: 'dl-bal-y' })), el('div', { class: 'row' }, num('dl-amt-y'))),
        el('div', { class: 'row' },
          el('label', { class: 'hint', for: 'dl-below', text: tt('below') }), num('dl-below', '10'),
          el('label', { class: 'hint', for: 'dl-above', text: tt('above') }), num('dl-above', '10')),
        el('div', { class: 'row' }, el('label', { class: 'hint', for: 'dl-shape', text: tt('shape') }),
          sel('dl-shape', ['spot', 'curve', 'bidask'].map((s) => el('option', { value: s, text: tt(s) })))),
        el('div', { class: 'field', id: 'dl-start-row', hidden: '' }, el('div', { class: 'field-top' }, el('label', { for: 'dl-start', id: 'dl-start-lbl' })), el('div', { class: 'row' }, num('dl-start'))),
        el('p', { class: 'hint', id: 'dl-preview' }),
        el('div', { class: 'neuro', id: 'dl-add-neuro', hidden: '' }),
        el('label', { class: 'ack', id: 'dl-add-ack-row', hidden: '' }, el('input', { type: 'checkbox', id: 'dl-add-ack', autocomplete: 'off' }), el('span', { text: tt('ack') })),
        el('div', { class: 'actions' },
          el('button', { type: 'button', id: 'dl-approve-x', hidden: '' }), el('button', { type: 'button', id: 'dl-approve-y', hidden: '' }),
          el('button', { type: 'button', class: 'primary', id: 'dl-add', text: tt('add') })),
        el('p', { class: 'status', id: 'dl-add-status', role: 'status' })),
      el('div', { class: 'card' },
        el('h2', { text: tt('posTitle') }),
        el('div', { class: 'list', id: 'dl-positions' }),
        el('p', { class: 'status', id: 'dl-pos-status', role: 'status' })),
      el('div', { class: 'card' },
        el('h2', { text: tt('swapTitle') }),
        el('div', { class: 'field' }, el('div', { class: 'field-top' }, el('label', { for: 'dl-swap-amt', text: tt('amountIn') })),
          el('div', { class: 'row' }, num('dl-swap-amt'), sel('dl-swap-dir', []))),
        el('p', { class: 'hint', id: 'dl-swap-quote' }),
        el('div', { class: 'neuro', id: 'dl-swap-neuro', hidden: '' }),
        el('label', { class: 'ack', id: 'dl-swap-ack-row', hidden: '' }, el('input', { type: 'checkbox', id: 'dl-swap-ack', autocomplete: 'off' }), el('span', { text: tt('ack') })),
        el('div', { class: 'actions' }, el('button', { type: 'button', id: 'dl-swap-approve', hidden: '' }), el('button', { type: 'button', class: 'primary', id: 'dl-swap', text: tt('swap') })),
        el('p', { class: 'status', id: 'dl-swap-status', role: 'status' })),
    );
    if (state.tokens[1]) $('dl-b').value = ctx.keyOf(state.tokens[1]);
    $('dl-load').addEventListener('click', loadPair);
    for (const id of ['dl-a', 'dl-b', 'dl-step']) $(id).addEventListener('change', loadPair);
    for (const id of ['dl-amt-x', 'dl-amt-y', 'dl-below', 'dl-above', 'dl-shape', 'dl-start']) $(id).addEventListener('input', () => { previewAdd().catch(() => {}); });
    $('dl-add').addEventListener('click', onAdd);
    $('dl-swap-amt').addEventListener('input', () => { quoteSwap().catch(() => {}); });
    $('dl-swap-dir').addEventListener('change', () => { quoteSwap().catch(() => {}); });
    $('dl-swap').addEventListener('click', onSwap);
    built = true;
    builtLang = state.lang;
  }

  // ------------------------------------------------------------ pair

  const tokAddr = (tok) => (ctx.isNative(tok) ? c().wnative : tok.address);
  const asTok = (addr) => ctx.tokenByAddress(addr) ?? { address: addr, symbol: addr.slice(0, 8), name: '?', decimals: 18, source: 'unlisted' };

  async function loadSteps() {
    let steps = [];
    try { [steps] = await call(c().dlmmFactory, 'presetSteps()', [], [], ['uint16[]']); } catch { steps = []; }
    const s = $('dl-step');
    const prev = s.value;
    s.replaceChildren(...steps.map(Number).sort((a, b) => a - b).map((v) => el('option', { value: String(v), text: `${v} bps` })));
    if (prev && [...s.options].some((o) => o.value === prev)) s.value = prev;
  }

  async function loadPair() {
    const my = ++seq;
    info = null;
    $('dl-chart').replaceChildren();
    if (!deployedDlmm()) return;
    try {
      if (!$('dl-step').options.length) await loadSteps();
      const a = ctx.tokenByKey($('dl-a').value);
      const b = ctx.tokenByKey($('dl-b').value);
      const step = Number($('dl-step').value);
      if (!a || !b || !step || tokAddr(a).toLowerCase() === tokAddr(b).toLowerCase()) { $('dl-info').textContent = ''; return; }
      const [xa, ya] = BigInt(tokAddr(a)) < BigInt(tokAddr(b)) ? [a, b] : [b, a];
      const [pair] = await call(c().dlmmFactory, 'getPair(address,address,uint16)', ['address', 'address', 'uint16'], [tokAddr(xa), tokAddr(ya), step], ['address']);
      const p = { tokX: xa, tokY: ya, step, pair: pair === ZERO_ADDRESS ? null : pair, active: 0, rx: 0n, ry: 0n, fee: 0n };
      if (p.pair) {
        const [[act], [rx], [ry], [fee]] = await Promise.all([
          call(p.pair, 'getActiveId()', [], [], ['int24']), call(p.pair, 'reserveX()', [], [], ['uint128']),
          call(p.pair, 'reserveY()', [], [], ['uint128']), call(p.pair, 'baseFeeBps()', [], [], ['uint16'])]);
        Object.assign(p, { active: Number(act), rx, ry, fee });
      }
      if (my !== seq) return;
      info = p;
      $('dl-lbl-x').textContent = `${xa.symbol} (X)`;
      $('dl-lbl-y').textContent = `${ya.symbol} (Y)`;
      $('dl-start-lbl').textContent = tt('startPrice', { x: xa.symbol, y: ya.symbol });
      const empty = !p.pair || (p.rx === 0n && p.ry === 0n);
      $('dl-start-row').hidden = !empty;
      const lines = [];
      if (!p.pair) lines.push(tt('noPair'));
      else {
        if (empty) lines.push(tt('empty'));
        lines.push(tt('active', { id: p.active, x: xa.symbol, y: ya.symbol, p: displayPrice(p.active, step, xa.decimals, ya.decimals).toPrecision(6) }));
        lines.push(tt('fee', { f: (Number(p.fee) / 100).toString() }));
        lines.push(tt('reserves', { x: `${fmt(p.rx, xa.decimals)} ${xa.symbol}`, y: `${fmt(p.ry, ya.decimals)} ${ya.symbol}` }));
      }
      $('dl-info').textContent = lines.join(' · ');
      $('dl-swap-dir').replaceChildren(el('option', { value: 'xy', text: `${xa.symbol} → ${ya.symbol}` }), el('option', { value: 'yx', text: `${ya.symbol} → ${xa.symbol}` }));
      if (p.pair && !empty) await drawChart(p, my);
      await Promise.all([loadPositions(my), previewAdd(), quoteSwap()]);
    } catch (e) { $('dl-info').textContent = tt('failed', { msg: errText(e) }); }
  }

  async function drawChart(p, my) {
    const ids = Array.from({ length: 2 * CHART_BINS + 1 }, (_, i) => p.active - CHART_BINS + i);
    const bins = await Promise.all(ids.map((id) => call(p.pair, 'getBin(int24)', ['int24'], [id], ['uint128', 'uint128'])));
    if (my !== seq) return;
    // Value of each bin in Y at its own price, for the bar heights (display only).
    const vals = bins.map(([x, y], i) => Number(x) * displayPrice(ids[i], p.step, 0, 0) + Number(y));
    const max = Math.max(...vals, 1e-30);
    $('dl-chart-label').textContent = tt('chart', { x: p.tokX.symbol, y: p.tokY.symbol });
    $('dl-chart').replaceChildren(...bins.map(([x, y], i) => {
      const bar = el('div', { class: `dl-bar${ids[i] === p.active ? ' active' : ''}${x > 0n && y === 0n ? ' x' : ''}${y > 0n && x === 0n ? ' y' : ''}`, title: `bin ${ids[i]}: ${fmt(x, p.tokX.decimals)} ${p.tokX.symbol} · ${fmt(y, p.tokY.decimals)} ${p.tokY.symbol}` });
      bar.style.height = `${Math.max(2, Math.round((vals[i] / max) * 100))}%`; // CSSOM, allowed by the CSP
      return bar;
    }));
  }

  // ------------------------------------------------------------ add

  function readAmount(id, dec) {
    const v = $(id).value.trim();
    if (!v) return 0n;
    return parseUnits(v, dec);
  }

  async function plan() {
    if (!info) return null;
    const below = Number($('dl-below').value || 0);
    const above = Number($('dl-above').value || 0);
    if (!Number.isInteger(below) || !Number.isInteger(above) || below < 0 || above < 0) throw new Error(tt('badAmount'));
    if (below + above + 1 > 100) throw new Error(tt('tooWide'));
    const totalX = readAmount('dl-amt-x', info.tokX.decimals);
    const totalY = readAmount('dl-amt-y', info.tokY.decimals);
    const empty = !info.pair || (info.rx === 0n && info.ry === 0n);
    let activeId = info.active;
    if (empty) {
      const price = Number($('dl-start').value);
      if (!(price > 0)) return null;
      activeId = idFromPrice(price, info.step, info.tokX.decimals, info.tokY.decimals);
    }
    let ratio = { x: 0n, y: 0n };
    if (!empty) {
      const [x, y] = await call(info.pair, 'getBin(int24)', ['int24'], [activeId], ['uint128', 'uint128']);
      ratio = { x, y };
    }
    const d = distribute({ below, above, totalX, totalY, shape: $('dl-shape').value, activeRatio: ratio });
    if (!d.deltas.length) return null;
    const sumX = d.ax.reduce((s, v) => s + v, 0n);
    const sumY = d.ay.reduce((s, v) => s + v, 0n);
    return { ...d, activeId, sumX, sumY, empty };
  }

  async function previewAdd() {
    const box = $('dl-preview');
    $('dl-approve-x').hidden = true;
    $('dl-approve-y').hidden = true;
    try {
      const p = await plan();
      if (!p) { box.textContent = ''; return; }
      box.textContent = tt('preview', { n: p.deltas.length, x: `${fmt(p.sumX, info.tokX.decimals)} ${info.tokX.symbol}`, y: `${fmt(p.sumY, info.tokY.decimals)} ${info.tokY.symbol}` });
      await neuroBox([info.tokX, info.tokY], 'dl-add-neuro', 'dl-add-ack-row');
      if (state.account) {
        for (const [tok, amt, btn] of [[info.tokX, p.sumX, 'dl-approve-x'], [info.tokY, p.sumY, 'dl-approve-y']]) {
          if (ctx.isNative(tok) || amt === 0n) continue;
          const al = await ctx.allowance(tok.address, state.account, c().dlmmRouter);
          if (al < amt) {
            const b = $(btn);
            b.hidden = false;
            b.textContent = tt('approve', { sym: tok.symbol });
            b.onclick = () => approve(tok, amt, 'dl-add-status').then(previewAdd);
          }
        }
      }
    } catch (e) { box.textContent = String(e?.message ?? e); }
  }

  async function approve(tok, amount, statusId) {
    try {
      await ctx.sendTx({ to: tok.address, data: encodeDlmmCall('approve(address,uint256)', ['address', 'uint256'], [c().dlmmRouter, amount]) }, statusId);
    } catch (e) { ctx.setStatus(statusId, tt('failed', { msg: errText(e) }), 'err'); }
  }

  /** Shows Neuro's answer for the riskiest token; throws if one is enforced or needs a tick. Returns whether a tick is needed. */
  async function neuroBox(tokens, boxId, ackRowId) {
    let worst = null;
    for (const tok of tokens) {
      if (ctx.isNative(tok)) continue;
      const r = await ctx.neuroCheck(tok.address);
      const rank = { enforced: 4, flagged: 3, unknown: 2, clear: 1, nocode: 0 };
      if (!worst || (rank[r.status] ?? 0) > (rank[worst.result.status] ?? 0)) worst = { result: r, token: tok };
    }
    ctx.renderNeuro($(boxId), worst);
    const need = !!worst && ctx.needsAck(worst.result);
    $(ackRowId).hidden = !need;
    return { worst, need };
  }

  async function onAdd() {
    if (!state.account) { ctx.openWallets(); return; }
    const st = 'dl-add-status';
    ctx.setStatus(st, tt('adding'));
    try {
      const p = await plan();
      if (!p) throw new Error(tt('badAmount'));
      const ackNeeded = (await neuroBox([info.tokX, info.tokY], 'dl-add-neuro', 'dl-add-ack-row')).need;
      if (ackNeeded && !$('dl-add-ack').checked) throw new Error(tt('needAck'));
      await ctx.recheckNeuro([info.tokX, info.tokY], ackNeeded && $('dl-add-ack').checked);
      const bps = state.settings.slippageBps;
      const idSlip = Math.max(1, Math.ceil(bps / info.step));
      const params = [tokAddr(info.tokX), tokAddr(info.tokY), info.step, p.activeId, idSlip, p.deltas, p.ax, p.ay, minAfter(p.sumX, bps), minAfter(p.sumY, bps), state.account, ctx.deadline()];
      const T = [['address', 'address', 'uint16', 'int24', 'uint24', 'int24[]', 'uint256[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256']];
      const nativeX = ctx.isNative(info.tokX);
      const nativeY = ctx.isNative(info.tokY);
      const tx = nativeX || nativeY
        ? { to: c().dlmmRouter, value: nativeX ? p.sumX : p.sumY, data: encodeDlmmCall('addLiquidityNATIVE((address,address,uint16,int24,uint24,int24[],uint256[],uint256[],uint256,uint256,address,uint256))', T, [params]) }
        : { to: c().dlmmRouter, data: encodeDlmmCall('addLiquidity((address,address,uint16,int24,uint24,int24[],uint256[],uint256[],uint256,uint256,address,uint256))', T, [params]) };
      ctx.setStatus(st, tt('adding'));
      $('dl-add').disabled = true;
      await ctx.sendTx(tx, st);
      $('dl-amt-x').value = '';
      $('dl-amt-y').value = '';
    } catch (e) { ctx.setStatus(st, tt('failed', { msg: errText(e) }), 'err'); }
    $('dl-add').disabled = false;
    $('dl-add-ack').checked = false;
    await loadPair();
  }

  // ------------------------------------------------------------ positions

  async function myBins(p) {
    const out = [];
    let [id, found] = await call(p.pair, 'getNextNonEmptyBin(bool,int24)', ['bool', 'int24'], [false, MIN_ID - 1], ['int24', 'bool']);
    while (found && out.length < MAX_SCAN) {
      const [[sh], [sup], [x, y]] = await Promise.all([
        call(p.pair, 'balanceOf(address,int24)', ['address', 'int24'], [state.account, id], ['uint256']),
        call(p.pair, 'totalSupply(int24)', ['int24'], [id], ['uint256']),
        call(p.pair, 'getBin(int24)', ['int24'], [id], ['uint128', 'uint128'])]);
      if (sh > 0n) out.push({ id: Number(id), sh, sup, x, y });
      [id, found] = await call(p.pair, 'getNextNonEmptyBin(bool,int24)', ['bool', 'int24'], [false, id], ['int24', 'bool']);
    }
    return out;
  }

  async function loadPositions(my) {
    const box = $('dl-positions');
    if (!info?.pair) { box.replaceChildren(); return; }
    if (!state.account) { box.replaceChildren(el('p', { class: 'hint', text: tt('connect') })); return; }
    const bins = await myBins(info);
    if (my !== seq) return;
    if (!bins.length) { box.replaceChildren(el('p', { class: 'hint', text: tt('noPos') })); return; }
    const ux = bins.reduce((s, b) => s + (b.x * b.sh) / b.sup, 0n);
    const uy = bins.reduce((s, b) => s + (b.y * b.sh) / b.sup, 0n);
    const main = el('div', { class: 'main' }, el('span', { class: 'sym', text: `${info.tokX.symbol} / ${info.tokY.symbol} · ${info.step} bps` }),
      el('span', { class: 'sub', text: tt('posLine', { n: bins.length, lo: bins[0].id, hi: bins[bins.length - 1].id, x: `${fmt(ux, info.tokX.decimals)} ${info.tokX.symbol}`, y: `${fmt(uy, info.tokY.decimals)} ${info.tokY.symbol}` }) }));
    const btns = el('div', { class: 'btns' },
      ...[25, 50, 100].map((pct) => el('button', { type: 'button', class: 'ghost small', text: tt('remove', { p: pct }), dataset: { dlRemove: String(pct) }, onclick: (ev) => onRemove(bins, pct, ev.currentTarget) })),
      el('button', { type: 'button', class: 'ghost small', text: tt('revoke'), onclick: onRevoke }));
    box.replaceChildren(el('div', { class: 'item' }, main, btns));
  }

  async function onRemove(bins, pct, button) {
    const st = 'dl-pos-status';
    ctx.setStatus(st, tt('removing'));
    button.disabled = true;
    try {
      const [ok] = await call(info.pair, 'isApprovedForAll(address,address)', ['address', 'address'], [state.account, c().dlmmRouter], ['bool']);
      if (!ok) {
        ctx.setStatus(st, tt('approveRouter'));
        await ctx.sendTx({ to: info.pair, data: encodeDlmmCall('setApprovalForAll(address,bool)', ['address', 'bool'], [c().dlmmRouter, true]) }, st);
      }
      const sel = bins.slice(0, 100).map((b) => ({ ...b, take: (b.sh * BigInt(pct)) / 100n })).filter((b) => b.take > 0n);
      const ex = sel.reduce((s, b) => s + (b.x * b.take) / b.sup, 0n);
      const ey = sel.reduce((s, b) => s + (b.y * b.take) / b.sup, 0n);
      const bps = state.settings.slippageBps;
      const ids = sel.map((b) => b.id);
      const shares = sel.map((b) => b.take);
      let data;
      if (ctx.isNative(info.tokX) || ctx.isNative(info.tokY)) {
        const nativeX = ctx.isNative(info.tokX);
        const token = nativeX ? info.tokY.address : info.tokX.address;
        const [minTok, minNat] = nativeX ? [minAfter(ey, bps), minAfter(ex, bps)] : [minAfter(ex, bps), minAfter(ey, bps)];
        data = encodeDlmmCall('removeLiquidityNATIVE(address,uint16,int24[],uint256[],uint256,uint256,address,uint256)',
          ['address', 'uint16', 'int24[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256'], [token, info.step, ids, shares, minTok, minNat, state.account, ctx.deadline()]);
      } else {
        data = encodeDlmmCall('removeLiquidity(address,address,uint16,int24[],uint256[],uint256,uint256,address,uint256)',
          ['address', 'address', 'uint16', 'int24[]', 'uint256[]', 'uint256', 'uint256', 'address', 'uint256'],
          [info.tokX.address, info.tokY.address, info.step, ids, shares, minAfter(ex, bps), minAfter(ey, bps), state.account, ctx.deadline()]);
      }
      ctx.setStatus(st, tt('removing'));
      await ctx.sendTx({ to: c().dlmmRouter, data }, st);
    } catch (e) { ctx.setStatus(st, tt('failed', { msg: errText(e) }), 'err'); }
    await loadPair();
  }

  async function onRevoke() {
    try {
      await ctx.sendTx({ to: info.pair, data: encodeDlmmCall('setApprovalForAll(address,bool)', ['address', 'bool'], [c().dlmmRouter, false]) }, 'dl-pos-status');
    } catch (e) { ctx.setStatus('dl-pos-status', tt('failed', { msg: errText(e) }), 'err'); }
  }

  // ------------------------------------------------------------ swap

  function swapSide() {
    const xy = $('dl-swap-dir').value !== 'yx';
    return xy ? { tin: info.tokX, tout: info.tokY } : { tin: info.tokY, tout: info.tokX };
  }

  async function quoteSwap() {
    const q = $('dl-swap-quote');
    $('dl-swap-approve').hidden = true;
    if (!info?.pair) { q.textContent = ''; return null; }
    const { tin, tout } = swapSide();
    const amt = readAmount('dl-swap-amt', tin.decimals);
    if (amt === 0n) { q.textContent = ''; return null; }
    const path = [[info.step], [tokAddr(tin), tokAddr(tout)]];
    try {
      const [amounts] = await call(c().dlmmRouter, 'getAmountsOut(uint256,(uint16[],address[]))', ['uint256', ['uint16[]', 'address[]']], [amt, path], ['uint256[]']);
      const out = amounts[1];
      const min = minAfter(out, state.settings.slippageBps);
      q.textContent = tt('quote', { out: fmt(out, tout.decimals), sym: tout.symbol, min: fmt(min, tout.decimals) });
      await neuroBox([tout], 'dl-swap-neuro', 'dl-swap-ack-row');
      if (state.account && !ctx.isNative(tin)) {
        const al = await ctx.allowance(tin.address, state.account, c().dlmmRouter);
        if (al < amt) {
          const b = $('dl-swap-approve');
          b.hidden = false;
          b.textContent = tt('approve', { sym: tin.symbol });
          b.onclick = () => approve(tin, amt, 'dl-swap-status').then(quoteSwap);
        }
      }
      return { tin, tout, amt, min, path };
    } catch (e) { q.textContent = errText(e); return null; }
  }

  async function onSwap() {
    if (!state.account) { ctx.openWallets(); return; }
    const st = 'dl-swap-status';
    ctx.setStatus(st, tt('swapping'));
    try {
      const s = await quoteSwap();
      if (!s) throw new Error(tt('badAmount'));
      const { need } = await neuroBox([s.tout], 'dl-swap-neuro', 'dl-swap-ack-row');
      if (need && !$('dl-swap-ack').checked) throw new Error(tt('needAck'));
      await ctx.recheckNeuro([s.tout], need && $('dl-swap-ack').checked);
      const P = ['uint16[]', 'address[]'];
      let tx;
      if (ctx.isNative(s.tin)) {
        tx = { to: c().dlmmRouter, value: s.amt, data: encodeDlmmCall('swapExactNATIVEForTokens(uint256,(uint16[],address[]),address,uint256)', ['uint256', P, 'address', 'uint256'], [s.min, s.path, state.account, ctx.deadline()]) };
      } else if (ctx.isNative(s.tout)) {
        tx = { to: c().dlmmRouter, data: encodeDlmmCall('swapExactTokensForNATIVE(uint256,uint256,(uint16[],address[]),address,uint256)', ['uint256', 'uint256', P, 'address', 'uint256'], [s.amt, s.min, s.path, state.account, ctx.deadline()]) };
      } else {
        tx = { to: c().dlmmRouter, data: encodeDlmmCall('swapExactTokensForTokens(uint256,uint256,(uint16[],address[]),address,uint256)', ['uint256', 'uint256', P, 'address', 'uint256'], [s.amt, s.min, s.path, state.account, ctx.deadline()]) };
      }
      ctx.setStatus(st, tt('swapping'));
      $('dl-swap').disabled = true;
      await ctx.sendTx(tx, st);
      $('dl-swap-amt').value = '';
    } catch (e) { ctx.setStatus(st, tt('failed', { msg: errText(e) }), 'err'); }
    $('dl-swap').disabled = false;
    $('dl-swap-ack').checked = false;
    await loadPair();
  }

  return {
    async show() {
      if (!built || builtLang !== state.lang) build();
      $('dl-deployed').textContent = deployedDlmm() ? '' : tt('notDeployed');
      if (deployedDlmm()) { await loadSteps(); await loadPair(); }
    },
  };
}
