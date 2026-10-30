// Neuro ML, stage 2: feature extractor.
//
// Turns what Neuro already computes (a readContract() report: rules analysis,
// known functions, unknown selectors, proxy, owner, trade simulation) plus the
// contract's runtime bytecode and optional market facts into a fixed list of
// named numbers for the model in ml/model.js.
//
// Plain JS, no dependencies beyond src/ (browser- and runner-safe), and pure:
// the same input always gives the same features. Missing facts are 0 with a
// matching `*_known` flag at 0, never guessed.

import { codeLengthWithoutMetadata, hexToBytes } from '../src/bytecode.js';
import { SELECTORS } from '../src/selectors.generated.js';
import { flowFeatures, FLOW_FEATURES } from './flow.js';

// 2: + per-function path features (x_*, ml/flow.js)
export const FEATURE_VERSION = 2;

const RANK = { high: 3, medium: 2, low: 1, info: 0, good: 0 };
const CATS = ['mint', 'blacklist', 'pause', 'fee', 'trading', 'limit', 'upgrade', 'roles', 'ownership', 'feeExempt', 'taxWallet', 'holder', 'burn', 'view'];
const SIG_CAT = Object.fromEntries(Object.values(SELECTORS).map((f) => [f.sig, f.cat]));
const ERC20_COUNT = Object.values(SELECTORS).filter((f) => f.cat === 'erc20').length;

// Opcodes whose share of all instructions is a feature.
const RATE_OPS = {
  sstore: [0x55], sload: [0x54], caller: [0x33], origin: [0x32], timestamp: [0x42], number: [0x43],
  gasprice: [0x3a], extcodehash: [0x3f], extcodesize: [0x3b], balance: [0x31], selfbalance: [0x47],
  sha3: [0x20], log: [0xa0, 0xa1, 0xa2, 0xa3, 0xa4], revert: [0xfd], jumpi: [0x57], eq: [0x14],
  cmp: [0x10, 0x11, 0x12, 0x13], iszero: [0x15], bitwise: [0x16, 0x17, 0x18, 0x19], xor: [0x18],
  muldiv: [0x02, 0x04, 0x05, 0x06, 0x07], exp: [0x0a], callvalue: [0x34], gas: [0x5a], returndatasize: [0x3d],
  staticcall: [0xfa], call: [0xf1],
};
const FLAG_OPS = { selfdestruct: 0xff, delegatecall: 0xf4, callcode: 0xf2, create: 0xf0, create2: 0xf5, call: 0xf1, staticcall: 0xfa };
export const NGRAM_BUCKETS = 32;

