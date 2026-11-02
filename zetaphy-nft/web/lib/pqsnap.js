// Post-quantum signing for the dapps: the ZETAPHY Snap (zetaphy-snap/: an ML-DSA-44 key made inside MetaMask from
// its recovery phrase) as an EIP-1193 provider, so the hub, Swap and NFT send through it with their usual code
// (one file, copied as-is into each app by `npm run sync:shared`; test/shared.test.mjs checks the copies).
//  - The account is the snap's native PQ account (its own 0x… / zetaphy1… address, not the MetaMask ECDSA one).
//    Its address is derived here from the public key (sha256("zetaphy/mldsa44\0" || pk)[:20]), never taken on
//    the snap's word.
//  - eth_sendTransaction {to, data, value} becomes one `evmCall` message (MsgEVMCall: msg.sender = the PQ account),
//    signed with ML-DSA-44 by the snap after its own confirmation window (zetaphy_signTx), and broadcast with
//    zetaphy_sendCosmosTx. A Cosmos tx has no EVM receipt: the result is read from the node's CometBFT RPC
//    (/rpc/tx), and recorded with txguard.js settleTx, so the apps' usual watch (watchTx) sees it.
//  - ECDSA-only requests (personal_sign, EIP-712 typed data, eth_sign) are refused (4200) with a plain reason:
//    an ML-DSA key cannot make a secp256k1 signature. Reads go to the node. Contract creation is not offered here.
// Never holds a key: only the snap ID, the public key and the address. Canonical copy: zetaphy-hub/.
import { settleTx, settledTx, txgText } from './txguard.js';

/** The wallet id the sites store for this choice (SHARED_KEY in walletbar.js). */
export const PQSNAP_ID = 'zetaphy-snap';
export const SNAP_ID = 'npm:@zetaphy/snap';
export const COSMOS_CHAIN_ID = 'zetaphy_77390-1';
export const PQS_LANGS = ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th'];
/** Tx gas = EVM gas + this (the ML-DSA check, tx size, the Cosmos side): EVM_CALL_GAS_OVERHEAD in pqtx.js. */
export const EVM_CALL_GAS_OVERHEAD = 400000n;
export const MIN_EVM_GAS = 21000n;
export const MAX_EVM_GAS = 10000000n;
const PUBLIC_KEY_BYTES = 1312;

