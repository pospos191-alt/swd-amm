// Words for the money-flow graph, the investigator and the watch list, in
// Neuro's 9 languages. Kept here, not in src/lang/, so adding them does not
// change the skill id (src/ is hashed). Same rule as src/lang: what the chain
// shows, never a judgement of people. test/graph.test.js checks that every
// language has every key.
import { LANGS } from '../src/explain.js';

export const short = (a) => { const s = String(a ?? ''); return s.length > 14 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s; };
const hops = (n) => String(n ?? '?');

// ---------------------------------------------------------------- English
const en = {
  UI: {
    title: 'Money flow', intro: 'Who deployed this contract, who funded them, who received the token first, and where its liquidity went. Read on demand from public chain data (free sources, with limits).',
    trace: 'Trace money flow', tracing: 'Tracing money flow…', none: 'No money-flow signal found. This does not mean it is safe.', partial: 'Incomplete: some data could not be read.',
    evidence: 'Evidence', selected: 'Selected address', role: 'Role', explorer: 'Open in explorer', requests: 'requests', unsupported: 'The money-flow graph does not cover this chain yet.',
    failed: 'Could not trace: ', graphLabel: 'Money-flow graph. Use Tab to move between addresses and Enter to show one.', legend: 'Legend',
    follow: 'Follow this token', unfollow: 'Stop following', watchTitle: 'Tokens you follow',
    watchNote: 'While this page is open, Neuro re-checks the tokens you follow every 30 minutes (rules, trade test and money flow) and shows here when a result gets worse. The list is stored only in this browser.',
    watchEmpty: 'You do not follow any token yet.', checkNow: 'Check now', lastChecked: 'Last checked', notYet: 'not yet', worse: 'Result got worse',
    investigate: 'Investigate (all steps)', confidence: 'Confidence', steps: 'Steps',
  },
  ROLE: { token: 'This contract', deployer: 'Deployer', factory: 'Factory contract', funder: 'Funder', hub: 'Busy address (exchange, bridge or contract)', receiver: 'Early receiver', 'cluster-source': 'Shared funder', pool: 'Liquidity pool', 'lp-provider': 'Liquidity provider', 'lp-receiver': 'Received removed liquidity', prior: 'Earlier contract of the deployer', flagged: 'Known address' },
  EDGE: { funded: 'funded', deployed: 'deployed', called: 'called', received: 'received tokens', minted: 'minted to', pool: 'pool', 'lp-add': 'added liquidity', 'lp-remove': 'removed liquidity' },
  SRC: { registry: (r) => `flagged in the ZETAPHY ThreatRegistry${r ? ` (${r})` : ''}`, memory: 'rated high risk by an earlier Neuro check', list: 'on the known-address list' },
  STEP: { rules: 'Contract rules', honeypot: 'Trade test', graph: 'Money flow', ml: 'ML score', llm: 'AI review' },
  STATUS: { ok: 'done', skipped: 'skipped', failed: 'failed', timeout: 'timed out' },
  S: {
    'deployer-flagged': (p, src) => `The deployer ${short(p.addr)} is ${src}.`,
    'funding-flagged': (p, src) => `The deployer's funding trail reaches ${short(p.addr)} (${hops(p.hop)} hop(s) back), which is ${src}.`,
    'prior-flagged': (p) => `This deployer created ${p.total} earlier contract(s); ${p.count} of them are flagged or were rated high risk by Neuro (for example ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `On an earlier token of this deployer (${short(p.addr)}), ${p.share}% of the liquidity the deployer's side added was removed again.`,
    'lp-removed': (p) => (p.linked ? `${p.share}% of the liquidity that ${short(p.addr)} (the deployer or its funding trail) added to the pool was removed again${p.blocks != null ? `, ${p.blocks} blocks after it was added` : ''}.` : `${p.share}% of all liquidity added to the pool has been removed.`),
    'lp-held': (p) => `The deployer holds ${p.share}% of the pool's liquidity tokens, so it can remove that liquidity at any time.`,
    'lp-burned': (p) => `${p.share}% of the pool's liquidity tokens were sent to a burn address, so that liquidity cannot be removed.`,
    'holders-funded-by-deployer': (p) => `${p.count} of the ${p.total} first wallets that received the token were funded by the deployer or its funding trail.`,
    'holders-sybil': (p) => `${p.count} of the ${p.total} first wallets that received the token were funded from the same address ${short(p.addr)} (within ${hops(p.hop)} hop(s)).`,
    'linked-flagged': (p, src) => `${p.count} address(es) in this money flow (holders or liquidity) are known to Neuro, for example ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `The deployer had sent only ${p.nonce} transaction(s) in total: a new wallet.`,
    'funding-from-hub': (p) => `The deployer's funding trail reaches a busy address (an exchange, bridge or contract) ${hops(p.hop)} hop(s) back. Trails are not followed past such addresses.`,
    'prior-contracts': (p) => `This deployer created ${p.count} other contract(s) (shown in the graph).`,
    'supply-split': (p) => `The first tokens were minted to ${p.count} different wallets.`,
    'graph-partial': (p) => `Some data could not be read within the free sources' limits, so this graph is incomplete (${p.notes || '-'}).`,
  },
};