/** Short human labels (en, th) for explanations; `key` is stable for UIs that translate. */
const L = (en, th) => ({ en, th });
const INFO = {
  r_level: L('rules level (0 info .. 3 high)', 'ระดับจากกฎ (0 ข้อมูล .. 3 สูง)'),
  r_ctl_owner: L('an owner still controls it', 'ยังมีเจ้าของควบคุมอยู่'),
  r_ctl_renounced: L('owner renounced (owner() = 0)', 'เจ้าของสละสิทธิ์แล้ว (owner() = 0)'),
  r_ctl_roles: L('role-based permissions', 'ระบบสิทธิ์แบบ role'),
  r_ctl_upgradeable: L('code can be upgraded', 'เปลี่ยนโค้ดได้'),
  r_ctl_unknown: L('who controls it is unknown', 'ไม่ทราบว่าใครควบคุม'),
  r_proxy_upgradeable: L('upgradeable proxy', 'proxy ที่อัปเกรดได้'),
  r_proxy_minimal: L('EIP-1167 clone', 'โคลน EIP-1167'),
  r_name_link: L('name contains a link', 'ชื่อมีลิงก์'),
  r_lookalike: L('copies an official symbol', 'ใช้สัญลักษณ์ซ้ำกับเหรียญทางการ'),
  r_known_issuer: L('official issuer contract', 'สัญญาของผู้ออกทางการ'),
  r_template: L('matches a registered template', 'ตรงกับเทมเพลตที่ลงทะเบียน'),
  r_similar: L('similarity to reference code', 'ความคล้ายกับโค้ดอ้างอิง'),
  r_unknown_pattern: L('pattern the rules do not recognise', 'รูปแบบที่กฎยังไม่รู้จัก'),
  r_not_erc20: L('not an ERC-20 interface', 'ไม่ใช่ ERC-20'),
  r_delegatecall_finding: L('DELEGATECALL outside a known proxy', 'มี DELEGATECALL นอก proxy ที่รู้จัก'),
  s_dispatched: L('number of functions offered', 'จำนวนฟังก์ชันที่เปิดให้เรียก'),
  s_known: L('number of named functions', 'จำนวนฟังก์ชันที่รู้จักชื่อ'),
  s_unknown: L('number of unnamed functions', 'จำนวนฟังก์ชันที่ไม่รู้จักชื่อ'),
  s_unknown_share: L('share of unnamed functions', 'สัดส่วนฟังก์ชันที่ไม่รู้จักชื่อ'),
  s_erc20: L('share of the ERC-20 interface present', 'สัดส่วนของ ERC-20 ที่มี'),
  o_size: L('code size', 'ขนาดโค้ด'),
  o_instr: L('instruction count', 'จำนวนคำสั่ง'),
  p_caller_guard: L('caller-is-stored-address checks', 'การตรวจว่าผู้เรียกคือที่อยู่ที่เก็บไว้'),
  p_origin_guard: L('tx.origin checks', 'การตรวจ tx.origin'),
  p_time_gate: L('time/block-number conditions', 'เงื่อนไขตามเวลา/หมายเลขบล็อก'),
  p_gasprice_gate: L('gas-price conditions', 'เงื่อนไขตามราคา gas'),
  p_hash_guard: L('hashed caller checks (hidden owner)', 'การตรวจผู้เรียกแบบแฮช (เจ้าของแฝง)'),
  p_xor_guard: L('XOR-masked caller checks (hidden owner)', 'การตรวจผู้เรียกแบบ XOR (เจ้าของแฝง)'),
  p_codesize_gate: L('checks whether an address is a contract', 'การตรวจว่าที่อยู่เป็นสัญญาหรือไม่'),
  p_ext_calls: L('calls to other contracts', 'การเรียกสัญญาอื่น'),
  m_sim_run: L('buy/sell simulation ran', 'จำลองซื้อขายแล้ว'),
  m_sim_ok: L('simulation: bought and sold normally', 'จำลอง: ซื้อและขายได้ปกติ'),
  m_sim_tax_medium: L('simulation: tax 10-50%', 'จำลอง: ภาษี 10-50%'),
  m_sim_tax_high: L('simulation: tax over 50%', 'จำลอง: ภาษีเกิน 50%'),
  m_sim_cannot_sell: L('simulation: could not sell', 'จำลอง: ขายไม่ได้'),
  m_sim_skipped: L('simulation skipped', 'ข้ามการจำลอง'),
  m_buy_tax: L('simulated buy tax', 'ภาษีซื้อจากการจำลอง'),
  m_sell_tax: L('simulated sell tax', 'ภาษีขายจากการจำลอง'),
  k_top_holder: L('largest holder share', 'สัดส่วนผู้ถือรายใหญ่สุด'),
  k_top10: L('top-10 holders share', 'สัดส่วนผู้ถือ 10 อันดับแรก'),
  k_lp_locked: L('liquidity locked or burned', 'สภาพคล่องถูกล็อกหรือเผา'),
  k_liquidity: L('pool liquidity (USD, log)', 'สภาพคล่องในพูล (USD, log)'),
  k_age: L('contract age (days, log)', 'อายุสัญญา (วัน, log)'),
  k_verified: L('verified source published', 'เผยแพร่ซอร์สที่ยืนยันแล้ว'),
  k_holders: L('number of holders (log)', 'จำนวนผู้ถือ (log)'),
  x_fn_found: L('functions could be traced one by one', 'ติดตามโค้ดของแต่ละฟังก์ชันได้'),
  x_fn_xfer: L('functions that can move tokens', 'จำนวนฟังก์ชันที่ย้ายเหรียญได้'),
  x_priv_fns: L('functions only the owner can call', 'ฟังก์ชันที่เจ้าของเท่านั้นเรียกได้'),
  x_priv_unknown: L('unnamed functions only the owner can call', 'ฟังก์ชันไม่รู้จักชื่อที่เจ้าของเท่านั้นเรียกได้'),
  x_priv_xfer: L('the owner can move or create tokens', 'เจ้าของย้ายหรือสร้างเหรียญได้เอง'),
  x_priv_xfer_unknown: L('an unnamed owner-only function moves or creates tokens', 'มีฟังก์ชันไม่รู้จักชื่อของเจ้าของที่ย้ายหรือสร้างเหรียญได้'),
  x_priv_xfer_free: L('the owner can move or create tokens with no fixed limit', 'เจ้าของย้ายหรือสร้างเหรียญได้โดยไม่มีเพดานตายตัว'),
  x_priv_capped: L('owner-only functions bounded by a fixed limit', 'ฟังก์ชันเฉพาะเจ้าของที่มีเพดานตายตัว'),
  x_priv_sstore: L('owner-only functions that change settings', 'ฟังก์ชันเฉพาะเจ้าของที่เปลี่ยนค่าตั้งได้'),
  x_owner_const: L('owner() always returns the same value', 'owner() คืนค่าเดิมเสมอ'),
  x_fake_renounce: L('says it has no owner, yet owner-only functions remain', 'อ้างว่าไม่มีเจ้าของ แต่ยังมีฟังก์ชันที่เจ้าของเท่านั้นเรียกได้'),
  x_fee_owner_set: L('the owner sets the rate transfers charge', 'เจ้าของตั้งอัตราที่หักตอนโอนได้'),
  x_fee_owner_free: L('the owner can set the transfer fee to any value (no cap)', 'เจ้าของตั้งค่าธรรมเนียมการโอนเป็นค่าใดก็ได้ (ไม่มีเพดาน)'),
  x_tx_found: L('transfer code could be traced', 'ติดตามโค้ดการโอนได้'),
  x_tx_guard: L('transfers check for one special address (owner exemption)', 'การโอนตรวจหาที่อยู่พิเศษ (เจ้าของได้รับยกเว้น)'),
  x_tx_time: L('transfers depend on the time or block number', 'การโอนขึ้นกับเวลาหรือหมายเลขบล็อก'),
  x_tx_gasprice: L('transfers depend on the gas price', 'การโอนขึ้นกับราคา gas'),
  x_tx_origin: L('transfers read tx.origin', 'การโอนอ่าน tx.origin'),
  x_tx_codesize: L('transfers check whether the sender is a contract', 'การโอนตรวจว่าผู้ส่งเป็นสัญญาหรือไม่'),
  x_tx_balance: L('transfers read an ETH balance', 'การโอนอ่านยอด ETH'),
  x_tx_coinbase: L('transfers read the block producer', 'การโอนอ่านผู้ผลิตบล็อก'),
  x_tx_gas: L('transfers depend on the gas left', 'การโอนขึ้นกับ gas ที่เหลือ'),
  x_tx_branches: L('how many conditions transfers check', 'จำนวนเงื่อนไขที่การโอนตรวจ'),
  x_tx_sloads: L('how many stored values transfers read', 'จำนวนค่าที่เก็บไว้ที่การโอนอ่าน'),
  x_tx_div: L('transfers take a percentage (a fee)', 'การโอนหักเป็นเปอร์เซ็นต์ (ค่าธรรมเนียม)'),
};

