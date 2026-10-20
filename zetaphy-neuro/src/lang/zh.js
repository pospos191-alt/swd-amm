import { fmtSupply, list } from './fmt.js';

// Simplified Chinese. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = '中文';

export const LEVEL = { high: '高风险', medium: '中等风险', low: '低风险', info: '按这些规则未发现风险' };

export const UI = {
  subtitle: '读取并解释合约 · 第 1 级，只读', chain: '链', address: '合约或代币地址', check: '检查合约',
  details: '详情', reading: '正在从链上读取…', badAddress: '该地址不适用于这条链。支持的格式：',
  failed: '读取失败：', footer: '从不要求连接钱包，也从不发送交易。只读取公开的链上数据。不构成投资建议。', stats: '使用统计', language: '语言',
  m: {
    chain: '链', address: '地址', proxy: 'Proxy', implementation: '实际代码（Implementation）', owner: '所有者', functions: '已识别的函数', report: '报告编号', explorer: '在 explorer 中打开', fingerprint: '代码指纹（用于登记模板）', unknown: '无法识别名称的函数',
    program: '代币程序', mintAuth: '增发权限（mint authority）', freezeAuth: '冻结权限（freeze authority）', extensions: '扩展', upgradeAuth: '升级权限', none: '无',
    package: '代码包', standard: '标准', admin: '管理员', holders: '持有人数', listed: 'tonapi 名单', raw: '原始地址',
  },
};

export const T = {
    'no-code': () => '该地址上没有合约代码。它可能只是普通钱包，或者选错了链。',
    'erc20': (p) => `ERC-20 代币“${p.name ?? '?'}”（${p.symbol ?? '?'}），总供应量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'not-erc20': () => '未找到标准的 ERC-20 函数。这个合约可能不是代币。',
    'name-has-link': () => '代币名称或符号里含有链接或网站名，这是常见骗局（免费“空投”代币，引诱你访问假网站）。不要打开该网站，也不要连接钱包。',
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
    'lookalike': (p) => `使用了与 ${p.issuer} 代币相同的符号 ${p.symbol}，但不是官方地址（${p.official}）。可能是假币；在核实地址之前，不要购买或接收。`,
    'template-match': (p) => `与已登记的 ${p.project} 代币模板（${p.name}）一致。该模板的规则尚未经过审计。`,
    'template-mismatch': (p) => `代码与 ${p.project} 模板一致，但拥有模板声称没有的权限（${list(p.functions)}）。模板记录可能有误；核实之前不要相信它。`,
    'trading-switch': (p) => `有交易开关（${list(p.functions)}）。开关打开之前，你可能能买入却无法卖出。`,
    'can-limit': (p) => `可以设置单笔交易或单个钱包的限额（${list(p.functions)}）。限额极低时可能导致无法卖出。`,
    'fee-exempt': (p) => `可以让指定钱包免税（${list(p.functions)}）。在收税代币中很常见，但会让部分钱包占便宜。`,
    'network-flagged': (p) => `Neuro ZETAPHY 网络已投票认定这段代码危险${p.reason ? `（${p.reason}）` : ''}。所有使用相同代码的合约都会收到同样的警告。`,
    'tax-wallet': (p) => `可以更改接收税款的钱包（${list(p.functions)}）。在收税代币中很常见。`,
    'selfdestruct': () => '代码中包含 SELFDESTRUCT。一旦触发，可能清除合约或转走其中的资金。',
    'delegatecall': () => '代码可以把另一个合约的代码当作自己的来运行（DELEGATECALL），因此实际运行的代码可能不是这里显示的代码。',
    'nothing-found': () => '按这些规则未发现特殊权限或危险指令。',
    'unknown-functions': (p) => `还有 ${p.count} 个函数 Neuro 无法识别名称（${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}），因此不知道它们做什么。只要仍有所有者控制合约，这些函数就可能是特权函数，例如设置税率或交易限额。`,
    'bytecode-only': () => '基于链上代码和固定规则检查。用不寻常函数名隐藏的骗局可能被漏掉。不构成投资建议。',
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
      : `账户仍然可以被冻结（freeze authority：${p.authority}）。被冻结的账户无法卖出或转账，这是 Solana 上常见的骗局。`),
    'sol-freeze-renounced': () => '冻结权限（freeze authority）已放弃：没有人能冻结你的代币。',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} 可以从任何账户转走或销毁代币（permanent delegate），用于依法没收。`
      : `一个永久代理（permanent delegate：${p.delegate}）无需许可就能从【所有】钱包转走或销毁代币。非常危险。`),
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
    'ton-scam': () => 'tonapi.io 标记该代币或其管理员与诈骗有关。不要购买或接收。',
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
    'ton-caveat': () => '基于 tonapi.io 解码的合约数据和固定规则检查。未检查持有人钱包的代码（有些代币因此可以买入却无法卖出）。不构成投资建议。',
};
