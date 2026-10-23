// The DLMM tab of the DEX page (UNAUDITED contracts, testnet only): pick a
// pair and bin step, see the bins around the price, add liquidity over a
// range (spot / curve / bid-ask), remove it, and swap through the DLMM
// router. Uses the page's own wallet, RPC, Neuro checks and transaction flow
// (passed in by app.js); every text goes in with textContent. The DLMM
// contracts come from deployments.json (contracts.dlmmFactory,
// contracts.dlmmRouter); without them the tab says so and does nothing.

import { encodeDlmmCall, decodeWords, dlmmErrorName, displayPrice, idFromPrice, distribute, minAfter } from './lib/dlmm.js';
import { parseUnits, formatUnits, isAddress, ZERO_ADDRESS } from './lib/abi.js';

export const TEXT = {
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
  zh: {
    title: 'DLMM · 分档流动性', unaudited: '⚠️ 新功能，未经审计（UNAUDITED）。仅限测试网。',
    notDeployed: '此网络尚未部署 DLMM', pair: '交易对', binStep: 'bin step', load: '加载',
    noPair: '该资金池尚不存在：首次存入将按您设定的初始价格创建它', empty: '资金池为空：由首个存入者设定价格',
    active: 'active bin {id} · 价格 1 {x} = {p} {y}', fee: '基础费率 {f}%（+ 波动费）', reserves: '池中：{x} · {y}',
    addTitle: '添加流动性', below: '价格下方的 bin 数量', above: '价格上方的 bin 数量', shape: '分布形状', spot: 'Spot（均匀）', curve: 'Curve（集中在价格附近）', bidask: 'Bid-Ask（远离价格）',
    startPrice: '初始价格（每 1 {x} 对应的 {y}）', approve: '授权 {sym}', add: '添加流动性', adding: '正在添加流动性…',
    preview: '{n} 个 bin · 使用 {x} + {y}', posTitle: '我的 DLMM 流动性（此资金池）', noPos: '此资金池中暂无流动性', connect: '连接钱包以查看',
    posLine: '{n} 个 bin（{lo} … {hi}）· 约可取回 {x} + {y}', remove: '移除 {p}%', removing: '移除中…', approveRouter: '正在授权 router 销毁您在此资金池中的份额（setApprovalForAll）…',
    revoke: '撤销 router 授权', swapTitle: '通过 DLMM 兑换', amountIn: '支付', quote: '约 {out} {sym} · 最少 {min}', swap: '兑换', swapping: '兑换中…',
    enforced: '已拒绝：Neuro 对 {sym} 的标记已强制生效', ack: '我已阅读 Neuro 的警告', needAck: '请先勾选确认 Neuro 警告', badAmount: '数量无效',
    tooWide: '最多 100 个 bin', chart: '价格附近的 bin（蓝色 = {x}，紫色 = {y}）', failed: '失败：{msg}',
    err_IdSlippage: '价格移动的 bin 数超出允许范围。请重试。', err_InsufficientXAmount: '价格已变动：使用的 X 低于最低值', err_InsufficientYAmount: '价格已变动：使用的 Y 低于最低值',
    err_ZeroShares: '某个 bin 的数量太小（或 active bin 需要按比例同时存入两种代币）', err_SingleSidedViolation: '价格上方的 bin 只接受 X，下方只接受 Y',
    err_OutOfLiquidity: '流动性不足以满足该数量', err_TooManyBinsCrossed: '需要跨越超过 100 个 bin：请拆分交易', err_FeeOnTransferNotSupported: 'DLMM 不支持转账收费代币',
    err_NotApproved: '尚未授权 router 销毁您的份额', err_InsufficientShares: '份额不足', err_PriceOutOfRange: '该价格超出支持范围', err_PresetNotEnabled: '该 bin step 未启用',
    err_InsufficientOutputAmount: '价格变动超出滑点容差。请重试。', err_Expired: '交易已超过截止时间。请重试。', err_ZeroAmount: '数量为零', err_BalanceBelowReserves: '资金池的代币余额自行减少（rebase 代币）：不支持',
  },
  es: {
    title: 'DLMM · liquidez por bins', unaudited: '⚠️ Nuevo y SIN AUDITAR (UNAUDITED). Solo testnet.',
    notDeployed: 'El DLMM aún no está desplegado en esta red', pair: 'Par', binStep: 'bin step', load: 'Cargar',
    noPair: 'Este pool aún no existe: el primer depósito lo crea al precio inicial que fijes', empty: 'El pool está vacío: el primer depositante fija el precio',
    active: 'bin activo {id} · precio 1 {x} = {p} {y}', fee: 'comisión base {f}% (+ comisión por volatilidad)', reserves: 'En el pool: {x} · {y}',
    addTitle: 'Añadir liquidez', below: 'bins por debajo del precio', above: 'bins por encima del precio', shape: 'Forma', spot: 'Spot (uniforme)', curve: 'Curve (cerca del precio)', bidask: 'Bid-Ask (lejos del precio)',
    startPrice: 'Precio inicial ({y} por 1 {x})', approve: 'Aprobar {sym}', add: 'Añadir liquidez', adding: 'Añadiendo liquidez…',
    preview: '{n} bins · usa {x} + {y}', posTitle: 'Mi liquidez DLMM (este pool)', noPos: 'Aún no hay liquidez en este pool', connect: 'Conecta una billetera para verla',
    posLine: '{n} bins ({lo} … {hi}) · unos {x} + {y} por retirar', remove: 'Retirar {p}%', removing: 'Retirando…', approveRouter: 'Autorizando al router a quemar tus participaciones en este pool (setApprovalForAll)…',
    revoke: 'Revocar el router', swapTitle: 'Intercambiar a través del DLMM', amountIn: 'Pagas', quote: 'Aprox. {out} {sym} · mínimo {min}', swap: 'Intercambiar', swapping: 'Intercambiando…',
    enforced: 'Rechazado: la marca de Neuro sobre {sym} está en vigor', ack: 'He leído la advertencia de Neuro', needAck: 'Marca primero la confirmación de Neuro', badAmount: 'Cantidad no válida',
    tooWide: 'Como máximo 100 bins', chart: 'bins alrededor del precio (azul = {x}, morado = {y})', failed: 'Error: {msg}',
    err_IdSlippage: 'El precio se movió más bins de los permitidos. Inténtalo de nuevo.', err_InsufficientXAmount: 'El precio se movió: X usado por debajo del mínimo', err_InsufficientYAmount: 'El precio se movió: Y usado por debajo del mínimo',
    err_ZeroShares: 'Una cantidad es demasiado pequeña para un bin (o el bin activo necesita ambos tokens en su proporción)', err_SingleSidedViolation: 'Los bins por encima del precio solo aceptan X; los de debajo, solo Y',
    err_OutOfLiquidity: 'No hay suficiente liquidez para esta cantidad', err_TooManyBinsCrossed: 'Hay que cruzar más de 100 bins: divide la operación', err_FeeOnTransferNotSupported: 'El DLMM no admite tokens con comisión por transferencia',
    err_NotApproved: 'El router aún no tiene permiso para quemar tus participaciones', err_InsufficientShares: 'Participaciones insuficientes', err_PriceOutOfRange: 'Ese precio está fuera del rango admitido', err_PresetNotEnabled: 'Ese bin step no está habilitado',
    err_InsufficientOutputAmount: 'El precio se movió más de lo que permite tu deslizamiento. Inténtalo de nuevo.', err_Expired: 'Venció el plazo de la transacción. Inténtalo de nuevo.', err_ZeroAmount: 'Cantidad cero', err_BalanceBelowReserves: 'El saldo de tokens del pool disminuyó por sí solo (token rebase): no compatible',
  },
  ko: {
    title: 'DLMM · bin 단위 유동성', unaudited: '⚠️ 새 기능이며 감사를 받지 않았습니다(UNAUDITED). 테스트넷 전용.',
    notDeployed: '이 네트워크에는 아직 DLMM이 배포되지 않았습니다', pair: '페어', binStep: 'bin step', load: '불러오기',
    noPair: '이 풀은 아직 없습니다: 첫 예치가 당신이 정한 시작 가격으로 풀을 만듭니다', empty: '풀이 비어 있습니다: 첫 예치자가 가격을 정합니다',
    active: 'active bin {id} · 가격 1 {x} = {p} {y}', fee: '기본 수수료 {f}% (+ 변동성 수수료)', reserves: '풀 보유량: {x} · {y}',
    addTitle: '유동성 추가', below: '가격 아래 bin 수', above: '가격 위 bin 수', shape: '분포 형태', spot: 'Spot (균등)', curve: 'Curve (가격 근처 집중)', bidask: 'Bid-Ask (가격에서 멀리)',
    startPrice: '시작 가격 (1 {x}당 {y})', approve: '{sym} 승인', add: '유동성 추가', adding: '유동성 추가 중…',
    preview: 'bin {n}개 · {x} + {y} 사용', posTitle: '내 DLMM 유동성 (이 풀)', noPos: '이 풀에 아직 유동성이 없습니다', connect: '지갑을 연결하면 볼 수 있습니다',
    posLine: 'bin {n}개 ({lo} … {hi}) · 약 {x} + {y} 인출 가능', remove: '{p}% 제거', removing: '제거 중…', approveRouter: '이 풀에서 router가 당신의 지분을 소각하도록 허용하는 중 (setApprovalForAll)…',
    revoke: 'router 권한 취소', swapTitle: 'DLMM으로 스왑', amountIn: '지불', quote: '약 {out} {sym} · 최소 {min}', swap: '스왑', swapping: '스왑 중…',
    enforced: '거부됨: {sym}에 대한 Neuro의 플래그가 강제 적용 중입니다', ack: 'Neuro의 경고를 읽었습니다', needAck: '먼저 Neuro 확인란을 체크하세요', badAmount: '잘못된 수량',
    tooWide: '최대 100개 bin', chart: '가격 주변 bin (파랑 = {x}, 보라 = {y})', failed: '실패: {msg}',
    err_IdSlippage: '가격이 허용된 것보다 많은 bin만큼 움직였습니다. 다시 시도하세요.', err_InsufficientXAmount: '가격 변동: 사용된 X가 최소값 미만', err_InsufficientYAmount: '가격 변동: 사용된 Y가 최소값 미만',
    err_ZeroShares: '한 bin에 넣기에는 수량이 너무 적습니다(또는 active bin에는 비율에 맞게 두 토큰이 모두 필요합니다)', err_SingleSidedViolation: '가격 위 bin은 X만, 아래 bin은 Y만 받습니다',
    err_OutOfLiquidity: '이 수량에 필요한 유동성이 부족합니다', err_TooManyBinsCrossed: '100개가 넘는 bin을 지나야 합니다: 거래를 나누세요', err_FeeOnTransferNotSupported: 'DLMM은 전송 수수료 토큰을 지원하지 않습니다',
    err_NotApproved: 'router가 아직 지분 소각 권한을 받지 않았습니다', err_InsufficientShares: '지분이 부족합니다', err_PriceOutOfRange: '지원 범위를 벗어난 가격입니다', err_PresetNotEnabled: '이 bin step은 활성화되지 않았습니다',
    err_InsufficientOutputAmount: '가격이 슬리피지 허용 범위보다 더 움직였습니다. 다시 시도하세요.', err_Expired: '거래 기한이 지났습니다. 다시 시도하세요.', err_ZeroAmount: '수량이 0입니다', err_BalanceBelowReserves: '풀의 토큰 잔액이 저절로 줄었습니다(리베이스 토큰): 지원하지 않음',
  },
  ja: {
    title: 'DLMM · ビン型流動性', unaudited: '⚠️ 新機能で未監査（UNAUDITED）です。テストネット専用。',
    notDeployed: 'このネットワークには DLMM がまだデプロイされていません', pair: 'ペア', binStep: 'bin step', load: '読み込む',
    noPair: 'このプールはまだありません: 最初の入金で、あなたが設定した初期価格のプールが作成されます', empty: 'プールは空です: 最初の入金者が価格を設定します',
    active: 'active bin {id} · 価格 1 {x} = {p} {y}', fee: '基本手数料 {f}%（+ ボラティリティ手数料）', reserves: 'プール内: {x} · {y}',
    addTitle: '流動性を追加', below: '価格より下の bin 数', above: '価格より上の bin 数', shape: '分布の形', spot: 'Spot（均等）', curve: 'Curve（価格付近に集中）', bidask: 'Bid-Ask（価格から離す）',
    startPrice: '初期価格（1 {x} あたりの {y}）', approve: '{sym} を承認', add: '流動性を追加', adding: '流動性を追加中…',
    preview: '{n} bin · {x} + {y} を使用', posTitle: '自分の DLMM 流動性（このプール）', noPos: 'このプールにはまだ流動性がありません', connect: 'ウォレットを接続すると表示されます',
    posLine: '{n} bin（{lo} … {hi}）· 約 {x} + {y} を引き出せます', remove: '{p}% を引き出す', removing: '引き出し中…', approveRouter: 'このプールのシェアをバーンする権限を router に付与しています（setApprovalForAll）…',
    revoke: 'router の権限を取り消す', swapTitle: 'DLMM でスワップ', amountIn: '支払う', quote: '約 {out} {sym} · 最低 {min}', swap: 'スワップ', swapping: 'スワップ中…',
    enforced: '拒否: {sym} に対する Neuro のフラグが強制適用されています', ack: 'Neuro の警告を読みました', needAck: '先に Neuro の確認にチェックを入れてください', badAmount: '無効な数量です',
    tooWide: '最大 100 bin まで', chart: '価格周辺の bin（青 = {x}、紫 = {y}）', failed: '失敗: {msg}',
    err_IdSlippage: '価格が許容より多くの bin を動きました。もう一度お試しください。', err_InsufficientXAmount: '価格が変動: 使用した X が最低額未満', err_InsufficientYAmount: '価格が変動: 使用した Y が最低額未満',
    err_ZeroShares: 'bin に対して数量が少なすぎます（または active bin では両方のトークンが比率どおりに必要です）', err_SingleSidedViolation: '価格より上の bin は X のみ、下の bin は Y のみ受け付けます',
    err_OutOfLiquidity: 'この数量に対して流動性が不足しています', err_TooManyBinsCrossed: '100 を超える bin をまたぎます: 取引を分割してください', err_FeeOnTransferNotSupported: 'DLMM は送金時手数料トークンに対応していません',
    err_NotApproved: 'router にシェアをバーンする権限がまだありません', err_InsufficientShares: 'シェアが不足しています', err_PriceOutOfRange: 'その価格は対応範囲外です', err_PresetNotEnabled: 'その bin step は有効になっていません',
    err_InsufficientOutputAmount: '価格がスリッページ許容値を超えて動きました。もう一度お試しください。', err_Expired: '取引期限が過ぎました。もう一度お試しください。', err_ZeroAmount: '数量がゼロです', err_BalanceBelowReserves: 'プールのトークン残高がひとりでに減りました（リベーストークン）: 非対応',
  },
  ru: {
    title: 'DLMM · ликвидность по бинам', unaudited: '⚠️ Новый модуль, БЕЗ АУДИТА (UNAUDITED). Только тестнет.',
    notDeployed: 'DLMM ещё не развёрнут в этой сети', pair: 'Пара', binStep: 'bin step', load: 'Загрузить',
    noPair: 'Такого пула ещё нет: первый депозит создаст его по заданной вами начальной цене', empty: 'Пул пуст: цену задаёт первый вкладчик',
    active: 'активный бин {id} · цена 1 {x} = {p} {y}', fee: 'базовая комиссия {f}% (+ комиссия за волатильность)', reserves: 'В пуле: {x} · {y}',
    addTitle: 'Добавить ликвидность', below: 'бинов ниже цены', above: 'бинов выше цены', shape: 'Форма', spot: 'Spot (равномерно)', curve: 'Curve (около цены)', bidask: 'Bid-Ask (вдали от цены)',
    startPrice: 'Начальная цена ({y} за 1 {x})', approve: 'Одобрить {sym}', add: 'Добавить ликвидность', adding: 'Добавление ликвидности…',
    preview: 'бинов: {n} · используется {x} + {y}', posTitle: 'Моя ликвидность DLMM (этот пул)', noPos: 'В этом пуле пока нет ликвидности', connect: 'Подключите кошелёк, чтобы увидеть',
    posLine: 'бинов: {n} ({lo} … {hi}) · к выводу примерно {x} + {y}', remove: 'Вывести {p}%', removing: 'Вывод…', approveRouter: 'Разрешаем router сжигать ваши доли в этом пуле (setApprovalForAll)…',
    revoke: 'Отозвать разрешение router', swapTitle: 'Обмен через DLMM', amountIn: 'Вы платите', quote: 'Около {out} {sym} · минимум {min}', swap: 'Обменять', swapping: 'Обмен…',
    enforced: 'Отклонено: отметка Neuro для {sym} применяется принудительно', ack: 'Я прочитал(а) предупреждение Neuro', needAck: 'Сначала отметьте подтверждение Neuro', badAmount: 'Неверная сумма',
    tooWide: 'Не более 100 бинов', chart: 'бины вокруг цены (синий = {x}, фиолетовый = {y})', failed: 'Ошибка: {msg}',
    err_IdSlippage: 'Цена сдвинулась на большее число бинов, чем допустимо. Попробуйте снова.', err_InsufficientXAmount: 'Цена изменилась: использовано X меньше минимума', err_InsufficientYAmount: 'Цена изменилась: использовано Y меньше минимума',
    err_ZeroShares: 'Сумма слишком мала для бина (или активному бину нужны оба токена в его пропорции)', err_SingleSidedViolation: 'Бины выше цены принимают только X, ниже — только Y',
    err_OutOfLiquidity: 'Недостаточно ликвидности для этой суммы', err_TooManyBinsCrossed: 'Нужно пересечь более 100 бинов: разбейте сделку', err_FeeOnTransferNotSupported: 'DLMM не поддерживает токены с комиссией за перевод',
    err_NotApproved: 'У router ещё нет разрешения сжигать ваши доли', err_InsufficientShares: 'Недостаточно долей', err_PriceOutOfRange: 'Эта цена вне поддерживаемого диапазона', err_PresetNotEnabled: 'Этот bin step не включён',
    err_InsufficientOutputAmount: 'Цена изменилась сильнее, чем допускает проскальзывание. Попробуйте снова.', err_Expired: 'Срок транзакции истёк. Попробуйте снова.', err_ZeroAmount: 'Нулевая сумма', err_BalanceBelowReserves: 'Баланс токенов пула уменьшился сам по себе (rebase-токен): не поддерживается',
  },
  vi: {
    title: 'DLMM · thanh khoản theo bin', unaudited: '⚠️ Tính năng mới và CHƯA KIỂM TOÁN (UNAUDITED). Chỉ dùng trên testnet.',
    notDeployed: 'DLMM chưa được triển khai trên mạng này', pair: 'Cặp', binStep: 'bin step', load: 'Tải',
    noPair: 'Pool này chưa tồn tại: lần nạp đầu tiên sẽ tạo pool với giá khởi điểm bạn đặt', empty: 'Pool đang trống: người nạp đầu tiên đặt giá',
    active: 'bin hoạt động {id} · giá 1 {x} = {p} {y}', fee: 'phí cơ bản {f}% (+ phí biến động)', reserves: 'Trong pool: {x} · {y}',
    addTitle: 'Thêm thanh khoản', below: 'số bin dưới giá', above: 'số bin trên giá', shape: 'Hình dạng', spot: 'Spot (đều)', curve: 'Curve (gần giá)', bidask: 'Bid-Ask (xa giá)',
    startPrice: 'Giá khởi điểm ({y} cho 1 {x})', approve: 'Phê duyệt {sym}', add: 'Thêm thanh khoản', adding: 'Đang thêm thanh khoản…',
    preview: '{n} bin · dùng {x} + {y}', posTitle: 'Thanh khoản DLMM của tôi (pool này)', noPos: 'Chưa có thanh khoản trong pool này', connect: 'Kết nối ví để xem',
    posLine: '{n} bin ({lo} … {hi}) · rút được khoảng {x} + {y}', remove: 'Rút {p}%', removing: 'Đang rút…', approveRouter: 'Đang cho phép router đốt cổ phần của bạn trong pool này (setApprovalForAll)…',
    revoke: 'Thu hồi quyền của router', swapTitle: 'Hoán đổi qua DLMM', amountIn: 'Bạn trả', quote: 'Khoảng {out} {sym} · tối thiểu {min}', swap: 'Hoán đổi', swapping: 'Đang hoán đổi…',
    enforced: 'Từ chối: cờ của Neuro cho {sym} đang được áp dụng bắt buộc', ack: 'Tôi đã đọc cảnh báo của Neuro', needAck: 'Hãy đánh dấu xác nhận cảnh báo Neuro trước', badAmount: 'Số lượng không hợp lệ',
    tooWide: 'Tối đa 100 bin', chart: 'các bin quanh giá (xanh dương = {x}, tím = {y})', failed: 'Thất bại: {msg}',
    err_IdSlippage: 'Giá đã dịch chuyển nhiều bin hơn mức cho phép. Hãy thử lại.', err_InsufficientXAmount: 'Giá đã thay đổi: lượng X dùng dưới mức tối thiểu', err_InsufficientYAmount: 'Giá đã thay đổi: lượng Y dùng dưới mức tối thiểu',
    err_ZeroShares: 'Số lượng quá nhỏ cho một bin (hoặc bin hoạt động cần cả hai token theo đúng tỷ lệ)', err_SingleSidedViolation: 'Bin trên giá chỉ nhận X, bin dưới giá chỉ nhận Y',
    err_OutOfLiquidity: 'Không đủ thanh khoản cho số lượng này', err_TooManyBinsCrossed: 'Phải đi qua hơn 100 bin: hãy chia nhỏ giao dịch', err_FeeOnTransferNotSupported: 'DLMM không hỗ trợ token thu phí khi chuyển',
    err_NotApproved: 'Router chưa được phép đốt cổ phần của bạn', err_InsufficientShares: 'Không đủ cổ phần', err_PriceOutOfRange: 'Giá này nằm ngoài phạm vi hỗ trợ', err_PresetNotEnabled: 'Bin step này chưa được bật',
    err_InsufficientOutputAmount: 'Giá biến động vượt mức trượt giá cho phép. Hãy thử lại.', err_Expired: 'Đã quá hạn giao dịch. Hãy thử lại.', err_ZeroAmount: 'Số lượng bằng 0', err_BalanceBelowReserves: 'Số dư token của pool tự giảm (token rebase): không được hỗ trợ',
  },
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