function buildNames() {
  const names = [
    'r_level', 'r_ctl_owner', 'r_ctl_renounced', 'r_ctl_roles', 'r_ctl_upgradeable', 'r_ctl_unknown',
    'r_proxy_upgradeable', 'r_proxy_minimal', 'r_name_link', 'r_lookalike', 'r_known_issuer', 'r_template',
    'r_similar', 'r_unknown_pattern', 'r_not_erc20', 'r_delegatecall_finding',
    's_dispatched', 's_known', 's_unknown', 's_unknown_share', 's_erc20',
    ...CATS.map((c) => `s_cat_${c}`),
    'o_size', 'o_instr',
    ...Object.keys(FLAG_OPS).map((k) => `o_has_${k}`),
    ...Object.keys(RATE_OPS).map((k) => `o_rate_${k}`),
    'p_caller_guard', 'p_origin_guard', 'p_time_gate', 'p_gasprice_gate', 'p_hash_guard', 'p_xor_guard', 'p_codesize_gate', 'p_ext_calls',
    ...Array.from({ length: NGRAM_BUCKETS }, (_, i) => `g3_${String(i).padStart(2, '0')}`),
    'm_sim_run', 'm_sim_ok', 'm_sim_tax_medium', 'm_sim_tax_high', 'm_sim_cannot_sell', 'm_sim_skipped', 'm_buy_tax', 'm_sell_tax',
  ];
  for (const k of ['k_top_holder', 'k_top10', 'k_lp_locked', 'k_liquidity', 'k_age', 'k_verified', 'k_holders']) names.push(k, `${k}_known`);
  names.push(...FLOW_FEATURES);
  return names;
}
/** Feature names, in the order of the vector. */
export const FEATURES = Object.freeze(buildNames());
const INDEX = Object.fromEntries(FEATURES.map((n, i) => [n, i]));

