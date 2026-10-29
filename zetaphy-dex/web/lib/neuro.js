// Neuro (ZETAPHY's code analysis) in the DEX page: asks the ThreatRegistry
// (zetaphy-network/contracts/ThreatRegistry.sol) about a token before it is
// imported, bought, or added to a pool. The same keys as the wallet's vaccine
// (zetaphy-network/src/vaccine.js), without keccak in the page:
//   - isContractFlagged / isContractEnforced(token): its address on this chain,
//     or its exact code (the registry hashes it on chain);
//   - isFlagged / isEnforced(fp1): Neuro's fingerprint of the code (sha256 via WebCrypto);
//   - the same for the code a proxy forwards to (EIP-1167, EIP-1967 implementation/beacon).
// Flagged: the page warns. Enforced: the page refuses (and so does the router,
// when governance set the registry there). Wording: facts about code, never an
// accusation (docs/LEGAL.md).

import { encodeCall, decode } from './abi.js';

// Reason texts in the 8 languages of the ZETAPHY apps (th and en are the same
// as zetaphy-network/src/vaccine.js). Missing languages fall back to en.
export const REASON_TEXT = [
  { en: '-', zh: '-', es: '-', ko: '-', ja: '-', ru: '-', vi: '-', th: '-' },
  {
    en: 'in a simulated trade, buying worked but selling failed or returned almost nothing',
    zh: '在模拟交易中可以买入，但卖出失败或几乎拿不回任何东西',
    es: 'en una operación simulada, la compra funcionó pero la venta falló o devolvió casi nada',
    ko: '모의 거래에서 매수는 되었으나 매도가 실패하거나 거의 아무것도 돌려받지 못함',
    ja: '模擬取引で、購入はできたが売却が失敗したか、ほとんど何も戻らなかった',
    ru: 'в смоделированной сделке покупка прошла, но продажа не удалась или почти ничего не вернула',
    vi: 'trong giao dịch mô phỏng, mua được nhưng bán thất bại hoặc gần như không nhận lại gì',
    th: 'ในการจำลองซื้อขาย ซื้อได้ แต่ขายไม่ได้หรือได้เงินคืนน้อยมาก',
  },
  {
    en: 'an address can mint new tokens without a cap',
    zh: '有地址可以无上限地铸造新代币',
    es: 'una dirección puede acuñar nuevos tokens sin límite',
    ko: '특정 주소가 상한 없이 새 토큰을 발행할 수 있음',
    ja: '特定のアドレスが上限なく新しいトークンを発行できる',
    ru: 'некий адрес может выпускать новые токены без ограничения',
    vi: 'một địa chỉ có thể đúc thêm token mới không giới hạn',
    th: 'มีที่อยู่ที่สร้างเหรียญเพิ่มได้ไม่จำกัด',
  },
  {
    en: 'an owner or admin can stop holders from transferring or selling',
    zh: '所有者或管理员可以阻止持有者转账或卖出',
    es: 'un propietario o administrador puede impedir que los titulares transfieran o vendan',
    ko: '소유자 또는 관리자가 보유자의 전송이나 매도를 막을 수 있음',
    ja: 'オーナーまたは管理者が保有者の送金や売却を止められる',
    ru: 'владелец или администратор может запретить держателям переводить или продавать',
    vi: 'chủ sở hữu hoặc quản trị viên có thể chặn người nắm giữ chuyển hoặc bán',
    th: 'เจ้าของหรือผู้ดูแลระงับการโอนหรือการขายของผู้ถือได้',
  },
  {
    en: 'an owner or admin can move or burn tokens or funds held by others',
    zh: '所有者或管理员可以转移或销毁他人持有的代币或资金',
    es: 'un propietario o administrador puede mover o quemar tokens o fondos de otros titulares',
    ko: '소유자 또는 관리자가 다른 사람이 보유한 토큰이나 자금을 옮기거나 소각할 수 있음',
    ja: 'オーナーまたは管理者が他人の保有するトークンや資金を移動・バーンできる',
    ru: 'владелец или администратор может перемещать или сжигать токены или средства других держателей',
    vi: 'chủ sở hữu hoặc quản trị viên có thể chuyển hoặc đốt token hay tiền do người khác nắm giữ',
    th: 'เจ้าของหรือผู้ดูแลย้ายหรือเผาเหรียญหรือเงินในบัญชีของผู้ถือคนอื่นได้',
  },
  {
    en: 'uses the same name or symbol as a known token at a different address',
    zh: '使用与已知代币相同的名称或符号，但地址不同',
    es: 'usa el mismo nombre o símbolo que un token conocido, en otra dirección',
    ko: '알려진 토큰과 같은 이름 또는 심볼을 다른 주소에서 사용함',
    ja: '既知のトークンと同じ名前またはシンボルを、異なるアドレスで使っている',
    ru: 'использует то же название или тикер, что и известный токен, но по другому адресу',
    vi: 'dùng cùng tên hoặc ký hiệu với một token đã biết nhưng ở địa chỉ khác',
    th: 'ใช้ชื่อหรือสัญลักษณ์เดียวกับเหรียญที่รู้จัก แต่อยู่คนละที่อยู่',
  },
  {
    en: 'in a reproducible test, it moved tokens approved to it to an address the holder did not choose',
    zh: '在可复现的测试中，它把授权给它的代币转到了持有者未选择的地址',
    es: 'en una prueba reproducible, movió tokens aprobados a su favor a una dirección que el titular no eligió',
    ko: '재현 가능한 테스트에서 승인받은 토큰을 보유자가 선택하지 않은 주소로 옮김',
    ja: '再現可能なテストで、承認されたトークンを保有者が選んでいないアドレスへ移動した',
    ru: 'в воспроизводимом тесте он перевёл одобренные ему токены на адрес, который держатель не выбирал',
    vi: 'trong một thử nghiệm có thể lặp lại, nó đã chuyển token được phê duyệt cho nó tới địa chỉ mà người nắm giữ không chọn',
    th: 'ในการทดสอบที่ทำซ้ำได้ ย้ายเหรียญที่ได้รับอนุญาต (approve) ไปยังที่อยู่ที่ผู้ถือไม่ได้เลือก',
  },
  {
    en: 'another code fact (see the evidence)',
    zh: '其他代码事实（见证据）',
    es: 'otro hecho del código (ver la evidencia)',
    ko: '기타 코드상의 사실(증거 참조)',
    ja: 'その他のコード上の事実（証拠を参照）',
    ru: 'другой факт о коде (см. доказательства)',
    vi: 'một dữ kiện khác về mã (xem bằng chứng)',
    th: 'ข้อเท็จจริงอื่นของโค้ด (ดูหลักฐาน)',
  },
];
const LANG_CODES = Object.keys(REASON_TEXT[0]);
export const reasonText = (n) => (REASON_TEXT[n] && n > 0 ? REASON_TEXT[n] : Object.fromEntries(LANG_CODES.map((l) => [l, `#${n}`])));
/** Shown with every warning or refusal. */
export const DISCLAIMER = {
  en: 'Automated code analysis, not an accusation',
  zh: '自动代码分析，并非指控',
  es: 'Análisis automático de código, no una acusación',
  ko: '자동 코드 분석이며, 비난이 아닙니다',
  ja: '自動コード分析であり、告発ではありません',
  ru: 'Автоматический анализ кода, а не обвинение',
  vi: 'Phân tích mã tự động, không phải lời buộc tội',
  th: 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา',
};

