// Keeps transactions from getting stuck in the wallet (one file, copied as-is into each app; a test checks the copies).
//
// What leaves a transaction "pending" in MetaMask, Binance, Trust or Phantom:
//   - the node is down: the wallet signs, cannot broadcast, and shows the transaction as pending for good;
//   - a second click while the wallet still shows the first request: requests pile up in the wallet;
//   - an older transaction of the same account is stuck in the node's queue: every new one waits behind it;
//   - the page stops watching (closed, timed out) and says nothing, so the user does not know what to do.
// So, before the wallet opens: the node must answer, nothing else may be waiting in the wallet from this page,
// and the account must have no stuck transaction. After sending: watch until it is in a block, failed, never
// reached the node, or the wait is over, and say which, with what to do in the wallet. Closing the page stops
// the watch; nothing the page sent stays half-done on its side.

export const TXG_LANGS = ['en', 'zh', 'es', 'ko', 'ja', 'ru', 'vi', 'th'];

const M = {
  en: {
    down: 'The ZETAPHY network is not answering right now, so nothing was sent to your wallet. Try again in a few minutes.',
    busy: 'Your wallet is still showing an earlier request from this page. Confirm or reject it in the wallet first.',
    stuck: (n) => `This account has ${n} earlier transaction(s) still waiting on the network. New ones would wait behind them. In your wallet, open Activity and press Cancel (or Speed up) on the pending one, then try again.`,
    timeout: 'Sent, but not in a block yet. Nothing more is needed from this page. If it stays pending in your wallet: open Activity and press Speed up or Cancel.',
    dropped: 'The network never received this transaction (the wallet could not broadcast it). It will not go through. To clear it from the wallet: MetaMask: Settings > Advanced > Clear activity tab data; other wallets: press Cancel on it.',
    failed: 'The transaction was included but failed; nothing changed except the fee.',
    cancelled: 'Cancelled. Nothing was sent.',
  },
  zh: {
    down: 'ZETAPHY 网络暂时没有响应，因此没有向钱包发送任何请求。请几分钟后再试。',
    busy: '钱包里还有本页面之前的请求。请先在钱包中确认或拒绝它。',
    stuck: (n) => `此账户有 ${n} 笔之前的交易仍在网络上等待，新交易会排在它们后面。请在钱包的"活动"中对待处理的交易点击"取消"（或"加速"），然后再试。`,
    timeout: '已发送，但还没有进入区块。本页面无需再做任何操作。如果钱包中一直显示待处理：在"活动"中点击"加速"或"取消"。',
    dropped: '网络从未收到这笔交易（钱包无法广播），它不会成功。从钱包中清除：MetaMask：设置 > 高级 > 清除活动标签数据；其他钱包：对它点击"取消"。',
    failed: '交易已上链但执行失败；除手续费外没有任何变化。',
    cancelled: '已取消，没有发送任何内容。',
  },
  es: {
    down: 'La red ZETAPHY no responde ahora, así que no se envió nada a tu billetera. Inténtalo de nuevo en unos minutos.',
    busy: 'Tu billetera aún muestra una solicitud anterior de esta página. Confírmala o recházala primero en la billetera.',
    stuck: (n) => `Esta cuenta tiene ${n} transacción(es) anterior(es) esperando en la red. Las nuevas esperarían detrás. En tu billetera, abre Actividad y pulsa Cancelar (o Acelerar) en la pendiente, y vuelve a intentarlo.`,
    timeout: 'Enviada, pero aún no está en un bloque. No hace falta nada más en esta página. Si sigue pendiente en tu billetera: abre Actividad y pulsa Acelerar o Cancelar.',
    dropped: 'La red nunca recibió esta transacción (la billetera no pudo difundirla). No se completará. Para quitarla de la billetera: MetaMask: Configuración > Avanzado > Borrar datos de la pestaña de actividad; otras billeteras: pulsa Cancelar en ella.',
    failed: 'La transacción se incluyó pero falló; no cambió nada salvo la comisión.',
    cancelled: 'Cancelado. No se envió nada.',
  },
  ko: {
    down: 'ZETAPHY 네트워크가 지금 응답하지 않아 지갑으로 아무것도 보내지 않았습니다. 몇 분 후 다시 시도하세요.',
    busy: '지갑에 이 페이지의 이전 요청이 아직 남아 있습니다. 먼저 지갑에서 승인하거나 거절하세요.',
    stuck: (n) => `이 계정에 네트워크에서 대기 중인 이전 거래가 ${n}건 있습니다. 새 거래는 그 뒤에서 기다리게 됩니다. 지갑의 활동에서 대기 중인 거래에 취소(또는 가속)를 누른 뒤 다시 시도하세요.`,
    timeout: '전송했지만 아직 블록에 포함되지 않았습니다. 이 페이지에서 더 할 일은 없습니다. 지갑에 계속 대기 중으로 표시되면 활동에서 가속 또는 취소를 누르세요.',
    dropped: '네트워크가 이 거래를 받지 못했습니다(지갑이 전파하지 못함). 처리되지 않습니다. 지갑에서 지우기: MetaMask: 설정 > 고급 > 활동 탭 데이터 지우기, 다른 지갑: 해당 거래에서 취소.',
    failed: '거래가 블록에 포함되었지만 실패했습니다. 수수료 외에는 바뀐 것이 없습니다.',
    cancelled: '취소했습니다. 아무것도 보내지 않았습니다.',
  },
  ja: {
    down: 'ZETAPHY ネットワークが現在応答しないため、ウォレットには何も送っていません。数分後にもう一度お試しください。',
    busy: 'ウォレットにこのページからの前のリクエストが残っています。先にウォレットで承認または拒否してください。',
    stuck: (n) => `このアカウントにはネットワークで待機中の取引が ${n} 件あります。新しい取引はその後ろで待つことになります。ウォレットのアクティビティで保留中の取引の「キャンセル」(または「高速化」)を押してから、もう一度お試しください。`,
    timeout: '送信しましたが、まだブロックに入っていません。このページでの操作は不要です。ウォレットで保留のままなら、アクティビティで「高速化」か「キャンセル」を押してください。',
    dropped: 'ネットワークはこの取引を受け取っていません(ウォレットが送信できませんでした)。処理されません。ウォレットから消すには、MetaMask: 設定 > 高度な設定 > アクティビティタブのデータを消去、他のウォレット: その取引で「キャンセル」。',
    failed: '取引はブロックに入りましたが失敗しました。手数料以外は何も変わっていません。',
    cancelled: 'キャンセルしました。何も送っていません。',
  },
  ru: {
    down: 'Сеть ZETAPHY сейчас не отвечает, поэтому в кошелёк ничего не отправлено. Попробуйте через несколько минут.',
    busy: 'В кошельке ещё открыт предыдущий запрос этой страницы. Сначала подтвердите или отклоните его в кошельке.',
    stuck: (n) => `У этого счёта ${n} предыдущих транзакций ещё ждут в сети. Новые будут ждать за ними. В кошельке откройте «Активность» и нажмите «Отменить» (или «Ускорить») у ожидающей, затем попробуйте снова.`,
    timeout: 'Отправлено, но ещё не в блоке. На этой странице больше ничего делать не нужно. Если в кошельке она висит как ожидающая: «Активность» → «Ускорить» или «Отменить».',
    dropped: 'Сеть так и не получила эту транзакцию (кошелёк не смог её разослать). Она не пройдёт. Убрать её из кошелька: MetaMask: Настройки > Дополнительно > Очистить данные вкладки активности; другие кошельки: нажмите «Отменить».',
    failed: 'Транзакция попала в блок, но завершилась ошибкой; изменилась только комиссия.',
    cancelled: 'Отменено. Ничего не отправлено.',
  },
  vi: {
    down: 'Mạng ZETAPHY hiện không phản hồi nên chưa có gì được gửi tới ví. Hãy thử lại sau vài phút.',
    busy: 'Ví của bạn vẫn đang hiện yêu cầu trước từ trang này. Hãy xác nhận hoặc từ chối nó trong ví trước.',
    stuck: (n) => `Tài khoản này có ${n} giao dịch trước vẫn đang chờ trên mạng. Giao dịch mới sẽ phải chờ sau chúng. Trong ví, mở Hoạt động và bấm Hủy (hoặc Tăng tốc) ở giao dịch đang chờ, rồi thử lại.`,
    timeout: 'Đã gửi nhưng chưa vào khối. Trang này không cần làm gì thêm. Nếu ví vẫn báo đang chờ: mở Hoạt động và bấm Tăng tốc hoặc Hủy.',
    dropped: 'Mạng chưa từng nhận giao dịch này (ví không phát đi được). Nó sẽ không thành công. Xóa khỏi ví: MetaMask: Cài đặt > Nâng cao > Xóa dữ liệu thẻ hoạt động; ví khác: bấm Hủy ở giao dịch đó.',
    failed: 'Giao dịch đã vào khối nhưng thất bại; không có gì thay đổi ngoài phí.',
    cancelled: 'Đã hủy. Không có gì được gửi.',
  },
  th: {
    down: 'เครือข่าย ZETAPHY ไม่ตอบในตอนนี้ จึงยังไม่ได้ส่งอะไรไปที่กระเป๋า ลองใหม่อีกครั้งในอีกไม่กี่นาที',
    busy: 'กระเป๋ายังแสดงคำขอก่อนหน้าจากหน้านี้ค้างอยู่ กดยืนยันหรือปฏิเสธในกระเป๋าก่อน',
    stuck: (n) => `บัญชีนี้มีธุรกรรมก่อนหน้า ${n} รายการที่ยังรออยู่ในเครือข่าย ธุรกรรมใหม่จะต้องรอต่อท้าย เปิด กิจกรรม (Activity) ในกระเป๋า แล้วกด ยกเลิก (Cancel) หรือ เร่ง (Speed up) ที่รายการที่ค้าง จากนั้นลองใหม่`,
    timeout: 'ส่งแล้ว แต่ยังไม่เข้าบล็อก หน้านี้ไม่ต้องทำอะไรเพิ่ม ถ้าในกระเป๋ายังขึ้นว่ารออยู่ ให้เปิด กิจกรรม แล้วกด เร่ง หรือ ยกเลิก',
    dropped: 'เครือข่ายไม่เคยได้รับธุรกรรมนี้ (กระเป๋าส่งออกไปไม่ได้) จึงจะไม่สำเร็จ ล้างออกจากกระเป๋า: MetaMask: Settings > Advanced > Clear activity tab data, กระเป๋าอื่น: กด ยกเลิก ที่รายการนั้น',
    failed: 'ธุรกรรมเข้าบล็อกแล้วแต่ไม่สำเร็จ ไม่มีอะไรเปลี่ยนนอกจากค่าธรรมเนียม',
    cancelled: 'ยกเลิกแล้ว ไม่ได้ส่งอะไรออกไป',
  },
};