/** Human label of a feature: {en, th}. */
export function featureLabel(name) {
  if (INFO[name]) return INFO[name];
  const base = name.replace(/_known$/, '');
  if (name.endsWith('_known') && INFO[base]) return L(`${INFO[base].en} is known`, `ทราบ${INFO[base].th}`);
  let m;
  if ((m = /^s_cat_(\w+)$/.exec(name))) return L(`functions of kind "${m[1]}"`, `ฟังก์ชันประเภท "${m[1]}"`);
  if ((m = /^o_has_(\w+)$/.exec(name))) return L(`has ${m[1].toUpperCase()}`, `มีคำสั่ง ${m[1].toUpperCase()}`);
  if ((m = /^o_rate_(\w+)$/.exec(name))) return L(`share of ${m[1].toUpperCase()} instructions`, `สัดส่วนคำสั่ง ${m[1].toUpperCase()}`);
  if ((m = /^g3_(\d+)$/.exec(name))) return L(`opcode pattern group ${m[1]}`, `กลุ่มรูปแบบ opcode ${m[1]}`);
  return L(name, name);
}

/** Opcode sequence of the code part (metadata excluded), PUSH data skipped. */
export function opcodeStream(codeHex) {
  if (!codeHex || codeHex === '0x') return [];
  let bytes;
  try { bytes = hexToBytes(codeHex); } catch { return []; }
  const end = codeLengthWithoutMetadata(bytes);
  const ops = [];
  for (let pc = 0; pc < end; pc++) {
    const op = bytes[pc];
    ops.push(op);
    if (op >= 0x60 && op <= 0x7f) pc += op - 0x5f;
  }
  return ops;
}

// Opcode classes for n-grams: exact opcode for the interesting ones, a class
// otherwise, so PUSH sizes and DUP/SWAP depths do not dominate.
function opClass(op) {
  if (op >= 0x60 && op <= 0x7f) return 'P';
  if (op === 0x5f) return 'P';
  if (op >= 0x80 && op <= 0x8f) return 'D';
  if (op >= 0x90 && op <= 0x9f) return 'W';
  if (op >= 0xa0 && op <= 0xa4) return 'L';
  return op.toString(16);
}
function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h;
}

const isCmp = (op) => op === 0x14 || (op >= 0x10 && op <= 0x13);
/** Count windows: a `src` opcode, then within `win` instructions a comparison, then a JUMPI within 6 more. */
function gateCount(ops, srcSet, { win = 12, need = null } = {}) {
  let n = 0;
  for (let i = 0; i < ops.length; i++) {
    if (!srcSet.has(ops[i])) continue;
    let sawNeed = need == null;
    for (let j = i + 1; j < Math.min(ops.length, i + win); j++) {
      if (need && need.has(ops[j])) sawNeed = true;
      if (isCmp(ops[j]) && sawNeed) {
        let jumped = false;
        for (let k = j + 1; k < Math.min(ops.length, j + 6); k++) if (ops[k] === 0x57) { jumped = true; break; }
        if (jumped) { n++; break; }
      }
    }
  }
  return n;
}