const M = {
  en: {
    btn: 'ZETAPHY Snap: post-quantum (ML-DSA) in MetaMask',
    note: 'Signs with an ML-DSA-44 key kept inside MetaMask. It is its own account (not your MetaMask address): send ZETAPHY to it first. Until the snap is on MetaMask\'s allowlist, MetaMask Flask is needed.',
    badge: 'post-quantum',
    noSnaps: 'This wallet cannot run MetaMask Snaps. Use MetaMask Flask (until the ZETAPHY Snap is allowlisted), or the ZETAPHY web wallet.',
    badAccount: 'The snap answered with an account whose address does not match its public key. Nothing was signed.',
    notFunded: (a) => `This post-quantum account is not on the chain yet. Send some ZETAPHY to ${a} first.`,
    noFunds: 'Not enough ZETAPHY on the post-quantum account for the amount and the fee.',
    ecdsaOnly: 'The ZETAPHY Snap signs with ML-DSA only. This action needs an ECDSA signature (a message or typed-data signature), which it cannot make: use a regular wallet for it.',
    wouldFail: (m) => `The call would fail on the chain, so nothing was signed: ${m}`,
    refused: (m) => `The node refused the transaction: ${m}`,
  },
  zh: {
    btn: 'ZETAPHY Snap：MetaMask 中的抗量子签名（ML-DSA）',
    note: '使用保存在 MetaMask 内的 ML-DSA-44 密钥签名。这是一个独立账户（不是你的 MetaMask 地址）：请先向它转入 ZETAPHY。在该 Snap 进入 MetaMask 白名单之前，需要使用 MetaMask Flask。',
    badge: '抗量子',
    noSnaps: '此钱包无法运行 MetaMask Snaps。请使用 MetaMask Flask（直到 ZETAPHY Snap 进入白名单），或使用 ZETAPHY 网页钱包。',
    badAccount: 'Snap 返回的账户地址与其公钥不符。没有签署任何内容。',
    notFunded: (a) => `这个抗量子账户还不在链上。请先向 ${a} 转入一些 ZETAPHY。`,
    noFunds: '抗量子账户中的 ZETAPHY 不足以支付金额和手续费。',
    ecdsaOnly: 'ZETAPHY Snap 只用 ML-DSA 签名。此操作需要 ECDSA 签名（消息或结构化数据签名），它无法生成：请使用普通钱包完成此操作。',
    wouldFail: (m) => `该调用在链上会失败，因此没有签名：${m}`,
    refused: (m) => `节点拒绝了这笔交易：${m}`,
  },
  es: {
    btn: 'ZETAPHY Snap: poscuántico (ML-DSA) en MetaMask',
    note: 'Firma con una clave ML-DSA-44 guardada dentro de MetaMask. Es una cuenta propia (no tu dirección de MetaMask): envíale ZETAPHY primero. Hasta que el snap esté en la lista permitida de MetaMask, se necesita MetaMask Flask.',
    badge: 'poscuántico',
    noSnaps: 'Esta billetera no puede ejecutar MetaMask Snaps. Usa MetaMask Flask (hasta que el ZETAPHY Snap esté permitido) o la billetera web de ZETAPHY.',
    badAccount: 'El snap respondió con una cuenta cuya dirección no coincide con su clave pública. No se firmó nada.',
    notFunded: (a) => `Esta cuenta poscuántica aún no está en la cadena. Envía primero algo de ZETAPHY a ${a}.`,
    noFunds: 'No hay suficiente ZETAPHY en la cuenta poscuántica para el importe y la comisión.',
    ecdsaOnly: 'El ZETAPHY Snap solo firma con ML-DSA. Esta acción necesita una firma ECDSA (de mensaje o de datos tipados), que no puede hacer: usa una billetera normal para ella.',
    wouldFail: (m) => `La llamada fallaría en la cadena, así que no se firmó nada: ${m}`,
    refused: (m) => `El nodo rechazó la transacción: ${m}`,
  },
  ko: {
    btn: 'ZETAPHY Snap: MetaMask 안의 양자 내성(ML-DSA) 서명',
    note: 'MetaMask 안에 보관된 ML-DSA-44 키로 서명합니다. 별도의 계정입니다(MetaMask 주소가 아님): 먼저 ZETAPHY를 보내세요. 스냅이 MetaMask 허용 목록에 오르기 전까지는 MetaMask Flask가 필요합니다.',
    badge: '양자 내성',
    noSnaps: '이 지갑은 MetaMask Snaps를 실행할 수 없습니다. MetaMask Flask(ZETAPHY Snap이 허용될 때까지) 또는 ZETAPHY 웹 지갑을 사용하세요.',
    badAccount: '스냅이 공개키와 맞지 않는 주소의 계정을 돌려주었습니다. 아무것도 서명하지 않았습니다.',
    notFunded: (a) => `이 양자 내성 계정은 아직 체인에 없습니다. 먼저 ${a}(으)로 ZETAPHY를 보내세요.`,
    noFunds: '양자 내성 계정의 ZETAPHY가 금액과 수수료에 부족합니다.',
    ecdsaOnly: 'ZETAPHY Snap은 ML-DSA로만 서명합니다. 이 작업은 ECDSA 서명(메시지 또는 타입 데이터 서명)이 필요하며 스냅은 이를 만들 수 없습니다: 일반 지갑을 사용하세요.',
    wouldFail: (m) => `이 호출은 체인에서 실패하므로 서명하지 않았습니다: ${m}`,
    refused: (m) => `노드가 거래를 거부했습니다: ${m}`,
  },
  ja: {
    btn: 'ZETAPHY Snap：MetaMask 内の耐量子署名（ML-DSA）',
    note: 'MetaMask 内に保管された ML-DSA-44 鍵で署名します。別のアカウントです（MetaMask のアドレスではありません）：先に ZETAPHY を送ってください。スナップが MetaMask の許可リストに載るまでは MetaMask Flask が必要です。',
    badge: '耐量子',
    noSnaps: 'このウォレットでは MetaMask Snaps を実行できません。MetaMask Flask（ZETAPHY Snap が許可されるまで）か、ZETAPHY ウェブウォレットを使ってください。',
    badAccount: 'スナップが返したアカウントのアドレスが公開鍵と一致しません。何も署名していません。',
    notFunded: (a) => `この耐量子アカウントはまだチェーン上にありません。先に ${a} に ZETAPHY を送ってください。`,
    noFunds: '耐量子アカウントの ZETAPHY が金額と手数料に足りません。',
    ecdsaOnly: 'ZETAPHY Snap は ML-DSA でのみ署名します。この操作には ECDSA 署名（メッセージまたは型付きデータの署名）が必要で、スナップには作れません：通常のウォレットを使ってください。',
    wouldFail: (m) => `この呼び出しはチェーン上で失敗するため、署名していません：${m}`,
    refused: (m) => `ノードが取引を拒否しました：${m}`,
  },
  ru: {
    btn: 'ZETAPHY Snap: постквантовая подпись (ML-DSA) в MetaMask',
    note: 'Подписывает ключом ML-DSA-44, который хранится внутри MetaMask. Это отдельный счёт (не ваш адрес MetaMask): сначала отправьте на него ZETAPHY. Пока снап не в списке разрешённых MetaMask, нужен MetaMask Flask.',
    badge: 'постквантовый',
    noSnaps: 'Этот кошелёк не может запускать MetaMask Snaps. Используйте MetaMask Flask (пока ZETAPHY Snap не разрешён) или веб-кошелёк ZETAPHY.',
    badAccount: 'Снап вернул счёт, адрес которого не соответствует его открытому ключу. Ничего не подписано.',
    notFunded: (a) => `Этого постквантового счёта ещё нет в сети. Сначала отправьте немного ZETAPHY на ${a}.`,
    noFunds: 'На постквантовом счёте не хватает ZETAPHY на сумму и комиссию.',
    ecdsaOnly: 'ZETAPHY Snap подписывает только ML-DSA. Для этого действия нужна подпись ECDSA (сообщения или типизированных данных), которую он сделать не может: используйте обычный кошелёк.',
    wouldFail: (m) => `Вызов завершился бы ошибкой в сети, поэтому ничего не подписано: ${m}`,
    refused: (m) => `Узел отклонил транзакцию: ${m}`,
  },
  vi: {
    btn: 'ZETAPHY Snap: ký hậu lượng tử (ML-DSA) trong MetaMask',
    note: 'Ký bằng khóa ML-DSA-44 giữ bên trong MetaMask. Đây là một tài khoản riêng (không phải địa chỉ MetaMask của bạn): hãy gửi ZETAPHY vào nó trước. Cho đến khi snap có trong danh sách cho phép của MetaMask, cần dùng MetaMask Flask.',
    badge: 'hậu lượng tử',
    noSnaps: 'Ví này không chạy được MetaMask Snaps. Hãy dùng MetaMask Flask (cho đến khi ZETAPHY Snap được cho phép) hoặc ví web ZETAPHY.',
    badAccount: 'Snap trả về một tài khoản có địa chỉ không khớp với khóa công khai. Chưa ký gì cả.',
    notFunded: (a) => `Tài khoản hậu lượng tử này chưa có trên chuỗi. Hãy gửi một ít ZETAPHY tới ${a} trước.`,
    noFunds: 'Tài khoản hậu lượng tử không đủ ZETAPHY cho số tiền và phí.',
    ecdsaOnly: 'ZETAPHY Snap chỉ ký bằng ML-DSA. Thao tác này cần chữ ký ECDSA (ký tin nhắn hoặc dữ liệu có cấu trúc), snap không làm được: hãy dùng ví thường cho việc này.',
    wouldFail: (m) => `Lệnh gọi sẽ thất bại trên chuỗi nên chưa ký gì: ${m}`,
    refused: (m) => `Node đã từ chối giao dịch: ${m}`,
  },
  th: {
    btn: 'ZETAPHY Snap: ลายเซ็นทนควอนตัม (ML-DSA) ใน MetaMask',
    note: 'เซ็นด้วยกุญแจ ML-DSA-44 ที่เก็บอยู่ใน MetaMask เป็นบัญชีแยกต่างหาก (ไม่ใช่ที่อยู่ MetaMask ของคุณ) ให้โอน ZETAPHY เข้าไปก่อน จนกว่า Snap จะอยู่ในรายชื่อที่ MetaMask อนุญาต ต้องใช้ MetaMask Flask',
    badge: 'ทนควอนตัม',
    noSnaps: 'กระเป๋านี้รัน MetaMask Snaps ไม่ได้ ใช้ MetaMask Flask (จนกว่า ZETAPHY Snap จะได้รับอนุญาต) หรือกระเป๋าเว็บ ZETAPHY',
    badAccount: 'Snap ตอบกลับบัญชีที่ที่อยู่ไม่ตรงกับกุญแจสาธารณะของมัน ยังไม่ได้เซ็นอะไร',
    notFunded: (a) => `บัญชีทนควอนตัมนี้ยังไม่อยู่บนเชน โอน ZETAPHY ไปที่ ${a} ก่อน`,
    noFunds: 'ZETAPHY ในบัญชีทนควอนตัมไม่พอสำหรับจำนวนเงินและค่าธรรมเนียม',
    ecdsaOnly: 'ZETAPHY Snap เซ็นด้วย ML-DSA เท่านั้น การทำรายการนี้ต้องใช้ลายเซ็น ECDSA (เซ็นข้อความหรือข้อมูลแบบมีโครงสร้าง) ซึ่ง Snap ทำไม่ได้ ใช้กระเป๋าทั่วไปสำหรับรายการนี้',
    wouldFail: (m) => `รายการนี้จะไม่สำเร็จบนเชน จึงยังไม่ได้เซ็น: ${m}`,
    refused: (m) => `โหนดปฏิเสธธุรกรรม: ${m}`,
  },
};