// EIP-1967 slots (keccak256(name) - 1) and EIP-1167 / ERC-7511 minimal proxies.
export const SLOT_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SLOT_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
const SEL_IMPLEMENTATION = '0x5c60da1b';
const MINIMAL_PROXY = [/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i, /^0x365f5f375f5f365f73([0-9a-f]{40})5af43d5f5f3e5f3d91602a57fd5bf3$/i];

function fromHex(hex) {
  const h = hex.replace(/^0x/i, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('invalid hex');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// ---- Neuro's fp1 fingerprint (zetaphy-neuro/src/fingerprint.js): PUSH20/PUSH32 data blanked, metadata dropped, sha256 ----
function codeLengthWithoutMetadata(code) {
  if (code.length < 4) return code.length;
  const metaLen = (code[code.length - 2] << 8) | code[code.length - 1];
  const start = code.length - 2 - metaLen;
  if (metaLen > 0 && start > 0 && code[start] >= 0xa1 && code[start] <= 0xa5) return start;
  return code.length;
}
export async function fingerprint1(codeHex, subtle = globalThis.crypto.subtle) {
  const code = fromHex(codeHex);
  const end = codeLengthWithoutMetadata(code);
  const out = code.slice(0, end);
  for (let pc = 0; pc < end; pc++) {
    const op = out[pc];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x60 + 1;
      if (op === 0x73 || op === 0x7f) out.fill(0, pc + 1, Math.min(pc + 1 + n, end));
      pc += n;
    }
  }
  return '0x' + toHex(new Uint8Array(await subtle.digest('SHA-256', out)));
}

function wordAddress(hex) {
  const h = String(hex ?? '').replace(/^0x/, '');
  if (h.length < 64 || !/^0{24}/.test(h) || /^0{64}$/.test(h.slice(0, 64))) return null;
  return '0x' + h.slice(24, 64);
}

/** Where a proxy forwards its calls (best effort, like the wallet). `rpc(method, params)`. */
export async function proxyTargets(rpc, addr, code) {
  const out = [];
  for (const re of MINIMAL_PROXY) { const m = re.exec(code); if (m) out.push('0x' + m[1].toLowerCase()); }
  const impl = wordAddress(await rpc('eth_getStorageAt', [addr, SLOT_IMPL, 'latest']));
  if (impl) out.push(impl);
  const beacon = wordAddress(await rpc('eth_getStorageAt', [addr, SLOT_BEACON, 'latest']));
  if (beacon) {
    out.push(beacon);
    try { const bi = wordAddress(await rpc('eth_call', [{ to: beacon, data: SEL_IMPLEMENTATION }, 'latest'])); if (bi) out.push(bi); } catch { /* not a beacon */ }
  }
  return [...new Set(out)];
}

const call = (rpc, to, data) => rpc('eth_call', [{ to, data }, 'latest']);

/** The registry's two answers for one address: its address key and its code. */
async function askContract(rpc, registry, addr) {
  const [w, e] = await Promise.all([
    call(rpc, registry, encodeCall('isContractFlagged(address)', [addr])),
    call(rpc, registry, encodeCall('isContractEnforced(address)', [addr])),
  ]);
  return readPair(w, e);
}
async function askFingerprint(rpc, registry, fp) {
  const [w, e] = await Promise.all([
    call(rpc, registry, encodeCall('isFlagged(bytes32)', [fp])),
    call(rpc, registry, encodeCall('isEnforced(bytes32)', [fp])),
  ]);
  return readPair(w, e);
}
function readPair(w, e) {
  const [wf, wr] = decode(['bool', 'uint8'], w);
  const [ef, er] = decode(['bool', 'uint8'], e);
  return { flagged: wf || ef, enforced: ef, reason: Number(ef ? er : wf ? wr : 0n) };
}

/**
 * Checks `token` (and what it forwards to) against the registry.
 * Returns { status: 'clear'|'flagged'|'enforced'|'unknown'|'nocode', reason, via, error }.
 * 'unknown': no registry configured, or it did not answer (the page says so; it does not pretend all is fine).
 */
export async function checkToken(rpc, registry, token) {
  const code = await rpc('eth_getCode', [token, 'latest']);
  if (!code || code === '0x') return { status: 'nocode', reason: 0, via: null };
  if (!registry) return { status: 'unknown', reason: 0, via: null, error: 'noRegistry' };
  try {
    let worst = { status: 'clear', reason: 0, via: null };
    const consider = (r, via) => {
      if (r.enforced && worst.status !== 'enforced') worst = { status: 'enforced', reason: r.reason, via };
      else if (r.flagged && worst.status === 'clear') worst = { status: 'flagged', reason: r.reason, via };
    };
    consider(await askContract(rpc, registry, token), 'address/code');
    consider(await askFingerprint(rpc, registry, await fingerprint1(code)), 'fingerprint');
    let targets = [];
    try { targets = await proxyTargets(rpc, token, code); } catch { targets = []; }
    for (const t of targets.slice(0, 3)) {
      consider(await askContract(rpc, registry, t), `proxy ${t}`);
      const tc = await rpc('eth_getCode', [t, 'latest']);
      if (tc && tc !== '0x') consider(await askFingerprint(rpc, registry, await fingerprint1(tc)), `proxy ${t}`);
    }
    return worst;
  } catch (e) {
    return { status: 'unknown', reason: 0, via: null, error: String(e?.message ?? e) };
  }
}

/**
 * The "Neuro-checked" certificate of `token` (NeuroAttest.badge, docs/future/crosschain-assist.md item 19):
 * { checked, uid, by } or null (no NeuroAttest configured, none for this token, or no answer). A check, not a guarantee.
 */
export async function checkBadge(rpc, attest, token) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(attest ?? '') || !/^0x[0-9a-fA-F]{40}$/.test(token ?? '')) return null;
  try {
    const h = String(await rpc('eth_call', [{ to: attest, data: `0x88e179c7${token.slice(2).toLowerCase().padStart(64, '0')}` }, 'latest'])).replace(/^0x/, '');
    if (h.length < 7 * 64) return null;
    const uid = BigInt(`0x${h.slice(64, 128)}`);
    if (uid === 0n) return null;
    return { checked: BigInt(`0x${h.slice(0, 64)}`) !== 0n, uid, by: `0x${h.slice(5 * 64 + 24, 6 * 64)}` };
  } catch { return null; }
}