/** The message for `key` in `lang` (English when missing). */
export function txgText(lang, key, ...args) {
  const m = (M[lang] ?? M.en)[key] ?? M.en[key];
  return typeof m === 'function' ? m(...args) : m;
}

/** An Error with a `txGuard` code the apps can show as is (`code` 4001 for "cancelled", as wallets do). */
export function txgError(lang, key, ...args) {
  return Object.assign(new Error(txgText(lang, key, ...args)), { txGuard: key, ...(key === 'cancelled' ? { code: 4001 } : {}) });
}

const timeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);

/** True when the node answers eth_chainId with `chainId` (a number) within `ms`. */
export async function nodeAlive(rpc, chainId, ms = 8000) {
  try { return Number(BigInt(await timeout(rpc('eth_chainId', []), ms))) === Number(chainId); } catch { return false; }
}

/** How many of `from`'s transactions the node still holds unmined (pending nonce - mined nonce); 0 when unknown. */
export async function stuckCount(rpc, from, ms = 8000) {
  try {
    const [pend, mined] = await timeout(Promise.all([rpc('eth_getTransactionCount', [from, 'pending']), rpc('eth_getTransactionCount', [from, 'latest'])]), ms);
    const d = BigInt(pend) - BigInt(mined);
    return d > 0n ? Number(d) : 0;
  } catch { return 0; }
}

