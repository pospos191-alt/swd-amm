import { fmtSupply, list } from './fmt.js';

// Korean. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = '한국어';

export const LEVEL = { high: '높은 위험', medium: '중간 위험', low: '낮은 위험', info: '이 규칙으로 찾은 위험 없음' };

export const UI = {
  subtitle: '컨트랙트를 읽고 설명합니다 · 1단계, 읽기 전용', chain: '체인', address: '컨트랙트 또는 토큰 주소', check: '컨트랙트 검사',
  details: '세부 정보', reading: '체인에서 읽는 중…', badAddress: '이 체인에 맞지 않는 주소입니다. 사용 가능한 형식: ',
  failed: '읽지 못했습니다: ', footer: '지갑 연결을 요청하지 않으며 거래를 보내지 않습니다. 공개된 체인 데이터만 읽습니다. 투자 조언이 아닙니다.', stats: '사용 통계', language: '언어',
  m: {
    chain: '체인', address: '주소', proxy: 'Proxy', implementation: '실제 코드 (implementation)', owner: '소유자', functions: '알려진 함수', report: '보고서 ID', explorer: 'explorer에서 열기', fingerprint: '코드 지문 (템플릿 등록용)', unknown: '이름을 알 수 없는 함수',
    program: '토큰 프로그램', mintAuth: '발행 권한', freezeAuth: '동결 권한', extensions: '확장 기능', upgradeAuth: '업그레이드 권한', none: '없음',
    package: '패키지', standard: '표준', admin: '관리자', holders: '보유자 수', listed: 'tonapi 목록', raw: '원본 주소 (raw)',
    idl: 'Anchor IDL', codeId: 'code ID', label: '라벨 (label)', creator: '생성자', migrations: '코드 교체 횟수', hook: '전송 검사 컨트랙트 (hook)', source: '검증된 소스 코드', format: '코드 형식', delegation: '이 지갑이 실행하는 코드', walletCode: '보유자 지갑 코드', nearKeys: '전체 접근 키 (full-access key)', codeHash: '코드 해시', cairo: 'Cairo 버전', maxSupply: '최대 공급량', tokenId: '토큰 ID',
    pool: '유동성 풀', simTax: '시뮬레이션 세금 (구매 / 판매)', simFailed: '판매 실패',
  },
};