/** Bytecode-only features (also usable without a report). */
export function codeFeatures(codeHex) {
  const out = {};
  const ops = opcodeStream(codeHex);
  const size = codeHex && codeHex !== '0x' ? (codeHex.replace(/^0x/i, '').length / 2) : 0;
  out.o_size = Math.log1p(size) / 10;
  out.o_instr = Math.log1p(ops.length) / 10;
  const counts = new Map();
  for (const op of ops) counts.set(op, (counts.get(op) ?? 0) + 1);
  for (const [k, op] of Object.entries(FLAG_OPS)) out[`o_has_${k}`] = counts.get(op) ? 1 : 0;
  const n = ops.length || 1;
  for (const [k, list] of Object.entries(RATE_OPS)) {
    let c = 0;
    for (const op of list) c += counts.get(op) ?? 0;
    out[`o_rate_${k}`] = (c / n) * 100; // percent of instructions
  }
  out.p_caller_guard = Math.log1p(gateCount(ops, new Set([0x33]), { need: new Set([0x54]) }));
  out.p_origin_guard = Math.log1p(gateCount(ops, new Set([0x32])));
  out.p_time_gate = Math.log1p(gateCount(ops, new Set([0x42, 0x43])));
  out.p_gasprice_gate = Math.log1p(gateCount(ops, new Set([0x3a])));
  out.p_hash_guard = Math.log1p(gateCount(ops, new Set([0x33]), { win: 24, need: new Set([0x20]) }));
  out.p_xor_guard = Math.log1p(gateCount(ops, new Set([0x33]), { win: 16, need: new Set([0x18]) }));
  out.p_codesize_gate = Math.log1p(gateCount(ops, new Set([0x3b, 0x3f])));
  out.p_ext_calls = Math.log1p((counts.get(0xf1) ?? 0) + (counts.get(0xfa) ?? 0) + (counts.get(0xf4) ?? 0));
  const buckets = new Array(NGRAM_BUCKETS).fill(0);
  let grams = 0;
  for (let i = 0; i + 2 < ops.length; i++) {
    buckets[fnv(opClass(ops[i]) + ',' + opClass(ops[i + 1]) + ',' + opClass(ops[i + 2])) % NGRAM_BUCKETS]++;
    grams++;
  }
  for (let i = 0; i < NGRAM_BUCKETS; i++) out[`g3_${String(i).padStart(2, '0')}`] = grams ? (buckets[i] / grams) * 10 : 0;
  return out;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));
function known(out, key, value, transform = (v) => v) {
  if (value == null || Number.isNaN(Number(value))) { out[key] = 0; out[`${key}_known`] = 0; return; }
  out[key] = transform(Number(value));
  out[`${key}_known`] = 1;
}

/**
 * @param {object} input
 * @param {object} input.report      a readContract() report (EVM); only its plain fields are read
 * @param {string} [input.code]      runtime bytecode at the address (hex)
 * @param {string} [input.logicCode] implementation's bytecode behind a proxy (hex), if read
 * @param {object} [input.market]    optional facts outside the code: {topHolderShare, top10Share
 *   (0..1), lpLocked (bool), liquidityUsd, ageDays, holders}. Missing = unknown.
 * @returns {Record<string, number>} every name in FEATURES, finite numbers
 */