// ---------------------------------------------------------------- 中文
const zh = {
  UI: {
    title: '资金流向', intro: '谁部署了此合约、谁为部署者提供资金、谁最先收到代币、流动性去向何处。按需从公开链上数据读取（免费数据源，有限额）。',
    trace: '追踪资金流向', tracing: '正在追踪资金流向…', none: '未发现资金流向信号。这并不代表安全。', partial: '不完整：部分数据无法读取。',
    evidence: '证据', selected: '所选地址', role: '角色', explorer: '在浏览器中打开', requests: '次请求', unsupported: '资金流向图暂不支持此链。',
    failed: '无法追踪：', graphLabel: '资金流向图。按 Tab 在地址之间移动，按 Enter 查看。', legend: '图例',
    follow: '关注此代币', unfollow: '取消关注', watchTitle: '你关注的代币',
    watchNote: '在此页面打开期间，Neuro 每 30 分钟重新检查你关注的代币（规则、交易测试和资金流向），结果变差时在此显示。列表只保存在此浏览器中。',
    watchEmpty: '你还没有关注任何代币。', checkNow: '立即检查', lastChecked: '上次检查', notYet: '尚未', worse: '结果变差',
    investigate: '全面调查（所有步骤）', confidence: '可信度', steps: '步骤',
  },
  ROLE: { token: '此合约', deployer: '部署者', factory: '工厂合约', funder: '出资地址', hub: '繁忙地址（交易所、跨链桥或合约）', receiver: '早期接收者', 'cluster-source': '共同出资地址', pool: '流动性池', 'lp-provider': '流动性提供者', 'lp-receiver': '收到被移除的流动性', prior: '部署者之前的合约', flagged: '已知地址' },
  EDGE: { funded: '出资', deployed: '部署', called: '调用', received: '收到代币', minted: '铸造给', pool: '池', 'lp-add': '添加流动性', 'lp-remove': '移除流动性' },
  SRC: { registry: (r) => `已在 ZETAPHY ThreatRegistry 中被标记${r ? `（${r}）` : ''}`, memory: '在 Neuro 之前的检查中被评为高风险', list: '在已知地址列表中' },
  STEP: { rules: '合约规则', honeypot: '交易测试', graph: '资金流向', ml: '机器学习评分', llm: 'AI 审阅' },
  STATUS: { ok: '完成', skipped: '跳过', failed: '失败', timeout: '超时' },
  S: {
    'deployer-flagged': (p, src) => `部署者 ${short(p.addr)} ${src}。`,
    'funding-flagged': (p, src) => `部署者的资金来源链条追溯到 ${short(p.addr)}（向前 ${hops(p.hop)} 跳），该地址${src}。`,
    'prior-flagged': (p) => `此部署者之前创建了 ${p.total} 个合约，其中 ${p.count} 个已被标记或被 Neuro 评为高风险（例如 ${short(p.addr)}）。`,
    'prior-lp-removed': (p) => `在此部署者之前的一个代币（${short(p.addr)}）上，部署者一方添加的流动性有 ${p.share}% 又被移除。`,
    'lp-removed': (p) => (p.linked ? `${short(p.addr)}（部署者或其资金来源）向池中添加的流动性有 ${p.share}% 又被移除${p.blocks != null ? `，在添加后 ${p.blocks} 个区块` : ''}。` : `池中添加的全部流动性已有 ${p.share}% 被移除。`),
    'lp-held': (p) => `部署者持有池中 ${p.share}% 的流动性代币，因此可以随时移除这部分流动性。`,
    'lp-burned': (p) => `池中 ${p.share}% 的流动性代币已发送到销毁地址，这部分流动性无法被移除。`,
    'holders-funded-by-deployer': (p) => `最先收到代币的 ${p.total} 个钱包中，有 ${p.count} 个由部署者或其资金来源出资。`,
    'holders-sybil': (p) => `最先收到代币的 ${p.total} 个钱包中，有 ${p.count} 个由同一地址 ${short(p.addr)} 出资（${hops(p.hop)} 跳以内）。`,
    'linked-flagged': (p, src) => `此资金流中有 ${p.count} 个地址（持有者或流动性）为 Neuro 已知，例如 ${short(p.addr)}：${src}。`,
    'fresh-deployer': (p) => `部署者总共只发送过 ${p.nonce} 笔交易：这是一个新钱包。`,
    'funding-from-hub': (p) => `部署者的资金来源在向前 ${hops(p.hop)} 跳处到达一个繁忙地址（交易所、跨链桥或合约），不会越过此类地址继续追踪。`,
    'prior-contracts': (p) => `此部署者还创建了 ${p.count} 个其他合约（见图）。`,
    'supply-split': (p) => `最初的代币被铸造给了 ${p.count} 个不同的钱包。`,
    'graph-partial': (p) => `部分数据超出免费数据源的限额而无法读取，因此此图不完整（${p.notes || '-'}）。`,
  },
};

// ---------------------------------------------------------------- Español
const es = {
  UI: {
    title: 'Flujo de dinero', intro: 'Quién desplegó este contrato, quién le dio fondos, quién recibió el token primero y adónde fue su liquidez. Se lee bajo demanda de datos públicos de la cadena (fuentes gratuitas, con límites).',
    trace: 'Rastrear el flujo de dinero', tracing: 'Rastreando el flujo de dinero…', none: 'No se encontró ninguna señal en el flujo de dinero. Esto no significa que sea seguro.', partial: 'Incompleto: no se pudieron leer algunos datos.',
    evidence: 'Evidencia', selected: 'Dirección seleccionada', role: 'Papel', explorer: 'Abrir en el explorador', requests: 'solicitudes', unsupported: 'El gráfico de flujo de dinero aún no cubre esta cadena.',
    failed: 'No se pudo rastrear: ', graphLabel: 'Gráfico de flujo de dinero. Use Tab para moverse entre direcciones y Enter para ver una.', legend: 'Leyenda',
    follow: 'Seguir este token', unfollow: 'Dejar de seguir', watchTitle: 'Tokens que sigue',
    watchNote: 'Mientras esta página esté abierta, Neuro vuelve a revisar cada 30 minutos los tokens que sigue (reglas, prueba de compraventa y flujo de dinero) y muestra aquí si un resultado empeora. La lista se guarda solo en este navegador.',
    watchEmpty: 'Todavía no sigue ningún token.', checkNow: 'Revisar ahora', lastChecked: 'Última revisión', notYet: 'todavía no', worse: 'El resultado empeoró',
    investigate: 'Investigar (todos los pasos)', confidence: 'Confianza', steps: 'Pasos',
  },
  ROLE: { token: 'Este contrato', deployer: 'Desplegador', factory: 'Contrato fábrica', funder: 'Financiador', hub: 'Dirección muy activa (exchange, puente o contrato)', receiver: 'Receptor temprano', 'cluster-source': 'Financiador común', pool: 'Pool de liquidez', 'lp-provider': 'Proveedor de liquidez', 'lp-receiver': 'Recibió liquidez retirada', prior: 'Contrato anterior del desplegador', flagged: 'Dirección conocida' },
  EDGE: { funded: 'financió', deployed: 'desplegó', called: 'llamó', received: 'recibió tokens', minted: 'acuñado para', pool: 'pool', 'lp-add': 'añadió liquidez', 'lp-remove': 'retiró liquidez' },
  SRC: { registry: (r) => `marcada en el ThreatRegistry de ZETAPHY${r ? ` (${r})` : ''}`, memory: 'calificada de alto riesgo por una revisión anterior de Neuro', list: 'en la lista de direcciones conocidas' },
  STEP: { rules: 'Reglas del contrato', honeypot: 'Prueba de compraventa', graph: 'Flujo de dinero', ml: 'Puntuación ML', llm: 'Revisión por IA' },
  STATUS: { ok: 'hecho', skipped: 'omitido', failed: 'falló', timeout: 'tiempo agotado' },
  S: {
    'deployer-flagged': (p, src) => `El desplegador ${short(p.addr)} está ${src}.`,
    'funding-flagged': (p, src) => `El rastro de fondos del desplegador llega a ${short(p.addr)} (${hops(p.hop)} salto(s) atrás), que está ${src}.`,
    'prior-flagged': (p) => `Este desplegador creó ${p.total} contrato(s) anteriores; ${p.count} están marcados o Neuro los calificó de alto riesgo (por ejemplo ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `En un token anterior de este desplegador (${short(p.addr)}), se retiró de nuevo el ${p.share}% de la liquidez que añadió el lado del desplegador.`,
    'lp-removed': (p) => (p.linked ? `Se retiró de nuevo el ${p.share}% de la liquidez que ${short(p.addr)} (el desplegador o su rastro de fondos) añadió al pool${p.blocks != null ? `, ${p.blocks} bloques después de añadirla` : ''}.` : `Se ha retirado el ${p.share}% de toda la liquidez añadida al pool.`),
    'lp-held': (p) => `El desplegador tiene el ${p.share}% de los tokens de liquidez del pool, así que puede retirar esa liquidez en cualquier momento.`,
    'lp-burned': (p) => `El ${p.share}% de los tokens de liquidez del pool se envió a una dirección de quema, así que esa liquidez no se puede retirar.`,
    'holders-funded-by-deployer': (p) => `${p.count} de las ${p.total} primeras billeteras que recibieron el token recibieron fondos del desplegador o de su rastro de fondos.`,
    'holders-sybil': (p) => `${p.count} de las ${p.total} primeras billeteras que recibieron el token recibieron fondos de la misma dirección ${short(p.addr)} (en ${hops(p.hop)} salto(s) o menos).`,
    'linked-flagged': (p, src) => `${p.count} dirección(es) de este flujo (tenedores o liquidez) son conocidas por Neuro, por ejemplo ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `El desplegador solo había enviado ${p.nonce} transacción(es) en total: una billetera nueva.`,
    'funding-from-hub': (p) => `El rastro de fondos del desplegador llega a una dirección muy activa (exchange, puente o contrato) ${hops(p.hop)} salto(s) atrás. No se siguen rastros más allá de esas direcciones.`,
    'prior-contracts': (p) => `Este desplegador creó otros ${p.count} contrato(s) (en el gráfico).`,
    'supply-split': (p) => `Los primeros tokens se acuñaron para ${p.count} billeteras distintas.`,
    'graph-partial': (p) => `Algunos datos no se pudieron leer dentro de los límites de las fuentes gratuitas, así que este gráfico está incompleto (${p.notes || '-'}).`,
  },
};

