import { fmtSupply, list } from './fmt.js';

// Vietnamese. Same keys as en.js (test/i18n.test.js checks it).
export const NAME = 'Tiếng Việt';

export const LEVEL = { high: 'Rủi ro cao', medium: 'Rủi ro trung bình', low: 'Rủi ro thấp', info: 'Không phát hiện rủi ro theo các quy tắc này' };

export const UI = {
  subtitle: 'Đọc và giải thích hợp đồng · cấp 1, chỉ đọc', chain: 'Chuỗi', address: 'Địa chỉ hợp đồng hoặc token', check: 'Kiểm tra hợp đồng',
  details: 'Chi tiết', reading: 'Đang đọc dữ liệu từ chuỗi…', badAddress: 'Địa chỉ không hợp lệ cho chuỗi này. Các định dạng được chấp nhận: ',
  failed: 'Không đọc được: ', footer: 'Không bao giờ yêu cầu kết nối ví và không bao giờ gửi giao dịch. Chỉ đọc dữ liệu công khai trên chuỗi. Không phải lời khuyên đầu tư.', stats: 'Thống kê sử dụng', language: 'Ngôn ngữ',
  m: {
    chain: 'Chuỗi', address: 'Địa chỉ', proxy: 'Proxy', implementation: 'Mã thực thi', owner: 'Chủ sở hữu', functions: 'Hàm đã nhận diện', report: 'Mã báo cáo', explorer: 'Mở trên explorer', fingerprint: 'Dấu vân tay mã (để đăng ký mẫu)', unknown: 'Hàm chưa rõ tên',
    program: 'Chương trình token', mintAuth: 'Quyền tạo token (mint authority)', freezeAuth: 'Quyền đóng băng (freeze authority)', extensions: 'Tiện ích mở rộng', upgradeAuth: 'Quyền nâng cấp', none: 'không có',
    package: 'Gói', standard: 'Tiêu chuẩn', admin: 'Quản trị viên', holders: 'Số người nắm giữ', listed: 'Danh sách tonapi', raw: 'Địa chỉ gốc (raw)',
  },
};

export const T = {
    'no-code': () => 'Địa chỉ này không có mã hợp đồng. Có thể đây chỉ là một ví thông thường, hoặc bạn đã chọn sai chuỗi.',
    'erc20': (p) => `Token ERC-20 "${p.name ?? '?'}" (${p.symbol ?? '?'}), tổng cung ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'Không tìm thấy các hàm ERC-20 tiêu chuẩn. Hợp đồng này có thể không phải là token.',
    'name-has-link': () => 'Tên hoặc ký hiệu token chứa đường link hoặc tên trang web, một chiêu lừa đảo phổ biến (token "airdrop" miễn phí dụ bạn vào trang giả mạo). Đừng truy cập trang đó và đừng kết nối ví.',
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
    'lookalike': (p) => `Dùng ký hiệu ${p.symbol} giống token của ${p.issuer} nhưng KHÔNG phải địa chỉ chính thức (${p.official}). Có thể là hàng giả; đừng mua hoặc nhận token này cho đến khi bạn kiểm tra lại địa chỉ.`,
    'template-match': (p) => `Khớp với mẫu token ${p.project} đã đăng ký (${p.name}). Các quy tắc của mẫu này chưa được kiểm toán.`,
    'template-mismatch': (p) => `Mã khớp với mẫu ${p.project} nhưng lại có một quyền mà mẫu ghi là không có (${list(p.functions)}). Thông tin mẫu có thể sai; đừng tin cho đến khi được kiểm tra.`,
    'trading-switch': (p) => `Có công tắc bật/tắt giao dịch (${list(p.functions)}). Trước khi bật, bạn có thể mua được nhưng không bán được.`,
    'can-limit': (p) => `Có thể đặt giới hạn cho mỗi giao dịch hoặc mỗi ví (${list(p.functions)}). Giới hạn quá thấp có thể khiến bạn không bán được.`,
    'fee-exempt': (p) => `Có thể miễn thuế cho một số ví được chọn (${list(p.functions)}). Thường gặp ở token có thuế, nhưng điều này cho một số ví lợi thế hơn người khác.`,
    'network-flagged': (p) => `Mạng lưới Neuro ZETAPHY đã bỏ phiếu đánh giá mã này là nguy hiểm${p.reason ? ` (${p.reason})` : ''}. Mọi hợp đồng có cùng mã đều nhận cảnh báo tương tự.`,
    'tax-wallet': (p) => `Có thể đổi ví nhận tiền thuế (${list(p.functions)}). Thường gặp ở token có thuế.`,
    'selfdestruct': () => 'Mã có chứa SELFDESTRUCT. Nếu được kích hoạt, nó có thể xóa sạch hợp đồng hoặc chuyển tiền của hợp đồng đi nơi khác.',
    'delegatecall': () => 'Mã có thể chạy mã của một hợp đồng khác như mã của chính nó (DELEGATECALL), nên mã thực sự chạy có thể khác với mã hiển thị ở đây.',
    'nothing-found': () => 'Các quy tắc này không phát hiện quyền đặc biệt hay lệnh nguy hiểm nào.',
    'unknown-functions': (p) => `Còn ${p.count} hàm mà Neuro không xác định được tên (${(p.selectors ?? []).map((x) => '0x' + x).join(', ')}), nên không rõ chúng làm gì. Khi hợp đồng vẫn còn chủ sở hữu kiểm soát, đó có thể là các hàm đặc quyền, ví dụ đặt thuế hoặc giới hạn giao dịch.`,
    'bytecode-only': () => 'Kiểm tra từ mã trên chuỗi theo các quy tắc cố định. Các chiêu lừa đảo ẩn sau tên hàm lạ có thể bị bỏ sót. Không phải lời khuyên đầu tư.',
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
      : `Tài khoản vẫn có thể bị đóng băng (freeze authority: ${p.authority}). Tài khoản bị đóng băng không bán hay chuyển được, một chiêu lừa đảo phổ biến trên Solana.`),
    'sol-freeze-renounced': () => 'Quyền đóng băng (freeze authority) đã được từ bỏ: không ai có thể đóng băng token của bạn.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} có thể chuyển đi hoặc hủy token từ bất kỳ tài khoản nào (permanent delegate), dùng cho việc thu giữ theo pháp luật.`
      : `Một bên được ủy quyền vĩnh viễn (permanent delegate: ${p.delegate}) có thể chuyển đi hoặc hủy token từ MỌI ví mà không cần sự cho phép. Rất nguy hiểm.`),
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
    'ton-scam': () => 'tonapi.io đánh dấu token này hoặc quản trị viên của nó có liên quan đến lừa đảo. Đừng mua hoặc nhận token này.',
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
    'ton-caveat': () => 'Kiểm tra từ dữ liệu hợp đồng do tonapi.io giải mã theo các quy tắc cố định. Chưa kiểm tra mã ví của người nắm giữ (vì lý do này, một số token có thể mua được nhưng không bán được). Không phải lời khuyên đầu tư.',
};
