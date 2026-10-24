import { fmtSupply, list, short, sym } from './fmt.js';

// Simplified Chinese. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = '中文';

export const LEVEL = { high: '高风险', medium: '中等风险', low: '低风险', info: '按这些规则未发现风险' };

export const UI = {
  subtitle: '读取并解释合约 · 第 1 级，只读', chain: '链', address: '合约、代币地址或交易哈希', check: '检查合约',
  details: '详情', reading: '正在从链上读取…', badAddress: '该地址不适用于这条链。支持的格式：',
  failed: '读取失败：', footer: '从不要求连接钱包，也从不发送交易。读取公开的链上数据；为提前预警，仅将链名和合约地址发送到本站服务器（不保存）。不构成投资建议。', stats: '使用统计', badTx: '检查交易需要 EVM 链（Ethereum、BNB Chain、Base、Arbitrum 或 ZETAPHY），以及由 0x 加 64 个十六进制字符组成的哈希。', path: '发生了什么（路径）', statTx: '已检查的交易', statZetaphy: '在 ZETAPHY 上的检查', statChecks: '已检查的合约', statRisky: '标记为有风险的合约', statHigh: '发现高风险', statNote: '所有用户合计，近似值。只统计结果等级，从不记录合约。', language: '语言',
  disclaimer: '这是可重复验证的自动代码分析，不是对任何个人或项目的指控，也不构成投资建议。合约所有者可以回应或要求更正。',
  correction: '如何回应或要求更正',
  reproduce: '自行复核',
  reproduceHow: '任何人都可以用下面的命令（在 zetaphy-neuro 文件夹中）重新运行此检查。裁定 ID 只涵盖规则得出的结论，只要合约的代码和设置不变就会一致。报告 ID 还涵盖供应量等会变化的数字。',
  asWritten: '名称和符号按合约中所写显示，Neuro 不作确认。',
  early: '提前提醒：尚未公开的模式',
  earlyHow: 'ZETAPHY 的服务器还会把该合约的代码与正在观察、尚未公开的模式进行比对，以免这些模式在公布前就被绕开。代码与下列模式相符。此信息仅供参考：不属于上方结果，也不属于网络的裁定，可能有误；这些模式会在之后公开（通常约 30 天内）。',
  m: {
    chain: '链', address: '地址', proxy: 'Proxy', implementation: '实际代码（Implementation）', owner: '所有者', functions: '已识别的函数', report: '报告编号', explorer: '在 explorer 中打开', fingerprint: '代码指纹（用于登记模板）', unknown: '无法识别名称的函数',
    program: '代币程序', mintAuth: '增发权限（mint authority）', freezeAuth: '冻结权限（freeze authority）', extensions: '扩展', upgradeAuth: '升级权限', none: '无',
    package: '代码包', standard: '标准', admin: '管理员', holders: '持有人数', listed: 'tonapi 名单', raw: '原始地址',
    idl: 'Anchor IDL', codeId: '代码编号（code ID）', label: '合约名称', creator: '创建者', migrations: '代码被替换次数', hook: '转账检查合约', source: '已验证的源代码', format: '代码格式', delegation: '该钱包运行的代码', walletCode: '持有人钱包代码', nearKeys: '完全访问密钥（full-access key）', codeHash: '代码哈希', cairo: 'Cairo 版本', maxSupply: '最大供应量', tokenId: '代币编号',
    pool: '流动性池', simTax: '模拟交易税（买入 / 卖出）', simFailed: '卖出失败',
    verdict: '裁定 ID（仅规则）', command: '命令', rule: '规则',
    earlyMatch: '与观察中的模式相符。类别：', earlyRef: '参考编号',
    hash: '交易', status: '状态', block: '区块', succeeded: '成功', reverted: '失败（已回滚）',
  },
};

// ThreatRegistry categories (src/threat-reasons.js), as neutral descriptions of what the code does.
export const REASON = { 'cannot-sell-in-simulation': '模拟交易中卖出失败或几乎拿不回钱', 'unlimited-mint': '某个地址可以无上限增发', 'owner-can-block-transfers': '所有者或管理员可以阻止转账或卖出', 'owner-can-move-holder-funds': '所有者或管理员可以转走或销毁他人持有的资金', 'same-name-as-known-token': '与已知代币同名或同符号，但地址不同', 'sweeps-approved-tokens': '在可复现的测试中，把授权给它的代币转到持有人未选择的地址', 'other': '其他代码事实（见证据）' };