// ---------------------------------------------------------------- 한국어
const ko = {
  UI: {
    title: '자금 흐름', intro: '누가 이 컨트랙트를 배포했는지, 누가 배포자에게 자금을 보냈는지, 누가 토큰을 먼저 받았는지, 유동성이 어디로 갔는지 보여 줍니다. 요청할 때 공개 체인 데이터에서 읽습니다(무료 소스, 한도 있음).',
    trace: '자금 흐름 추적', tracing: '자금 흐름을 추적하는 중…', none: '자금 흐름 신호가 발견되지 않았습니다. 안전하다는 뜻은 아닙니다.', partial: '불완전함: 일부 데이터를 읽지 못했습니다.',
    evidence: '증거', selected: '선택한 주소', role: '역할', explorer: '익스플로러에서 열기', requests: '요청', unsupported: '자금 흐름 그래프는 아직 이 체인을 지원하지 않습니다.',
    failed: '추적할 수 없음: ', graphLabel: '자금 흐름 그래프. Tab으로 주소 사이를 이동하고 Enter로 표시합니다.', legend: '범례',
    follow: '이 토큰 팔로우', unfollow: '팔로우 해제', watchTitle: '팔로우 중인 토큰',
    watchNote: '이 페이지가 열려 있는 동안 Neuro는 30분마다 팔로우한 토큰을 다시 확인하고(규칙, 거래 테스트, 자금 흐름) 결과가 나빠지면 여기에 표시합니다. 목록은 이 브라우저에만 저장됩니다.',
    watchEmpty: '아직 팔로우한 토큰이 없습니다.', checkNow: '지금 확인', lastChecked: '마지막 확인', notYet: '아직 안 함', worse: '결과가 나빠짐',
    investigate: '조사하기(모든 단계)', confidence: '신뢰도', steps: '단계',
  },
  ROLE: { token: '이 컨트랙트', deployer: '배포자', factory: '팩토리 컨트랙트', funder: '자금 제공자', hub: '바쁜 주소(거래소, 브리지 또는 컨트랙트)', receiver: '초기 수령자', 'cluster-source': '공통 자금 제공자', pool: '유동성 풀', 'lp-provider': '유동성 공급자', 'lp-receiver': '제거된 유동성 수령자', prior: '배포자의 이전 컨트랙트', flagged: '알려진 주소' },
  EDGE: { funded: '자금 송금', deployed: '배포', called: '호출', received: '토큰 수령', minted: '발행 대상', pool: '풀', 'lp-add': '유동성 추가', 'lp-remove': '유동성 제거' },
  SRC: { registry: (r) => `ZETAPHY ThreatRegistry에 플래그됨${r ? ` (${r})` : ''}`, memory: '이전 Neuro 검사에서 고위험으로 평가됨', list: '알려진 주소 목록에 있음' },
  STEP: { rules: '컨트랙트 규칙', honeypot: '거래 테스트', graph: '자금 흐름', ml: 'ML 점수', llm: 'AI 검토' },
  STATUS: { ok: '완료', skipped: '건너뜀', failed: '실패', timeout: '시간 초과' },
  S: {
    'deployer-flagged': (p, src) => `배포자 ${short(p.addr)}: ${src}.`,
    'funding-flagged': (p, src) => `배포자의 자금 경로가 ${short(p.addr)}(${hops(p.hop)}단계 전)에 닿으며, 이 주소는 ${src}.`,
    'prior-flagged': (p) => `이 배포자는 이전에 컨트랙트 ${p.total}개를 만들었고, 그중 ${p.count}개가 플래그되었거나 Neuro가 고위험으로 평가했습니다(예: ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `이 배포자의 이전 토큰(${short(p.addr)})에서 배포자 측이 추가한 유동성의 ${p.share}%가 다시 제거되었습니다.`,
    'lp-removed': (p) => (p.linked ? `${short(p.addr)}(배포자 또는 그 자금 경로)가 풀에 추가한 유동성의 ${p.share}%가 다시 제거되었습니다${p.blocks != null ? `(추가 후 ${p.blocks}블록)` : ''}.` : `풀에 추가된 전체 유동성의 ${p.share}%가 제거되었습니다.`),
    'lp-held': (p) => `배포자가 풀 유동성 토큰의 ${p.share}%를 보유하고 있어 언제든 그 유동성을 제거할 수 있습니다.`,
    'lp-burned': (p) => `풀 유동성 토큰의 ${p.share}%가 소각 주소로 보내져 그 유동성은 제거할 수 없습니다.`,
    'holders-funded-by-deployer': (p) => `토큰을 처음 받은 지갑 ${p.total}개 중 ${p.count}개가 배포자 또는 그 자금 경로로부터 자금을 받았습니다.`,
    'holders-sybil': (p) => `토큰을 처음 받은 지갑 ${p.total}개 중 ${p.count}개가 같은 주소 ${short(p.addr)}로부터 자금을 받았습니다(${hops(p.hop)}단계 이내).`,
    'linked-flagged': (p, src) => `이 자금 흐름의 주소 ${p.count}개(보유자 또는 유동성)가 Neuro에 알려져 있습니다. 예: ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `배포자는 총 ${p.nonce}건의 거래만 보냈습니다: 새 지갑입니다.`,
    'funding-from-hub': (p) => `배포자의 자금 경로가 ${hops(p.hop)}단계 전에 바쁜 주소(거래소, 브리지 또는 컨트랙트)에 닿습니다. 그런 주소 너머로는 추적하지 않습니다.`,
    'prior-contracts': (p) => `이 배포자는 다른 컨트랙트 ${p.count}개를 만들었습니다(그래프에 표시).`,
    'supply-split': (p) => `처음 발행된 토큰이 서로 다른 지갑 ${p.count}개에 발행되었습니다.`,
    'graph-partial': (p) => `무료 소스의 한도 안에서 일부 데이터를 읽지 못해 이 그래프는 불완전합니다(${p.notes || '-'}).`,
  },
};