export const T = {
    'no-code': () => '이 주소에는 컨트랙트 코드가 없습니다. 일반 지갑이거나 체인을 잘못 선택했을 수 있습니다.',
    'erc20': (p) => `ERC-20 토큰 "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'not-erc20': () => '표준 ERC-20 함수를 찾지 못했습니다. 이 컨트랙트는 토큰이 아닐 수 있습니다.',
    'name-has-link': () => '토큰 이름이나 심볼에 링크나 웹사이트 이름이 들어 있습니다. 흔한 사기 수법입니다 (무료 "에어드롭" 토큰으로 가짜 사이트에 유인). 그 사이트에 들어가거나 지갑을 연결하지 마십시오.',
    'proxy-minimal': (p) => `최소 복제 컨트랙트(EIP-1167)로, 항상 ${p.implementation}의 코드를 실행합니다. 코드를 바꿀 수 없습니다.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer}이(가) 컨트랙트 코드를 업그레이드할 수 있습니다. 발행사가 수정하거나 기능을 추가할 때 쓰는 일반적인 방식입니다.`
      : `업그레이드 가능: 관리자${p.admin ? ` (${p.admin})` : ''}가 언제든지 코드 전체를 교체할 수 있습니다. 오늘 확인한 내용이 내일은 달라질 수 있습니다.`),
    'owner-active': (p) => `소유자가 이 컨트랙트를 관리하고 있습니다: ${p.owner}`,
    'owner-renounced': () => '소유권이 포기되었습니다 (소유자가 0 주소). 소유자 전용 함수는 더 이상 누구도 호출할 수 없습니다.',
    'owner-unknown': () => 'owner() 함수가 없어 아래의 특별 권한을 누가 가졌는지 알 수 없습니다. 누군가 가지고 있다고 가정하십시오.',
    'roles': () => '역할 기반 권한(roles)을 사용합니다. 여러 주소가 특별 권한을 가질 수 있으며, 코드만으로는 누가 가졌는지 알 수 없습니다.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer}이(가) 토큰을 새로 발행할 수 있습니다 (${list(p.functions)}). 예치금에 맞춰 토큰을 발행하는 것으로, 이런 종류의 토큰에서는 정상입니다.`
      : `새 토큰을 만들어 낼 수 있습니다 (${list(p.functions)}). 보유자의 몫이 줄어들거나 시장에 물량이 쏟아질 수 있습니다.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer}이(가) 특정 지갑을 동결할 수 있습니다 (${list(p.functions)}). 보통 도난 자금이나 법적 명령에 사용됩니다.`
      : `특정 지갑을 차단할 수 있습니다 (${list(p.functions)}). 차단된 지갑은 팔거나 보낼 수 없을 수 있습니다.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer}이(가) 비상시 모든 전송을 일시 중지할 수 있습니다 (${list(p.functions)}).`
      : `모든 전송을 멈출 수 있습니다 (${list(p.functions)}). 아무도 팔지 못하게 될 수 있습니다.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `세금을 조정할 수 있지만 (${list(p.functions)}), ${p.project} 템플릿은 낮추는 것만 허용합니다.`
      : `매수/매도 세금을 바꿀 수 있습니다 (${list(p.functions)}). 매도 세금이 매우 높으면 팔아도 거의 남는 것이 없습니다.`),
    'known-issuer': (p) => `${p.issuer}이(가) 발행한 ${p.symbol}의 공식 컨트랙트입니다 (등록된 주소와 일치). 아래 권한은 발행사의 것이며, 주된 위험은 숨겨진 코드가 아니라 발행사를 믿을 수 있는지입니다.`,
    'lookalike': (p) => `${p.issuer}의 토큰과 같은 심볼 ${p.symbol}을(를) 쓰지만 공식 주소(${p.official})가 아닙니다. 가짜일 수 있습니다. 주소를 확인하기 전에는 사거나 받지 마십시오.`,
    'template-match': (p) => `등록된 ${p.project} 토큰 템플릿(${p.name})과 일치합니다. 이 템플릿의 규칙은 아직 감사(audit)를 받지 않았습니다.`,
    'template-mismatch': (p) => `코드는 ${p.project} 템플릿과 일치하지만, 템플릿에는 없다고 되어 있는 권한이 있습니다 (${list(p.functions)}). 템플릿 기록이 틀렸을 수 있으니 확인 전까지 믿지 마십시오.`,
    'trading-switch': (p) => `거래를 켜고 끄는 스위치가 있습니다 (${list(p.functions)}). 켜지기 전에는 살 수는 있어도 팔지 못할 수 있습니다.`,
    'can-limit': (p) => `거래당 또는 지갑당 한도를 정할 수 있습니다 (${list(p.functions)}). 한도가 아주 낮으면 팔지 못할 수 있습니다.`,
    'fee-exempt': (p) => `선택한 지갑의 세금을 면제할 수 있습니다 (${list(p.functions)}). 세금이 있는 토큰에서는 흔하지만, 일부 지갑에 유리합니다.`,
    'network-flagged': (p) => `Neuro ZETAPHY 네트워크가 이 코드를 위험하다고 투표했습니다${p.reason ? ` (${({ drainer: '자금 탈취', honeypot: '살 수는 있지만 팔 수 없음', 'hidden-mint': '숨겨진 발행', 'fake-token': '가짜 토큰', phishing: '피싱' })[p.reason] ?? p.reason})` : ''}. 같은 코드를 쓰는 모든 컨트랙트에 같은 경고가 표시됩니다.`,
    'tax-wallet': (p) => `세금을 받는 지갑을 바꿀 수 있습니다 (${list(p.functions)}). 세금이 있는 토큰에서는 흔합니다.`,
    'selfdestruct': () => '코드에 SELFDESTRUCT가 들어 있습니다. 실행되면 컨트랙트를 지우거나 그 안의 자금을 옮길 수 있습니다.',
    'delegatecall': () => '이 코드는 다른 컨트랙트의 코드를 자기 코드처럼 실행할 수 있습니다 (DELEGATECALL). 실제로 실행되는 코드가 여기 보이는 코드와 다를 수 있습니다.',
    'nothing-found': () => '이 규칙으로는 특별 권한이나 위험한 명령을 찾지 못했습니다.',
    'unknown-functions': (p) => `Neuro가 이름을 알 수 없는 함수가 ${p.count}개 더 있습니다 (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}). 무슨 일을 하는지 알 수 없습니다. 소유자가 아직 컨트랙트를 관리하고 있다면, 세금이나 거래 한도 설정 같은 특별 권한일 수 있습니다.`,
    'bytecode-only': () => '체인에 있는 코드를 정해진 규칙으로 검사했습니다. 특이한 함수 이름 뒤에 숨은 사기는 놓칠 수 있습니다. 투자 조언이 아닙니다.',
    // Solana
    'sol-not-found': () => 'Solana에서 이 주소의 계정을 찾지 못했습니다. 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'sol-not-token': (p) => `이 주소는 Solana의 토큰 민트(mint)가 아니라 프로그램 ${p.owner}의 계정입니다.`,
    'sol-token': (p) => `${p.program} 토큰 "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer}이(가) 토큰을 새로 발행할 수 있습니다 (mint authority: ${p.authority}). 예치금에 맞춰 토큰을 발행하는 것으로, 이런 종류의 토큰에서는 정상입니다.`
      : `아직 새 토큰을 발행할 수 있습니다 (mint authority: ${p.authority}). 보유자의 몫이 줄어들거나 시장에 물량이 쏟아질 수 있습니다.`),
    'sol-mint-renounced': () => '발행 권한(mint authority)이 포기되었습니다. 발행량이 더 늘어날 수 없습니다.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer}이(가) 계정을 동결할 수 있습니다 (freeze authority). 보통 도난 자금이나 법적 명령에 사용됩니다.`
      : `아직 계정을 동결할 수 있습니다 (freeze authority: ${p.authority}). 동결된 계정은 팔거나 보낼 수 없습니다. Solana에서 흔한 사기 수법입니다.`),
    'sol-freeze-renounced': () => '동결 권한(freeze authority)이 포기되었습니다. 아무도 당신의 토큰을 동결할 수 없습니다.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer}이(가) 어떤 계정에서든 토큰을 옮기거나 소각할 수 있습니다 (permanent delegate). 법적 압류에 사용됩니다.`
      : `영구 위임자(permanent delegate: ${p.delegate})가 허락 없이 모든 지갑에서 토큰을 옮기거나 소각할 수 있습니다. 매우 위험합니다.`),
    'sol-transfer-fee': (p) => `전송할 때마다 ${p.percent}%의 수수료를 뗍니다${p.authority ? `. 수수료 관리자(${p.authority})는 이를 최대 100%까지 올릴 수 있습니다` : ''}.`,
    'sol-transfer-hook': (p) => `전송할 때마다 추가 프로그램이 실행됩니다 (transfer hook: ${p.programId}). 이 프로그램은 매도 차단 같은 자체 규칙을 강제할 수 있습니다.`,
    'sol-default-frozen': () => '이 토큰의 새 계정은 동결된 상태로 시작합니다. 산 뒤에도 동결이 풀릴 때까지 옮기거나 팔 수 없을 수 있습니다.',
    'sol-pausable': (p) => `모든 전송을 일시 중지할 수 있습니다 (pausable)${p.paused ? '. 지금 실제로 중지되어 있습니다' : ''}.`,
    'sol-close-authority': (p) => `민트(mint)를 닫았다가 같은 주소에 다시 만들 수 있습니다 (close authority: ${p.authority}).`,
    'sol-non-transferable': () => '이 토큰은 전송할 수 없습니다 (non-transferable). 거래용 코인이 아니라 배지나 권리입니다.',
    'sol-metadata-mutable': (p) => `이름, 심볼, 이미지를 아직 바꿀 수 있습니다 (update authority: ${p.authority}). 나중에 다른 토큰을 흉내 내도록 바뀔 수 있습니다.`,
    'sol-program-upgradeable': (p) => `업그레이드 가능한 프로그램입니다. 권한자(${p.authority})가 언제든지 코드를 교체할 수 있습니다.`,
    'sol-program-immutable': () => '이 프로그램은 더 이상 업그레이드할 수 없습니다. 코드가 고정되어 있습니다.',
    'sol-caveat': () => '체인의 계정 데이터를 정해진 규칙으로 검사했습니다. 유동성과 보유자 분포는 검사하지 않았습니다. 투자 조언이 아닙니다.',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer}이(가) 어떤 지갑에서든 토큰을 압류하거나 소각할 수 있습니다 (${list(p.functions)}). 법적 압류에 사용됩니다.`
      : `다른 사람의 지갑에서 토큰을 가져가거나 소각하는 함수가 있습니다 (${list(p.functions)}). 당신의 토큰이 허락 없이 빼앗길 수 있습니다.`),
    // Sui
    'sui-not-found': () => 'Sui에서 이 주소의 코인이나 패키지를 찾지 못했습니다. 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'sui-coin': (p) => `Sui 코인 "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'sui-not-coin': (p) => `패키지 ${p.package}은(는) 있지만 그 이름의 코인을 찾지 못했습니다. 모듈 이름과 코인 이름을 확인하십시오.`,
    'sui-package': (p) => `Sui의 Move 코드 패키지(${p.package})이며 코인이 아닙니다. 아래 결과는 이 코드가 열어 둔 권한입니다.`,
    'sui-supply-fixed': () => '발행량이 고정되어 있습니다. 늘어나거나 줄어들 수 없습니다.',
    'sui-supply-burn-only': () => '더 이상 코인을 발행할 수 없고, 소각만 할 수 있습니다.',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer}이(가) 코인을 새로 발행할 수 있습니다 (TreasuryCap). 예치금에 맞춰 코인을 발행하는 것으로, 이런 종류의 코인에서는 정상입니다.`;
      if (p.holder) return `아직 새 코인을 발행할 수 있습니다. 지갑 ${p.holder}이(가) 발행 키(TreasuryCap)를 가지고 있어 제한 없이 발행할 수 있습니다. 보유자의 몫이 줄어들거나 시장에 물량이 쏟아질 수 있습니다.`;
      const where = { object: '다른 컨트랙트 안에 보관되어 있습니다', shared: '공유 객체(shared object) 안에 있습니다' }[p.where] ?? '아직 존재하지만 누가 가졌는지 찾지 못했습니다';
      return `아직 새 코인을 발행할 수 있습니다. 발행 키(TreasuryCap)가 ${where}. 발행 규칙은 이 키를 가진 코드에 달려 있습니다.`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer}이(가) 특정 지갑을 차단할 수 있습니다 (DenyCap). 보통 도난 자금이나 법적 명령에 사용됩니다.`
      : `규제형 코인(regulated)입니다. DenyCap 보유자${p.holder ? ` (${p.holder})` : ''}가 지갑을 차단할 수 있습니다. 차단된 지갑은 이 코인을 쓰거나 팔 수 없습니다.`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer}이(가) 비상시 이 코인의 모든 사용을 일시 중지할 수 있습니다.`
      : 'DenyCap 보유자가 모든 사람의 이 코인 사용을 한 번에 멈출 수 있습니다 (global pause).'),
    'sui-system': () => 'Sui 시스템 코드입니다. 검증자(validator) 투표로만 업그레이드할 수 있습니다.',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer}이(가) 패키지 코드를 업그레이드할 수 있습니다. 발행사가 수정하거나 기능을 추가할 때 쓰는 일반적인 방식입니다.`
      : `업그레이드 가능한 패키지: UpgradeCap 보유자${p.holder ? ` (${p.holder})` : p.where === 'object' ? ' (다른 컨트랙트 안에 보관됨)' : ''}가 코드를 바꿀 수 있습니다 (정책: ${p.policy}). 오늘 확인한 내용이 내일은 달라질 수 있습니다.`),
    'sui-upgrade-cap-gone': () => '업그레이드 키(UpgradeCap)가 더 이상 따로 존재하지 않습니다. 파기되어 코드가 영구히 고정되었거나, 다른 컨트랙트 안에 잠겨 있습니다.',
    'move-truncated': () => '이 패키지는 커서 Neuro가 처음 50개 모듈과 모듈당 50개 함수만 검사했습니다.',
    'move-caveat': () => '함수 이름과 체인 데이터를 정해진 규칙으로 검사했습니다. 함수 내부 동작과 유동성은 검사하지 않았습니다. 투자 조언이 아닙니다.',
    // Aptos
    'apt-not-found': () => 'Aptos에서 이 주소의 코인이나 계정을 찾지 못했습니다. 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'apt-not-token': (p) => (p.account ? '이 주소는 Aptos의 사용자 계정이며 토큰이 아닙니다.' : '이 주소는 토큰이 아닌 Aptos 객체입니다.'),
    'apt-token': (p) => `Aptos ${p.standard} "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개${p.maxSupply ? `, 최대 ${fmtSupply(p.maxSupply, p.decimals)}개` : ''}입니다.`,
    'apt-package': (p) => `Aptos의 Move 코드 패키지(${p.address})이며 토큰이 아닙니다. 아래 결과는 이 코드가 열어 둔 권한입니다.`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer}이(가) 발행, 동결, 소각을 할 수 있습니다 (managed_coin). 이런 종류의 토큰에서는 정상입니다.`
      : `생성자(${p.account})가 발행, 동결, 소각 권한을 모두 가지고 있으며 (managed_coin) 언제든지 발행할 수 있습니다.`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer}이(가) 토큰을 새로 발행할 수 있습니다. 예치금에 맞춰 토큰을 발행하는 것으로, 이런 종류의 토큰에서는 정상입니다.`
      : `생성자의 코드가 발행 권한을 가지고 있습니다 (${list(p.structs)}). 아직 새 토큰을 만들 수 있어 보유자의 몫이 줄어들 수 있습니다.`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer}이(가) 특정 지갑을 동결할 수 있습니다. 보통 도난 자금이나 법적 명령에 사용됩니다.`
      : `생성자의 코드가 지갑 동결 권한을 가지고 있습니다 (${list(p.structs)}). 동결된 지갑은 팔거나 보낼 수 없으며, TransferRef로는 허락 없이 당신의 토큰을 옮길 수 있습니다.`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer}이(가) 어떤 지갑에서든 토큰을 소각할 수 있습니다. 법적 압류에 사용됩니다.`
      : `생성자의 코드가 누구의 지갑에서든 토큰을 소각할 수 있는 권한을 가지고 있습니다 (${list(p.structs)}).`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer}이(가) 입금과 출금 때마다 추가 코드를 실행합니다 (${list(p.functions)}).`
      : `입금과 출금 때마다 추가 코드가 실행됩니다 (${list(p.functions)}). 이 코드는 매도 차단 같은 자체 규칙을 강제할 수 있습니다.`),
    'apt-untransferable': () => '토큰 저장소의 소유자를 바꿀 수 없습니다 (untransferable). 일반적인 토큰 전송은 계속 가능합니다.',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer}이(가) 코드를 업그레이드할 수 있습니다. 발행사가 수정하거나 기능을 추가할 때 쓰는 일반적인 방식입니다.`
      : `생성자의 코드(${p.address}의 ${list(p.packages)})는 업그레이드 가능합니다. 그 계정이 언제든지 코드를 바꿀 수 있습니다. 오늘 확인한 내용이 내일은 달라질 수 있습니다.`),
    'apt-immutable': (p) => `생성자의 코드(${p.address})는 변경 불가(immutable)로 설정되어 있습니다. 절대 바뀔 수 없습니다.`,
    'apt-framework': () => 'Aptos 시스템 코드입니다. 네트워크 투표로만 업그레이드할 수 있습니다.',
    // TON
    'ton-not-found': () => 'TON에서 이 주소의 컨트랙트를 찾지 못했습니다 (존재하지 않거나 배포되지 않음). 잘못 입력했을 수 있습니다.',
    'ton-not-jetton': (p) => {
      if (p.wallet) return '이 주소는 지갑이며 토큰이 아닙니다.';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return '이것은 한 보유자의 토큰 지갑(jetton wallet)이며 토큰 자체가 아닙니다. 토큰의 메인 주소(jetton master)를 입력하십시오.';
      return `이 TON 컨트랙트는 토큰이 아닙니다${p.interfaces?.length ? ` (${list(p.interfaces)})` : ''}.`;
    },
    'ton-scam': () => 'tonapi.io가 이 토큰이나 관리자를 사기와 관련 있다고 표시했습니다. 사거나 받지 마십시오.',
    'ton-jetton': (p) => `TON 토큰(jetton) "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개${p.holders != null ? `, 보유자 ${fmtSupply(p.holders, 0)}명` : ''}입니다.`,
    'ton-listed': () => 'tonapi.io가 확인한 토큰 목록(whitelist)에 있습니다. 제3자의 목록일 뿐 보증은 아닙니다.',
    'ton-frozen': () => '이 토큰 컨트랙트는 저장 수수료 미납으로 동결되어 지금은 사용할 수 없습니다.',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer}이(가) 토큰을 새로 발행할 수 있습니다. 예치금에 맞춰 토큰을 발행하는 것으로, 이런 종류의 토큰에서는 정상입니다.`
      : `관리자(${p.admin})가 아직 새 토큰을 발행할 수 있습니다. 보유자의 몫이 줄어들거나 시장에 물량이 쏟아질 수 있습니다.`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer}이(가) 컨트랙트 관리자이며 토큰 정보를 바꿀 수 있습니다.`
      : `관리자(${p.admin})가 아직 이름과 로고를 바꿀 수 있습니다. 컨트랙트 코드가 표준이 아니라면, 이 검사로는 볼 수 없는 다른 권한도 가지고 있을 수 있습니다.`),
    'ton-admin-dropped': () => '관리자 권한이 포기되었습니다. 이제 아무도 토큰을 발행하거나 토큰 정보를 바꿀 수 없습니다.',
    'ton-mint-flag': () => '컨트랙트에는 아직 발행 가능으로 표시되어 있지만, 발행할 관리자가 없습니다.',
    'ton-caveat': () => 'tonapi.io가 해석한 컨트랙트 데이터를 정해진 규칙으로 검사했습니다. 보유자 지갑은 tonapi의 인식 결과로 검사했으며 코드를 한 줄씩 읽지는 않았습니다. 투자 조언이 아닙니다.',
    'ton-wallet-standard': (p) => `보유자의 토큰은 tonapi.io가 인식하는 표준 jetton 지갑에 들어 있습니다 (${list(p.interfaces)}).`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer}는(은) 자체 jetton 지갑 코드를 사용합니다. 이 토큰에서는 정상입니다.`
      : `보유자의 토큰이 tonapi.io가 표준 jetton 지갑으로 인식하지 못하는 코드에 들어 있습니다${p.compiler ? ` (${p.compiler})` : ''}. 사용자 정의 지갑 코드는 전송을 거부할 수 있어, 살 수는 있어도 팔지 못할 수 있습니다. 코드 해시: ${p.codeHash ?? '?'}.`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `이 프로그램은 Rust(Anchor)로 작성되었으며 명령어 목록을 체인에 공개합니다: ${p.name ?? '?'}, 명령어 ${p.count ?? '?'}개입니다.`,
    'sol-admin-instructions': (p) => `관리자 서명이 필요한 명령어가 있습니다 (${list(p.functions)}). 관리자는 이 명령어로 프로그램의 동작을 바꿀 수 있습니다.`,
    'sol-no-idl': () => '이 프로그램은 명령어 목록(Anchor IDL)을 체인에 공개하지 않으므로, 무엇을 할 수 있는지 읽을 수 없습니다.',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer}은(는) Stylus 컨트랙트(Rust/C++를 Arbitrum의 WASM으로 컴파일한 것)를 사용하며, Neuro의 규칙으로는 아직 읽을 수 없습니다.`
      : 'Stylus 컨트랙트입니다 (Rust 또는 C++를 Arbitrum의 WASM으로 컴파일한 것). Neuro의 규칙으로는 아직 이 코드를 읽을 수 없으므로, 발행·차단·일시 정지가 가능한지 알 수 없습니다. 검사되지 않은 것으로 간주하십시오.'),
    'stylus-read': (p) => `Stylus 컨트랙트입니다(Rust 또는 C++를 Arbitrum의 WASM으로 컴파일). Neuro가 WASM 코드(${fmtSupply(p.size, 0)}바이트)를 풀어서 읽었고, 알려진 함수 ${p.count ?? 0}개를 찾았습니다. 아래 결과는 이 함수들에서 나온 것입니다. 이름이 특이한 함수는 놓칠 수 있습니다.`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer}은(는) 표준 EVM bytecode가 아닌 코드를 사용합니다.`
      : '이 컨트랙트의 코드는 표준 EVM bytecode가 아니어서 Neuro의 규칙으로 읽을 수 없습니다. 검사되지 않은 것으로 간주하십시오.'),
    'eip7702': (p) => `이 주소는 일반 지갑이며, 소유자가 컨트랙트 ${p.target}의 코드를 실행하도록 설정했습니다 (EIP-7702). 토큰이 아닙니다. 그 코드는 작성된 대로 지갑의 자금으로 무엇이든 할 수 있으므로, ${p.target}도 검사하십시오.`,
    'source-verified': (p) => `Sourcify가 ${p.match === 'exact' ? '체인의 코드와 바이트 단위까지 일치한다고' : '체인의 코드와 일치한다고'} 확인한 공개 소스 코드가 있습니다 (${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}). ${p.url}에서 읽을 수 있습니다.`,
    'source-unverified': () => 'Sourcify에 소스 코드가 없습니다. 체인의 explorer에는 공개되어 있을 수 있습니다. 어디에도 공개되어 있지 않다면 특히 주의하십시오.',
    // Trade simulation (honeypot check, src/honeypot.js)
    'sim-cannot-sell': (p) => `허니팟 경고: ${p.dex}에서 거래를 시뮬레이션해 보니 살 수는 있었지만 ${p.sell == null ? '팔 수 없었습니다' : `팔아도 거의 돌려받지 못했습니다 (${p.sell}% 손실)`}. 사면 팔지 못할 수 있습니다. (일부 토큰은 산 직후에만 판매를 막는데, 이 검사로는 두 경우를 구별할 수 없습니다.)`,
    'sim-high-tax': (p) => (p.buy >= 100 && p.sell == null
      ? `${p.dex}에서 구매를 시뮬레이션해 보니 토큰을 하나도 받지 못했습니다. 낸 돈 전부가 빠져나갑니다.`
      : `${p.dex}에서 거래를 시뮬레이션해 보니 살 때 ${p.buy ?? '?'}%, 팔 때 ${p.sell ?? '?'}%가 토큰의 세금으로 빠져나갔습니다. 가격으로 예상한 것보다 그만큼 적게 돌려받습니다.`),
    'sim-ok': (p) => `${p.dex}에서 소액을 사고 다시 파는 시뮬레이션이 성공했습니다 (세금: 구매 ${p.buy}%, 판매 ${p.sell}%). 현재 블록에서 한 테스트일 뿐입니다. 컨트랙트를 관리하는 사람이 나중에 세금을 올리거나 판매를 막을 수 있습니다.`,
    'sim-skipped': (p) => ({
      'no-pool': `${p.dex}에서 이 토큰과 ${p.native}의 풀을 찾지 못해 사고파는 시뮬레이션을 하지 않았습니다. 이것만으로는 위험 신호가 아닙니다. 다른 곳에서 거래될 수 있습니다.`,
      'no-override': '공개 RPC가 거래 시뮬레이션(state override)을 허용하지 않아 사고파는 테스트를 하지 않았습니다.',
      'buy-failed': `${p.dex}에서 구매 시뮬레이션이 실패해 판매를 테스트하지 못했습니다. 아직 거래가 열리지 않았거나, 토큰이 컨트랙트의 구매를 거부할 수 있습니다.`,
    })[p.why] ?? '거래 시뮬레이션을 실행하지 못해 구매와 판매를 테스트하지 않았습니다.',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => '이 체인의 이 주소에는 컨트랙트나 토큰이 없습니다. 주소를 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'cw20-token': (p) => `CW20 토큰(CosmWasm의 Rust 컨트랙트) "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'cw-contract': (p) => `CosmWasm 컨트랙트(Rust로 작성)${p.label ? `, 이름 "${p.label}"` : ''}, code ID ${p.codeId ?? '?'}입니다. CW20 토큰이 아닙니다.`,
    'cw-admin': (p) => `관리자(${p.admin})가 언제든지 컨트랙트 코드를 새 코드로 교체할 수 있습니다 (migrate). 오늘 검사한 내용이 내일은 맞지 않을 수 있습니다.`,
    'cw-no-admin': () => '관리자가 없습니다. 컨트랙트 코드는 절대 교체될 수 없습니다.',
    'cw-migrated': (p) => `이 컨트랙트의 코드는 이미 ${p.count}번 교체되었습니다.`,
    'cw20-minter': (p) => `${p.minter}이(가) 아직 새 토큰을 ${p.cap ? `총 ${fmtSupply(p.cap, p.decimals)}개까지` : '제한 없이'} 발행할 수 있습니다. 보유자의 몫이 줄어들거나 시장에 물량이 쏟아질 수 있습니다.`,
    'cw20-no-minter': () => '아무도 이 토큰을 더 발행할 수 없습니다.',
    'tf-token': (p) => `${p.creator}이(가) 만든 Token Factory 코인 "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''}, 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'tf-admin': (p) => `관리자(${p.admin})가 제한 없이 발행할 수 있으며, 일부 체인에서는 다른 사람의 지갑에서 토큰을 옮기거나 소각할 수도 있습니다.`,
    'tf-no-admin': () => '관리자 권한이 포기되었습니다. 이제 아무도 더 발행할 수 없습니다.',
    'tf-hook': (p) => `모든 전송은 컨트랙트 ${p.contract}(before-send hook)를 거쳐야 하며, 이 컨트랙트는 판매 차단 같은 자체 규칙을 적용할 수 있습니다.`,
    'cw-caveat': () => '체인의 컨트랙트 데이터를 정해진 규칙으로 검사했습니다. 내부의 Rust 코드와 유동성은 검사하지 않았습니다. 투자 조언이 아닙니다.',
    // NEAR
    'near-not-found': () => 'NEAR에 이 이름의 계정이 없습니다. 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'near-no-contract': () => '이 NEAR 계정은 컨트랙트가 없는 일반 계정입니다. 토큰이 아닙니다.',
    'near-token': (p) => `NEAR 토큰(NEP-141) "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'near-contract': (p) => `공개 함수가 ${p.count ?? '?'}개 있는 NEAR 컨트랙트(WASM 코드, 예: Rust로 작성)입니다. NEP-141 토큰이 아닙니다.`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer}이(가) 아직 컨트랙트 계정의 full-access key를 가지고 있어 코드를 변경할 수 있습니다. 발행사가 수정하거나 기능을 추가할 때 쓰는 일반적인 방식입니다.`
      : `컨트랙트 계정에 아직 full-access key가 ${p.count}개 있습니다. 키를 가진 사람은 언제든지 새 코드를 덮어써서 배포할 수 있습니다. 오늘 검사한 내용이 내일은 맞지 않을 수 있습니다.`),
    'near-locked': () => '컨트랙트 계정에 full-access key가 없습니다. 외부에서 아무도 새 코드를 덮어써서 배포할 수 없습니다.',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer}이(가) 컨트랙트 함수(${list(p.functions)})를 통해 코드를 업그레이드할 수 있습니다.`
      : `코드에 자기 코드를 교체할 수 있는 함수가 있습니다 (${list(p.functions)}). full-access key가 없어도 이 함수를 호출할 수 있는 사람은 코드를 변경할 수 있습니다.`),
    'near-caveat': () => 'WASM 코드의 함수 이름과 체인의 계정 데이터를 정해진 규칙으로 검사했습니다. 함수 내부는 읽지 않았습니다. 투자 조언이 아닙니다.',
    // Starknet (Cairo)
    'sn-not-found': () => 'Starknet에서 이 주소의 컨트랙트를 찾지 못했습니다. 잘못 입력했거나 체인을 잘못 선택했을 수 있습니다.',
    'sn-token': (p) => `Starknet 토큰 "${p.name ?? '?'}" (${p.symbol ?? '?'}), 총 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'sn-contract': (p) => `ABI에 함수가 ${p.count ?? '?'}개 있는 Starknet 컨트랙트(Cairo ${p.cairo === 1 ? '1' : '0'}로 작성)입니다. 토큰이 아닙니다.`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer}이(가) 컨트랙트 코드를 업그레이드할 수 있습니다. 발행사가 수정하거나 기능을 추가할 때 쓰는 일반적인 방식입니다.`
      : `업그레이드 가능${p.implementation ? ` (코드 ${p.implementation}을(를) 가리키는 proxy)` : ''}${p.functions?.length ? ` (함수: ${list(p.functions)})` : ''}: 권한이 있는 사람이 코드 전체를 교체할 수 있습니다. 오늘 확인한 내용이 내일은 달라질 수 있습니다.`),
    'sn-caveat': () => '컨트랙트가 체인에 공개한 ABI(함수 이름과 상태 변경 여부)를 정해진 규칙으로 검사했습니다. 함수 내부는 읽지 않았습니다. 투자 조언이 아닙니다.',
    // Bitcoin (Runes)
    'btc-not-found': () => 'Bitcoin에서 이 이름이나 ID의 Rune을 찾을 수 없습니다. Rune 이름은 DOG•GO•TO•THE•MOON, ID는 840000:3 같은 형식입니다. BRC-20 토큰은 아직 읽을 수 없습니다.',
    'btc-rune': (p) => `Bitcoin Rune "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''}, ID ${p.id ?? '?'}, 지금까지 발행량 ${fmtSupply(p.totalSupply, p.decimals)}개입니다.`,
    'btc-no-admin': () => 'Bitcoin 토큰에는 컨트랙트 코드도 소유자도 없습니다. 누구도 이 토큰을 동결, 차단, 일시 중지하거나 세금을 매기거나 바꿀 수 없습니다. 규칙은 만들 때 고정되었습니다.',
    'btc-open-mint': (p) => (p.unlimited
      ? '지금도 누구나 더 mint할 수 있고 상한도 종료일도 없어, 공급량이 끝없이 늘어날 수 있습니다.'
      : `아직 mint가 열려 있습니다: ${p.end ? `블록 ${p.end}에 이르거나 ` : ''}${p.maxSupply ? `최대 ${fmtSupply(p.maxSupply, p.decimals)}개에 도달할` : 'mint 기간이 끝날'} 때까지 누구나 더 mint할 수 있습니다${p.percent != null ? ` (지금까지 ${p.percent}% mint됨)` : ''}. 공급량이 아직 늘고 있습니다.`),
    'btc-premine': (p) => `토큰을 만들 때 최대 공급량의 ${p.percent}%가 생성자에게 돌아갔습니다 (premine). 생성자는 언제든지 팔 수 있습니다.`,
    'btc-turbo': () => '생성자가 앞으로의 Runes 프로토콜 변경을 받아들이도록 선택했습니다 (turbo). 그래서 이 토큰의 작동 방식이 새 프로토콜 버전에 따라 바뀔 수 있습니다.',
    'btc-caveat': () => 'Runes의 기준 인덱서인 ord(ordinals.com)의 데이터를 정해진 규칙으로 검사했습니다. Rune은 Bitcoin 위에서 인덱서가 읽는 규칙으로 존재합니다. 보유자와 유동성은 검사하지 않았습니다. 투자 조언이 아닙니다.',
};
