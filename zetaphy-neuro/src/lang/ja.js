// Japanese. Same keys as en.js (test/i18n.test.js checks it).
import { fmtSupply, list } from './fmt.js';

export const NAME = '日本語';

export const LEVEL = { high: '高リスク', medium: '中リスク', low: '低リスク', info: 'このルールではリスクは見つかりませんでした' };

export const UI = {
  subtitle: 'コントラクトを読み取り、わかりやすく説明します · ティア1・読み取り専用', chain: 'チェーン', address: 'コントラクトまたはトークンのアドレス', check: 'コントラクトを確認',
  details: '詳細', reading: 'チェーンから読み取り中…', badAddress: 'このチェーンでは無効なアドレスです。使える形式: ',
  failed: '読み取れませんでした: ', footer: 'ウォレットの接続を求めることも、取引を送ることもありません。公開されているチェーンのデータを読むだけです。投資助言ではありません。', stats: '利用状況', language: '言語',
  m: {
    chain: 'チェーン', address: 'アドレス', proxy: 'Proxy', implementation: '実装コード', owner: 'オーナー', functions: '判明している関数', report: 'レポートID', explorer: 'explorer で開く', fingerprint: 'コードの指紋（テンプレート登録用）', unknown: '名前が不明な関数',
    program: 'トークンプログラム', mintAuth: '発行権限', freezeAuth: '凍結権限', extensions: '拡張機能', upgradeAuth: 'アップグレード権限', none: 'なし',
    package: 'パッケージ', standard: '規格', admin: '管理者', holders: '保有者数', listed: 'tonapi リスト', raw: 'raw アドレス',
    idl: 'Anchor IDL', codeId: 'code ID', label: 'ラベル', creator: '作成者', migrations: 'コードの置き換え回数', hook: '送金チェック用コントラクト', source: '検証済みのソースコード', format: 'コードの形式', delegation: 'このウォレットが実行するコード', walletCode: '保有者ウォレットのコード', nearKeys: 'フルアクセスキー（full-access key）', codeHash: 'コードハッシュ', cairo: 'Cairo バージョン', maxSupply: '最大供給量', tokenId: 'トークン ID',
  },
};