// ---------------------------------------------------------------- 日本語
const ja = {
  UI: {
    title: '資金の流れ', intro: 'このコントラクトを誰がデプロイし、誰がその資金を出し、誰が最初にトークンを受け取り、流動性がどこへ行ったか。必要なときに公開チェーンデータから読み取ります（無料のソース、上限あり）。',
    trace: '資金の流れを追跡', tracing: '資金の流れを追跡中…', none: '資金の流れに関するシグナルは見つかりませんでした。安全という意味ではありません。', partial: '不完全：一部のデータを読み取れませんでした。',
    evidence: '証拠', selected: '選択したアドレス', role: '役割', explorer: 'エクスプローラーで開く', requests: 'リクエスト', unsupported: '資金の流れグラフはまだこのチェーンに対応していません。',
    failed: '追跡できません：', graphLabel: '資金の流れグラフ。Tab でアドレス間を移動し、Enter で表示します。', legend: '凡例',
    follow: 'このトークンをフォロー', unfollow: 'フォローをやめる', watchTitle: 'フォロー中のトークン',
    watchNote: 'このページを開いている間、Neuro はフォロー中のトークンを 30 分ごとに再確認し（ルール、売買テスト、資金の流れ）、結果が悪化したらここに表示します。リストはこのブラウザにのみ保存されます。',
    watchEmpty: 'まだトークンをフォローしていません。', checkNow: '今すぐ確認', lastChecked: '最終確認', notYet: '未確認', worse: '結果が悪化しました',
    investigate: '調査する（全ステップ）', confidence: '信頼度', steps: 'ステップ',
  },
  ROLE: { token: 'このコントラクト', deployer: 'デプロイヤー', factory: 'ファクトリーコントラクト', funder: '資金提供元', hub: '取引の多いアドレス（取引所、ブリッジ、コントラクト）', receiver: '初期の受取人', 'cluster-source': '共通の資金提供元', pool: '流動性プール', 'lp-provider': '流動性提供者', 'lp-receiver': '引き出された流動性の受取人', prior: 'デプロイヤーの過去のコントラクト', flagged: '既知のアドレス' },
  EDGE: { funded: '資金送付', deployed: 'デプロイ', called: '呼び出し', received: 'トークン受取', minted: 'ミント先', pool: 'プール', 'lp-add': '流動性追加', 'lp-remove': '流動性引き出し' },
  SRC: { registry: (r) => `ZETAPHY ThreatRegistry でフラグ付き${r ? `（${r}）` : ''}`, memory: '過去の Neuro のチェックで高リスクと評価', list: '既知アドレスのリストに記載' },
  STEP: { rules: 'コントラクトのルール', honeypot: '売買テスト', graph: '資金の流れ', ml: 'ML スコア', llm: 'AI レビュー' },
  STATUS: { ok: '完了', skipped: 'スキップ', failed: '失敗', timeout: 'タイムアウト' },
  S: {
    'deployer-flagged': (p, src) => `デプロイヤー ${short(p.addr)} は${src}です。`,
    'funding-flagged': (p, src) => `デプロイヤーの資金の経路は ${short(p.addr)}（${hops(p.hop)} ホップ前）に届き、そのアドレスは${src}です。`,
    'prior-flagged': (p) => `このデプロイヤーは過去に ${p.total} 件のコントラクトを作成し、そのうち ${p.count} 件がフラグ付き、または Neuro が高リスクと評価しています（例：${short(p.addr)}）。`,
    'prior-lp-removed': (p) => `このデプロイヤーの過去のトークン（${short(p.addr)}）では、デプロイヤー側が追加した流動性の ${p.share}% が再び引き出されました。`,
    'lp-removed': (p) => (p.linked ? `${short(p.addr)}（デプロイヤーまたはその資金の経路）がプールに追加した流動性の ${p.share}% が再び引き出されました${p.blocks != null ? `（追加から ${p.blocks} ブロック後）` : ''}。` : `プールに追加された全流動性の ${p.share}% が引き出されています。`),
    'lp-held': (p) => `デプロイヤーはプールの流動性トークンの ${p.share}% を保有しており、その流動性をいつでも引き出せます。`,
    'lp-burned': (p) => `プールの流動性トークンの ${p.share}% がバーンアドレスに送られており、その流動性は引き出せません。`,
    'holders-funded-by-deployer': (p) => `最初にトークンを受け取った ${p.total} 個のウォレットのうち ${p.count} 個が、デプロイヤーまたはその資金の経路から資金を受け取っています。`,
    'holders-sybil': (p) => `最初にトークンを受け取った ${p.total} 個のウォレットのうち ${p.count} 個が、同じアドレス ${short(p.addr)} から資金を受け取っています（${hops(p.hop)} ホップ以内）。`,
    'linked-flagged': (p, src) => `この資金の流れにある ${p.count} 件のアドレス（保有者または流動性）は Neuro にとって既知です。例：${short(p.addr)}：${src}。`,
    'fresh-deployer': (p) => `デプロイヤーが送ったトランザクションは合計 ${p.nonce} 件だけです：新しいウォレットです。`,
    'funding-from-hub': (p) => `デプロイヤーの資金の経路は ${hops(p.hop)} ホップ前に取引の多いアドレス（取引所、ブリッジ、コントラクト）に届きます。そのようなアドレスの先は追跡しません。`,
    'prior-contracts': (p) => `このデプロイヤーは他に ${p.count} 件のコントラクトを作成しています（グラフに表示）。`,
    'supply-split': (p) => `最初のトークンは ${p.count} 個の異なるウォレットにミントされました。`,
    'graph-partial': (p) => `無料ソースの上限内で一部のデータを読み取れなかったため、このグラフは不完全です（${p.notes || '-'}）。`,
  },
};

