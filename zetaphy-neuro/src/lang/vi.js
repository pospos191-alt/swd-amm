import { fmtSupply, list } from './fmt.js';

// Vietnamese. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = 'Tiếng Việt';

export const LEVEL = { high: 'Rủi ro cao', medium: 'Rủi ro trung bình', low: 'Rủi ro thấp', info: 'Không phát hiện rủi ro theo các quy tắc này' };

export const UI = {
  subtitle: 'Đọc và giải thích hợp đồng · cấp 1, chỉ đọc', chain: 'Chuỗi', address: 'Địa chỉ hợp đồng hoặc token', check: 'Kiểm tra hợp đồng',
  details: 'Chi tiết', reading: 'Đang đọc dữ liệu từ chuỗi…', badAddress: 'Địa chỉ không hợp lệ cho chuỗi này. Các định dạng được chấp nhận: ',
  failed: 'Không đọc được: ', footer: 'Không bao giờ yêu cầu kết nối ví và không bao giờ gửi giao dịch. Chỉ đọc dữ liệu công khai trên chuỗi. Không phải lời khuyên đầu tư.', stats: 'Thống kê sử dụng', language: 'Ngôn ngữ',
  disclaimer: 'Đây là phân tích mã tự động, có thể kiểm chứng lại, không phải lời buộc tội bất kỳ cá nhân hay dự án nào và không phải lời khuyên đầu tư. Chủ hợp đồng có thể phản hồi hoặc yêu cầu đính chính.',
  correction: 'Cách phản hồi hoặc yêu cầu đính chính',
  reproduce: 'Tự kiểm tra lại',
  reproduceHow: 'Ai cũng có thể chạy lại phép kiểm tra này bằng lệnh bên dưới (trong thư mục zetaphy-neuro). Mã phán định chỉ gồm những gì các quy tắc kết luận, nên sẽ trùng khớp khi mã và thiết lập của hợp đồng không đổi. Mã báo cáo còn gồm các con số thay đổi như tổng cung.',
  asWritten: 'Tên và ký hiệu được hiển thị như ghi trong hợp đồng; Neuro không xác nhận chúng.',
  m: {
    chain: 'Chuỗi', address: 'Địa chỉ', proxy: 'Proxy', implementation: 'Mã thực thi', owner: 'Chủ sở hữu', functions: 'Hàm đã nhận diện', report: 'Mã báo cáo', explorer: 'Mở trên explorer', fingerprint: 'Dấu vân tay mã (để đăng ký mẫu)', unknown: 'Hàm chưa rõ tên',
    program: 'Chương trình token', mintAuth: 'Quyền tạo token (mint authority)', freezeAuth: 'Quyền đóng băng (freeze authority)', extensions: 'Tiện ích mở rộng', upgradeAuth: 'Quyền nâng cấp', none: 'không có',
    package: 'Gói', standard: 'Tiêu chuẩn', admin: 'Quản trị viên', holders: 'Số người nắm giữ', listed: 'Danh sách tonapi', raw: 'Địa chỉ gốc (raw)',
    idl: 'Anchor IDL', codeId: 'Code ID', label: 'Nhãn', creator: 'Người tạo', migrations: 'Số lần thay mã', hook: 'Hợp đồng kiểm soát chuyển token', source: 'Mã nguồn đã xác minh', format: 'Định dạng mã', delegation: 'Mã mà ví này chạy', walletCode: 'Mã ví của người nắm giữ', nearKeys: 'Khóa toàn quyền (full-access key)', codeHash: 'Mã băm của mã', cairo: 'Phiên bản Cairo', maxSupply: 'Nguồn cung tối đa', tokenId: 'Mã token',
    pool: 'Pool thanh khoản', simTax: 'Thuế khi mô phỏng (mua / bán)', simFailed: 'bán thất bại',
    verdict: 'Mã phán định (chỉ quy tắc)', command: 'Lệnh', rule: 'quy tắc',
  },
};

// ThreatRegistry categories (src/threat-reasons.js), as neutral descriptions of what the code does.
export const REASON = { 'cannot-sell-in-simulation': 'trong giao dịch mô phỏng, bán thất bại hoặc gần như không nhận lại gì', 'unlimited-mint': 'một địa chỉ có thể đúc thêm token không giới hạn', 'owner-can-block-transfers': 'chủ sở hữu hoặc quản trị viên có thể chặn chuyển hoặc bán', 'owner-can-move-holder-funds': 'chủ sở hữu hoặc quản trị viên có thể chuyển hoặc đốt tiền của người khác', 'same-name-as-known-token': 'cùng tên hoặc ký hiệu với một token đã biết nhưng khác địa chỉ', 'sweeps-approved-tokens': 'trong một thử nghiệm tái lập được, đã chuyển token được phê duyệt tới địa chỉ người nắm giữ không chọn', 'other': 'sự thật khác về mã (xem bằng chứng)' };