/** The text for `key` in `lang` (English when missing). */
export function pqsText(lang, key, ...args) {
  const m = (M[lang] ?? M.en)[key] ?? M.en[key];
  return typeof m === 'function' ? m(...args) : m;
}

function rpcError(code, message, extra = {}) { return Object.assign(new Error(message), { code, ...extra }); }
const clean = (s) => String(s ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
const toHex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
function fromHex(h) {
  const s = String(h ?? '').replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
}

// ---- bech32 (BIP-173), for the zetaphy1… form of the address
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  return chk >>> 0;
}
/** bech32 of `bytes` with human-readable part `hrp`. */
export function bech32(hrp, bytes) {
  const words = [];
  let acc = 0, bits = 0;
  for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); } }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const exp = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...exp, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const sum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...sum].map((w) => CHARSET[w]).join('')}`;
}

const ADDRESS_PREFIX = new TextEncoder().encode('zetaphy/mldsa44\0');
/** The ML-DSA-44 account of a public key: sha256("zetaphy/mldsa44\0" || pk)[:20] (pqAddress in pqtx.js). */
export async function pqAddressOf(publicKey, subtle = globalThis.crypto?.subtle) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('not an ML-DSA-44 public key');
  const buf = new Uint8Array(ADDRESS_PREFIX.length + publicKey.length);
  buf.set(ADDRESS_PREFIX);
  buf.set(publicKey, ADDRESS_PREFIX.length);
  const bytes = new Uint8Array(await subtle.digest('SHA-256', buf)).slice(0, 20);
  return { hex: `0x${toHex(bytes)}`, bech32: bech32('zetaphy', bytes) };
}

/** A MetaMask (or Flask) entry of a wallet list (discoverWallets): the only wallets that run snaps. */
export const snapHost = (list) => (Array.isArray(list) ? list.find((w) => w?.kind === 'flask') ?? list.find((w) => w?.kind === 'metamask') ?? null : null);

const clampGas = (g) => (g < MIN_EVM_GAS ? MIN_EVM_GAS : g > MAX_EVM_GAS ? MAX_EVM_GAS : g);
/** EVM gas for a call: the node's estimate + 25%, within [21000, 10M]. */
export const evmGasFor = (estimate) => clampGas((BigInt(estimate) * 125n) / 100n);

/** A CometBFT /tx answer as { code, log, height }, or null while the node does not know the hash. */
export function parseCometTx(j) {
  const r = j?.result;
  if (!r?.tx_result) return null;
  return { code: Number(r.tx_result.code ?? 0), log: clean(r.tx_result.log), height: String(r.height ?? '') };
}

/**
 * @param {object} o
 * @param {object} o.host        the MetaMask EIP-1193 provider (snapHost(list).provider)
 * @param {(m: string, p?: any[]) => Promise<any>} o.rpc   the node's JSON-RPC (reads, gas, broadcast)
 * @param {() => string} o.comet  the node's CometBFT RPC base (https://<node>/rpc): where the result is read
 * @param {number} [o.chainId]   the EVM chain id (77390)
 * @param {() => string} [o.lang]
 * @param {string} [o.snapId]
 * @param {Function} [o.fetch]
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} [o.clock]
 * @param {{timeoutMs?: number, everyMs?: number}} [o.watch]
 */
export function snapProvider({ host, rpc, comet, chainId = 77390, cosmosChainId = COSMOS_CHAIN_ID, lang = () => 'en', snapId = SNAP_ID,
  fetch: fetchFn = (...a) => globalThis.fetch(...a), clock = null, watch = {}, subtle = globalThis.crypto?.subtle }) {
  const listeners = new Map();
  const emit = (ev, v) => { for (const f of listeners.get(ev) ?? []) { try { f(v); } catch { /* listener */ } } };
  const chainHex = `0x${chainId.toString(16)}`;
  const now = clock?.now ?? (() => Date.now());
  const sleep = clock?.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const L = () => (PQS_LANGS.includes(lang()) ? lang() : 'en');
  let account = null; // { hex, bech32 }
  const unsupported = (e) => e?.code === -32601 || e?.code === 4200 || /does not exist|not supported|not available|unsupported/i.test(e?.message ?? '');

  async function invoke(method, params) {
    return host.request({ method: 'wallet_invokeSnap', params: { snapId, request: params === undefined ? { method } : { method, params } } });
  }

  /** The snap's account, checked against its public key. */
  async function readAccount() {
    const a = await invoke('zetaphy_getAccount');
    let pk;
    try { pk = fromHex(a?.publicKey); } catch { throw rpcError(4100, pqsText(L(), 'badAccount')); }
    if (pk.length !== PUBLIC_KEY_BYTES) throw rpcError(4100, pqsText(L(), 'badAccount'));
    const me = await pqAddressOf(pk, subtle);
    if (a.address !== me.bech32 || String(a.hex ?? '').toLowerCase() !== me.hex) throw rpcError(4100, pqsText(L(), 'badAccount'));
    // the snap's checksummed spelling (same bytes, checked above)
    return { hex: /^0x[0-9a-fA-F]{40}$/.test(a.hex) ? a.hex : me.hex, bech32: me.bech32 };
  }

  async function requestAccounts() {
    if (account) return [account.hex];
    try { await host.request({ method: 'wallet_getSnaps' }); } catch (e) { if (unsupported(e)) throw rpcError(4200, pqsText(L(), 'noSnaps')); }
    let snaps;
    try { snaps = await host.request({ method: 'wallet_requestSnaps', params: { [snapId]: {} } }); } catch (e) {
      if (unsupported(e)) throw rpcError(4200, pqsText(L(), 'noSnaps'));
      throw e; // 4001: the user said no in MetaMask
    }
    if (!snaps?.[snapId] || snaps[snapId].error) throw rpcError(4001, clean(snaps?.[snapId]?.error?.message) || 'snap not connected');
    account = await readAccount();
    emit('accountsChanged', [account.hex]);
    return [account.hex];
  }

  /** No prompt: the account when this site already has the snap. */
  async function silentAccounts() {
    if (account) return [account.hex];
    try {
      const snaps = await host.request({ method: 'wallet_getSnaps' });
      if (!snaps?.[snapId]) return [];
      account = await readAccount();
      return [account.hex];
    } catch { return []; }
  }

  async function cometTx(hash) {
    try {
      const r = await fetchFn(`${comet().replace(/\/+$/, '')}/tx?hash=0x${hash}`, { headers: { accept: 'application/json' } });
      return parseCometTx(await r.json());
    } catch { return null; }
  }

  /** eth_sendTransaction through the snap: one MsgEVMCall, signed with ML-DSA-44; resolves once it is in a block. */
  async function send(tx) {
    if (!account) throw rpcError(4100, 'not connected');
    if (tx.from && String(tx.from).toLowerCase() !== account.hex.toLowerCase()) throw rpcError(4100, 'from is not the snap account');
    if (tx.chainId != null && BigInt(tx.chainId) !== BigInt(chainId)) throw rpcError(4901, 'wrong chain', { chainId });
    if (!tx.to || !/^0x[0-9a-fA-F]{40}$/.test(tx.to)) throw rpcError(4200, 'contract creation is not offered through the snap here');
    const value = BigInt(tx.value ?? 0);
    const data = tx.data ?? tx.input ?? '0x';
    const call = { from: account.hex, to: tx.to, data, value: `0x${value.toString(16)}` };
    const [acct, price, bal, est] = await Promise.all([
      rpc('zetaphy_pqAccount', [account.bech32]),
      rpc('eth_gasPrice', []).then(BigInt),
      rpc('eth_getBalance', [account.hex, 'latest']).then(BigInt),
      tx.gas ?? tx.gasLimit ? Promise.resolve(BigInt(tx.gas ?? tx.gasLimit)) : rpc('eth_estimateGas', [call]).then(BigInt, (e) => { throw rpcError(-32000, pqsText(L(), 'wouldFail', clean(e?.message ?? e))); }),
    ]);
    if (!acct || typeof acct.exists !== 'boolean') throw new Error('the node did not answer zetaphy_pqAccount');
    if (acct.chainId && acct.chainId !== cosmosChainId) throw new Error(`the node is on ${clean(acct.chainId)}, not ${cosmosChainId}`);
    if (!acct.exists) throw rpcError(-32000, pqsText(L(), 'notFunded', account.hex));
    const evmGas = tx.gas ?? tx.gasLimit ? clampGas(est) : evmGasFor(est); // a gas the site set is kept (within the limits)
    const gasLimit = evmGas + EVM_CALL_GAS_OVERHEAD;
    const gasPrice = (price * 12n + 9n) / 10n; // bumpGasPrice in pqtx.js
    if (value + gasLimit * gasPrice > bal) throw rpcError(-32000, pqsText(L(), 'noFunds'));
    const sequence = BigInt(acct.sequence);
    const signed = await invoke('zetaphy_signTx', {
      chainId: cosmosChainId, accountNumber: String(BigInt(acct.accountNumber)), sequence: sequence.toString(),
      gasLimit: gasLimit.toString(), gasPrice: gasPrice.toString(), memo: '', lang: L() === 'th' ? 'th' : 'en',
      messages: [{ type: 'evmCall', to: tx.to, data: String(data).toLowerCase(), value: value.toString(), gasLimit: evmGas.toString() }],
    });
    if (!signed || typeof signed.txHex !== 'string') throw new Error('the snap returned no signed transaction');
    const r = await rpc('zetaphy_sendCosmosTx', [signed.txHex]);
    if (!r || typeof r.code !== 'number') throw new Error('the node did not answer zetaphy_sendCosmosTx');
    if (r.code !== 0) throw rpcError(-32000, pqsText(L(), 'refused', clean(r.log) || `code ${r.code}`));
    const hash = String(r.txHash || signed.txHash || '').replace(/^0x/, '').toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(hash)) throw new Error('no transaction hash from the node');
    const evmHash = `0x${hash.toLowerCase()}`;
    // In a block, failed, or not yet: read from CometBFT (a Cosmos tx has no EVM receipt).
    const { timeoutMs = 180_000, everyMs = 2000 } = watch;
    const t0 = now();
    while (now() - t0 < timeoutMs) {
      const res = await cometTx(hash);
      if (res) {
        const receipt = { status: res.code === 0 ? '0x1' : '0x0', transactionHash: evmHash, cosmosTxHash: hash, blockNumber: /^\d+$/.test(res.height) ? `0x${BigInt(res.height).toString(16)}` : null, from: account.hex, to: tx.to, zetaphySnap: true, log: res.log };
        settleTx(evmHash, receipt);
        if (res.code !== 0) throw Object.assign(new Error(`${txgText(L(), 'failed')} ${res.log}`.trim()), { txGuard: 'failed', hash: evmHash, receipt });
        return evmHash;
      }
      await sleep(everyMs);
    }
    throw Object.assign(new Error(txgText(L(), 'timeout')), { txGuard: 'timeout', hash: evmHash, cosmosTxHash: hash });
  }

  async function request({ method, params = [] }) {
    switch (method) {
      case 'eth_requestAccounts': return requestAccounts();
      case 'eth_accounts': return silentAccounts();
      case 'eth_chainId': return chainHex;
      case 'net_version': return String(chainId);
      case 'wallet_switchEthereumChain':
      case 'wallet_addEthereumChain':
        if (BigInt(params?.[0]?.chainId ?? -1) === BigInt(chainId)) return null;
        throw rpcError(4902, 'the ZETAPHY Snap signs for the ZETAPHY chain only', { chainId });
      case 'wallet_requestPermissions': await requestAccounts(); return [{ parentCapability: 'eth_accounts' }];
      case 'wallet_revokePermissions': forget(); return null;
      case 'wallet_watchAsset': return false; // MetaMask's token list belongs to its ECDSA accounts
      case 'eth_sendTransaction': return send(params[0] ?? {});
      case 'eth_getTransactionReceipt': {
        const known = settledTx(params[0]);
        return known ?? rpc(method, params);
      }
      case 'personal_sign': case 'eth_sign': case 'eth_signTransaction': case 'eth_signTypedData': case 'eth_signTypedData_v3': case 'eth_signTypedData_v4':
        throw rpcError(4200, pqsText(L(), 'ecdsaOnly'));
      default:
        if (/^(eth_|net_|web3_)/.test(method)) return rpc(method, params);
        throw rpcError(4200, `${method} is not supported`);
    }
  }
  /** Forgets the account (idle, disconnect): the next use asks MetaMask again. */
  function forget() {
    const had = account;
    account = null;
    if (had) emit('accountsChanged', []);
  }

  return {
    isZetaphySnap: true, isPostQuantum: true,
    request,
    on: (ev, f) => { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev).add(f); },
    removeListener: (ev, f) => listeners.get(ev)?.delete(f),
    forget,
    address: () => account,
  };
}