// ---------------------------------------------------------------- Русский
const ru = {
  UI: {
    title: 'Движение денег', intro: 'Кто развернул этот контракт, кто дал ему средства, кто первым получил токен и куда ушла его ликвидность. Читается по запросу из публичных данных сети (бесплатные источники, с лимитами).',
    trace: 'Проследить движение денег', tracing: 'Прослеживаем движение денег…', none: 'Сигналов в движении денег не найдено. Это не значит, что безопасно.', partial: 'Неполно: часть данных не удалось прочитать.',
    evidence: 'Доказательства', selected: 'Выбранный адрес', role: 'Роль', explorer: 'Открыть в обозревателе', requests: 'запросов', unsupported: 'Граф движения денег пока не поддерживает эту сеть.',
    failed: 'Не удалось проследить: ', graphLabel: 'Граф движения денег. Tab переключает адреса, Enter показывает адрес.', legend: 'Обозначения',
    follow: 'Следить за токеном', unfollow: 'Перестать следить', watchTitle: 'Токены, за которыми вы следите',
    watchNote: 'Пока эта страница открыта, Neuro каждые 30 минут заново проверяет токены, за которыми вы следите (правила, тест покупки/продажи и движение денег), и показывает здесь, если результат стал хуже. Список хранится только в этом браузере.',
    watchEmpty: 'Вы пока не следите ни за одним токеном.', checkNow: 'Проверить сейчас', lastChecked: 'Последняя проверка', notYet: 'ещё нет', worse: 'Результат стал хуже',
    investigate: 'Расследовать (все шаги)', confidence: 'Уверенность', steps: 'Шаги',
  },
  ROLE: { token: 'Этот контракт', deployer: 'Развернувший', factory: 'Контракт-фабрика', funder: 'Источник средств', hub: 'Нагруженный адрес (биржа, мост или контракт)', receiver: 'Ранний получатель', 'cluster-source': 'Общий источник средств', pool: 'Пул ликвидности', 'lp-provider': 'Поставщик ликвидности', 'lp-receiver': 'Получил выведенную ликвидность', prior: 'Прежний контракт развернувшего', flagged: 'Известный адрес' },
  EDGE: { funded: 'отправил средства', deployed: 'развернул', called: 'вызвал', received: 'получил токены', minted: 'выпущено на', pool: 'пул', 'lp-add': 'добавил ликвидность', 'lp-remove': 'вывел ликвидность' },
  SRC: { registry: (r) => `отмечен в ZETAPHY ThreatRegistry${r ? ` (${r})` : ''}`, memory: 'получил высокий риск в прежней проверке Neuro', list: 'в списке известных адресов' },
  STEP: { rules: 'Правила контракта', honeypot: 'Тест покупки/продажи', graph: 'Движение денег', ml: 'Оценка ML', llm: 'Проверка ИИ' },
  STATUS: { ok: 'готово', skipped: 'пропущено', failed: 'ошибка', timeout: 'истекло время' },
  S: {
    'deployer-flagged': (p, src) => `Развернувший ${short(p.addr)}: ${src}.`,
    'funding-flagged': (p, src) => `Цепочка средств развернувшего доходит до ${short(p.addr)} (${hops(p.hop)} шаг(а) назад); этот адрес ${src}.`,
    'prior-flagged': (p) => `Этот развернувший ранее создал контрактов: ${p.total}; из них ${p.count} отмечены или получили высокий риск в Neuro (например, ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `На прежнем токене этого развернувшего (${short(p.addr)}) ${p.share}% ликвидности, добавленной его стороной, было снова выведено.`,
    'lp-removed': (p) => (p.linked ? `${p.share}% ликвидности, которую ${short(p.addr)} (развернувший или его цепочка средств) добавил в пул, было снова выведено${p.blocks != null ? ` через ${p.blocks} блоков после добавления` : ''}.` : `Из пула выведено ${p.share}% всей добавленной ликвидности.`),
    'lp-held': (p) => `Развернувшему принадлежит ${p.share}% токенов ликвидности пула, поэтому он может вывести эту ликвидность в любой момент.`,
    'lp-burned': (p) => `${p.share}% токенов ликвидности пула отправлено на адрес сжигания, эту ликвидность вывести нельзя.`,
    'holders-funded-by-deployer': (p) => `${p.count} из ${p.total} первых кошельков, получивших токен, получили средства от развернувшего или его цепочки средств.`,
    'holders-sybil': (p) => `${p.count} из ${p.total} первых кошельков, получивших токен, получили средства с одного адреса ${short(p.addr)} (не дальше ${hops(p.hop)} шаг(ов)).`,
    'linked-flagged': (p, src) => `Адресов в этом движении денег (держатели или ликвидность), известных Neuro: ${p.count}; например, ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `Развернувший отправил всего ${p.nonce} транзакц.: это новый кошелёк.`,
    'funding-from-hub': (p) => `Цепочка средств развернувшего доходит до нагруженного адреса (биржа, мост или контракт) ${hops(p.hop)} шаг(а) назад. Дальше таких адресов цепочки не прослеживаются.`,
    'prior-contracts': (p) => `Этот развернувший создал ещё контрактов: ${p.count} (показаны на графе).`,
    'supply-split': (p) => `Первые токены выпущены на ${p.count} разных кошельков.`,
    'graph-partial': (p) => `Часть данных не удалось прочитать в пределах лимитов бесплатных источников, поэтому граф неполон (${p.notes || '-'}).`,
  },
};