/**
 * One wallet request at a time per page: `run(fn)` refuses (code 'busy') while an earlier one has not answered.
 * A request the wallet never answers is forgotten after `maxMs`, so the page is never locked for good.
 */
export function walletLock({ maxMs = 10 * 60_000, now = () => Date.now() } = {}) {
  let since = 0;
  return {
    busy: () => since !== 0 && now() - since < maxMs,
    async run(fn, lang = 'en') {
      if (since !== 0 && now() - since < maxMs) throw txgError(lang, 'busy');
      since = now();
      try { return await fn(); } finally { since = 0; }
    },
  };
}

/**
 * Before the wallet opens: the node answers as `chainId`, and `from` has nothing stuck. Throws the message to show.
 */
export async function preflight({ rpc, chainId, from, lang = 'en' }) {
  if (!(await nodeAlive(rpc, chainId))) throw txgError(lang, 'down');
  const n = from ? await stuckCount(rpc, from) : 0;
  if (n > 0) throw txgError(lang, 'stuck', n);
}

/**
 * After the wallet returns a hash: { status: 'ok' | 'failed' | 'timeout' | 'dropped' | 'stopped', receipt? }.
 * 'dropped' = the node has never seen the hash after `dropMs` (the wallet could not broadcast it).
 * Stops ('stopped') when `signal` aborts, e.g. on pagehide.
 */