export const T = {
    'no-code': () => 'このアドレスにはコントラクトのコードがありません。通常のウォレットか、チェーンの選択が間違っている可能性があります。',
    'erc20': (p) => `ERC-20 トークン「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'not-erc20': () => '標準的な ERC-20 の関数が見つかりません。このコントラクトはトークンではない可能性があります。',
    'name-has-link': () => 'トークン名またはシンボルにリンクやサイト名が含まれています。よくある詐欺の手口です（無料の「エアドロップ」トークンで偽サイトに誘導します）。そのサイトを開いたり、ウォレットを接続したりしないでください。',
    'proxy-minimal': (p) => `最小クローン（EIP-1167）で、常に ${p.implementation} のコードを実行します。コードは変更できません。`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} はコントラクトのコードをアップグレードできます。発行者が修正や機能追加をする通常の方法です。`
      : `アップグレード可能: 管理者${p.admin ? `（${p.admin}）` : ''}はいつでもコード全体を置き換えられます。今日の確認結果が明日も正しいとは限りません。`),
    'owner-active': (p) => `このコントラクトはオーナーが管理しています: ${p.owner}`,
    'owner-renounced': () => 'オーナー権限は放棄されています（オーナーはゼロアドレス）。オーナー専用の関数はもう誰も呼び出せません。',
    'owner-unknown': () => 'owner() 関数が見つからないため、下記の特別な権限を誰が持っているか不明です。誰かが持っているものと考えてください。',
    'roles': () => 'ロール方式の権限を使っています。複数のアドレスが特別な権限を持っている可能性があり、コードだけでは誰が持っているかわかりません。',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} は預かり資産に応じてトークンを新しく発行できます（${list(p.functions)}）。この種類のトークンでは想定どおりです。`
      : `トークンを新しく発行できます（${list(p.functions)}）。保有者の取り分が薄まったり、市場に大量に売られたりするおそれがあります。`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} は特定のウォレットを凍結できます（${list(p.functions)}）。主に盗難資金や法的命令への対応に使われます。`
      : `特定のウォレットをブロックできます（${list(p.functions)}）。ブロックされたウォレットは売却や送金ができなくなる可能性があります。`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} は緊急時にすべての送金を一時停止できます（${list(p.functions)}）。`
      : `すべての送金を止められます（${list(p.functions)}）。誰も売却できなくなる可能性があります。`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `手数料（税）を調整できます（${list(p.functions)}）が、${p.project} のテンプレートでは引き下げしかできません。`
      : `売買時の手数料（税）を変更できます（${list(p.functions)}）。売却時の手数料が非常に高いと、売ってもほとんど何も残りません。`),
    'known-issuer': (p) => `${p.issuer} が発行する ${p.symbol} の公式コントラクトです（登録済みのアドレスと一致）。下記の権限は発行者のものです。主なリスクは隠れたコードではなく、発行者を信頼できるかどうかです。`,
    'lookalike': (p) => `${p.issuer} のトークンと同じシンボル ${p.symbol} を使っていますが、公式アドレス（${p.official}）ではありません。偽物の可能性があります。アドレスを確認するまで購入や受け取りはしないでください。`,
    'template-match': (p) => `登録済みの ${p.project} トークンテンプレート（${p.name}）と一致します。このテンプレートのルールはまだ監査されていません。`,
    'template-mismatch': (p) => `コードは ${p.project} のテンプレートと一致しますが、テンプレート上は無いはずの権限があります（${list(p.functions)}）。テンプレートの記録が誤っている可能性があるため、確認されるまで信用しないでください。`,
    'trading-switch': (p) => `取引のオン/オフ切り替えがあります（${list(p.functions)}）。オンになる前は、買えても売れない場合があります。`,
    'can-limit': (p) => `1回の取引ごと、またはウォレットごとの上限を設定できます（${list(p.functions)}）。上限が非常に低いと売却できなくなることがあります。`,
    'fee-exempt': (p) => `選んだウォレットだけ手数料（税）を免除できます（${list(p.functions)}）。手数料付きトークンではよくありますが、一部のウォレットが有利になります。`,
    'network-flagged': (p) => `Neuro ZETAPHY ネットワークの投票で、このコードは危険と判定されました${p.reason ? `（${({ drainer: '資金を抜き取る', honeypot: '買えるが売れない', 'hidden-mint': '隠れた発行機能', 'fake-token': '偽トークン', phishing: 'フィッシング' })[p.reason] ?? p.reason}）` : ''}。同じコードを使うすべてのコントラクトに同じ警告が表示されます。`,
    'tax-wallet': (p) => `手数料（税）を受け取るウォレットを変更できます（${list(p.functions)}）。手数料付きトークンではよくあることです。`,
    'selfdestruct': () => 'コードに SELFDESTRUCT が含まれています。実行されると、コントラクトが消されたり、資金が移動されたりする可能性があります。',
    'delegatecall': () => '別のコントラクトのコードを自分のものとして実行できます（DELEGATECALL）。そのため、実際に動くコードはここに表示されたものと違う可能性があります。',
    'nothing-found': () => 'このルールでは、特別な権限や危険な命令は見つかりませんでした。',
    'unknown-functions': (p) => `Neuro が名前を特定できない関数がほかに ${p.count} 個あります（${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}）。何をする関数かは不明です。オーナーがまだコントラクトを管理している間は、手数料や取引上限の設定などの特別な権限である可能性があります。`,
    'bytecode-only': () => 'チェーン上のコードを決まったルールで確認した結果です。珍しい関数名で隠された詐欺は見逃すことがあります。投資助言ではありません。',
    // Solana
    'sol-not-found': () => 'Solana 上のこのアドレスにアカウントがありません。入力ミスか、チェーンの選択が間違っている可能性があります。',
    'sol-not-token': (p) => `このアドレスは Solana のトークン（mint）ではなく、プログラム ${p.owner} のアカウントです。`,
    'sol-token': (p) => `${p.program} トークン「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} は預かり資産に応じてトークンを新しく発行できます（mint authority: ${p.authority}）。この種類のトークンでは想定どおりです。`
      : `まだトークンを新しく発行できます（mint authority: ${p.authority}）。保有者の取り分が薄まったり、市場に大量に売られたりするおそれがあります。`),
    'sol-mint-renounced': () => '発行権限（mint authority）は放棄されています。供給量が増えることはありません。',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} はアカウントを凍結できます（freeze authority）。主に盗難資金や法的命令への対応に使われます。`
      : `まだアカウントを凍結できます（freeze authority: ${p.authority}）。凍結されたアカウントは売却も送金もできません。Solana でよくある詐欺の手口です。`),
    'sol-freeze-renounced': () => '凍結権限（freeze authority）は放棄されています。誰もあなたのトークンを凍結できません。',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} はどのアカウントからもトークンを移動・焼却できます（permanent delegate）。法的な差し押さえに使われます。`
      : `永続的な代理人（permanent delegate: ${p.delegate}）が、許可なく「すべての」ウォレットからトークンを移動・焼却できます。非常に危険です。`),
    'sol-transfer-fee': (p) => `送金のたびに ${p.percent}% の手数料がかかります${p.authority ? `。また、手数料の管理者（${p.authority}）は最大 100% まで引き上げられます` : ''}。`,
    'sol-transfer-hook': (p) => `送金のたびに追加のプログラム（transfer hook: ${p.programId}）が実行され、売却の禁止など独自のルールを強制できます。`,
    'sol-default-frozen': () => 'このトークンの新しいアカウントは最初から凍結されています。購入後、凍結が解除されるまで移動や売却ができない可能性があります。',
    'sol-pausable': (p) => `すべての送金を一時停止できます（pausable）${p.paused ? '。現在、実際に停止中です' : ''}。`,
    'sol-close-authority': (p) => `この mint は閉じたうえで同じアドレスに作り直すことができます（close authority: ${p.authority}）。`,
    'sol-non-transferable': () => 'このトークンは送金できません（non-transferable）。売買できるコインではなく、バッジや権利を表すものです。',
    'sol-metadata-mutable': (p) => `名前・シンボル・画像はまだ変更できます（update authority: ${p.authority}）。後から別のトークンに見せかけることも可能です。`,
    'sol-program-upgradeable': (p) => `アップグレード可能なプログラムです: 権限者（${p.authority}）はいつでもコードを置き換えられます。`,
    'sol-program-immutable': () => 'このプログラムはもうアップグレードできません。コードは固定されています。',
    'sol-caveat': () => 'チェーン上のアカウントデータを決まったルールで確認した結果です。流動性や保有者の分布は確認していません。投資助言ではありません。',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} はどのウォレットからもトークンを差し押さえ・焼却できます（${list(p.functions)}）。法的な差し押さえに使われます。`
      : `他人のウォレットからトークンを取り上げたり焼却したりする関数があります（${list(p.functions)}）。あなたのトークンが許可なく奪われる可能性があります。`),
    // Sui
    'sui-not-found': () => 'Sui 上のこのアドレスにコインもパッケージもありません。入力ミスか、チェーンの選択が間違っている可能性があります。',
    'sui-coin': (p) => `Sui のコイン「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sui-not-coin': (p) => `パッケージ ${p.package} は存在しますが、その名前のコインは見つかりません。モジュール名とコイン名を確認してください。`,
    'sui-package': (p) => `Sui 上の Move コードのパッケージ（${p.package}）で、コインではありません。以下はこのコードが持つ権限の結果です。`,
    'sui-supply-fixed': () => '供給量はロックされています。増えることも減ることもありません。',
    'sui-supply-burn-only': () => 'これ以上コインを発行することはできず、焼却のみ可能です。',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} は預かり資産に応じてコインを新しく発行できます（TreasuryCap）。この種類のコインでは想定どおりです。`;
      if (p.holder) return `まだコインを新しく発行できます: ウォレット ${p.holder} が発行の鍵（TreasuryCap）を持ち、無制限に発行できます。保有者の取り分が薄まったり、市場に大量に売られたりするおそれがあります。`;
      const where = { object: 'は別のコントラクトの中に保管されています', shared: 'は共有オブジェクトの中にあります' }[p.where] ?? 'はまだ存在しますが、保有者が見つかりません';
      return `まだコインを新しく発行できます: 発行の鍵（TreasuryCap）${where}。発行のルールは、鍵を保管しているコード次第です。`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} は特定のウォレットをブロックできます（DenyCap）。主に盗難資金や法的命令への対応に使われます。`
      : `規制付きコイン（regulated）です: DenyCap の保有者${p.holder ? `（${p.holder}）` : ''}はウォレットをブロックできます。ブロックされたウォレットはこのコインを使うことも売ることもできません。`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} は緊急時にこのコインのすべての利用を一時停止できます。`
      : 'DenyCap の保有者は、このコインを全員に対して一斉に停止できます（global pause）。'),
    'sui-system': () => 'Sui のシステムコードです。バリデーターの投票によってのみアップグレードできます。',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} はパッケージのコードをアップグレードできます。発行者が修正や機能追加をする通常の方法です。`
      : `アップグレード可能なパッケージです: UpgradeCap の保有者${p.holder ? `（${p.holder}）` : p.where === 'object' ? '（別のコントラクトの中に保管）' : ''}はコードを変更できます（ポリシー: ${p.policy}）。今日の確認結果が明日も正しいとは限りません。`),
    'sui-upgrade-cap-gone': () => 'アップグレードの鍵（UpgradeCap）は単独では存在しません。破棄されてコードが永久に固定されたか、別のコントラクトの中にロックされています。',
    'move-truncated': () => 'このパッケージは大きいため、Neuro は最初の 50 モジュール、各モジュール 50 関数までしか確認していません。',
    'move-caveat': () => '関数名とチェーン上のデータを決まったルールで確認した結果です。関数の中身や流動性は確認していません。投資助言ではありません。',
    // Aptos
    'apt-not-found': () => 'Aptos 上のこのアドレスにコインもアカウントもありません。入力ミスか、チェーンの選択が間違っている可能性があります。',
    'apt-not-token': (p) => (p.account ? 'このアドレスは Aptos のユーザーアカウントで、トークンではありません。' : 'このアドレスはトークンではない Aptos のオブジェクトです。'),
    'apt-token': (p) => `Aptos ${p.standard}「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `、上限 ${fmtSupply(p.maxSupply, p.decimals)}` : ''}。`,
    'apt-package': (p) => `Aptos 上の Move コードのパッケージ（${p.address}）で、トークンではありません。以下はこのコードが持つ権限の結果です。`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} は発行・凍結・焼却ができます（managed_coin）。この種類のトークンでは想定どおりです。`
      : `作成者（${p.account}）が発行・凍結・焼却の権限（managed_coin）を持ち、いつでも新しく発行できます。`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} は預かり資産に応じてトークンを新しく発行できます。この種類のトークンでは想定どおりです。`
      : `作成者のコードが発行の権限を持ち続けています（${list(p.structs)}）。まだトークンを新しく作れるため、保有者の取り分が薄まるおそれがあります。`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} は特定のウォレットを凍結できます。主に盗難資金や法的命令への対応に使われます。`
      : `作成者のコードがウォレットを凍結する権限を持ち続けています（${list(p.structs)}）。凍結されたウォレットは売却も送金もできず、TransferRef があれば許可なくあなたのトークンを移動できます。`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} はどのウォレットからもトークンを焼却できます。法的な差し押さえに使われます。`
      : `作成者のコードが、誰のウォレットからでもトークンを焼却する権限を持ち続けています（${list(p.structs)}）。`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} は入金・出金のたびに追加のコードを実行します（${list(p.functions)}）。`
      : `入金・出金のたびに追加のコードが実行され（${list(p.functions)}）、売却の禁止など独自のルールを強制できます。`),
    'apt-untransferable': () => 'トークンの保管場所の持ち主は変更できません（untransferable）。通常のトークン送金は引き続き可能です。',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} はコードをアップグレードできます。発行者が修正や機能追加をする通常の方法です。`
      : `作成者のコード（${p.address} の ${list(p.packages)}）はアップグレード可能です: そのアカウントはいつでもコードを変更できます。今日の確認結果が明日も正しいとは限りません。`),
    'apt-immutable': (p) => `作成者のコード（${p.address}）は変更不可（immutable）に設定されています。今後変わることはありません。`,
    'apt-framework': () => 'Aptos のシステムコードです。ネットワークの投票によってのみアップグレードできます。',
    // TON
    'ton-not-found': () => 'TON 上のこのアドレスにコントラクトがありません（存在しないか、まだデプロイされていません）。入力ミスの可能性があります。',
    'ton-not-jetton': (p) => {
      if (p.wallet) return 'このアドレスはウォレットで、トークンではありません。';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return 'これは保有者ひとりの jetton wallet で、トークン本体ではありません。トークンのメインアドレス（jetton master）を入力してください。';
      return `この TON コントラクトはトークンではありません${p.interfaces?.length ? `（${list(p.interfaces)}）` : ''}。`;
    },
    'ton-scam': () => 'tonapi.io は、このトークンまたはその管理者を詐欺に関係していると判定しています。購入や受け取りはしないでください。',
    'ton-jetton': (p) => `TON のトークン（jetton）「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `、保有者 ${fmtSupply(p.holders, 0)} 人` : ''}。`,
    'ton-listed': () => 'tonapi.io の確認済みトークンのリスト（whitelist）に載っています。第三者のリストであり、安全の保証ではありません。',
    'ton-frozen': () => 'このトークンのコントラクトは保管料の未払いで凍結されており、現在は使えません。',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} は預かり資産に応じてトークンを新しく発行できます。この種類のトークンでは想定どおりです。`
      : `管理者（${p.admin}）はまだトークンを新しく発行できます。保有者の取り分が薄まったり、市場に大量に売られたりするおそれがあります。`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} はコントラクトの管理者で、トークンの情報を変更できます。`
      : `管理者（${p.admin}）はまだ名前やロゴを変更できます。コントラクトのコードが標準的でない場合、このチェックでは見えない他の権限を持っている可能性もあります。`),
    'ton-admin-dropped': () => '管理者の役割は放棄されています。もう誰もトークンを発行したり、情報を変更したりできません。',
    'ton-mint-flag': () => 'コントラクト上はまだ発行可能となっていますが、発行できる管理者はいません。',
    'ton-caveat': () => 'tonapi.io が解読したコントラクトのデータを決まったルールで確認した結果です。保有者のウォレットは tonapi の認識結果で確認しており、コードを一行ずつ読んではいません。投資助言ではありません。',
    'ton-wallet-standard': (p) => `保有者のトークンは、tonapi.io が認識する標準の jetton ウォレットに入っています（${list(p.interfaces)}）。`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} は独自の jetton ウォレットコードを使っています。このトークンでは通常のことです。`
      : `保有者のトークンは、tonapi.io が標準の jetton ウォレットと認識しないコードに入っています${p.compiler ? ` (${p.compiler})` : ''}。独自のウォレットコードは送金を拒否できるため、買えても売れない可能性があります。コードハッシュ：${p.codeHash ?? '?'}。`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `このプログラムは Rust（Anchor）で書かれており、命令の一覧をチェーン上で公開しています: ${p.name ?? '?'}、命令 ${p.count ?? '?'} 個。`,
    'sol-admin-instructions': (p) => `管理者の署名が必要な命令があります（${list(p.functions)}）。管理者はこれらを使ってプログラムの動作を変更できます。`,
    'sol-no-idl': () => 'このプログラムは命令の一覧（Anchor IDL）をチェーン上で公開していないため、何ができるのかを読み取れません。',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} は Stylus コントラクト（Arbitrum 上で Rust/C++ を WASM にコンパイルしたもの）を使っており、Neuro のルールではまだ読み取れません。`
      : 'Stylus コントラクト（Arbitrum 上で Rust または C++ を WASM にコンパイルしたもの）です。Neuro のルールではまだこのコードを読み取れないため、トークンの発行、送金の停止、一時停止ができるかどうかは不明です。未確認として扱ってください。'),
    'stylus-read': (p) => `Stylus コントラクトです（Rust や C++ を Arbitrum 上の WASM にコンパイルしたもの）。Neuro は WASM コード（${fmtSupply(p.size, 0)} バイト）を展開して読み、既知の関数を ${p.count ?? 0} 個見つけました。以下の結果はそれらに基づきます。珍しい名前の関数は見落とす可能性があります。`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} は標準的な EVM bytecode ではないコードを使っています。`
      : 'このコントラクトのコードは標準的な EVM bytecode ではなく、Neuro のルールでは読み取れません。未確認として扱ってください。'),
    'eip7702': (p) => `このアドレスは普通のウォレットで、持ち主がコントラクト ${p.target} のコードを実行するように設定しています（EIP-7702）。トークンではありません。そのコードは、書かれているとおりにウォレットの資金を何にでも使えます。${p.target} も確認してください。`,
    'source-verified': (p) => `Sourcify が${p.match === 'exact' ? 'チェーン上のコードと1バイト単位で完全に一致する' : 'チェーン上のコードと一致する'}ことを確認した公開ソースコードがあります（${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}）。${p.url} で読めます。`,
    'source-unverified': () => 'Sourcify にソースコードがありません。チェーンの explorer で公開されている可能性はありますが、どこにも公開されていない場合は特に注意してください。',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => 'このチェーンのこのアドレスにはコントラクトもトークンもありません。入力ミスか、選んだチェーンが違う可能性があります。',
    'cw20-token': (p) => `CW20 トークン（CosmWasm 上の Rust コントラクト）「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'cw-contract': (p) => `CosmWasm コントラクト（Rust で書かれたもの）${p.label ? `「${p.label}」` : ''}、code ID ${p.codeId ?? '?'}。CW20 トークンではありません。`,
    'cw-admin': (p) => `管理者（${p.admin}）はいつでもコントラクトのコードを新しいコードに置き換えられます（migrate）。今日確認した内容が明日も正しいとは限りません。`,
    'cw-no-admin': () => '管理者はいません。コントラクトのコードが置き換えられることはありません。',
    'cw-migrated': (p) => `このコントラクトのコードはすでに ${p.count} 回置き換えられています。`,
    'cw20-minter': (p) => `${p.minter} はまだトークンを新しく発行できます${p.cap ? `（合計 ${fmtSupply(p.cap, p.decimals)} まで）` : '（上限なし）'}。保有者の取り分が薄まったり、市場に大量に売られたりするおそれがあります。`,
    'cw20-no-minter': () => 'このトークンをこれ以上発行できる人はいません。',
    'tf-token': (p) => `Token Factory のコイン「${p.name ?? '?'}」${p.symbol ? `（${p.symbol}）` : ''}、作成者 ${p.creator}、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'tf-admin': (p) => `管理者（${p.admin}）は上限なくトークンを発行できます。チェーンによっては、他の人のウォレットからトークンを移動したり焼却したりすることもできます。`,
    'tf-no-admin': () => '管理者の役割は放棄されています。もう誰もトークンを発行できません。',
    'tf-hook': (p) => `すべての送金はコントラクト ${p.contract}（before-send hook）を通過する必要があり、このコントラクトは売却の禁止など独自のルールを適用できます。`,
    'cw-caveat': () => 'チェーン上のコントラクトのデータを決まったルールで確認した結果です。中身の Rust コードと流動性は確認していません。投資助言ではありません。',
    // NEAR
    'near-not-found': () => 'NEAR にこの名前のアカウントはありません。入力ミスか、選んだチェーンが違う可能性があります。',
    'near-no-contract': () => 'この NEAR アカウントはコントラクトのない普通のアカウントです。トークンではありません。',
    'near-token': (p) => `NEAR トークン（NEP-141）「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'near-contract': (p) => `NEAR コントラクト（WASM コード、Rust などで作成）で、公開関数が ${p.count ?? '?'} 個あります。NEP-141 トークンではありません。`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer} はコントラクトのアカウントの full-access key をまだ持っているため、コードを変更できます。発行者が修正や機能追加をする通常の方法です。`
      : `コントラクトのアカウントには full-access key がまだ ${p.count} 個あります。キーを持つ人はいつでも新しいコードを上書きでデプロイできます。今日確認した内容が明日も正しいとは限りません。`),
    'near-locked': () => 'コントラクトのアカウントには full-access key がありません。外部から新しいコードを上書きでデプロイできる人はいません。',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer} はコントラクトの関数（${list(p.functions)}）を通じてコードをアップグレードできます。`
      : `コードには自分自身のコードを置き換えられる関数があります（${list(p.functions)}）。full-access key がなくても、これらを呼び出せる人はコードを変更できます。`),
    'near-caveat': () => 'WASM コード内の関数名とチェーン上のアカウントデータを決まったルールで確認した結果です。関数の中身は読んでいません。投資助言ではありません。',
    // Starknet (Cairo)
    'sn-not-found': () => 'Starknet 上のこのアドレスにコントラクトがありません。入力ミスか、チェーンの選択が間違っている可能性があります。',
    'sn-token': (p) => `Starknet トークン「${p.name ?? '?'}」（${p.symbol ?? '?'}）、総供給量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'sn-contract': (p) => `Starknet コントラクト（Cairo ${p.cairo === 1 ? '1' : '0'} で作成）で、ABI に関数が ${p.count ?? '?'} 個あります。トークンではありません。`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer} はコントラクトのコードをアップグレードできます。発行者が修正や機能追加をする通常の方法です。`
      : `アップグレード可能${p.implementation ? `（コード ${p.implementation} を指す proxy）` : ''}${p.functions?.length ? `（${list(p.functions)} 経由）` : ''}: 権限を持つ人はコード全体を置き換えられます。今日の確認結果が明日も正しいとは限りません。`),
    'sn-caveat': () => 'コントラクトがチェーン上で公開している ABI（関数名と、状態を変更するかどうか）を決まったルールで確認した結果です。関数の中身は読んでいません。投資助言ではありません。',
    // Bitcoin (Runes)
    'btc-not-found': () => 'この名前または ID の Rune は Bitcoin 上に見つかりません。Rune の名前は DOG•GO•TO•THE•MOON、ID は 840000:3 のような形です。BRC-20 トークンはまだ読み取れません。',
    'btc-rune': (p) => `Bitcoin の Rune「${p.name ?? '?'}」${p.symbol ? `（${p.symbol}）` : ''}、ID ${p.id ?? '?'}、これまでの発行量 ${fmtSupply(p.totalSupply, p.decimals)}。`,
    'btc-no-admin': () => 'Bitcoin のトークンにはコントラクトのコードもオーナーもありません。このトークンを凍結、ブロック、一時停止、課税、変更できる人はいません。ルールは作成時に固定されています。',
    'btc-open-mint': (p) => (p.unlimited
      ? '今も誰でも追加で mint できます。上限も終了日もないため、供給量は際限なく増え続ける可能性があります。'
      : `mint はまだ受付中です: ${p.end ? `ブロック ${p.end} に達するか、` : ''}${p.maxSupply ? `上限の ${fmtSupply(p.maxSupply, p.decimals)} に達する` : 'mint 期間が終わる'}まで誰でも追加で mint できます${p.percent != null ? `（現在 ${p.percent}% mint 済み）` : ''}。供給量はまだ増えています。`),
    'btc-premine': (p) => `トークン作成時に、最大供給量の ${p.percent}% が作成者に渡されました（premine）。作成者はいつでも売却できます。`,
    'btc-turbo': () => '作成者は Runes プロトコルの今後の変更を受け入れる設定（turbo）を選んでいます。そのため、このトークンの仕組みはプロトコルの新バージョンで変わる可能性があります。',
    'btc-caveat': () => 'Runes の基準となるインデクサー ord（ordinals.com）のデータを決まったルールで確認した結果です。Rune は Bitcoin 上でインデクサーが読み取るルールとして存在します。保有者と流動性は確認していません。投資助言ではありません。',
};