// ---------------------------------------------------------------- Tiếng Việt
const vi = {
  UI: {
    title: 'Dòng tiền', intro: 'Ai đã triển khai hợp đồng này, ai cấp tiền cho họ, ai nhận token đầu tiên và thanh khoản đã đi đâu. Đọc khi bạn yêu cầu từ dữ liệu công khai trên chuỗi (nguồn miễn phí, có giới hạn).',
    trace: 'Truy vết dòng tiền', tracing: 'Đang truy vết dòng tiền…', none: 'Không thấy tín hiệu nào trong dòng tiền. Điều này không có nghĩa là an toàn.', partial: 'Chưa đầy đủ: không đọc được một số dữ liệu.',
    evidence: 'Bằng chứng', selected: 'Địa chỉ đã chọn', role: 'Vai trò', explorer: 'Mở trong trình khám phá', requests: 'yêu cầu', unsupported: 'Biểu đồ dòng tiền chưa hỗ trợ chuỗi này.',
    failed: 'Không truy vết được: ', graphLabel: 'Biểu đồ dòng tiền. Dùng Tab để chuyển giữa các địa chỉ và Enter để xem.', legend: 'Chú thích',
    follow: 'Theo dõi token này', unfollow: 'Bỏ theo dõi', watchTitle: 'Token bạn theo dõi',
    watchNote: 'Khi trang này đang mở, Neuro kiểm tra lại các token bạn theo dõi mỗi 30 phút (quy tắc, thử mua bán và dòng tiền) và báo ở đây khi kết quả xấu đi. Danh sách chỉ lưu trong trình duyệt này.',
    watchEmpty: 'Bạn chưa theo dõi token nào.', checkNow: 'Kiểm tra ngay', lastChecked: 'Lần kiểm tra gần nhất', notYet: 'chưa', worse: 'Kết quả xấu đi',
    investigate: 'Điều tra (mọi bước)', confidence: 'Độ tin cậy', steps: 'Các bước',
  },
  ROLE: { token: 'Hợp đồng này', deployer: 'Người triển khai', factory: 'Hợp đồng nhà máy', funder: 'Nguồn tiền', hub: 'Địa chỉ bận (sàn, cầu nối hoặc hợp đồng)', receiver: 'Người nhận sớm', 'cluster-source': 'Nguồn tiền chung', pool: 'Pool thanh khoản', 'lp-provider': 'Nhà cung cấp thanh khoản', 'lp-receiver': 'Nhận thanh khoản đã rút', prior: 'Hợp đồng trước của người triển khai', flagged: 'Địa chỉ đã biết' },
  EDGE: { funded: 'cấp tiền', deployed: 'triển khai', called: 'gọi', received: 'nhận token', minted: 'đúc cho', pool: 'pool', 'lp-add': 'thêm thanh khoản', 'lp-remove': 'rút thanh khoản' },
  SRC: { registry: (r) => `bị gắn cờ trong ZETAPHY ThreatRegistry${r ? ` (${r})` : ''}`, memory: 'bị một lần kiểm tra Neuro trước đây đánh giá rủi ro cao', list: 'có trong danh sách địa chỉ đã biết' },
  STEP: { rules: 'Quy tắc hợp đồng', honeypot: 'Thử mua bán', graph: 'Dòng tiền', ml: 'Điểm ML', llm: 'AI xem xét' },
  STATUS: { ok: 'xong', skipped: 'bỏ qua', failed: 'lỗi', timeout: 'hết thời gian' },
  S: {
    'deployer-flagged': (p, src) => `Người triển khai ${short(p.addr)} ${src}.`,
    'funding-flagged': (p, src) => `Dấu vết nguồn tiền của người triển khai dẫn tới ${short(p.addr)} (${hops(p.hop)} bước trước), địa chỉ này ${src}.`,
    'prior-flagged': (p) => `Người triển khai này đã tạo ${p.total} hợp đồng trước đó; ${p.count} trong số đó bị gắn cờ hoặc bị Neuro đánh giá rủi ro cao (ví dụ ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `Ở một token trước của người triển khai này (${short(p.addr)}), ${p.share}% thanh khoản do phía người triển khai thêm vào đã bị rút lại.`,
    'lp-removed': (p) => (p.linked ? `${p.share}% thanh khoản mà ${short(p.addr)} (người triển khai hoặc dấu vết nguồn tiền của họ) thêm vào pool đã bị rút lại${p.blocks != null ? `, ${p.blocks} khối sau khi thêm` : ''}.` : `${p.share}% toàn bộ thanh khoản thêm vào pool đã bị rút.`),
    'lp-held': (p) => `Người triển khai giữ ${p.share}% token thanh khoản của pool nên có thể rút số thanh khoản đó bất cứ lúc nào.`,
    'lp-burned': (p) => `${p.share}% token thanh khoản của pool đã được gửi tới địa chỉ đốt, nên không thể rút số thanh khoản đó.`,
    'holders-funded-by-deployer': (p) => `${p.count} trong ${p.total} ví đầu tiên nhận token được cấp tiền bởi người triển khai hoặc dấu vết nguồn tiền của họ.`,
    'holders-sybil': (p) => `${p.count} trong ${p.total} ví đầu tiên nhận token được cấp tiền từ cùng một địa chỉ ${short(p.addr)} (trong vòng ${hops(p.hop)} bước).`,
    'linked-flagged': (p, src) => `${p.count} địa chỉ trong dòng tiền này (người nắm giữ hoặc thanh khoản) đã được Neuro biết đến, ví dụ ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `Người triển khai mới chỉ gửi tổng cộng ${p.nonce} giao dịch: một ví mới.`,
    'funding-from-hub': (p) => `Dấu vết nguồn tiền của người triển khai tới một địa chỉ bận (sàn, cầu nối hoặc hợp đồng) ở ${hops(p.hop)} bước trước. Không truy vết vượt qua những địa chỉ như vậy.`,
    'prior-contracts': (p) => `Người triển khai này đã tạo thêm ${p.count} hợp đồng khác (có trong biểu đồ).`,
    'supply-split': (p) => `Những token đầu tiên được đúc cho ${p.count} ví khác nhau.`,
    'graph-partial': (p) => `Không đọc được một số dữ liệu trong giới hạn của nguồn miễn phí, nên biểu đồ này chưa đầy đủ (${p.notes || '-'}).`,
  },
};