export const T = {
    'no-code': () => '该地址上没有合约代码。它可能只是普通钱包，或者选错了链。',
    'erc20': (p) => `ERC-20 代币“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'not-erc20': () => '未找到标准的 ERC-20 函数。这个合约可能不是代币。',
    'name-has-link': () => '代币名称或符号（按合约中所写）里含有链接或网站名。未经请求发来、名称带链接的代币常被用来把人引到外部网站。不要因为代币名称而访问该网站或连接钱包。',
    'proxy-minimal': (p) => `最小克隆合约（EIP-1167），始终运行 ${p.implementation} 上的代码。代码无法更改。`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} 可以升级合约代码，这是发行方修复或扩展功能的常规做法。`
      : `可升级：管理员${p.admin ? `（${p.admin}）` : ''}随时可以替换全部代码。今天的检查结果，明天未必仍然成立。`),
    'owner-active': (p) => `该合约由一个所有者控制：${p.owner}`,
    'owner-renounced': () => '所有权已放弃（所有者是零地址）。仅限所有者的函数已无法再调用。',
    'owner-unknown': () => '未找到 owner() 函数，因此不清楚谁掌握下面这些特殊权限。请假设有人掌握。',
    'roles': () => '使用基于角色的权限。可能有多个地址拥有特殊权限，仅看代码无法知道是谁。',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} 可以增发（${list(p.functions)}），根据存入的资产发行代币，这类代币通常如此。`
      : `可以凭空增发新代币（${list(p.functions)}），稀释持有人或大量抛向市场。`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} 可以冻结指定钱包（${list(p.functions)}），通常用于被盗资金或执法要求。`
      : `可以封锁指定钱包（${list(p.functions)}）。被封锁的钱包可能无法卖出或转账。`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} 可以在紧急情况下暂停所有转账（${list(p.functions)}）。`
      : `可以冻结所有转账（${list(p.functions)}）。届时可能没有人能卖出。`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `可以调整税率（${list(p.functions)}），但 ${p.project} 模板只允许调低。`
      : `可以修改买入/卖出税（${list(p.functions)}）。卖出税很高时，卖出几乎拿不回钱。`),
    'known-issuer': (p) => `由 ${p.issuer} 发行的官方 ${p.symbol} 合约（与登记的地址一致）。下列权限属于发行方；主要风险在于你是否信任发行方，而不是隐藏的代码。`,
    'lookalike': (p) => `使用了与 ${p.issuer} 代币相同的符号 ${p.symbol}，但不是其登记地址（${p.official}）。此合约不是已登记的 ${p.issuer} 代币；购买或接收前请核实地址。`,
    'template-match': (p) => `与已登记的 ${p.project} 代币模板（${p.name}）一致。该模板的规则尚未经过审计。`,
    'template-mismatch': (p) => `代码与 ${p.project} 模板一致，但拥有模板声称没有的权限（${list(p.functions)}）。模板记录可能有误；核实之前不要相信它。`,
    'trading-switch': (p) => `有交易开关（${list(p.functions)}）。开关打开之前，你可能能买入却无法卖出。`,
    'can-limit': (p) => `可以设置单笔交易或单个钱包的限额（${list(p.functions)}）。限额极低时可能导致无法卖出。`,
    'fee-exempt': (p) => `可以让指定钱包免税（${list(p.functions)}）。在收税代币中很常见，但会让部分钱包占便宜。`,
    'network-flagged': (p) => `Neuro ZETAPHY 网络的运行者已投票将这段代码记录在 ThreatRegistry 中${p.reason ? `（类别：${REASON[p.reason] ?? p.reason}）` : ''}。所有使用相同代码的合约都会收到同样的警告。`,
    'similar-flagged': (p) => `此代码与 Neuro 运行者标记过的代码相似 ${p.percent}%（指纹 ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `，类别：${REASON[p.reason] ?? p.reason}` : ''}）。对已标记代码稍作修改的副本，行为通常相同。`,
    'similar-reference': (p) => `此代码与 Neuro 数据集中的参考样本相似 ${p.percent}%（指纹 ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `，类别：${REASON[p.reason] ?? p.reason}` : ''}）。该样本并非 Neuro 运行者在链上标记的代码。相似只是提示需要仔细查看，并非证据。`,
    'tax-wallet': (p) => `可以更改接收税款的钱包（${list(p.functions)}）。在收税代币中很常见。`,
    'selfdestruct': () => '代码中包含 SELFDESTRUCT。一旦触发，可能清除合约或转走其中的资金。',
    'delegatecall': () => '代码可以把另一个合约的代码当作自己的来运行（DELEGATECALL），因此实际运行的代码可能不是这里显示的代码。',
    'nothing-found': () => '按这些规则未发现特殊权限或危险指令。',
    'unknown-functions': (p) => `还有 ${p.count} 个函数 Neuro 无法识别名称（${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}），因此不知道它们做什么。只要仍有所有者控制合约，这些函数就可能是特权函数，例如设置税率或交易限额。`,
    'unknown-pattern': (p) => `Neuro 还不认识这种模式，请小心：${p.share}% 的函数没有已知名称，而且代码可以转移币或代币。这里没发现问题并不代表安全。`,
    'bytecode-only': () => '基于链上代码和固定规则检查。隐藏在不寻常函数名后的权限可能被漏掉。不构成投资建议。',
    // Solana
    'sol-not-found': () => 'Solana 上该地址没有账户。可能输错了，或者选错了链。',
    'sol-not-token': (p) => `该地址不是 Solana 上的代币铸造账户（mint），而是程序 ${p.owner} 的一个账户。`,
    'sol-token': (p) => `${p.program} 代币“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} 可以增发（mint authority：${p.authority}），根据存入的资产发行代币，这类代币通常如此。`
      : `仍然可以增发新代币（mint authority：${p.authority}），稀释持有人或大量抛向市场。`),
    'sol-mint-renounced': () => '增发权限（mint authority）已放弃：供应量永远不会再增加。',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} 可以冻结账户（freeze authority），通常用于被盗资金或执法要求。`
      : `账户仍然可以被冻结（freeze authority：${p.authority}）。被冻结的账户无法卖出或转账。`),
    'sol-freeze-renounced': () => '冻结权限（freeze authority）已放弃：没有人能冻结你的代币。',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} 可以从任何账户转走或销毁代币（permanent delegate），用于依法没收。`
      : `一个永久代理（permanent delegate：${p.delegate}）无需许可就能从【所有】钱包转走或销毁代币。对持有人风险很高。`),
    'sol-transfer-fee': (p) => `每次转账收取 ${p.percent}% 的费用${p.authority ? `，且费用管理者（${p.authority}）可以把费率提高到 100%` : ''}。`,
    'sol-transfer-hook': (p) => `每次转账都会运行一个额外程序（transfer hook：${p.programId}），它可以执行自己的规则，例如禁止卖出。`,
    'sol-default-frozen': () => '该代币的新账户默认处于冻结状态：买入后，在解冻之前你可能无法转出或卖出。',
    'sol-pausable': (p) => `所有转账都可以被暂停（pausable）${p.paused ? '，而且目前正处于暂停状态' : ''}。`,
    'sol-close-authority': (p) => `该代币的铸造账户可以被关闭，并在同一地址重新创建（close authority：${p.authority}）。`,
    'sol-non-transferable': () => '该代币无法转账（non-transferable）：它是一种徽章或权益，而不是可交易的币。',
    'sol-metadata-mutable': (p) => `名称、符号和图片仍可修改（update authority：${p.authority}），例如日后被改成冒充其他代币。`,
    'sol-program-upgradeable': (p) => `可升级程序：权限持有者（${p.authority}）随时可以替换其代码。`,
    'sol-program-immutable': () => '该程序已无法再升级；代码是固定的。',
    'sol-caveat': () => '基于链上账户数据和固定规则检查；未检查流动性和持币分布。不构成投资建议。',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} 可以从任何钱包没收或销毁代币（${list(p.functions)}），用于依法没收。`
      : `有可以从别人钱包拿走或销毁代币的函数（${list(p.functions)}）。你的代币可能在未经你允许的情况下被拿走。`),
    // Sui
    'sui-not-found': () => 'Sui 上该地址没有币或代码包。可能输错了，或者选错了链。',
    'sui-coin': (p) => `Sui 币“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sui-not-coin': (p) => `代码包 ${p.package} 存在，但没有找到这个名字的币。请检查模块名和币名。`,
    'sui-package': (p) => `这是 Sui 上的一个 Move 代码包（${p.package}），不是币。下面列出的是其代码开放的权限。`,
    'sui-supply-fixed': () => '供应量已锁定：永远不会增加或减少。',
    'sui-supply-burn-only': () => '已无法再增发；只能销毁。',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} 可以增发（TreasuryCap），根据存入的资产发行币，这类币通常如此。`;
      if (p.holder) return `仍然可以增发新币：钱包 ${p.holder} 持有增发密钥（TreasuryCap），可以无限增发，稀释持有人或大量抛向市场。`;
      const where = { object: '被保存在另一个合约中', shared: '位于一个共享对象中' }[p.where] ?? '仍然存在，但没有找到持有者';
      return `仍然可以增发新币：增发密钥（TreasuryCap）${where}。增发规则取决于持有它的代码。`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} 可以封锁指定钱包（DenyCap），通常用于被盗资金或执法要求。`
      : `受监管的币（regulated）：DenyCap 持有者${p.holder ? `（${p.holder}）` : ''}可以封锁钱包。被封锁的钱包无法使用或卖出这个币。`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} 可以在紧急情况下暂停这个币的所有使用。`
      : 'DenyCap 持有者可以一次性对所有人暂停这个币（global pause）。'),
    'sui-system': () => 'Sui 系统代码：只能通过验证者投票升级。',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} 可以升级代码包，这是发行方修复或扩展功能的常规做法。`
      : `可升级代码包：UpgradeCap 持有者${p.holder ? `（${p.holder}）` : p.where === 'object' ? '（被保存在另一个合约中）' : ''}可以修改代码（policy：${p.policy}）。今天的检查结果，明天未必仍然成立。`),
    'sui-upgrade-cap-gone': () => '升级密钥（UpgradeCap）已不再单独存在：要么已被销毁、代码从此永久不变，要么被锁在另一个合约里。',
    'move-truncated': () => '这个代码包很大；Neuro 只检查了前 50 个模块，每个模块只检查前 50 个函数。',
    'move-caveat': () => '基于函数名、链上数据和固定规则检查。未检查函数内部逻辑和流动性。不构成投资建议。',
    // Aptos
    'apt-not-found': () => 'Aptos 上该地址没有币或账户。可能输错了，或者选错了链。',
    'apt-not-token': (p) => (p.account ? '该地址是 Aptos 上的用户账户，不是代币。' : '该地址是 Aptos 上的一个对象，但不是代币。'),
    'apt-token': (p) => `Aptos ${p.standard}“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `，上限 ${fmtSupply(p.maxSupply, p.decimals)}` : ''}。`,
    'apt-package': (p) => `这是 Aptos 上的一个 Move 代码包（${p.address}），不是代币。下面列出的是其代码开放的权限。`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} 可以增发、冻结和销毁（managed_coin），这类代币通常如此。`
      : `创建者（${p.account}）掌握增发、冻结和销毁权限（managed_coin），随时可以增发。`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} 可以增发，根据存入的资产发行代币，这类代币通常如此。`
      : `创建者的代码保留了增发权限（${list(p.structs)}）。仍然可以创建新代币，稀释持有人。`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} 可以冻结指定钱包，通常用于被盗资金或执法要求。`
      : `创建者的代码保留了冻结钱包的权限（${list(p.structs)}）。被冻结的钱包无法卖出或转账，而且 TransferRef 可以未经许可转走你的代币。`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} 可以从任何钱包销毁代币，用于依法没收。`
      : `创建者的代码保留了从任何人钱包销毁代币的权限（${list(p.structs)}）。`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} 会在每次存入和取出时运行额外代码（${list(p.functions)}）。`
      : `每次存入和取出都会运行额外代码（${list(p.functions)}），它可以执行自己的规则，例如禁止卖出。`),
    'apt-untransferable': () => '代币存储无法更换所有者（untransferable）。普通的代币转账仍然可以进行。',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} 可以升级代码，这是发行方修复或扩展功能的常规做法。`
      : `创建者的代码（${list(p.packages)}，位于 ${p.address}）可以升级：该账户随时可以修改它。今天的检查结果，明天未必仍然成立。`),
    'apt-immutable': (p) => `创建者的代码（${p.address}）已设为不可变：永远不会改变。`,
    'apt-framework': () => 'Aptos 系统代码：只能通过网络投票升级。',
    // TON
    'ton-not-found': () => 'TON 上该地址没有合约（不存在或尚未部署）。可能输错了。',
    'ton-not-jetton': (p) => {
      if (p.wallet) return '该地址是钱包，不是代币。';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return '这是某个持有人的 jetton wallet，不是代币本身。请输入代币的主地址（jetton master）。';
      return `这个 TON 合约不是代币${p.interfaces?.length ? `（${list(p.interfaces)}）` : ''}。`;
    },
    'ton-scam': () => 'tonapi.io（第三方）给该代币或其管理员账户加了警告标签。这是 tonapi.io 的标签，不是本次代码检查的结果；购买或接收前请查看其原因。',
    'ton-jetton': (p) => `TON 代币（jetton）“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `，持有人 ${fmtSupply(p.holders, 0)} 个` : ''}。`,
    'ton-listed': () => '在 tonapi.io 的已核查代币名单（whitelist）上。这只是第三方名单，不是保证。',
    'ton-frozen': () => '该代币合约因未缴存储费而被冻结，目前无法使用。',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} 可以增发，根据存入的资产发行代币，这类代币通常如此。`
      : `管理员（${p.admin}）仍然可以增发新代币，稀释持有人或大量抛向市场。`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} 是合约管理员，可以修改代币信息。`
      : `管理员（${p.admin}）仍然可以修改名称和图标；如果合约代码不是标准代码，还可能拥有本检查看不到的其他权限。`),
    'ton-admin-dropped': () => '管理员角色已放弃：再也没有人能增发或修改代币信息。',
    'ton-mint-flag': () => '合约仍标记为可增发，但已没有管理员可以执行增发。',
    'ton-caveat': () => '基于 tonapi.io 解码的合约数据和固定规则检查；持有人钱包按 tonapi 的识别结果检查，并未逐行阅读代码。不构成投资建议。',
    'ton-wallet-standard': (p) => `持有人的代币存放在 tonapi.io 识别的标准 jetton 钱包中（${list(p.interfaces)}）。`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} 使用自己的 jetton 钱包代码，这对该代币属正常。`
      : `持有人的代币存放在 tonapi.io 无法识别为标准 jetton 钱包的代码中${p.compiler ? ` (${p.compiler})` : ''}。自定义钱包代码可能拒绝转出，导致能买不能卖。代码哈希：${p.codeHash ?? '?'}。`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `该程序用 Rust（Anchor）编写，并在链上公开了指令列表：名称 ${p.name ?? '?'}，共 ${p.count ?? '?'} 条指令。`,
    'sol-admin-instructions': (p) => `需要管理员签名的指令（${list(p.functions)}）。管理员可以用它们改变程序的运行方式。`,
    'sol-no-idl': () => '该程序没有在链上公开指令列表（Anchor IDL），因此无法读出它能做什么。',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} 使用 Stylus 合约（Rust/C++ 编译为 Arbitrum 上的 WASM），Neuro 的规则目前还无法读取。`
      : '这是 Stylus 合约（用 Rust 或 C++ 编写，编译为 Arbitrum 上的 WASM）。Neuro 的规则目前还无法读取这种代码，因此不知道它能否增发、封锁或暂停转账。请视为未经检查。'),
    'stylus-read': (p) => `这是 Stylus 合约（用 Rust 或 C++ 编写，编译为 Arbitrum 上的 WASM）。Neuro 已解开其 WASM 代码（${fmtSupply(p.size, 0)} 字节），在其中找到 ${p.count ?? 0} 个已知函数，下面的结果即来自这些函数。名称特殊的函数可能会被漏掉。`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} 使用的代码不是标准的 EVM bytecode。`
      : '该合约的代码不是标准的 EVM bytecode，Neuro 的规则无法读取。请视为未经检查。'),
    'eip7702': (p) => `该地址是普通钱包，其所有者设置它运行合约 ${p.target} 的代码（EIP-7702）。它不是代币。那段代码可以按其编写方式任意处置钱包里的资金；请同时检查 ${p.target}。`,
    'source-verified': (p) => `有公开的源代码，Sourcify 已确认它${p.match === 'exact' ? '与链上代码逐字节一致' : '与链上代码一致'}（${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}）。可在 ${p.url} 阅读`,
    'source-unverified': () => 'Sourcify 上没有源代码。它可能仍在该链的 explorer 上公开；如果哪里都没有公开，请格外小心。',
    // Trade simulation (buy/sell test, src/honeypot.js)
    'sim-cannot-sell': (p) => `卖出测试未通过：通过 ${p.dex} 模拟交易，可以买入，但${p.sell == null ? '无法卖出' : `卖出后几乎拿不回钱（损失 ${p.sell}%）`}。买入后你可能无法卖出。（少数代币只在刚买入后禁止卖出，此检查无法区分这两种情况。）`,
    'sim-high-tax': (p) => (p.buy >= 100 && p.sell == null
      ? `通过 ${p.dex} 模拟买入后没有收到任何代币：所付款项被全部扣走。`
      : `通过 ${p.dex} 模拟交易：买入时损失 ${p.buy ?? '?'}%，卖出时损失 ${p.sell ?? '?'}%，被代币作为税收走。你拿回的会比价格显示的少这么多。`),
    'sim-ok': (p) => `通过 ${p.dex} 模拟少量买入再卖出成功（买入税 ${p.buy}%，卖出税 ${p.sell}%）。这只是当前区块的测试：控制合约的人以后仍可能提高税率或禁止卖出。`,
    'sim-skipped': (p) => ({
      'no-pool': `在 ${p.dex} 上未找到此代币与 ${p.native} 的交易池，因此未进行模拟买卖。仅凭这一点并非危险信号，该代币可能在其他地方交易。`,
      'no-override': '公共 RPC 不允许模拟交易（state override），因此未进行模拟买卖。',
      'buy-failed': `通过 ${p.dex} 模拟买入失败，因此无法测试卖出。可能尚未开放交易，或代币拒绝来自合约的买入。`,
    })[p.why] ?? '无法运行模拟交易，因此未测试买入和卖出。',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => '这条链上该地址没有合约或代币。可能地址输错了，或者选错了链。',
    'cw20-token': (p) => `CW20 代币（CosmWasm 上的 Rust 合约）“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'cw-contract': (p) => `CosmWasm 合约（用 Rust 编写）${p.label ? `，名称“${p.label}”` : ''}，code ID ${p.codeId ?? '?'}。不是 CW20 代币。`,
    'cw-admin': (p) => `管理员（${p.admin}）随时可以把合约代码替换为新代码（migrate）。今天的检查结果，明天未必仍然成立。`,
    'cw-no-admin': () => '没有管理员：合约代码永远无法被替换。',
    'cw-migrated': (p) => `该合约的代码已经被替换过 ${p.count} 次。`,
    'cw20-minter': (p) => `${p.minter} 仍然可以增发新代币${p.cap ? `，总量最多 ${fmtSupply(p.cap, p.decimals)}` : '，没有上限'}，稀释持有人或大量抛向市场。`,
    'cw20-no-minter': () => '没有人能再增发这种代币。',
    'tf-token': (p) => `Token Factory 代币“${p.name ?? '?'}”${p.symbol ? `（${p.symbol}）` : ''}，由 ${p.creator} 创建，总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'tf-admin': (p) => `管理员（${p.admin}）可以无限增发；在某些链上，还能转走或销毁别人钱包里的代币。`,
    'tf-no-admin': () => '管理员角色已放弃：再也没有人能增发。',
    'tf-hook': (p) => `每笔转账都必须经过合约 ${p.contract}（before-send hook），它可以执行自己的规则，例如禁止卖出。`,
    'cw-caveat': () => '基于链上合约数据和固定规则检查。未检查其中的 Rust 代码，也未检查流动性。不构成投资建议。',
    // NEAR
    'near-not-found': () => 'NEAR 上没有这个名称的账户。可能名称输错了，或者选错了链。',
    'near-no-contract': () => '这个 NEAR 账户是普通账户，没有合约。它不是代币。',
    'near-token': (p) => `NEAR 代币（NEP-141）“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'near-contract': (p) => `NEAR 合约（WASM 代码，例如用 Rust 编写），有 ${p.count ?? '?'} 个公开函数。不是 NEP-141 代币。`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer} 仍持有合约账户的 full-access key，因此可以修改代码，这是发行方修复或扩展功能的常规做法。`
      : `合约账户仍有 ${p.count} 个 full-access key：持有者随时可以部署新代码覆盖它。今天的检查结果，明天未必仍然成立。`),
    'near-locked': () => '合约账户没有任何 full-access key：没有人能从外部部署新代码覆盖它。',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer} 可以通过合约函数（${list(p.functions)}）升级代码。`
      : `代码中有可以替换自身代码的函数（${list(p.functions)}）。即使没有 full-access key，能调用这些函数的人也可以修改代码。`),
    'near-caveat': () => '基于 WASM 代码中的函数名和链上账户数据，按固定规则检查。未读取函数内部逻辑。不构成投资建议。',
    // Starknet (Cairo)
    'sn-not-found': () => 'Starknet 上该地址没有合约。可能输错了，或者选错了链。',
    'sn-token': (p) => `Starknet 代币“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sn-contract': (p) => `Starknet 合约（用 Cairo ${p.cairo === 1 ? '1' : '0'} 编写），ABI 中有 ${p.count ?? '?'} 个函数。不是代币。`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer} 可以升级合约代码，这是发行方修复或扩展功能的常规做法。`
      : `可升级${p.implementation ? `（proxy 指向代码 ${p.implementation}）` : ''}${p.functions?.length ? `（通过 ${list(p.functions)}）` : ''}：有权限的人可以替换全部代码。今天的检查结果，明天未必仍然成立。`),
    'sn-caveat': () => '基于合约在链上公开的 ABI（函数名以及是否会修改状态），按固定规则检查。未读取函数内部逻辑。不构成投资建议。',
    // Bitcoin (Runes)
    'btc-not-found': () => '在 Bitcoin 上找不到这个名称或编号的 Rune。Rune 的名称形如 DOG•GO•TO•THE•MOON，编号形如 840000:3。目前还不能读取 BRC-20 代币。',
    'btc-rune': (p) => `Bitcoin 上的 Rune 代币“${p.name ?? '?'}”${p.symbol ? `（${p.symbol}）` : ''}，编号 ${p.id ?? '?'}，目前已发行 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'btc-no-admin': () => 'Bitcoin 上的代币没有合约代码，也没有所有者：没有人能冻结、封锁、暂停、收税或修改这个代币。它的规则在创建时就已固定。',
    'btc-open-mint': (p) => (p.unlimited
      ? '任何人仍可继续铸造（mint），没有上限，也没有截止时间，因此供应量可以无限增长。'
      : `仍在开放铸造（mint）：任何人都可以继续铸造，直到${p.end ? `区块 ${p.end} 或` : ''}${p.maxSupply ? `达到上限 ${fmtSupply(p.maxSupply, p.decimals)}` : '铸造期结束'}${p.percent != null ? `（目前已铸造 ${p.percent}%）` : ''}。供应量仍在增加。`),
    'btc-premine': (p) => `创建代币时，最大供应量的 ${p.percent}% 直接归创建者所有（premine）。创建者随时可以卖出。`,
    'btc-turbo': () => '创建者选择接受 Runes 协议未来的变更（turbo），因此这个代币的运作方式可能会随协议新版本而改变。',
    'btc-caveat': () => '基于 Runes 的参考索引器 ord（ordinals.com）的数据，按固定规则检查。Rune 是索引器在 Bitcoin 之上按规则认定的。未检查持有人和流动性。不构成投资建议。',
    // Transaction checks (src/tx.js)
    'tx-not-found': () => '所选链上没有这个哈希的交易。请检查哈希，或选择发送这笔交易的链。',
    'tx-summary': (p) => (p.created ? `${short(p.from)} 在 ${short(p.to)} 创建了一个新合约。`
      : p.method ? `${short(p.from)} 调用了 ${short(p.to)} 上的 ${p.method}${p.value !== '0' ? `，并发送了 ${fmtSupply(p.value, 18)} ${p.native}` : ''}。`
        : `${short(p.from)} 向 ${short(p.to)} 发送了 ${fmtSupply(p.value, 18)} ${p.native}。`),
    'tx-failed': () => '这笔交易失败了（已回滚）：它想做的事都没有发生，但手续费已经支付。',
    'tx-created': (p) => `它在 ${p.address} 创建了一个合约。请也单独检查这个地址。`,
    'tx-approve-wallet': (p) => `发送者授权一个普通钱包（${p.spender}）而不是合约来使用他们的 ${sym(p)}${p.unlimited ? '，且没有额度限制' : ''}。正规应用使用的是合约；这是代币被从钱包转走的常见方式。请立即撤销这项授权（例如使用 revoke.cash）。`,
    'tx-approve-risky': (p) => `发送者授权 ${p.spender} 使用他们的 ${sym(p)}，而 Neuro 将这个合约评为高风险。请立即撤销这项授权（例如使用 revoke.cash）。`,
    'tx-approve-unlimited': (p) => `无限额授权：${p.spender} 现在和以后随时都可以拿走发送者的全部 ${sym(p)}。对你信任的应用来说这很常见；不再使用该应用时请撤销授权。`,
    'tx-approve-all-wallet': (p) => `发送者授权一个普通钱包（${p.operator}）转移他们的全部 ${sym(p)} NFT。NFT 盗取工具正是这样运作的。请立即撤销（例如使用 revoke.cash）。`,
    'tx-approve-all': (p) => `发送者授权 ${p.operator} 转移他们的全部 ${sym(p)} NFT。只应对你信任的交易市场这样做。`,
    'tx-zero-transfer': (p) => `从 ${short(p.from)} 向 ${short(p.to)} 转账 0 ${sym(p)}。这是地址投毒：在你的记录里留下一条假记录，让你以后复制一个长得很像的地址。永远不要从交易记录中复制地址。`,
    'tx-lookalike': (p) => `${p.a} 看起来像 ${p.b}（开头和结尾相同），但它是另一个地址。它是故意做成让人认错的：发送任何东西前请逐个字符核对。`,
    'tx-bait-payable': (p) => `向合约函数“${p.method}”发送了 ${fmtSupply(p.value, 18)} ${p.native}。虚假空投、领取和“验证钱包”网站会用这类函数拿走钱；真正的空投从不要求你付款。`,
    'tx-to-risky': (p) => `Neuro 将这笔交易调用的合约（${p.to}）评为${p.level === 'high' ? '高' : '中'}风险。请单独检查这个地址以了解原因。`,
    'tx-nothing-found': () => '按这些规则，在这笔交易中没有发现风险。只检查交易本身及其日志（logs）显示的内容。',
    'path-call': (p) => (p.method ? `${short(p.from)} → ${short(p.to)}：${p.method}${p.value !== '0' ? ` + ${fmtSupply(p.value, 18)} ${p.native}` : ''}`
      : `${short(p.from)} → ${short(p.to)}：${fmtSupply(p.value, 18)} ${p.native}`),
    'path-create': (p) => `${short(p.from)} 创建了合约 ${short(p.address)}`,
    'path-token': (p) => `${fmtSupply(p.amount, p.decimals)} ${sym(p)}：${short(p.from)} → ${short(p.to)}`,
    'path-nft': (p) => `${sym(p)} 的 NFT #${p.id}：${short(p.from)} → ${short(p.to)}`,
    'path-approve': (p) => `${short(p.owner)} 授权 ${short(p.spender)} 使用${p.unlimited ? '无限额' : ` ${fmtSupply(p.amount, p.decimals)}`} ${sym(p)}`,
    'path-approveAll': (p) => `${short(p.owner)} ${p.approved ? '授权' : '取消了'} ${short(p.operator)} 转移全部 ${sym(p)} NFT${p.approved ? '' : '的权限'}`,
    'path-note': () => '合约内部转移的币不会列出（这需要 trace API）。',
};