export async function watchTx({ rpc, hash, from = null, timeoutMs = 180_000, dropMs = 45_000, everyMs = 2000, signal, sleep, now = () => Date.now() }) {
  const t0 = now();
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let seen = false;
  while (now() - t0 < timeoutMs) {
    if (signal?.aborted) return { status: 'stopped' };
    const rc = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) return { status: rc.status === '0x1' ? 'ok' : 'failed', receipt: rc };
    if (!seen) seen = !!(await rpc('eth_getTransactionByHash', [hash]).catch(() => null));
    // a node that does not serve queued transactions by hash still counts them in the pending nonce
    if (!seen && from && now() - t0 >= dropMs) seen = (await stuckCount(rpc, from)) > 0;
    if (!seen && now() - t0 >= dropMs) return { status: 'dropped' };
    await wait(everyMs);
  }
  return { status: signal?.aborted ? 'stopped' : 'timeout' };
}

/** An AbortSignal that fires when the page is hidden for good (closed, navigated away): stops every watch. */
export function pageSignal(win = globalThis.window) {
  const ctl = new AbortController();
  win?.addEventListener?.('pagehide', (e) => { if (!e.persisted) ctl.abort(); });
  return ctl.signal;
}

/**
 * The whole path: preflight, then `request()` (the wallet call that returns the hash) under the lock, then the
 * watch. Resolves with the hash when it is in a block; otherwise throws the message to show (`txGuard` says which).
 */
export async function guardedSend({ rpc, chainId, from, lang = 'en', lock, request, signal, watch = {} }) {
  await preflight({ rpc, chainId, from, lang });
  const hash = await (lock ? lock.run(request, lang) : request());
  if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('no transaction hash from the wallet');
  const r = await watchTx({ rpc, hash, from, signal, ...watch });
  if (r.status === 'ok' || r.status === 'stopped') return hash;
  throw Object.assign(txgError(lang, r.status), { hash });
}