export const T = {
    'no-code': () => 'Địa chỉ này không có mã hợp đồng. Có thể đây chỉ là một ví thông thường, hoặc bạn đã chọn sai chuỗi.',
    'erc20': (p) => `Token ERC-20 "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'Không tìm thấy các hàm ERC-20 tiêu chuẩn. Hợp đồng này có thể không phải là token.',
    'name-has-link': () => 'Tên hoặc ký hiệu token (như được ghi trong hợp đồng) chứa đường link hoặc tên trang web. Token được gửi đến dù bạn không yêu cầu, có link trong tên, thường được dùng để dẫn người dùng tới trang web bên ngoài. Đừng truy cập trang đó hoặc kết nối ví chỉ vì tên token.',
    'proxy-minimal': (p) => `Bản sao tối giản (EIP-1167) luôn chạy mã tại ${p.implementation}. Mã này không thể thay đổi.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} có thể nâng cấp mã của hợp đồng, cách thông thường để nhà phát hành sửa lỗi hoặc bổ sung tính năng.`
      : `Có thể nâng cấp: quản trị viên${p.admin ? ` (${p.admin})` : ''} có thể thay toàn bộ mã bất cứ lúc nào. Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`),
    'owner-active': (p) => `Hợp đồng này đang do một chủ sở hữu kiểm soát: ${p.owner}`,
    'owner-renounced': () => 'Quyền sở hữu đã được từ bỏ (owner là địa chỉ 0). Không ai còn gọi được các hàm chỉ dành cho chủ sở hữu.',
    'owner-unknown': () => 'Không tìm thấy hàm owner(), nên không rõ ai nắm các quyền đặc biệt bên dưới. Hãy giả định là có người nắm.',
    'roles': () => 'Dùng phân quyền theo vai trò. Có thể nhiều địa chỉ cùng nắm quyền đặc biệt; chỉ nhìn mã thì không biết đó là ai.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} có thể tạo thêm token (${list(p.functions)}) để phát hành tương ứng với tiền gửi, điều bình thường với loại token này.`
      : `Có thể tạo thêm token mới (${list(p.functions)}), làm loãng giá trị của người nắm giữ hoặc xả tràn ngập thị trường.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} có thể đóng băng một số ví cụ thể (${list(p.functions)}), thường để xử lý tiền bị đánh cắp hoặc theo lệnh pháp lý.`
      : `Có thể chặn một số ví cụ thể (${list(p.functions)}). Ví bị chặn có thể không bán hoặc chuyển được token.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} có thể tạm dừng mọi giao dịch chuyển token (${list(p.functions)}) trong trường hợp khẩn cấp.`
      : `Có thể đóng băng mọi giao dịch chuyển token (${list(p.functions)}). Khi đó có thể không ai bán được.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `Có thể điều chỉnh thuế (${list(p.functions)}), nhưng mẫu ${p.project} chỉ cho phép giảm thuế.`
      : `Có thể thay đổi thuế mua/bán (${list(p.functions)}). Nếu thuế bán rất cao, bán ra gần như không nhận lại được gì.`),
    'known-issuer': (p) => `Hợp đồng ${p.symbol} chính thức do ${p.issuer} phát hành (khớp với địa chỉ đã đăng ký). Các quyền bên dưới thuộc về nhà phát hành; rủi ro chính là bạn có tin nhà phát hành hay không, chứ không phải mã ẩn.`,
    'lookalike': (p) => `Dùng ký hiệu ${p.symbol} giống token của ${p.issuer} nhưng KHÔNG phải địa chỉ đã đăng ký (${p.official}). Hợp đồng này không phải token ${p.issuer} đã đăng ký; hãy kiểm tra địa chỉ trước khi mua hoặc nhận.`,
    'template-match': (p) => `Khớp với mẫu token ${p.project} đã đăng ký (${p.name}). Các quy tắc của mẫu này chưa được kiểm toán.`,
    'template-mismatch': (p) => `Mã khớp với mẫu ${p.project} nhưng lại có một quyền mà mẫu ghi là không có (${list(p.functions)}). Thông tin mẫu có thể sai; đừng tin cho đến khi được kiểm tra.`,
    'trading-switch': (p) => `Có công tắc bật/tắt giao dịch (${list(p.functions)}). Trước khi bật, bạn có thể mua được nhưng không bán được.`,
    'can-limit': (p) => `Có thể đặt giới hạn cho mỗi giao dịch hoặc mỗi ví (${list(p.functions)}). Giới hạn quá thấp có thể khiến bạn không bán được.`,
    'fee-exempt': (p) => `Có thể miễn thuế cho một số ví được chọn (${list(p.functions)}). Thường gặp ở token có thuế, nhưng điều này cho một số ví lợi thế hơn người khác.`,
    'network-flagged': (p) => `Các runner của mạng Neuro ZETAPHY đã bỏ phiếu ghi mã này vào ThreatRegistry${p.reason ? ` (nhóm: ${REASON[p.reason] ?? p.reason})` : ''}. Mọi hợp đồng có cùng mã đều nhận cảnh báo tương tự.`,
    'similar-flagged': (p) => `Mã này giống ${p.percent}% với mã mà các runner Neuro đã gắn cờ (dấu vân tay ${String(p.fingerprint ?? '').slice(0, 12)}…${p.reason ? `, nhóm: ${REASON[p.reason] ?? p.reason}` : ''}). Bản sao sửa nhẹ của mã đã gắn cờ thường hoạt động giống vậy.`,
    'tax-wallet': (p) => `Có thể đổi ví nhận tiền thuế (${list(p.functions)}). Thường gặp ở token có thuế.`,
    'selfdestruct': () => 'Mã có chứa SELFDESTRUCT. Nếu được kích hoạt, nó có thể xóa sạch hợp đồng hoặc chuyển tiền của hợp đồng đi nơi khác.',
    'delegatecall': () => 'Mã có thể chạy mã của một hợp đồng khác như mã của chính nó (DELEGATECALL), nên mã thực sự chạy có thể khác với mã hiển thị ở đây.',
    'nothing-found': () => 'Các quy tắc này không phát hiện quyền đặc biệt hay lệnh nguy hiểm nào.',
    'unknown-functions': (p) => `Còn ${p.count} hàm mà Neuro không xác định được tên (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}), nên không rõ chúng làm gì. Khi hợp đồng vẫn còn chủ sở hữu kiểm soát, đó có thể là các hàm đặc quyền, ví dụ đặt thuế hoặc giới hạn giao dịch.`,
    'unknown-pattern': (p) => `Neuro chưa nhận ra mẫu này, hãy cẩn thận: ${p.share}% hàm không có tên đã biết, và mã có thể chuyển coin hoặc token. Không tìm thấy gì ở đây không có nghĩa là an toàn.`,
    'bytecode-only': () => 'Kiểm tra từ mã trên chuỗi theo các quy tắc cố định. Các quyền ẩn sau tên hàm lạ có thể bị bỏ sót. Không phải lời khuyên đầu tư.',
    // Solana
    'sol-not-found': () => 'Không có tài khoản nào tại địa chỉ này trên Solana. Có thể bạn nhập sai, hoặc đã chọn sai chuỗi.',
    'sol-not-token': (p) => `Địa chỉ này không phải là token mint trên Solana; đây là một tài khoản của chương trình ${p.owner}.`,
    'sol-token': (p) => `Token ${p.program} "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} có thể tạo thêm token (mint authority: ${p.authority}) để phát hành tương ứng với tiền gửi, điều bình thường với loại token này.`
      : `Vẫn có thể tạo thêm token mới (mint authority: ${p.authority}), làm loãng giá trị của người nắm giữ hoặc xả tràn ngập thị trường.`),
    'sol-mint-renounced': () => 'Quyền tạo token (mint authority) đã được từ bỏ: tổng cung không bao giờ tăng thêm được.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} có thể đóng băng tài khoản (freeze authority), thường để xử lý tiền bị đánh cắp hoặc theo lệnh pháp lý.`
      : `Tài khoản vẫn có thể bị đóng băng (freeze authority: ${p.authority}). Tài khoản bị đóng băng không bán hay chuyển được.`),
    'sol-freeze-renounced': () => 'Quyền đóng băng (freeze authority) đã được từ bỏ: không ai có thể đóng băng token của bạn.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} có thể chuyển đi hoặc hủy token từ bất kỳ tài khoản nào (permanent delegate), dùng cho việc thu giữ theo pháp luật.`
      : `Một bên được ủy quyền vĩnh viễn (permanent delegate: ${p.delegate}) có thể chuyển đi hoặc hủy token từ MỌI ví mà không cần sự cho phép. Rủi ro rất cao cho người nắm giữ.`),
    'sol-transfer-fee': (p) => `Thu phí ${p.percent}% cho mỗi lần chuyển token${p.authority ? `, và bên giữ quyền thu phí (${p.authority}) có thể tăng phí lên tới 100%` : ''}.`,
    'sol-transfer-hook': (p) => `Mỗi lần chuyển token đều chạy thêm một chương trình khác (transfer hook: ${p.programId}) có thể áp đặt quy tắc riêng, ví dụ chặn bán.`,
    'sol-default-frozen': () => 'Tài khoản mới của token này bị đóng băng ngay từ đầu: sau khi mua, bạn có thể không chuyển hay bán được cho đến khi được mở băng.',
    'sol-pausable': (p) => `Mọi giao dịch chuyển token có thể bị tạm dừng (pausable)${p.paused ? ', và hiện tại đang bị tạm dừng' : ''}.`,
    'sol-close-authority': (p) => `Token mint này có thể bị đóng rồi tạo lại tại cùng địa chỉ (close authority: ${p.authority}).`,
    'sol-non-transferable': () => 'Token này không thể chuyển nhượng (non-transferable): nó là huy hiệu hoặc quyền lợi, không phải đồng coin để giao dịch.',
    'sol-metadata-mutable': (p) => `Tên, ký hiệu và hình ảnh vẫn có thể bị thay đổi (update authority: ${p.authority}), ví dụ sau này đổi để giả mạo một token khác.`,
    'sol-program-upgradeable': (p) => `Chương trình có thể nâng cấp: bên giữ quyền (${p.authority}) có thể thay mã của nó bất cứ lúc nào.`,
    'sol-program-immutable': () => 'Chương trình này không thể nâng cấp nữa; mã của nó đã cố định.',
    'sol-caveat': () => 'Kiểm tra từ dữ liệu tài khoản trên chuỗi theo các quy tắc cố định; chưa kiểm tra thanh khoản và phân bổ người nắm giữ. Không phải lời khuyên đầu tư.',
    'can-seize': (p) => (p.issuer
      ? `${p.issuer} có thể thu giữ hoặc hủy token từ bất kỳ ví nào (${list(p.functions)}), dùng cho việc thu giữ theo pháp luật.`
      : `Có các hàm lấy đi hoặc hủy token trong ví của người khác (${list(p.functions)}). Token của bạn có thể bị lấy mất mà không cần sự cho phép của bạn.`),
    // Sui
    'sui-not-found': () => 'Không có coin hoặc gói (package) nào tại địa chỉ này trên Sui. Có thể bạn nhập sai, hoặc đã chọn sai chuỗi.',
    'sui-coin': (p) => `Coin Sui "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sui-not-coin': (p) => `Gói ${p.package} có tồn tại, nhưng không tìm thấy coin nào với tên đó. Hãy kiểm tra lại tên module và tên coin.`,
    'sui-package': (p) => `Một gói mã Move trên Sui (${p.package}), không phải coin. Kết quả bên dưới là các quyền mà mã của nó cung cấp.`,
    'sui-supply-fixed': () => 'Tổng cung đã bị khóa: không bao giờ tăng hay giảm được.',
    'sui-supply-burn-only': () => 'Không thể tạo thêm coin; chỉ có thể hủy (burn).',
    'sui-treasury': (p) => {
      if (p.issuer) return `${p.issuer} có thể tạo thêm coin (TreasuryCap) để phát hành tương ứng với tiền gửi, điều bình thường với loại coin này.`;
      if (p.holder) return `Vẫn có thể tạo thêm coin mới: ví ${p.holder} giữ chìa khóa tạo coin (TreasuryCap) và có thể tạo không giới hạn, làm loãng giá trị của người nắm giữ hoặc xả tràn ngập thị trường.`;
      const where = { object: 'được cất bên trong một hợp đồng khác', shared: 'nằm trong một đối tượng dùng chung (shared object)' }[p.where] ?? 'vẫn còn tồn tại, nhưng không tìm thấy ai đang giữ';
      return `Vẫn có thể tạo thêm coin mới: chìa khóa tạo coin (TreasuryCap) ${where}. Quy tắc tạo coin phụ thuộc vào đoạn mã đang giữ nó.`;
    },
    'sui-regulated': (p) => (p.issuer
      ? `${p.issuer} có thể chặn một số ví cụ thể (DenyCap), thường để xử lý tiền bị đánh cắp hoặc theo lệnh pháp lý.`
      : `Coin có kiểm soát (regulated): bên giữ DenyCap${p.holder ? ` (${p.holder})` : ''} có thể chặn ví. Ví bị chặn không dùng hay bán được coin này.`),
    'sui-global-pause': (p) => (p.issuer
      ? `${p.issuer} có thể tạm dừng mọi hoạt động của coin này trong trường hợp khẩn cấp.`
      : 'Bên giữ DenyCap có thể tạm dừng coin này cho tất cả mọi người cùng lúc (global pause).'),
    'sui-system': () => 'Mã hệ thống của Sui: chỉ có thể nâng cấp khi các validator bỏ phiếu đồng ý.',
    'sui-upgradeable': (p) => (p.issuer
      ? `${p.issuer} có thể nâng cấp mã của gói, cách thông thường để nhà phát hành sửa lỗi hoặc bổ sung tính năng.`
      : `Gói có thể nâng cấp: bên giữ UpgradeCap${p.holder ? ` (${p.holder})` : p.where === 'object' ? ' (được cất bên trong một hợp đồng khác)' : ''} có thể thay đổi mã (chính sách: ${p.policy}). Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`),
    'sui-upgrade-cap-gone': () => 'Chìa khóa nâng cấp (UpgradeCap) không còn tồn tại riêng lẻ: nó đã bị hủy, khiến mã trở nên vĩnh viễn, hoặc đã bị khóa bên trong một hợp đồng khác.',
    'move-truncated': () => 'Gói này rất lớn; Neuro chỉ kiểm tra 50 module đầu tiên và 50 hàm đầu tiên trong mỗi module.',
    'move-caveat': () => 'Kiểm tra từ tên hàm và dữ liệu trên chuỗi theo các quy tắc cố định. Chưa kiểm tra nội dung hàm và thanh khoản. Không phải lời khuyên đầu tư.',
    // Aptos
    'apt-not-found': () => 'Không có coin hoặc tài khoản nào tại địa chỉ này trên Aptos. Có thể bạn nhập sai, hoặc đã chọn sai chuỗi.',
    'apt-not-token': (p) => (p.account ? 'Địa chỉ này là tài khoản người dùng trên Aptos, không phải token.' : 'Địa chỉ này là một đối tượng (object) Aptos nhưng không phải token.'),
    'apt-token': (p) => `${p.standard} Aptos "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}${p.maxSupply ? `, tối đa ${fmtSupply(p.maxSupply, p.decimals)}` : ''}.`,
    'apt-package': (p) => `Một gói mã Move trên Aptos (${p.address}), không phải token. Kết quả bên dưới là các quyền mà mã của nó cung cấp.`,
    'apt-managed-coin': (p) => (p.issuer
      ? `${p.issuer} có thể tạo thêm, đóng băng và hủy token (managed_coin), điều bình thường với loại token này.`
      : `Người tạo (${p.account}) nắm quyền tạo thêm, đóng băng và hủy token (managed_coin) và có thể tạo thêm token bất cứ lúc nào.`),
    'apt-mint-power': (p) => (p.issuer
      ? `${p.issuer} có thể tạo thêm token để phát hành tương ứng với tiền gửi, điều bình thường với loại token này.`
      : `Mã của người tạo vẫn giữ quyền tạo thêm token (${list(p.structs)}). Token mới vẫn có thể được tạo ra, làm loãng giá trị của người nắm giữ.`),
    'apt-freeze-power': (p) => (p.issuer
      ? `${p.issuer} có thể đóng băng một số ví cụ thể, thường để xử lý tiền bị đánh cắp hoặc theo lệnh pháp lý.`
      : `Mã của người tạo vẫn giữ quyền đóng băng ví (${list(p.structs)}). Ví bị đóng băng không bán hay chuyển được, và TransferRef có thể chuyển token của bạn đi mà không cần sự cho phép.`),
    'apt-burn-power': (p) => (p.issuer
      ? `${p.issuer} có thể hủy token từ bất kỳ ví nào, dùng cho việc thu giữ theo pháp luật.`
      : `Mã của người tạo vẫn giữ quyền hủy (${list(p.structs)}) token trong ví của bất kỳ ai.`),
    'apt-dispatch': (p) => (p.issuer
      ? `${p.issuer} chạy thêm mã mỗi khi nạp vào hoặc rút ra (${list(p.functions)}).`
      : `Mỗi lần nạp vào hoặc rút ra đều chạy thêm mã (${list(p.functions)}) có thể áp đặt quy tắc riêng, ví dụ chặn bán.`),
    'apt-untransferable': () => 'Kho chứa token không thể đổi chủ (untransferable). Việc chuyển token thông thường vẫn hoạt động.',
    'apt-upgradeable': (p) => (p.issuer
      ? `${p.issuer} có thể nâng cấp mã, cách thông thường để nhà phát hành sửa lỗi hoặc bổ sung tính năng.`
      : `Mã của người tạo (${list(p.packages)} tại ${p.address}) có thể nâng cấp: tài khoản đó có thể thay đổi mã bất cứ lúc nào. Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`),
    'apt-immutable': (p) => `Mã của người tạo (${p.address}) được đặt là bất biến (immutable): không bao giờ thay đổi được.`,
    'apt-framework': () => 'Mã hệ thống của Aptos: chỉ có thể nâng cấp khi mạng lưới bỏ phiếu đồng ý.',
    // TON
    'ton-not-found': () => 'Không có hợp đồng nào tại địa chỉ này trên TON (không tồn tại hoặc chưa được triển khai). Có thể bạn nhập sai.',
    'ton-not-jetton': (p) => {
      if (p.wallet) return 'Địa chỉ này là một ví, không phải token.';
      if ((p.interfaces ?? []).includes('jetton_wallet')) return 'Đây là jetton wallet của một người nắm giữ, không phải bản thân token. Hãy nhập địa chỉ chính của token (jetton master).';
      return `Hợp đồng TON này không phải là token${p.interfaces?.length ? ` (${list(p.interfaces)})` : ''}.`;
    },
    'ton-scam': () => 'tonapi.io (bên thứ ba) đã gắn nhãn cảnh báo cho token này hoặc tài khoản quản trị của nó. Đây là nhãn của tonapi.io, không phải kết quả của lần kiểm tra mã này; hãy xem lý do trước khi mua hoặc nhận token.',
    'ton-jetton': (p) => `Token TON (jetton) "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}${p.holders != null ? `, ${fmtSupply(p.holders, 0)} người nắm giữ` : ''}.`,
    'ton-listed': () => 'Có trong danh sách token đã được kiểm tra của tonapi.io (whitelist). Đó là danh sách của bên thứ ba, không phải sự bảo đảm.',
    'ton-frozen': () => 'Hợp đồng token này đang bị đóng băng do chưa trả phí lưu trữ và hiện không thể sử dụng.',
    'ton-mintable': (p) => (p.issuer
      ? `${p.issuer} có thể tạo thêm token để phát hành tương ứng với tiền gửi, điều bình thường với loại token này.`
      : `Quản trị viên (${p.admin}) vẫn có thể tạo thêm token mới, làm loãng giá trị của người nắm giữ hoặc xả tràn ngập thị trường.`),
    'ton-admin': (p) => (p.issuer
      ? `${p.issuer} là quản trị viên hợp đồng và có thể thay đổi dữ liệu của token.`
      : `Một quản trị viên (${p.admin}) vẫn có thể đổi tên và logo, và nếu mã hợp đồng không theo chuẩn, có thể còn nắm những quyền khác mà lần kiểm tra này không thấy được.`),
    'ton-admin-dropped': () => 'Vai trò quản trị viên đã bị bỏ: không ai có thể tạo thêm token hay thay đổi dữ liệu của token nữa.',
    'ton-mint-flag': () => 'Hợp đồng vẫn ghi là có thể tạo thêm token, nhưng không có quản trị viên nào để làm việc đó.',
    'ton-caveat': () => 'Kiểm tra từ dữ liệu hợp đồng do tonapi.io giải mã theo các quy tắc cố định; ví của người nắm giữ được kiểm tra theo những gì tonapi nhận diện, không đọc từng dòng mã. Không phải lời khuyên đầu tư.',
    'ton-wallet-standard': (p) => `Token của người nắm giữ nằm trong ví jetton tiêu chuẩn mà tonapi.io nhận diện được (${list(p.interfaces)}).`,
    'ton-wallet-custom': (p) => (p.issuer
      ? `${p.issuer} dùng mã ví jetton riêng, điều bình thường với token này.`
      : `Token của người nắm giữ nằm trong mã ví mà tonapi.io không nhận diện là ví jetton tiêu chuẩn${p.compiler ? ` (${p.compiler})` : ''}. Mã ví tùy chỉnh có thể từ chối chuyển đi, nên bạn có thể mua được nhưng không bán được. Mã băm: ${p.codeHash ?? '?'}.`),
    // Solana programs (Anchor IDL)
    'sol-idl': (p) => `Chương trình này được viết bằng Rust (Anchor) và công bố danh sách lệnh của nó trên chuỗi: ${p.name ?? '?'}, ${p.count ?? '?'} lệnh.`,
    'sol-admin-instructions': (p) => `Các lệnh cần chữ ký của quản trị viên (${list(p.functions)}). Quản trị viên có thể dùng chúng để thay đổi cách chương trình hoạt động.`,
    'sol-no-idl': () => 'Chương trình này không công bố danh sách lệnh (Anchor IDL) trên chuỗi, nên không đọc được nó có thể làm gì.',
    // EVM code that is not EVM bytecode
    'stylus-code': (p) => (p.issuer
      ? `${p.issuer} dùng hợp đồng Stylus (Rust/C++ biên dịch sang WASM trên Arbitrum), loại mã mà các quy tắc của Neuro chưa đọc được.`
      : 'Đây là hợp đồng Stylus (Rust hoặc C++ biên dịch sang WASM trên Arbitrum). Các quy tắc của Neuro chưa đọc được loại mã này, nên không biết nó có thể tạo thêm token, chặn ví hay tạm dừng giao dịch hay không. Hãy coi như chưa được kiểm tra.'),
    'stylus-read': (p) => `Đây là hợp đồng Stylus (Rust hoặc C++ biên dịch thành WASM trên Arbitrum). Neuro đã giải nén mã WASM (${fmtSupply(p.size, 0)} byte) và tìm thấy ${p.count ?? 0} hàm đã biết; các kết quả bên dưới đến từ những hàm này. Hàm có tên lạ có thể bị bỏ sót.`,
    'unknown-code-format': (p) => (p.issuer
      ? `${p.issuer} dùng mã không phải EVM bytecode tiêu chuẩn.`
      : 'Mã của hợp đồng này không phải EVM bytecode tiêu chuẩn và các quy tắc của Neuro không đọc được. Hãy coi như chưa được kiểm tra.'),
    'eip7702': (p) => `Địa chỉ này là một ví thông thường mà chủ ví đã cài để chạy mã của hợp đồng ${p.target} (EIP-7702). Đây không phải token. Mã đó có thể làm bất cứ điều gì nó được viết ra để làm với tiền trong ví; hãy kiểm tra cả ${p.target}.`,
    'source-verified': (p) => `Có mã nguồn công khai mà Sourcify xác nhận ${p.match === 'exact' ? 'khớp từng byte với mã trên chuỗi' : 'khớp với mã trên chuỗi'} (${[p.name, p.language, p.compiler].filter(Boolean).join(', ')}). Xem tại ${p.url}`,
    'source-unverified': () => 'Không có mã nguồn trên Sourcify. Mã nguồn có thể vẫn được công bố trên explorer của chuỗi; nếu không được công bố ở đâu cả, hãy đặc biệt cẩn thận.',
    // Trade simulation (buy/sell test, src/honeypot.js)
    'sim-cannot-sell': (p) => `Thử bán không thành công: khi mô phỏng giao dịch qua ${p.dex}, mua được nhưng ${p.sell == null ? 'không bán được' : `bán ra gần như không nhận lại gì (mất ${p.sell}%)`}. Nếu mua, bạn có thể không bán được. (Một số ít token chỉ chặn bán ngay sau khi mua; phép kiểm tra này không phân biệt được hai trường hợp.)`,
    'sim-high-tax': (p) => (p.buy >= 100 && p.sell == null
      ? `Mô phỏng mua qua ${p.dex} không nhận được token nào: toàn bộ số tiền mua đã bị lấy mất.`
      : `Mô phỏng giao dịch qua ${p.dex} bị mất ${p.buy ?? '?'}% khi mua và ${p.sell ?? '?'}% khi bán, do token thu làm thuế. Bạn nhận lại ít hơn giá hiển thị đúng bằng phần đó.`),
    'sim-ok': (p) => `Mô phỏng mua rồi bán lại một lượng nhỏ qua ${p.dex} thành công (thuế: mua ${p.buy}%, bán ${p.sell}%). Đây chỉ là phép thử tại khối hiện tại: người kiểm soát hợp đồng vẫn có thể tăng thuế hoặc chặn bán sau này.`,
    'sim-skipped': (p) => ({
      'no-pool': `Không tìm thấy pool của token này với ${p.native} trên ${p.dex}, nên chưa mô phỏng mua bán. Riêng điều này không phải dấu hiệu nguy hiểm; token có thể được giao dịch ở nơi khác.`,
      'no-override': 'RPC công khai không cho phép mô phỏng giao dịch (state override), nên chưa thử mua bán.',
      'buy-failed': `Mô phỏng mua qua ${p.dex} thất bại, nên không thử bán được. Có thể giao dịch chưa được mở, hoặc token từ chối lệnh mua từ hợp đồng.`,
    })[p.why] ?? 'Không chạy được mô phỏng giao dịch, nên chưa thử mua và bán.',
    // CosmWasm (Osmosis, Neutron)
    'cw-not-found': () => 'Không có hợp đồng hay token nào tại địa chỉ này trên chuỗi này. Có thể bạn đã nhập sai, hoặc đã chọn sai chuỗi.',
    'cw20-token': (p) => `Token CW20 (hợp đồng Rust trên CosmWasm) "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'cw-contract': (p) => `Một hợp đồng CosmWasm (viết bằng Rust)${p.label ? ` tên "${p.label}"` : ''}, code ID ${p.codeId ?? '?'}. Không phải token CW20.`,
    'cw-admin': (p) => `Quản trị viên (${p.admin}) có thể thay mã của hợp đồng bằng mã mới bất cứ lúc nào (migrate). Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`,
    'cw-no-admin': () => 'Không có quản trị viên: mã của hợp đồng sẽ không bao giờ bị thay được.',
    'cw-migrated': (p) => `Mã của hợp đồng này đã từng bị thay ${p.count} lần.`,
    'cw20-minter': (p) => `${p.minter} vẫn có thể tạo thêm token mới${p.cap ? `, tối đa tổng cộng ${fmtSupply(p.cap, p.decimals)}` : ' không giới hạn'}, làm loãng giá trị của người nắm giữ hoặc xả tràn ngập thị trường.`,
    'cw20-no-minter': () => 'Không ai có thể tạo thêm token này.',
    'tf-token': (p) => `Coin Token Factory "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''} do ${p.creator} tạo, tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'tf-admin': (p) => `Quản trị viên (${p.admin}) có thể tạo thêm token không giới hạn, và trên một số chuỗi còn có thể chuyển hoặc đốt token từ ví của người khác.`,
    'tf-no-admin': () => 'Vai trò quản trị viên đã bị bỏ: không ai có thể tạo thêm token nữa.',
    'tf-hook': (p) => `Mọi giao dịch chuyển token đều phải qua hợp đồng ${p.contract} (before-send hook), hợp đồng này có thể áp đặt quy tắc riêng, chẳng hạn như chặn bán.`,
    'cw-caveat': () => 'Kiểm tra từ dữ liệu hợp đồng trên chuỗi theo các quy tắc cố định. Chưa kiểm tra mã Rust bên trong và thanh khoản. Không phải lời khuyên đầu tư.',
    // NEAR
    'near-not-found': () => 'Không có tài khoản nào có tên này trên NEAR. Có thể bạn đã nhập sai, hoặc đã chọn sai chuỗi.',
    'near-no-contract': () => 'Tài khoản NEAR này là tài khoản thường, không có hợp đồng. Đây không phải là token.',
    'near-token': (p) => `Token NEAR (NEP-141) "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'near-contract': (p) => `Một hợp đồng NEAR (mã WASM, ví dụ viết bằng Rust) có ${p.count ?? '?'} hàm công khai. Không phải token NEP-141.`,
    'near-full-access': (p) => (p.issuer
      ? `${p.issuer} vẫn giữ một full-access key của tài khoản hợp đồng, nên có thể thay đổi mã, cách thông thường để nhà phát hành sửa lỗi hoặc bổ sung tính năng.`
      : `Tài khoản hợp đồng vẫn còn ${p.count} full-access key: ai giữ khóa có thể triển khai mã mới đè lên bất cứ lúc nào. Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`),
    'near-locked': () => 'Tài khoản hợp đồng không có full-access key nào: không ai có thể triển khai mã mới đè lên từ bên ngoài.',
    'near-upgrade-method': (p) => (p.issuer
      ? `${p.issuer} có thể nâng cấp mã thông qua một hàm của hợp đồng (${list(p.functions)}).`
      : `Mã có các hàm có thể thay chính mã của nó (${list(p.functions)}). Dù không có full-access key, ai được phép gọi các hàm này vẫn có thể thay đổi mã.`),
    'near-caveat': () => 'Kiểm tra từ tên hàm trong mã WASM và dữ liệu tài khoản trên chuỗi theo các quy tắc cố định. Chưa đọc nội dung hàm. Không phải lời khuyên đầu tư.',
    // Starknet (Cairo)
    'sn-not-found': () => 'Không có hợp đồng nào tại địa chỉ này trên Starknet. Có thể bạn nhập sai, hoặc đã chọn sai chuỗi.',
    'sn-token': (p) => `Token Starknet "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sn-contract': (p) => `Một hợp đồng Starknet (viết bằng Cairo ${p.cairo === 1 ? '1' : '0'}) có ${p.count ?? '?'} hàm trong ABI. Không phải token.`,
    'sn-upgradeable': (p) => (p.issuer
      ? `${p.issuer} có thể nâng cấp mã của hợp đồng, cách thông thường để nhà phát hành sửa lỗi hoặc bổ sung tính năng.`
      : `Có thể nâng cấp${p.implementation ? ` (một proxy trỏ tới mã ${p.implementation})` : ''}${p.functions?.length ? ` thông qua ${list(p.functions)}` : ''}: ai được phép đều có thể thay toàn bộ mã. Kết quả kiểm tra hôm nay có thể không còn đúng vào ngày mai.`),
    'sn-caveat': () => 'Kiểm tra từ ABI mà hợp đồng công bố trên chuỗi (tên hàm và việc hàm có thay đổi trạng thái hay không) theo các quy tắc cố định. Chưa đọc nội dung hàm. Không phải lời khuyên đầu tư.',
    // Bitcoin (Runes)
    'btc-not-found': () => 'Không tìm thấy Rune có tên hoặc mã này trên Bitcoin. Tên Rune có dạng DOG•GO•TO•THE•MOON, mã có dạng 840000:3. Chưa đọc được token BRC-20.',
    'btc-rune': (p) => `Rune trên Bitcoin "${p.name ?? '?'}"${p.symbol ? ` (${p.symbol})` : ''}, mã ${p.id ?? '?'}, lượng đã phát hành đến nay ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'btc-no-admin': () => 'Token trên Bitcoin không có mã hợp đồng và không có chủ sở hữu: không ai có thể đóng băng, chặn ví, tạm dừng, đánh thuế hay thay đổi token này. Các quy tắc của nó đã cố định từ lúc tạo.',
    'btc-open-mint': (p) => (p.unlimited
      ? 'Bất kỳ ai vẫn có thể mint thêm, không có giới hạn và không có ngày kết thúc, nên nguồn cung có thể tăng mãi không giới hạn.'
      : `Vẫn đang mở mint: bất kỳ ai cũng có thể mint thêm cho đến khi ${p.end ? `tới khối ${p.end} hoặc ` : ''}${p.maxSupply ? `đạt mức tối đa ${fmtSupply(p.maxSupply, p.decimals)}` : 'hết thời gian mint'}${p.percent != null ? ` (đã mint ${p.percent}%)` : ''}. Nguồn cung vẫn đang tăng.`),
    'btc-premine': (p) => `${p.percent}% nguồn cung tối đa đã thuộc về người tạo ngay khi token được tạo (premine). Người tạo có thể bán ra bất cứ lúc nào.`,
    'btc-turbo': () => 'Người tạo đã chọn nhận các thay đổi sau này của giao thức Runes (turbo), nên cách token này hoạt động có thể thay đổi theo các phiên bản giao thức mới.',
    'btc-caveat': () => 'Kiểm tra từ ord (ordinals.com), bộ lập chỉ mục chuẩn của Runes, theo các quy tắc cố định. Rune tồn tại dưới dạng quy tắc của bộ lập chỉ mục trên nền Bitcoin. Chưa kiểm tra người nắm giữ và thanh khoản. Không phải lời khuyên đầu tư.',
};