// ---------------------------------------------------------------- ไทย
const th = {
  UI: {
    title: 'เส้นทางเงิน', intro: 'ใครสร้างสัญญานี้ ใครส่งเงินให้ผู้สร้าง ใครได้รับเหรียญก่อน และสภาพคล่องไปอยู่ที่ไหน อ่านจากข้อมูลสาธารณะบนเชนเมื่อคุณกดเท่านั้น (แหล่งข้อมูลฟรี มีขีดจำกัด)',
    trace: 'ตามรอยเส้นทางเงิน', tracing: 'กำลังตามรอยเส้นทางเงิน…', none: 'ไม่พบสัญญาณจากเส้นทางเงิน แต่ไม่ได้แปลว่าปลอดภัย', partial: 'ไม่ครบ: อ่านข้อมูลบางส่วนไม่ได้',
    evidence: 'หลักฐาน', selected: 'ที่อยู่ที่เลือก', role: 'บทบาท', explorer: 'เปิดใน Explorer', requests: 'คำขอ', unsupported: 'กราฟเส้นทางเงินยังไม่รองรับเชนนี้',
    failed: 'ตามรอยไม่ได้: ', graphLabel: 'กราฟเส้นทางเงิน กด Tab เพื่อเลื่อนไปทีละที่อยู่ และ Enter เพื่อดูรายละเอียด', legend: 'คำอธิบายสัญลักษณ์',
    follow: 'ติดตามเหรียญนี้', unfollow: 'เลิกติดตาม', watchTitle: 'เหรียญที่คุณติดตาม',
    watchNote: 'ระหว่างที่เปิดหน้านี้ Neuro จะตรวจเหรียญที่คุณติดตามซ้ำทุก 30 นาที (กฎ, การทดลองซื้อขาย และเส้นทางเงิน) และแจ้งที่นี่เมื่อผลแย่ลง รายการเก็บไว้ในเบราว์เซอร์นี้เท่านั้น',
    watchEmpty: 'คุณยังไม่ได้ติดตามเหรียญใด', checkNow: 'ตรวจตอนนี้', lastChecked: 'ตรวจล่าสุด', notYet: 'ยังไม่ได้ตรวจ', worse: 'ผลแย่ลง',
    investigate: 'สืบสวน (ทุกขั้นตอน)', confidence: 'ความมั่นใจ', steps: 'ขั้นตอน',
  },
  ROLE: { token: 'สัญญานี้', deployer: 'ผู้สร้างสัญญา', factory: 'สัญญาโรงงาน', funder: 'ผู้ส่งเงินให้', hub: 'ที่อยู่ที่มีธุรกรรมมาก (กระดานเทรด บริดจ์ หรือสัญญา)', receiver: 'ผู้ได้รับเหรียญช่วงแรก', 'cluster-source': 'ผู้ส่งเงินคนเดียวกัน', pool: 'พูลสภาพคล่อง', 'lp-provider': 'ผู้เติมสภาพคล่อง', 'lp-receiver': 'ผู้ได้รับสภาพคล่องที่ถอนออก', prior: 'สัญญาก่อนหน้าของผู้สร้าง', flagged: 'ที่อยู่ที่รู้จัก' },
  EDGE: { funded: 'ส่งเงินให้', deployed: 'สร้าง', called: 'เรียกใช้', received: 'ได้รับเหรียญ', minted: 'สร้างเหรียญให้', pool: 'พูล', 'lp-add': 'เติมสภาพคล่อง', 'lp-remove': 'ถอนสภาพคล่อง' },
  SRC: { registry: (r) => `ถูกติดธงใน ZETAPHY ThreatRegistry${r ? ` (${r})` : ''}`, memory: 'เคยถูก Neuro ตรวจแล้วได้ความเสี่ยงสูง', list: 'อยู่ในรายการที่อยู่ที่รู้จัก' },
  STEP: { rules: 'กฎของสัญญา', honeypot: 'ทดลองซื้อขาย', graph: 'เส้นทางเงิน', ml: 'คะแนน ML', llm: 'AI ตรวจทาน' },
  STATUS: { ok: 'เสร็จ', skipped: 'ข้าม', failed: 'ล้มเหลว', timeout: 'หมดเวลา' },
  S: {
    'deployer-flagged': (p, src) => `ผู้สร้างสัญญา ${short(p.addr)} ${src}`,
    'funding-flagged': (p, src) => `เส้นทางเงินของผู้สร้างสัญญาย้อนไปถึง ${short(p.addr)} (ย้อนหลัง ${hops(p.hop)} ทอด) ซึ่ง${src}`,
    'prior-flagged': (p) => `ผู้สร้างรายนี้เคยสร้างสัญญามาแล้ว ${p.total} สัญญา ในนั้น ${p.count} สัญญาถูกติดธงหรือเคยถูก Neuro ประเมินว่าเสี่ยงสูง (เช่น ${short(p.addr)})`,
    'prior-lp-removed': (p) => `ในเหรียญก่อนหน้าของผู้สร้างรายนี้ (${short(p.addr)}) สภาพคล่องที่ฝั่งผู้สร้างเติมไว้ถูกถอนออกไป ${p.share}%`,
    'lp-removed': (p) => (p.linked ? `สภาพคล่องที่ ${short(p.addr)} (ผู้สร้างหรือเส้นทางเงินของผู้สร้าง) เติมเข้าพูลถูกถอนออกไป ${p.share}%${p.blocks != null ? ` หลังเติม ${p.blocks} บล็อก` : ''}` : `สภาพคล่องทั้งหมดที่เติมเข้าพูลถูกถอนออกไปแล้ว ${p.share}%`),
    'lp-held': (p) => `ผู้สร้างถือโทเคนสภาพคล่องของพูลอยู่ ${p.share}% จึงถอนสภาพคล่องส่วนนั้นได้ทุกเมื่อ`,
    'lp-burned': (p) => `โทเคนสภาพคล่องของพูล ${p.share}% ถูกส่งไปที่อยู่เผาทิ้ง สภาพคล่องส่วนนั้นจึงถอนไม่ได้`,
    'holders-funded-by-deployer': (p) => `ในกระเป๋า ${p.total} ใบแรกที่ได้รับเหรียญ มี ${p.count} ใบที่ได้เงินจากผู้สร้างหรือเส้นทางเงินของผู้สร้าง`,
    'holders-sybil': (p) => `ในกระเป๋า ${p.total} ใบแรกที่ได้รับเหรียญ มี ${p.count} ใบที่ได้เงินจากที่อยู่เดียวกัน ${short(p.addr)} (ภายใน ${hops(p.hop)} ทอด)`,
    'linked-flagged': (p, src) => `ในเส้นทางเงินนี้มี ${p.count} ที่อยู่ (ผู้ถือหรือสภาพคล่อง) ที่ Neuro รู้จัก เช่น ${short(p.addr)}: ${src}`,
    'fresh-deployer': (p) => `ผู้สร้างเคยส่งธุรกรรมรวมเพียง ${p.nonce} ครั้ง: เป็นกระเป๋าใหม่`,
    'funding-from-hub': (p) => `เส้นทางเงินของผู้สร้างไปถึงที่อยู่ที่มีธุรกรรมมาก (กระดานเทรด บริดจ์ หรือสัญญา) ที่ย้อนหลัง ${hops(p.hop)} ทอด จะไม่ตามรอยต่อเลยที่อยู่แบบนี้`,
    'prior-contracts': (p) => `ผู้สร้างรายนี้สร้างสัญญาอื่นไว้อีก ${p.count} สัญญา (แสดงในกราฟ)`,
    'supply-split': (p) => `เหรียญชุดแรกถูกสร้างให้กระเป๋า ${p.count} ใบที่ต่างกัน`,
    'graph-partial': (p) => `อ่านข้อมูลบางส่วนไม่ได้ภายในขีดจำกัดของแหล่งข้อมูลฟรี กราฟนี้จึงยังไม่ครบ (${p.notes || '-'})`,
  },
};