export function extractFeatures({ report = {}, code = null, logicCode = null, market = null } = {}) {
  const out = Object.fromEntries(FEATURES.map((n) => [n, 0]));
  const a = report.analysis ?? {};
  const ids = new Set((a.findings ?? []).map((f) => f.id));
  const sev = (id) => (a.findings ?? []).find((f) => f.id === id)?.severity;
  out.r_level = RANK[a.rulesLevel ?? a.level] ?? 0;
  const ctl = a.control;
  out.r_ctl_owner = ctl === 'owner' ? 1 : 0;
  out.r_ctl_renounced = ctl === 'renounced' ? 1 : 0;
  out.r_ctl_roles = ctl === 'roles' ? 1 : 0;
  out.r_ctl_upgradeable = ctl === 'upgradeable' ? 1 : 0;
  out.r_ctl_unknown = ctl === 'unknown' ? 1 : 0;
  const pk = report.proxy?.kind;
  out.r_proxy_upgradeable = pk === 'eip1967' || pk === 'beacon' || pk === 'zos' ? 1 : 0;
  out.r_proxy_minimal = pk === 'eip1167' ? 1 : 0;
  out.r_name_link = ids.has('name-has-link') ? 1 : 0;
  out.r_lookalike = ids.has('lookalike') ? 1 : 0;
  out.r_known_issuer = ids.has('known-issuer') ? 1 : 0;
  out.r_template = ids.has('template-match') ? 1 : 0;
  const sim = (a.findings ?? []).find((f) => f.id === 'similar-flagged' || f.id === 'similar-reference');
  out.r_similar = sim ? clamp01((sim.params?.percent ?? 0) / 100) : 0;
  out.r_unknown_pattern = ids.has('unknown-pattern') ? 1 : 0;
  out.r_not_erc20 = ids.has('not-erc20') ? 1 : 0;
  out.r_delegatecall_finding = ids.has('delegatecall') ? 1 : 0;

  const sigs = report.functions ?? [];
  const unknown = report.unknownSelectors ?? [];
  const catCount = {};
  for (const s of sigs) { const c = SIG_CAT[s] ?? 'named'; catCount[c] = (catCount[c] ?? 0) + 1; }
  const dispatched = sigs.length + unknown.length;
  out.s_dispatched = Math.log1p(dispatched);
  out.s_known = Math.log1p(sigs.length);
  out.s_unknown = Math.log1p(unknown.length);
  out.s_unknown_share = dispatched ? unknown.length / dispatched : 0;
  out.s_erc20 = clamp01((catCount.erc20 ?? 0) / ERC20_COUNT);
  for (const c of CATS) out[`s_cat_${c}`] = Math.log1p(catCount[c] ?? 0);

  const body = logicCode && logicCode !== '0x' ? logicCode : code;
  Object.assign(out, codeFeatures(body));
  Object.assign(out, flowFeatures(body, { known: (sel) => SELECTORS[sel] != null }));

  const simF = (a.findings ?? []).filter((f) => f.id.startsWith('sim-'));
  if (simF.length) {
    out.m_sim_run = simF.some((f) => f.id !== 'sim-skipped') ? 1 : 0;
    out.m_sim_ok = ids.has('sim-ok') ? 1 : 0;
    out.m_sim_tax_medium = sev('sim-high-tax') === 'medium' ? 1 : 0;
    out.m_sim_tax_high = sev('sim-high-tax') === 'high' ? 1 : 0;
    out.m_sim_cannot_sell = ids.has('sim-cannot-sell') ? 1 : 0;
    out.m_sim_skipped = ids.has('sim-skipped') ? 1 : 0;
    const p = simF.find((f) => f.id !== 'sim-skipped')?.params ?? {};
    out.m_buy_tax = clamp01((p.buy ?? 0) / 100);
    out.m_sell_tax = p.sell == null && ids.has('sim-cannot-sell') ? 1 : clamp01((p.sell ?? 0) / 100);
  }

  const m = market ?? {};
  known(out, 'k_top_holder', m.topHolderShare, clamp01);
  known(out, 'k_top10', m.top10Share, clamp01);
  known(out, 'k_lp_locked', m.lpLocked == null ? null : (m.lpLocked ? 1 : 0));
  known(out, 'k_liquidity', m.liquidityUsd, (v) => Math.log1p(Math.max(0, v)) / 10);
  known(out, 'k_age', m.ageDays, (v) => Math.log1p(Math.max(0, v)) / 5);
  // Verified source: from the report when Sourcify was asked (undefined = not checked).
  const verified = m.verified ?? (report.source ? 1 : report.source === null ? 0 : null);
  known(out, 'k_verified', verified, (v) => (v ? 1 : 0));
  known(out, 'k_holders', m.holders, (v) => Math.log1p(Math.max(0, v)) / 10);

  for (const k of FEATURES) if (!Number.isFinite(out[k])) out[k] = 0;
  return out;
}

/** Named features -> vector in FEATURES order (or the given order: a model's own list). */
export function toVector(named, names = FEATURES) {
  return names.map((n) => (Number.isFinite(named[n]) ? named[n] : 0));
}

export { INDEX as FEATURE_INDEX };
