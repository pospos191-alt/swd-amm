// Turns findings into plain language (Thai and English).
// Template-based, so explaining costs $0 and gives the same words every time.

const LEVEL = {
  th: { high: 'เสี่ยงสูง', medium: 'เสี่ยงปานกลาง', low: 'เสี่ยงต่ำ', info: 'ไม่พบจุดเสี่ยงจากกฎที่ตรวจ' },
  en: { high: 'High risk', medium: 'Medium risk', low: 'Low risk', info: 'No risk found by these rules' },
};

const fmtSupply = (raw, decimals) => {
  if (raw == null) return '?';
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 0;
  const s = BigInt(raw).toString().padStart(d + 1, '0');
  const whole = s.slice(0, s.length - d).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = d ? s.slice(s.length - d).replace(/0+$/, '') : '';
  return frac ? `${whole}.${frac.slice(0, 6)}` : whole;
};
const list = (fns) => (fns ?? []).join(', ');

const T = {
  th: {
    'no-code': () => 'ที่อยู่นี้ไม่มีโค้ดสัญญา อาจเป็นกระเป๋าเงินธรรมดา หรือเลือกเชนผิด',
    'erc20': (p) => `เป็นเหรียญ ERC-20 ชื่อ "${p.name ?? '?'}" (${p.symbol ?? '?'}) จำนวนทั้งหมด ${fmtSupply(p.totalSupply, p.decimals)} เหรียญ`,
    'not-erc20': () => 'ไม่พบฟังก์ชันมาตรฐานของเหรียญ ERC-20 สัญญานี้อาจไม่ใช่เหรียญ',
    'name-has-link': () => 'ชื่อหรือสัญลักษณ์เหรียญมีลิงก์หรือชื่อเว็บ เป็นกลลวงที่พบบ่อย (เหรียญแจกฟรีที่ล่อให้เข้าเว็บปลอม) อย่าเข้าเว็บนั้นและอย่าเชื่อมกระเป๋า',
    'proxy-minimal': (p) => `เป็นสำเนาขนาดเล็ก (EIP-1167) ที่ชี้ไปยังโค้ดหลักที่ ${p.implementation} แบบตายตัว เปลี่ยนโค้ดไม่ได้`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} อัปเกรดโค้ดของสัญญาได้ เป็นวิธีปกติที่ผู้ออกใช้แก้ไขหรือเพิ่มความสามารถ`
      : `สัญญาอัปเกรดได้: ผู้ดูแล${p.admin ? ` (${p.admin})` : ''} เปลี่ยนโค้ดทั้งหมดได้ทุกเมื่อ กฎที่ตรวจวันนี้อาจไม่จริงในวันพรุ่งนี้`),
    'owner-active': (p) => `มีเจ้าของคุมสัญญาอยู่: ${p.owner}`,
    'owner-renounced': () => 'เจ้าของสละสิทธิ์แล้ว (owner เป็นที่อยู่ศูนย์) ฟังก์ชันที่จำกัดเฉพาะเจ้าของจะไม่มีใครเรียกได้อีก',
    'owner-unknown': () => 'ไม่พบฟังก์ชัน owner() จึงบอกไม่ได้ว่าใครคุมสิทธิ์พิเศษด้านล่าง ให้ถือว่ายังมีคนคุมอยู่',
    'roles': () => 'ใช้ระบบสิทธิ์แบบหลายบทบาท (roles) อาจมีหลายที่อยู่ที่มีสิทธิ์พิเศษ ตรวจจากโค้ดอย่างเดียวไม่ได้ว่าใครถืออยู่',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} สร้างเหรียญเพิ่มได้ (${list(p.functions)}) เพื่อออกเหรียญตามเงินที่รับฝาก ปกติของเหรียญประเภทนี้`
      : `สร้างเหรียญเพิ่มได้ (${list(p.functions)}) ทำให้เหรียญที่คุณถือมีสัดส่วนลดลง หรือถูกเทขายจนราคาตก`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} อายัดกระเป๋าบางใบได้ (${list(p.functions)}) มักใช้กับเงินที่ถูกขโมยหรือตามคำสั่งทางกฎหมาย`
      : `บล็อกกระเป๋าบางใบได้ (${list(p.functions)}) ถ้ากระเป๋าคุณถูกบล็อก อาจขายหรือโอนไม่ได้`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} หยุดการโอนทั้งหมดได้ (${list(p.functions)}) ใช้ในกรณีฉุกเฉิน`
      : `หยุดการโอนทั้งหมดได้ (${list(p.functions)}) ทุกคนอาจขายไม่ได้ชั่วคราวหรือถาวร`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `ปรับภาษีได้ (${list(p.functions)}) แต่ตามแม่แบบ ${p.project} ลดได้อย่างเดียว ขึ้นไม่ได้`
      : `เปลี่ยนภาษีซื้อขายได้ (${list(p.functions)}) ถ้าตั้งภาษีขายสูงมาก จะขายแล้วแทบไม่เหลือเงิน`),
    'known-issuer': (p) => `เป็นสัญญาทางการของ ${p.symbol} ออกโดย ${p.issuer} (ตรงกับที่อยู่ที่ลงทะเบียนไว้) สิทธิ์พิเศษด้านล่างเป็นของผู้ออกเหรียญ ความเสี่ยงหลักคือความน่าเชื่อถือของผู้ออก ไม่ใช่โค้ดแอบแฝง`,
    'lookalike': (p) => `ใช้สัญลักษณ์ ${p.symbol} เหมือนเหรียญของ ${p.issuer} แต่ไม่ใช่ที่อยู่ทางการ (${p.official}) อาจเป็นเหรียญปลอม อย่าซื้อหรือรับโอนจนกว่าจะตรวจที่อยู่`,
    'template-match': (p) => `ตรงกับแม่แบบเหรียญ ${p.project} ที่ลงทะเบียนไว้ (${p.name}) กติกาของแม่แบบนี้ยังไม่ผ่าน audit`,
    'template-mismatch': (p) => `โค้ดตรงกับแม่แบบ ${p.project} แต่มีสิทธิ์ที่แม่แบบบอกว่าไม่มี (${list(p.functions)}) ข้อมูลแม่แบบอาจผิด อย่าเชื่อจนกว่าจะตรวจ`,
    'trading-switch': (p) => `มีสวิตช์เปิดปิดการเทรด (${list(p.functions)}) ก่อนเปิด อาจซื้อได้แต่ขายไม่ได้`,
    'can-limit': (p) => `กำหนดเพดานต่อรายการหรือต่อกระเป๋าได้ (${list(p.functions)}) ถ้าตั้งต่ำมาก อาจขายไม่ได้`,
    'fee-exempt': (p) => `ยกเว้นภาษีให้บางกระเป๋าได้ (${list(p.functions)}) เป็นเรื่องปกติของเหรียญที่มีภาษี แต่ทำให้บางคนได้เปรียบ`,
    'selfdestruct': () => 'โค้ดมีคำสั่งทำลายสัญญา (SELFDESTRUCT) ถ้าถูกเรียกใช้ อาจลบหรือย้ายเงินในสัญญาได้',
    'delegatecall': () => 'โค้ดเรียกใช้โค้ดของสัญญาอื่นแทนตัวเองได้ (DELEGATECALL) โค้ดที่ทำงานจริงจึงอาจไม่ใช่โค้ดที่เห็นตรงนี้',
    'nothing-found': () => 'ไม่พบสิทธิ์พิเศษหรือคำสั่งอันตรายตามกฎที่ตรวจ',
    'bytecode-only': () => 'ตรวจจากโค้ดบนเชนด้วยกฎตายตัว อาจพลาดกลโกงที่ซ่อนชื่อฟังก์ชันแปลกๆ ไม่ใช่คำแนะนำการลงทุน',
    // Solana
    'sol-not-found': () => 'ไม่พบบัญชีนี้บน Solana อาจพิมพ์ผิด หรือเลือกเชนผิด',
    'sol-not-token': (p) => `ที่อยู่นี้ไม่ใช่เหรียญ (mint) บน Solana เป็นบัญชีของโปรแกรม ${p.owner}`,
    'sol-token': (p) => `เป็นเหรียญ ${p.program} ชื่อ "${p.name ?? '?'}" (${p.symbol ?? '?'}) จำนวนทั้งหมด ${fmtSupply(p.totalSupply, p.decimals)} เหรียญ`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} สร้างเหรียญเพิ่มได้ (mint authority: ${p.authority}) เพื่อออกเหรียญตามเงินที่รับฝาก ปกติของเหรียญประเภทนี้`
      : `ยังสร้างเหรียญเพิ่มได้ (mint authority: ${p.authority}) ทำให้เหรียญที่คุณถือมีสัดส่วนลดลง หรือถูกเทขายจนราคาตก`),
    'sol-mint-renounced': () => 'สละสิทธิ์สร้างเหรียญเพิ่มแล้ว จำนวนเหรียญเพิ่มไม่ได้อีก',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} อายัดบัญชีบางบัญชีได้ (freeze authority) มักใช้กับเงินที่ถูกขโมยหรือตามคำสั่งทางกฎหมาย`
      : `ยังอายัดบัญชีได้ (freeze authority: ${p.authority}) ถ้าบัญชีคุณถูกอายัด จะขายหรือโอนไม่ได้ เป็นกลโกงที่พบบ่อยบน Solana`),
    'sol-freeze-renounced': () => 'สละสิทธิ์อายัดบัญชีแล้ว ไม่มีใครอายัดเหรียญในกระเป๋าคุณได้',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} ย้ายหรือเผาเหรียญจากบัญชีใดก็ได้ (permanent delegate) ใช้กับการยึดเงินตามกฎหมาย`
      : `มีผู้ถือสิทธิ์ถาวร (permanent delegate: ${p.delegate}) ที่ย้ายหรือเผาเหรียญจากกระเป๋าของทุกคนได้โดยไม่ต้องขออนุญาต อันตรายมาก`),
    'sol-transfer-fee': (p) => `เก็บภาษีทุกครั้งที่โอน ${p.percent}%${p.authority ? ` และผู้ดูแล (${p.authority}) ปรับขึ้นได้สูงสุดถึง 100%` : ''}`,
    'sol-transfer-hook': (p) => `ทุกการโอนต้องผ่านโปรแกรมเสริม (transfer hook: ${p.programId}) ซึ่งเขียนกฎได้เอง เช่น ห้ามขาย`,
    'sol-default-frozen': () => 'บัญชีใหม่ของเหรียญนี้ถูกอายัดตั้งแต่เริ่ม ซื้อแล้วอาจโอนหรือขายไม่ได้จนกว่าผู้ดูแลจะปลดให้',
    'sol-pausable': (p) => `หยุดการโอนทั้งหมดได้ (pausable)${p.paused ? ' และตอนนี้กำลังหยุดอยู่' : ''}`,
    'sol-close-authority': (p) => `ปิดบัญชีเหรียญ (mint) แล้วสร้างใหม่ที่ที่อยู่เดิมได้ (close authority: ${p.authority})`,
    'sol-non-transferable': () => 'เหรียญนี้โอนไม่ได้ (non-transferable) ใช้เป็นตราหรือสิทธิ์ ไม่ใช่เหรียญซื้อขาย',
    'sol-metadata-mutable': (p) => `ชื่อ สัญลักษณ์ และรูปของเหรียญยังแก้ไขได้ (update authority: ${p.authority}) อาจเปลี่ยนให้เหมือนเหรียญอื่นภายหลัง`,
    'sol-program-upgradeable': (p) => `เป็นโปรแกรมที่อัปเกรดได้ ผู้ถือสิทธิ์ (${p.authority}) เปลี่ยนโค้ดได้ทุกเมื่อ`,
    'sol-program-immutable': () => 'เป็นโปรแกรมที่อัปเกรดไม่ได้แล้ว โค้ดเปลี่ยนไม่ได้อีก',
    'sol-caveat': () => 'ตรวจจากข้อมูลบัญชีบนเชนด้วยกฎตายตัว ไม่ได้ตรวจสภาพคล่องหรือการถือครอง ไม่ใช่คำแนะนำการลงทุน',
  },
  en: {
    'no-code': () => 'This address has no contract code. It may be a plain wallet, or the wrong chain is selected.',
    'erc20': (p) => `ERC-20 token "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'not-erc20': () => 'No standard ERC-20 functions found. This contract may not be a token.',
    'name-has-link': () => 'The token name or symbol contains a link or website name, a common scam (free "airdrop" tokens that lure you to a fake site). Do not visit it or connect your wallet.',
    'proxy-minimal': (p) => `Minimal clone (EIP-1167) that always runs the code at ${p.implementation}. The code cannot be changed.`,
    'proxy-upgradeable': (p) => (p.issuer
      ? `${p.issuer} can upgrade the contract's code, the usual way issuers fix or extend it.`
      : `Upgradeable: the admin${p.admin ? ` (${p.admin})` : ''} can replace all of the code at any time. What is checked today may not hold tomorrow.`),
    'owner-active': (p) => `An owner controls this contract: ${p.owner}`,
    'owner-renounced': () => 'Ownership is renounced (owner is the zero address). Owner-only functions can no longer be called.',
    'owner-unknown': () => 'No owner() function found, so it is unclear who holds the special powers below. Assume someone does.',
    'roles': () => 'Uses role-based permissions. Several addresses may hold special powers; the code alone does not show who.',
    'can-mint': (p) => (p.issuer
      ? `${p.issuer} can mint (${list(p.functions)}) to issue tokens against deposits, as expected for this kind of token.`
      : `Can create new tokens (${list(p.functions)}), diluting holders or flooding the market.`),
    'can-blacklist': (p) => (p.issuer
      ? `${p.issuer} can freeze specific wallets (${list(p.functions)}), usually for stolen funds or legal orders.`
      : `Can block specific wallets (${list(p.functions)}). A blocked wallet may be unable to sell or transfer.`),
    'can-pause': (p) => (p.issuer
      ? `${p.issuer} can pause all transfers (${list(p.functions)}) in an emergency.`
      : `Can freeze all transfers (${list(p.functions)}). Nobody may be able to sell.`),
    'can-change-fee': (p) => (p.decreaseOnly
      ? `Can adjust the tax (${list(p.functions)}), but the ${p.project} template only allows lowering it.`
      : `Can change the buy/sell tax (${list(p.functions)}). A very high sell tax means selling returns almost nothing.`),
    'known-issuer': (p) => `Official ${p.symbol} contract issued by ${p.issuer} (matches the registered address). The powers below belong to the issuer; the main risk is trust in the issuer, not hidden code.`,
    'lookalike': (p) => `Uses the symbol ${p.symbol} like ${p.issuer}'s token but is NOT the official address (${p.official}). Possibly a fake; do not buy or accept it until you check the address.`,
    'template-match': (p) => `Matches the registered ${p.project} token template (${p.name}). The template's rules are not audited yet.`,
    'template-mismatch': (p) => `Code matches the ${p.project} template but has a power the template says it lacks (${list(p.functions)}). The template record may be wrong; do not trust it until checked.`,
    'trading-switch': (p) => `Has a trading on/off switch (${list(p.functions)}). Before it is on, you may be able to buy but not sell.`,
    'can-limit': (p) => `Can set per-transaction or per-wallet limits (${list(p.functions)}). Very low limits can block selling.`,
    'fee-exempt': (p) => `Can exempt chosen wallets from tax (${list(p.functions)}). Common in taxed tokens, but it gives some wallets an edge.`,
    'selfdestruct': () => 'The code contains SELFDESTRUCT. If triggered, it can wipe the contract or move its funds.',
    'delegatecall': () => 'The code can run another contract\'s code as its own (DELEGATECALL), so the code that really runs may not be the code shown here.',
    'nothing-found': () => 'No special powers or dangerous instructions found by these rules.',
    'bytecode-only': () => 'Checked from on-chain code with fixed rules. Scams that hide behind unusual function names can be missed. Not investment advice.',
    // Solana
    'sol-not-found': () => 'No account at this address on Solana. It may be mistyped, or the wrong chain is selected.',
    'sol-not-token': (p) => `This address is not a token mint on Solana; it is an account of program ${p.owner}.`,
    'sol-token': (p) => `${p.program} token "${p.name ?? '?'}" (${p.symbol ?? '?'}), total supply ${fmtSupply(p.totalSupply, p.decimals)}.`,
    'sol-mint-authority': (p) => (p.issuer
      ? `${p.issuer} can mint (mint authority: ${p.authority}) to issue tokens against deposits, as expected for this kind of token.`
      : `New tokens can still be minted (mint authority: ${p.authority}), diluting holders or flooding the market.`),
    'sol-mint-renounced': () => 'Mint authority is renounced: the supply can never grow.',
    'sol-freeze-authority': (p) => (p.issuer
      ? `${p.issuer} can freeze accounts (freeze authority), usually for stolen funds or legal orders.`
      : `Accounts can still be frozen (freeze authority: ${p.authority}). A frozen account cannot sell or transfer, a common Solana scam.`),
    'sol-freeze-renounced': () => 'Freeze authority is renounced: nobody can freeze your tokens.',
    'sol-permanent-delegate': (p) => (p.issuer
      ? `${p.issuer} can move or burn tokens from any account (permanent delegate), used for legal seizures.`
      : `A permanent delegate (${p.delegate}) can move or burn tokens from EVERY wallet without permission. Very dangerous.`),
    'sol-transfer-fee': (p) => `Charges ${p.percent}% on every transfer${p.authority ? `, and the fee authority (${p.authority}) can raise it as high as 100%` : ''}.`,
    'sol-transfer-hook': (p) => `Every transfer runs an extra program (transfer hook: ${p.programId}) that can enforce its own rules, such as blocking sells.`,
    'sol-default-frozen': () => 'New accounts for this token start frozen: after buying you may be unable to move or sell until unfrozen.',
    'sol-pausable': (p) => `All transfers can be paused (pausable)${p.paused ? ', and they are paused right now' : ''}.`,
    'sol-close-authority': (p) => `The mint can be closed and re-created at the same address (close authority: ${p.authority}).`,
    'sol-non-transferable': () => 'This token cannot be transferred (non-transferable): a badge or right, not a tradable coin.',
    'sol-metadata-mutable': (p) => `Name, symbol and image can still be changed (update authority: ${p.authority}), e.g. later made to imitate another token.`,
    'sol-program-upgradeable': (p) => `Upgradeable program: the authority (${p.authority}) can replace its code at any time.`,
    'sol-program-immutable': () => 'This program can no longer be upgraded; its code is fixed.',
    'sol-caveat': () => 'Checked from on-chain account data with fixed rules; liquidity and holder distribution are not checked. Not investment advice.',
  },
};

// What the contract is comes first, then the most serious findings, the caveat last.
const IDENTITY = new Set(['no-code', 'erc20', 'not-erc20', 'sol-token', 'sol-not-found', 'sol-not-token']);
const ORDER = { high: 0, medium: 1, low: 2, good: 3, info: 4 };
// Who issued it (or that it copies someone) belongs right under what it is.
const ISSUER = new Set(['known-issuer', 'lookalike']);
const rank = (f) => (IDENTITY.has(f.id) ? -2 : ISSUER.has(f.id) ? -1 : (f.id === 'bytecode-only' || f.id === 'sol-caveat') ? 9 : ORDER[f.severity] ?? 5);

/** Report -> { title, lines: [{severity, text}] } in the chosen language. */
export function explain(report, lang = 'th') {
  const t = T[lang] ? lang : 'th';
  const sorted = [...report.analysis.findings].sort((a, b) => rank(a) - rank(b));
  const lines = sorted.map((f) => ({
    id: f.id,
    severity: f.severity,
    text: (T[t][f.id] ?? (() => f.id))(f.params ?? {}),
  }));
  return { title: LEVEL[t][report.analysis.level], level: report.analysis.level, lines };
}