// ---------------------------------------------------------------- Bahasa Indonesia
const id = {
  UI: {
    title: 'Aliran dana', intro: 'Siapa yang men-deploy kontrak ini, siapa yang mendanainya, siapa yang pertama menerima token, dan ke mana likuiditasnya pergi. Dibaca saat diminta dari data publik jaringan (sumber gratis, dengan batas).',
    trace: 'Lacak aliran dana', tracing: 'Melacak aliran dana…', none: 'Tidak ditemukan sinyal pada aliran dana. Ini tidak berarti aman.', partial: 'Belum lengkap: sebagian data tidak dapat dibaca.',
    evidence: 'Bukti', selected: 'Alamat terpilih', role: 'Peran', explorer: 'Buka di explorer', requests: 'permintaan', unsupported: 'Grafik aliran dana belum mendukung jaringan ini.',
    failed: 'Tidak dapat melacak: ', graphLabel: 'Grafik aliran dana. Gunakan Tab untuk berpindah antar alamat dan Enter untuk menampilkannya.', legend: 'Keterangan',
    follow: 'Ikuti token ini', unfollow: 'Berhenti mengikuti', watchTitle: 'Token yang Anda ikuti',
    watchNote: 'Selama halaman ini terbuka, Neuro memeriksa ulang token yang Anda ikuti setiap 30 menit (aturan, uji jual-beli, dan aliran dana) dan menampilkannya di sini bila hasilnya memburuk. Daftar hanya disimpan di browser ini.',
    watchEmpty: 'Anda belum mengikuti token apa pun.', checkNow: 'Periksa sekarang', lastChecked: 'Terakhir diperiksa', notYet: 'belum', worse: 'Hasil memburuk',
    investigate: 'Selidiki (semua langkah)', confidence: 'Keyakinan', steps: 'Langkah',
  },
  ROLE: { token: 'Kontrak ini', deployer: 'Deployer', factory: 'Kontrak pabrik', funder: 'Pemberi dana', hub: 'Alamat sibuk (bursa, bridge, atau kontrak)', receiver: 'Penerima awal', 'cluster-source': 'Pemberi dana bersama', pool: 'Pool likuiditas', 'lp-provider': 'Penyedia likuiditas', 'lp-receiver': 'Menerima likuiditas yang ditarik', prior: 'Kontrak deployer sebelumnya', flagged: 'Alamat yang dikenal' },
  EDGE: { funded: 'mendanai', deployed: 'men-deploy', called: 'memanggil', received: 'menerima token', minted: 'dicetak untuk', pool: 'pool', 'lp-add': 'menambah likuiditas', 'lp-remove': 'menarik likuiditas' },
  SRC: { registry: (r) => `ditandai di ZETAPHY ThreatRegistry${r ? ` (${r})` : ''}`, memory: 'dinilai berisiko tinggi oleh pemeriksaan Neuro sebelumnya', list: 'ada di daftar alamat yang dikenal' },
  STEP: { rules: 'Aturan kontrak', honeypot: 'Uji jual-beli', graph: 'Aliran dana', ml: 'Skor ML', llm: 'Tinjauan AI' },
  STATUS: { ok: 'selesai', skipped: 'dilewati', failed: 'gagal', timeout: 'waktu habis' },
  S: {
    'deployer-flagged': (p, src) => `Deployer ${short(p.addr)} ${src}.`,
    'funding-flagged': (p, src) => `Jejak dana deployer sampai ke ${short(p.addr)} (${hops(p.hop)} langkah ke belakang), yang ${src}.`,
    'prior-flagged': (p) => `Deployer ini membuat ${p.total} kontrak sebelumnya; ${p.count} di antaranya ditandai atau dinilai berisiko tinggi oleh Neuro (misalnya ${short(p.addr)}).`,
    'prior-lp-removed': (p) => `Pada token sebelumnya dari deployer ini (${short(p.addr)}), ${p.share}% likuiditas yang ditambahkan pihak deployer ditarik kembali.`,
    'lp-removed': (p) => (p.linked ? `${p.share}% likuiditas yang ditambahkan ${short(p.addr)} (deployer atau jejak dananya) ke pool ditarik kembali${p.blocks != null ? `, ${p.blocks} blok setelah ditambahkan` : ''}.` : `${p.share}% dari seluruh likuiditas yang ditambahkan ke pool telah ditarik.`),
    'lp-held': (p) => `Deployer memegang ${p.share}% token likuiditas pool, sehingga dapat menarik likuiditas itu kapan saja.`,
    'lp-burned': (p) => `${p.share}% token likuiditas pool dikirim ke alamat pembakaran, sehingga likuiditas itu tidak dapat ditarik.`,
    'holders-funded-by-deployer': (p) => `${p.count} dari ${p.total} dompet pertama yang menerima token didanai oleh deployer atau jejak dananya.`,
    'holders-sybil': (p) => `${p.count} dari ${p.total} dompet pertama yang menerima token didanai dari alamat yang sama ${short(p.addr)} (dalam ${hops(p.hop)} langkah).`,
    'linked-flagged': (p, src) => `${p.count} alamat dalam aliran dana ini (pemegang atau likuiditas) dikenal oleh Neuro, misalnya ${short(p.addr)}: ${src}.`,
    'fresh-deployer': (p) => `Deployer baru mengirim total ${p.nonce} transaksi: dompet baru.`,
    'funding-from-hub': (p) => `Jejak dana deployer sampai ke alamat sibuk (bursa, bridge, atau kontrak) ${hops(p.hop)} langkah ke belakang. Jejak tidak diikuti melewati alamat seperti itu.`,
    'prior-contracts': (p) => `Deployer ini membuat ${p.count} kontrak lain (ditampilkan di grafik).`,
    'supply-split': (p) => `Token pertama dicetak untuk ${p.count} dompet berbeda.`,
    'graph-partial': (p) => `Sebagian data tidak dapat dibaca dalam batas sumber gratis, sehingga grafik ini belum lengkap (${p.notes || '-'}).`,
  },
};

export const FLOW_TEXT = { en, zh, es, ko, ja, ru, vi, th, id };

const pickL = (lang) => FLOW_TEXT[lang] ?? FLOW_TEXT.en;

/** Words for one source of a known address ("flagged in ThreatRegistry (reason)" …). */
export function sourceText(k, lang) {
  const L = pickL(lang);
  if (!k?.source) return '';
  if (k.source === 'registry') {
    const reasons = LANGS[lang]?.REASON ?? LANGS.en.REASON;
    return L.SRC.registry(k.reason ? (reasons[k.reason] ?? LANGS.en.REASON[k.reason] ?? k.reason) : '');
  }
  return L.SRC[k.source] ?? k.source;
}

/** One signal in a language: its sentence. */
export function signalText(s, lang = 'en') {
  const L = pickL(lang);
  const fn = L.S[s.id] ?? en.S[s.id];
  if (!fn) return s.id;
  return fn(s.params ?? {}, sourceText(s.params ?? {}, lang));
}

/** UI words with English filling any gap. */
export const flowUi = (lang) => ({ ...en.UI, ...pickL(lang).UI });
export const flowWords = (lang) => {
  const L = pickL(lang);
  return { ROLE: { ...en.ROLE, ...L.ROLE }, EDGE: { ...en.EDGE, ...L.EDGE }, STEP: { ...en.STEP, ...L.STEP }, STATUS: { ...en.STATUS, ...L.STATUS } };
};
