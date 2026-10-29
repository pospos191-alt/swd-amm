// ZETAPHY PQ Wallet: a native ML-DSA-44 account in the browser.
// The seed is kept only encrypted (PBKDF2-SHA256 600k + AES-256-GCM) in
// localStorage. The only network traffic is JSON-RPC to the node the user
// typed in: addresses, balances and signed transactions. Never the seed.
// Or the key lives in MetaMask (the ZETAPHY Snap, zetaphy-snap/): this page then
// knows only the public key, and the snap builds, shows and signs each tx.
// security.js: the passphrase blob, an optional second blob under a passkey's WebAuthn
// PRF output (HKDF-SHA256 + AES-256-GCM), and the passphrase strength estimate. The
// unlocked key is wiped on Lock and after an idle time (auto-lock).
import {
  ml_dsa44, keccak_256, pqAddress, pqClient, normalizeAddress, validatorAddress, parseZeta, formatZeta, bytesToHex, hexToBytes,
  DEFAULT_GAS_LIMIT, DEFAULT_STAKING_GAS_LIMIT, DEFAULT_EVM_GAS_LIMIT, EVM_CALL_GAS_OVERHEAD, MIN_EVM_GAS_LIMIT, MAX_EVM_GAS_LIMIT,
  DEFAULT_PRECOMPILE_GAS_LIMIT, DEFAULT_DEPLOY_GAS_LIMIT, PUBLIC_KEY_BYTES, quantumLockTx, codeFingerprint,
  secp256k1, qdayRevealText, qdaySalt, qdayCommitment, consentCall, SECURITY_PRECOMPILE, MAX_CONSENT_SECONDS,
  THREAT_SEL, PROXY_DEPTH, proxyTargets, codeKey, addressKey, detailQueries, readEvidence, readResponse, REASON_TEXT, DISCLAIMER, REPRODUCE,
} from './vendor/pqwallet.js';
import {
  CHAIN_ID, CHAIN_NAME, EVM_CHAIN_ID_HEX, EVM_SYMBOL, DECIMALS, nodeEndpoints, evmChainParams, keplrChainInfo,
  discoverWallets, mayRunSnaps, openInAppLinks,
} from './wallets.js';
import {
  seal, unseal, passwordStrength, MIN_PASSWORD_LENGTH, wrapSeed, unwrapSeed, isPasskeyBlob, newPrfSalt, toB64url, fromB64url,
} from './security.js';

const KEYS = { seed: 'zetaphy-wallet:seed:v1', rpc: 'zetaphy-wallet:rpc', lang: 'zetaphy-wallet:lang', token: 'zetaphy-wallet:token',
  owners: 'zetaphy-wallet:owners:v1:', // + this wallet's zetaphy1… address
  snap: 'zetaphy-wallet:snap:v1', // the snap ID last connected (no key: MetaMask holds it)
  evmWallet: 'zetaphy-wallet:evm-wallet', // the EVM wallet picked (its EIP-6963 rdns, or which injected object)
  wcId: 'zetaphy-wallet:walletconnect-project-id',
  threats: 'zetaphy-wallet:threat-registry', // ThreatRegistry address (the vaccine), else the page's meta tag
  autolock: 'zetaphy-wallet:autolock-minutes', // 30, 60, 120 or 240
  passkey: 'zetaphy-wallet:passkey:v1', // the seed wrapped under a passkey's PRF output (security.js wrapSeed); never the PRF output
  bigHidden: 'zetaphy-wallet:big-balance-hidden-until:' }; // + address: the large-balance banner hidden until (ms)
const EVM_CHAIN_ID = 77390n;

const T = {
  th: {
    subtitle: 'กระเป๋าต้านควอนตัม (ML-DSA-44) · ไม่มีกุญแจ ECDSA',
    warnTitle: 'ใช้กับ testnet เท่านั้น',
    warnTestnet: 'ZETAPHY testnet ไม่ใช่เงินจริง ห้ามใส่ของที่มีมูลค่า',
    warnSeed: 'seed คือกุญแจเดียวของกระเป๋า ถ้าหายหรือลืมรหัสผ่าน เงินในกระเป๋าหายถาวร ไม่มีใครกู้คืนให้ได้',
    warnLocal: 'seed อยู่ในเบราว์เซอร์นี้เท่านั้น เก็บแบบเข้ารหัสด้วยรหัสผ่านของคุณ และไม่ถูกส่งไปที่ไหน',
    rpcLabel: 'ที่อยู่ RPC ของโหนด ZETAPHY (JSON-RPC พอร์ต 8545)',
    rpcSave: 'บันทึก',
    rpcHint: 'ถ้าเปิดหน้านี้ผ่าน https ต้องใช้ RPC แบบ https ด้วย (เบราว์เซอร์บล็อก http)',
    setupTitle: 'เริ่มใช้งาน',
    modeNew: 'สร้างกุญแจใหม่',
    modeImport: 'นำเข้า seed',
    seedLabel: 'seed (hex 64 ตัว, ขึ้นต้น 0x หรือไม่ก็ได้)',
    pass1: 'ตั้งรหัสผ่าน (อย่างน้อย 12 ตัวอักษร ระดับ "แข็งแรง" ขึ้นไป)',
    pass2: 'พิมพ์รหัสผ่านอีกครั้ง',
    saveKey: 'สร้างกระเป๋า',
    lockedTitle: 'กระเป๋าถูกล็อก',
    unlockLabel: 'รหัสผ่าน',
    unlock: 'ปลดล็อก',
    forget: 'ลบกระเป๋าออกจากเบราว์เซอร์นี้',
    accountTitle: 'บัญชีของคุณ',
    sameAccount: 'สองแบบนี้คือบัญชีเดียวกัน รับเงินได้ทั้งสองแบบ',
    copy: 'คัดลอก',
    balance: 'ยอดเงิน',
    refresh: 'อัปเดต',
    sendTitle: 'โอน ZETAPHY',
    toLabel: 'ถึง (0x… หรือ zetaphy1…)',
    amountLabel: 'จำนวน (ZETAPHY)',
    advanced: 'ตั้งค่าเพิ่มเติม',
    gasLabel: 'gas limit',
    review: 'ตรวจก่อนโอน',
    confirmTitle: 'ยืนยันการโอน',
    cTo: 'ถึง',
    cAmount: 'จำนวน',
    cFee: 'ค่าธรรมเนียมสูงสุด',
    cTotal: 'รวม',
    confirmSend: 'ยืนยัน เซ็นด้วย ML-DSA และส่ง',
    cancel: 'ยกเลิก',
    txSent: 'ส่งแล้ว tx hash:',
    backupTitle: 'สำรอง seed',
    backupWarn: 'ไฟล์สำรองเป็น seed แบบไม่เข้ารหัส ใครได้ไฟล์นี้ไปก็ย้ายเงินออกได้ เก็บไว้ในที่ปลอดภัยแบบออฟไลน์ ห้ามส่งให้ใคร',
    backupOk: 'เข้าใจแล้ว',
    backup: 'ดาวน์โหลดไฟล์สำรอง seed',
    backupCli: 'ไฟล์นี้ใช้เป็น ~/.zetaphy/pq.seed ของคำสั่ง zetaphy pq native ได้เลย',
    lock: 'ล็อกกระเป๋า',
    footer: 'โค้ดทั้งหมดอยู่ในหน้านี้ ไม่โหลดสคริปต์จากที่อื่น · ธุรกรรมเซ็นด้วย ML-DSA-44 (FIPS 204) ในเบราว์เซอร์ หรือใน MetaMask ผ่าน ZETAPHY Snap',
    // status messages
    working: 'กำลังทำงาน…',
    deriving: 'กำลังเข้ารหัส seed (ใช้เวลาสักครู่)…',
    created: 'สร้างกระเป๋าแล้ว ดาวน์โหลดไฟล์สำรอง seed เก็บไว้ก่อนรับเงิน',
    imported: 'นำเข้า seed แล้ว',
    unlocked: 'ปลดล็อกแล้ว',
    lockedMsg: 'ล็อกแล้ว',
    badPass: 'รหัสผ่านไม่ถูกต้อง',
    passShort: 'รหัสผ่านต้องยาวอย่างน้อย {n} ตัวอักษร',
    passMismatch: 'รหัสผ่านสองช่องไม่ตรงกัน',
    badSeed: 'seed ต้องเป็น hex 64 ตัว',
    storeFailed: 'เบราว์เซอร์นี้บันทึกข้อมูลไม่ได้ (โหมดส่วนตัว?) กระเป๋าจะหายเมื่อปิดหน้า ดาวน์โหลดไฟล์สำรองไว้',
    rpcSaved: 'บันทึก RPC แล้ว',
    needRpc: 'ใส่ที่อยู่ RPC ของโหนดก่อน',
    badRpc: 'ที่อยู่ RPC ต้องขึ้นต้นด้วย http:// หรือ https://',
    wrongChain: 'RPC นี้ไม่ใช่ ZETAPHY testnet (chain id {id})',
    rpcDown: 'ติดต่อ RPC ไม่ได้ (ปิดอยู่, ไม่อนุญาต CORS หรือเป็น http บนหน้า https)',
    notFunded: 'บัญชียังไม่มีบนเชน: โอน ZETAPHY เข้าที่อยู่นี้ก่อน จึงจะโอนออกได้',
    onChain: 'บัญชีมีบนเชนแล้ว (หมายเลข {n}, ส่งไปแล้ว {s} ธุรกรรม)',
    badAddress: 'ที่อยู่ปลายทางไม่ถูกต้อง (ตรวจตัวสะกดหรือ checksum)',
    badAmount: 'จำนวนเงินไม่ถูกต้อง',
    badGas: 'gas limit ต้องเป็นจำนวนเต็มมากกว่า 0',
    notEnough: 'เงินไม่พอ: ต้องมี {need} ZETAPHY (รวมค่าธรรมเนียม) แต่มี {have}',
    signing: 'กำลังเซ็นด้วย ML-DSA-44 และส่ง…',
    sent: 'ส่งแล้ว โหนดรับธุรกรรมแล้ว จะเข้าบล็อกในไม่กี่วินาที',
    rejected: 'โหนดปฏิเสธธุรกรรม',
    copied: 'คัดลอกแล้ว',
    forgetConfirm: 'ลบกระเป๋าออกจากเบราว์เซอร์นี้? ถ้าไม่มีไฟล์สำรอง seed เงินจะหายถาวร',
    forgotten: 'ลบกระเป๋าออกจากเบราว์เซอร์นี้แล้ว',
    backupDone: 'ดาวน์โหลดไฟล์สำรองแล้ว เก็บไว้แบบออฟไลน์',
    // ERC-20 tokens
    tokenTitle: 'โทเคน ERC-20',
    tokenLabel: 'ที่อยู่สัญญาโทเคน (0x…)',
    tokenLoad: 'ดูโทเคน',
    tokenBalance: 'ยอดโทเคน',
    tokenMeta: '{sym} · ทศนิยม {d} หลัก · สัญญา {addr}',
    tokenAmountLabel: 'จำนวนโทเคน',
    evmGasLabel: 'EVM gas limit (ค่าธรรมเนียมคิดจาก gas นี้บวกส่วนของธุรกรรม)',
    tokenConfirmTitle: 'ยืนยันการโอนโทเคน',
    cToken: 'โทเคน',
    tokenChecked: 'จำลองการโอนกับโหนดแล้ว ผ่าน (จะจำลองซ้ำอีกครั้งก่อนเซ็น)',
    tokenNote: 'ค่าธรรมเนียมจ่ายเป็น ZETAPHY ถ้าสัญญา revert ธุรกรรมทั้งหมดล้มเหลวแต่ยังเสียค่าธรรมเนียม หน้านี้จึงจำลองก่อนเซ็นทุกครั้ง',
    badToken: 'ที่อยู่สัญญาโทเคนต้องเป็น 0x ตามด้วย hex 40 ตัว (ตรวจ checksum)',
    noContract: 'ไม่มีสัญญาที่ {addr}',
    notToken: 'สัญญานี้ไม่ใช่โทเคน ERC-20 (ไม่มี decimals())',
    tokenDecimals: 'จำนวนมีทศนิยมเกิน {d} หลักของ {sym}',
    badEvmGas: 'EVM gas limit ต้องเป็นจำนวนเต็มระหว่าง {min} ถึง {max}',
    tokenNotEnough: 'โทเคนไม่พอ: จะโอน {need} {sym} แต่มี {have}',
    callFails: 'ไม่ได้ส่ง: จำลองกับโหนดแล้วการโอนจะล้มเหลว (revert)',
    tokenRefused: 'ไม่ได้ส่ง: โทเคนปฏิเสธการโอน (transfer คืนค่า false)',
    tokenSent: 'ส่งแล้ว โหนดรับธุรกรรมแล้ว (เป็นธุรกรรม Cosmos จึงไม่มี log ใน eth_getLogs แต่ยอดถูกต้อง)',
    // staking
    stakeTitle: 'Stake ZETAPHY',
    validatorLabel: 'validator (zetaphyvaloper1…)',
    stakeAmountLabel: 'จำนวน (ZETAPHY) ไม่ต้องใส่ถ้ารับรางวัล',
    stake: 'Stake',
    unstake: 'ถอน stake',
    claim: 'รับรางวัล',
    confirmStake: 'ยืนยันการ stake',
    confirmUnstake: 'ยืนยันการถอน stake',
    confirmClaim: 'ยืนยันการรับรางวัล',
    cValidator: 'validator',
    unbondNote: 'เงินที่ถอน stake จะกลับเข้าบัญชีหลังพ้นช่วง unbonding ของเชน ระหว่างนั้นใช้ไม่ได้และไม่ได้รางวัล',
    badValidator: 'ที่อยู่ validator ต้องเป็น zetaphyvaloper1… (ตรวจตัวสะกดหรือ checksum)',
    staked: 'ส่งคำสั่ง stake แล้ว โหนดรับธุรกรรมแล้ว',
    unstaked: 'ส่งคำสั่งถอน stake แล้ว เงินกลับเข้าบัญชีหลังพ้นช่วง unbonding',
    claimed: 'ส่งคำสั่งรับรางวัลแล้ว รางวัลเข้าบัญชีเมื่อธุรกรรมเข้าบล็อก',
    // quantum lock: accounts this wallet controls
    ownedTitle: 'บัญชีที่กระเป๋านี้ควบคุม',
    ownedHint: 'บัญชี ECDSA (เช่น MetaMask) ที่ล็อกควอนตัมให้กระเป๋านี้แล้ว กุญแจเดิมของบัญชีนั้นใช้ไม่ได้อีก กระเป๋านี้โอน โอนโทเคน และ stake แทนได้ (เซ็นด้วย ML-DSA-44 และจ่ายค่าธรรมเนียมจากกระเป๋านี้)',
    ownerLabel: 'ที่อยู่บัญชีที่ล็อกไว้ (0x… หรือ zetaphy1…)',
    ownerUse: 'ทำรายการในนามบัญชีนี้',
    actingAs: 'กำลังทำรายการในนามของ',
    ownerBalance: 'ยอดเงินของบัญชีนั้น',
    actingHint: 'โอน ZETAPHY โอนโทเคน และ stake ด้านล่างจะทำในนามบัญชีนี้ (as_owner) ค่าธรรมเนียมหักจากกระเป๋านี้',
    ownerStop: 'กลับไปใช้บัญชีของฉัน',
    ownedMine: 'ล็อกให้กระเป๋านี้',
    ownedNotMine: 'ไม่ได้ล็อกให้กระเป๋านี้ (หรือยังไม่เข้าบล็อก)',
    ownedOther: 'ล็อกให้บัญชีอื่น: {to}',
    asTag: 'ในนามของ {owner}',
    asNote: 'ทำในนามของ {owner} ซึ่งล็อกควอนตัมให้กระเป๋านี้ เงินและโทเคนออกจากบัญชีนั้น ค่าธรรมเนียมหักจากกระเป๋านี้',
    nowActing: 'จากนี้ทำรายการในนามของ {owner}',
    stopActing: 'กลับมาใช้บัญชีของคุณแล้ว',
    ownerNotLocked: 'บัญชีนี้ไม่ได้ล็อกควอนตัมให้กระเป๋านี้ จึงทำรายการแทนไม่ได้',
    ownerOther: 'บัญชีนี้ล็อกให้บัญชีอื่น ({to}) ไม่ใช่กระเป๋านี้',
    ownerSelf: 'นี่คือบัญชีของกระเป๋านี้เอง',
    ownerNotEnough: 'เงินในบัญชีนั้นไม่พอ: ต้องมี {need} ZETAPHY แต่มี {have}',
    // quantum lock from MetaMask
    mmTitle: 'ล็อกบัญชี MetaMask ให้กระเป๋านี้',
    mmIntro: 'ย้ายการควบคุมบัญชี ECDSA ใน MetaMask มาไว้ที่กระเป๋าต้านควอนตัมนี้ ที่อยู่ ยอดเงิน โทเคน และ stake ของบัญชีนั้นอยู่ที่เดิม แต่จากนี้ไปสั่งได้ผ่านกระเป๋านี้เท่านั้น',
    mmWarnPermanent: 'ถาวร ยกเลิกไม่ได้: หลังล็อก เชนจะปฏิเสธทุกธุรกรรมที่กุญแจ MetaMask ของบัญชีนั้นเซ็น และลายเซ็นของกุญแจนั้นใช้กับสัญญา (เช่น permit) ไม่ได้อีก',
    mmWarnSeed: 'ถ้า seed ของกระเป๋านี้หาย บัญชีที่ล็อกไว้ก็หายไปด้วย ดาวน์โหลดไฟล์สำรอง seed ก่อน',
    mmWarnTx: 'กระเป๋านี้ต้องเคยส่งธุรกรรมบนเชนแล้วอย่างน้อยหนึ่งครั้ง (ให้เชนรู้กุญแจสาธารณะ ML-DSA-44)',
    mmOk: 'เข้าใจแล้วว่าการล็อกเป็นแบบถาวร',
    mmLock: 'เชื่อม MetaMask แล้วล็อก',
    mmSentLabel: 'MetaMask ส่งคำสั่งล็อกแล้ว tx hash:',
    mmConfirm: 'ล็อกบัญชี MetaMask {owner} ให้กระเป๋านี้ ({me}) แบบถาวร?\n\nหลังจากนี้กุญแจ MetaMask ของบัญชีนั้นจะใช้กับ ZETAPHY ไม่ได้อีกเลย และถ้า seed ของกระเป๋านี้หาย บัญชีนั้นหายด้วย',
    mmMissing: 'ไม่พบ MetaMask (window.ethereum) ในเบราว์เซอร์นี้',
    mmDenied: 'MetaMask ไม่อนุญาตให้เชื่อมบัญชี',
    mmRejected: 'ยกเลิกใน MetaMask แล้ว ไม่ได้ส่งอะไร',
    mmWrongChain: 'MetaMask ไม่ได้อยู่บน ZETAPHY testnet (chain id {id}) สลับเครือข่ายใน MetaMask ก่อน',
    mmNeedTx: 'กระเป๋านี้ยังไม่เคยส่งธุรกรรม: ส่งธุรกรรมสักครั้งก่อน (เช่น โอนเข้าบัญชีตัวเอง) เชนจึงจะยอมให้เป็นผู้ควบคุม',
    mmSelfLocked: 'กระเป๋านี้ถูกล็อกให้บัญชีอื่นอยู่ จึงเป็นผู้ควบคุมไม่ได้',
    mmAlreadyLocked: 'บัญชี MetaMask นี้ล็อกให้ {to} ไปแล้ว',
    mmAlreadyMine: 'บัญชี MetaMask นี้ล็อกให้กระเป๋านี้อยู่แล้ว',
    mmCancelled: 'ยกเลิกแล้ว ไม่ได้ส่งอะไร',
    mmSent: 'MetaMask ส่งคำสั่งล็อกแล้ว เมื่อเข้าบล็อก บัญชีนั้นจะขึ้นในรายการด้านบน',
    mmWarnSeedSnap: 'ถ้า Secret Recovery Phrase ของ MetaMask หาย บัญชีที่ล็อกไว้ก็หายไปด้วย',
    // security core: Q-day and the threat gate's consent (docs/SECURITY-CORE.md)
    qdTitle: 'เตรียมพร้อมสำหรับ Q-day',
    qdIntro: 'Q-day คือวันที่เครือข่ายเลิกเชื่อลายเซ็น ECDSA (กุญแจแบบ MetaMask) เพราะคอมพิวเตอร์ควอนตัมอาจปลอมได้ หลังวันนั้นบัญชี ECDSA ที่ยังไม่ย้ายจะถูกแช่แข็ง (เงินยังอยู่ แต่ส่งธุรกรรมไม่ได้) วิธีที่ปลอดภัยที่สุดคือล็อกบัญชี MetaMask ให้กระเป๋านี้ล่วงหน้า (การ์ดด้านบน)',
    qdCheck: 'ตรวจบัญชี MetaMask ของฉัน',
    qdNone: 'Q-day: ยังไม่ได้กำหนด (เครือข่ายจะประกาศผ่านการโหวตล่วงหน้า)',
    qdScheduled: 'Q-day: บล็อก {h} (ตอนนี้บล็อก {now}) หลังจากนั้นธุรกรรมที่เซ็นด้วย ECDSA จะถูกปฏิเสธ',
    qdPassed: 'Q-day ผ่านไปแล้ว (บล็อก {h}): ธุรกรรมที่เซ็นด้วย ECDSA ถูกปฏิเสธ',
    qdOff: 'ระบบความปลอดภัยแกนกลางยังไม่เปิดบนโหนดนี้',
    qdPQ: '{acct}: เป็นบัญชี ML-DSA-44 อยู่แล้ว ไม่ต้องทำอะไร',
    qdMigrated: '{acct}: ย้ายแล้ว ผู้ควบคุมคือ {to}',
    qdPending: '{acct}: กำลังย้ายไป {to} เสร็จที่บล็อก {h}',
    qdExposed: '{acct}: ยังไม่ย้าย และกุญแจสาธารณะเคยถูกใช้บนเชนแล้ว ต้องล็อกก่อน Q-day (การ์ดด้านบน) ไม่อย่างนั้นบัญชีจะถูกแช่แข็ง',
    qdUnexposed: '{acct}: ยังไม่ย้าย แต่กุญแจไม่เคยถูกใช้บนเชน ล็อกตอนนี้ได้ (แนะนำ) หรือหลัง Q-day ย้ายด้วย commit–reveal ด้านล่างก็ได้',
    qdRecoverWarn: 'คำเตือน: ข้อความที่ MetaMask ให้เซ็นในสองขั้นนี้ มอบสิทธิ์ควบคุมบัญชี {acct} ให้ {ctrl} (บัญชี ML-DSA-44 ของกระเป๋านี้) ทั้งหมด ตรวจว่าที่อยู่ "New ML-DSA-44 controller" ในข้อความตรงกับ {ctrl} และเซ็นข้อความนี้เฉพาะในกระเป๋า ZETAPHY ทางการเท่านั้น เว็บอื่นที่ขอให้เซ็นข้อความ "ZETAPHY Q-day migration" อาจยึดบัญชีของคุณ',
    qdRecoverIntro: 'กู้บัญชีหลัง Q-day (เฉพาะกุญแจที่ไม่เคยใช้บนเชน): MetaMask เซ็นข้อความในเครื่องเท่านั้น ไม่ส่งธุรกรรม กระเป๋านี้ส่ง commitment (ขั้นที่ 1) รอ {d} บล็อก แล้ว reveal (ขั้นที่ 2) รออีก {d} บล็อกบัญชีจึงเป็นของกระเป๋านี้',
    qdCommit: 'ขั้นที่ 1: บันทึก commitment',
    qdReveal: 'ขั้นที่ 2: reveal',
    qdCommitted: 'บันทึก commitment แล้ว reveal ได้ตั้งแต่บล็อก {h}',
    qdAlready: 'commitment นี้บันทึกไว้แล้วที่บล็อก {h}: reveal ได้ตั้งแต่บล็อก {r}',
    qdNoCommit: 'ยังไม่มี commitment: ทำขั้นที่ 1 ก่อน',
    qdTooEarly: 'ยังเร็วไป: reveal ได้ตั้งแต่บล็อก {h} (ตอนนี้ {now})',
    qdNotYet: 'การ reveal เปิดหลัง Q-day เท่านั้น ก่อน Q-day ให้ล็อกบัญชีจาก MetaMask (การ์ดด้านบน)',
    qdRevealed: 'reveal แล้ว: บัญชีจะเป็นของกระเป๋านี้เมื่อถึงบล็อกที่กำหนด',
    qdCannot: 'บัญชีนี้ใช้ commit–reveal ไม่ได้ (ย้ายแล้ว หรือกุญแจเคยถูกใช้บนเชน)',
    csTitle: 'ยินยอมเรียกสัญญาที่ติดธง',
    csIntro: 'ถ้าเปิด threat gate ไว้ เครือข่ายจะไม่ส่งธุรกรรมไปหาสัญญาที่ Neuro ติดธงแบบบังคับใช้ เว้นแต่เจ้าของบัญชียินยอมเอง (ธุรกรรมเดียว นานสุด 1 วัน) นี่คือการขอความยินยอม ไม่ใช่การเซ็นเซอร์: คุณยังไปต่อได้ แต่ควรอ่านเหตุผลของธงก่อน',
    csTarget: 'สัญญา (0x…)',
    csSeconds: 'นานเท่าไร',
    csOk: 'ฉันอ่านเหตุผลของธงแล้วและยอมรับความเสี่ยงเอง',
    csSend: 'ส่งความยินยอมจากกระเป๋านี้',
    csSendMM: 'ส่งความยินยอมจาก MetaMask',
    csSent: 'ส่งความยินยอมแล้ว tx hash:',
    csBad: 'ใส่ที่อยู่สัญญา 0x ตามด้วย hex 40 ตัว',
    threatConsented: 'คำเตือน: {addr} ติดธงแบบบังคับใช้ ({what} · เหตุผล: {reason}) แต่คุณให้ความยินยอมไว้แล้ว จึงส่งได้ · {details}',
    // MetaMask Snap mode
    snapTitle: 'ใช้ MetaMask (ZETAPHY Snap)',
    snapIntro: 'กุญแจ ML-DSA-44 สร้างใน MetaMask จาก Secret Recovery Phrase ของคุณ หน้านี้ไม่เห็นกุญแจเลย และ MetaMask แสดงทุกธุรกรรมเป็นคำอ่านง่ายให้ยืนยันก่อนเซ็น',
    snapFlask: 'ระหว่างที่ snap ยังไม่ได้เผยแพร่และยังไม่ผ่านการตรวจของ MetaMask จะติดตั้งได้เฉพาะใน MetaMask Flask (รุ่นสำหรับนักพัฒนา)',
    snapIdLabel: 'snap ID (npm:@zetaphy/snap หรือ local:http://localhost:8080 ตอนพัฒนา)',
    snapIdHint: 'บัญชีขึ้นกับ snap ID: snap ตัวเดียวกันให้บัญชีเดิมเสมอ (กู้คืนได้ด้วย Secret Recovery Phrase) แต่ snap แบบ local:… ให้บัญชีอื่น',
    snapConnect: 'เชื่อม MetaMask',
    snapConnected: 'เชื่อม MetaMask (ZETAPHY Snap) แล้ว',
    snapMode: 'กุญแจอยู่ใน MetaMask (ZETAPHY Snap) ไม่ใช่ในหน้านี้ สำรองด้วย Secret Recovery Phrase ของ MetaMask',
    snapDisconnect: 'เลิกใช้ MetaMask ในหน้านี้',
    snapDisconnected: 'เลิกใช้ MetaMask ในหน้านี้แล้ว (snap ยังติดตั้งอยู่ใน MetaMask)',
    snapBadId: 'snap ID ต้องเป็น npm:ชื่อแพ็กเกจ หรือ local:http://localhost:พอร์ต',
    snapDenied: 'MetaMask ไม่ได้ติดตั้งหรือไม่อนุญาต snap',
    snapUnsupported: 'MetaMask นี้ใช้ snap ไม่ได้ (ใช้ MetaMask Flask หรือรุ่นที่รองรับ snap)',
    snapBadAccount: 'snap ตอบบัญชีที่ไม่ตรงกับกุญแจสาธารณะของมัน จึงไม่ใช้',
    snapConfirm: 'ตรวจรายละเอียดและยืนยันในหน้าต่างของ MetaMask…',
    snapRejected: 'ยกเลิกใน MetaMask แล้ว ไม่ได้เซ็นและไม่ได้ส่งอะไร',
    snapMismatch: 'snap เซ็นธุรกรรมที่ไม่ตรงกับที่ขอ จึงไม่ได้ส่ง',
    // deploy
    deployTitle: 'สร้างสัญญา (deploy)',
    initCodeLabel: 'bytecode สำหรับสร้างสัญญา (hex รวม constructor arguments)',
    deployConfirmTitle: 'ยืนยันการสร้างสัญญา',
    cCodeSize: 'ขนาดโค้ด',
    cCodeHash: 'hash ของโค้ด (keccak-256)',
    bytesN: '{n} ไบต์',
    deployChecked: 'จำลองการสร้างกับโหนดแล้ว ผ่าน (จะจำลองซ้ำอีกครั้งก่อนเซ็น) เทียบ hash ของโค้ดกับที่ผู้เขียนสัญญาประกาศไว้ การสร้างสัญญาไม่มีปลายทาง จึงไม่ได้ตรวจกับ ThreatRegistry',
    deployedAt: 'ที่อยู่สัญญาใหม่:',
    badInitCode: 'bytecode ต้องเป็น hex (0x…) ที่ไม่ว่าง',
    deploySent: 'ส่งแล้ว โหนดรับธุรกรรมแล้ว สัญญาจะมีเมื่อธุรกรรมเข้าบล็อก',
    // other wallets
    walletsTitle: 'ใช้ ZETAPHY กับกระเป๋าอื่น',
    walletsIntro: 'เพิ่มเครือข่าย ZETAPHY Testnet ในกระเป๋าที่คุณใช้อยู่ (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap ฯลฯ) ด้วยปุ่มด้านล่าง หรือใส่ค่าเอง ทุกค่ามาจากที่อยู่ RPC ด้านบน',
    evmWalletsTitle: 'กระเป๋า EVM ในเบราว์เซอร์นี้',
    evmNone: 'ไม่พบกระเป๋า EVM ในเบราว์เซอร์นี้ ติดตั้งส่วนขยาย (MetaMask, Rabby, Trust, OKX, Coinbase Wallet ฯลฯ) หรือบนมือถือ เปิดหน้านี้ในเบราว์เซอร์ของแอปกระเป๋า',
    evmAdd: 'เพิ่ม ZETAPHY ในกระเป๋านี้',
    evmConnect: 'เชื่อมกระเป๋านี้',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (กระเป๋าบนมือถือที่เปิดหน้านี้จากเบราว์เซอร์อื่น เช่น Binance Wallet) ยังปิดอยู่: ต้องใส่ projectId ของ Reown ก่อน',
    wcOn: 'มี projectId แล้ว แต่หน้านี้ยังไม่มีโค้ด WalletConnect (เป็นขั้นต่อไป)',
    wcNotYet: 'หน้านี้ยังไม่มี WalletConnect (เป็นขั้นต่อไป) ระหว่างนี้บนมือถือให้เปิดหน้านี้ในเบราว์เซอร์ของแอปกระเป๋า',
    wcIdLabel: 'WalletConnect projectId (จาก Reown, hex 32 ตัว)',
    wcIdHint: 'สมัครฟรีที่ cloud.reown.com ใส่ที่นี่ (จำไว้ในเบราว์เซอร์นี้) หรือใส่ใน meta zetaphy-walletconnect-project-id ของ index.html ให้ทุกคน',
    wcSaved: 'บันทึก projectId แล้ว',
    wcBadId: 'projectId ต้องเป็น hex 32 ตัว',
    manualTitle: 'เพิ่มเครือข่ายเอง: ค่าที่ต้องใส่ในกระเป๋า',
    mNetwork: 'ชื่อเครือข่าย',
    mRpc: 'RPC URL',
    mChainId: 'Chain ID',
    mSymbol: 'สัญลักษณ์เหรียญ',
    mDecimals: 'ทศนิยม',
    mExplorer: 'Block explorer',
    mNone: 'ไม่มี (เว้นว่าง)',
    mRpcUnset: '(ใส่ที่อยู่ RPC แบบ https ด้านบนก่อน)',
    mSymbolNote: '{sym} คือ ZETAPHY: MetaMask และ chainlist รับสัญลักษณ์ได้ไม่เกิน 6 ตัวอักษร กระเป๋า EVM จึงแสดงยอดเป็น {sym} ไม่ต้อง import โทเคนที่ {precompile} เพราะเป็นเหรียญเดียวกัน (จะเห็นยอดซ้ำ)',
    cosmosTitle: 'กระเป๋า Cosmos (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'ได้ที่อยู่ zetaphy1… ของบัญชีเดียวกับในกระเป๋า EVM (กุญแจ eth_secp256k1, coin type 60) ต้องใช้ที่อยู่ https ของโหนดที่มี /rpc และ /rest (โหนดที่ติดตั้งด้วย setup-node.sh มีให้แล้ว)',
    keplrAdd: 'เพิ่มใน Keplr',
    leapAdd: 'เพิ่มใน Leap',
    cosmostationAdd: 'เพิ่มใน Cosmostation',
    supportTitle: 'กระเป๋าไหนใช้ได้บ้าง',
    supWorks: 'ใช้ได้เลย (เพิ่มเครือข่ายเองได้): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame และ Ledger/Trezor ผ่านกระเป๋าเหล่านี้ ส่วน Keplr, Leap, Cosmostation ใช้ปุ่มด้านบน',
    supMaybe: 'อาจใช้ได้ (ยังไม่ได้ยืนยัน): Binance Wallet ในแอป Binance ถ้ากระเป๋ายอมรับเครือข่ายใหม่ นอกแอปต้องใช้ WalletConnect',
    supNot: 'ยังใช้ไม่ได้จนกว่ากระเป๋าจะรองรับ ZETAPHY เอง: Phantom และกระเป๋าที่มีรายชื่อเชนตายตัว',
    supNever: 'ใช้ไม่ได้เลย: กระเป๋าที่มีแต่ Solana หรือ Bitcoin เพราะไม่ใช่กระเป๋า EVM หรือ Cosmos',
    supPq: 'ต้านควอนตัม: เฉพาะกุญแจ ML-DSA-44 ของหน้านี้และ ZETAPHY Snap กระเป๋าอื่นทั้งหมดเซ็นด้วย ECDSA (secp256k1) ซึ่งคอมพิวเตอร์ควอนตัมที่ใหญ่พอถอดได้ ป้องกันได้ด้วยการล็อกบัญชีนั้นให้กระเป๋านี้',
    usingWallet: 'กระเป๋าที่ใช้: {name}',
    usingNone: 'ยังไม่พบกระเป๋า EVM ในเบราว์เซอร์นี้',
    changeWallet: 'เลือกกระเป๋าอื่น',
    inApp: 'หน้านี้เปิดอยู่ในเบราว์เซอร์ของแอป {name} ใช้ปุ่มด้านล่างได้เลย',
    mobileNoWallet: 'บนมือถือ: เปิดหน้านี้ในเบราว์เซอร์ของแอปกระเป๋า (กดลิงก์ด้านล่าง หรือคัดลอกที่อยู่หน้านี้ไปวางในแท็บ Browser ของแอป)',
    phantomNote: 'Phantom ไม่ให้เพิ่มเครือข่ายเอง รองรับเฉพาะเชนที่ Phantom เลือกไว้ จึงใช้กับ ZETAPHY ไม่ได้จนกว่า Phantom จะเพิ่มให้ ใช้กระเป๋าอื่นแทน (MetaMask, Rabby, Trust, OKX, Coinbase)',
    binanceNote: 'Binance Wallet อาจยังไม่รับเครือข่ายใหม่ ถ้าเพิ่มไม่ได้ ให้ใส่ค่าด้านล่างเองหรือใช้กระเป๋าอื่น',
    evmMissing: 'ไม่พบกระเป๋า EVM ในเบราว์เซอร์นี้',
    evmRejected: 'ยกเลิกในกระเป๋าแล้ว',
    evmDenied: 'กระเป๋าไม่อนุญาตให้เชื่อมบัญชี',
    chainNeedHttps: 'กระเป๋ารับเฉพาะ RPC แบบ https (หรือ localhost) ใส่ที่อยู่ https ของโหนดด้านบน เช่น https://1-2-3-4.sslip.io',
    chainAdding: 'ยืนยันการเพิ่ม ZETAPHY Testnet ในหน้าต่างของ {name}…',
    chainAdded: 'เพิ่ม ZETAPHY Testnet ใน {name} และสลับไปใช้แล้ว',
    chainAddedNoSwitch: 'เพิ่ม ZETAPHY Testnet ใน {name} แล้ว แต่ยังไม่ได้สลับ เลือกเครือข่ายเองในกระเป๋า',
    addChainUnsupported: '{name} ไม่ได้เพิ่มเครือข่าย ({why}) กระเป๋านี้อาจยังไม่รับเครือข่ายใหม่ ใส่ค่าที่แสดงด้านล่างเองในกระเป๋า หรือใช้กระเป๋าอื่น',
    evmConnected: 'เชื่อม {name} แล้ว',
    evmOnZetaphy: 'อยู่บน ZETAPHY Testnet',
    evmOtherChain: 'อยู่บนเครือข่ายอื่น (chain id {id}): กด "เพิ่ม ZETAPHY ในกระเป๋านี้"',
    evmBalance: 'ยอดเงิน {amount} ZETAPHY',
    cosmosMissing: 'ไม่พบ {name} ในเบราว์เซอร์นี้',
    cosmosAdding: 'ยืนยันในหน้าต่างของ {name}…',
    cosmosRejected: '{name} ไม่ได้เพิ่มเครือข่าย ({why})',
    cosmosAdded: 'เพิ่ม ZETAPHY Testnet ใน {name} แล้ว ที่อยู่ของคุณอยู่ด้านล่าง',
    cosmosBadAddress: 'กระเป๋าตอบที่อยู่ที่ไม่ใช่ zetaphy1… จึงไม่ใช้',
    walletPicked: 'เลือก {name} แล้ว',
    snapNotMetaMask: '{name} ใช้ MetaMask Snap ไม่ได้ เลือก MetaMask (หรือ MetaMask Flask) ในส่วน "ใช้ ZETAPHY กับกระเป๋าอื่น" ด้านล่าง',
    // vaccine: ThreatRegistry
    threatLabel: 'ThreatRegistry (ระบบภูมิคุ้มกัน: ไม่เซ็นธุรกรรมไปหาโค้ดที่ติดธง)',
    threatHint: 'ที่อยู่ 0x… ของ ThreatRegistry บน ZETAPHY (จำไว้ในเบราว์เซอร์นี้) หรือใส่ใน meta zetaphy-threat-registry ของ index.html ให้ทุกคน เว้นว่าง = ใช้ค่าใน meta',
    threatSaved: 'บันทึกที่อยู่ ThreatRegistry แล้ว',
    threatBadAddress: 'ที่อยู่ ThreatRegistry ต้องเป็น 0x ตามด้วย hex 40 ตัว',
    threatFlagged: 'ไม่เซ็น: {addr} ติดธงในระบบภูมิคุ้มกันของ ZETAPHY ({what} · เหตุผล: {reason}) กระเป๋านี้ไม่ส่งธุรกรรมไปหาโค้ดที่ธงบังคับใช้แล้ว เว้นแต่คุณยินยอมก่อน (การ์ด "ยินยอมเรียกสัญญาที่ติดธง") · {details}',
    threatUnchecked: 'ไม่เซ็น: ตรวจ {addr} กับ ThreatRegistry {reg} ไม่ได้ เมื่อตั้ง ThreatRegistry แล้ว ตรวจไม่ได้ = ไม่ส่ง',
    threatUnset: 'ยังไม่ได้ตรวจโค้ดปลายทาง: ยังไม่ได้ตั้งที่อยู่ ThreatRegistry (ตั้งค่าเพิ่มเติม ใต้ช่อง RPC)',
    threatClean: 'ตรวจกับ ThreatRegistry แล้ว: ปลายทางไม่ติดธง (ตรวจแบบดีที่สุดเท่าที่ทำได้: ที่อยู่ โค้ด และโค้ดจริงหลัง proxy แบบ EIP-1967 / beacon / EIP-1167 ตรวจซ้ำอีกครั้งก่อนเซ็น)',
    threatWarned: 'คำเตือน: {addr} ถูกนักรัน Neuro ติดธงแล้ว ({what} · เหตุผล: {reason}) แต่ธงยังไม่บังคับใช้ (ช่วงที่ governance ตรวจทานได้) กระเป๋าจะปฏิเสธเมื่อธงบังคับใช้ (ธงที่นักรันเสียงข้างมากพิเศษหรือ governance ส่งเข้าช่องทางด่วน บังคับใช้ทันที) ส่งตอนนี้หรือไม่เป็นการตัดสินใจของคุณ · {details}',
    threatNewWarning: 'ไม่เซ็น: {addr} ถูกติดธงหลังจากที่คุณตรวจ ({what} · เหตุผล: {reason}) กดตรวจอีกครั้งเพื่อดูคำเตือน · {details}',
    threatBehind: '{impl} (โค้ดจริงหลัง proxy {proxy})',
    threatWhatFingerprint: 'ลายนิ้วมือโค้ด (fp1) ตรงกับโค้ดที่ติดธง',
    threatWhatCode: 'โค้ดตรงกับโค้ดที่ติดธงทุกไบต์',
    threatWhatAddress: 'ที่อยู่นี้ติดธง',
    // ThreatRegistry.Reason: code facts (zetaphy-network/src/vaccine.js REASON_TEXT), never intent
    ...Object.fromEntries(REASON_TEXT.map((r, i) => [`reason${i}`, r.th]).slice(1)),
    threatEvidence: 'หลักฐาน: reportHash {hash}{uri} · ' + REPRODUCE.th,
    threatNoEvidence: 'หลักฐาน: ไม่มีบันทึกไว้',
    threatEvidenceUnread: 'หลักฐาน: อ่านไม่ได้',
    threatResponse: 'คำชี้แจงจาก {by}: "{text}"',
    threatResponseAssigned: 'คำชี้แจงจากผู้ชี้แจงที่ governance แต่งตั้ง ({by}): "{text}"',
    threatNoResponse: 'ยังไม่มีคำชี้แจง',
    threatDisclaimer: DISCLAIMER.th,
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'เคล็ดลับ: คำสุ่มที่ไม่เกี่ยวกัน 4–5 คำ ทำเป็นรหัสผ่านที่ทั้งแข็งแรงและจำง่าย',
    passWeak: 'รหัสผ่านนี้เดาง่ายเกินไป (ระดับ {label}) ต้องได้ระดับ "แข็งแรง" ขึ้นไป',
    pwStrength: 'ความแข็งแรง: {label}',
    pwVeryWeak: 'อ่อนมาก',
    pwWeak: 'อ่อน',
    pwFair: 'พอใช้',
    pwStrong: 'แข็งแรง',
    pwVeryStrong: 'แข็งแรงมาก',
    pwLength: 'ใช้อย่างน้อย {n} ตัวอักษร ยิ่งยาวยิ่งดี',
    pwCommon: 'เป็นรหัสผ่านที่คนใช้กันมากที่สุดตัวหนึ่ง',
    pwDictionary: 'มีรหัสผ่านหรือคำที่คนใช้กันบ่อยอยู่ข้างใน',
    pwSequence: 'มีลำดับอย่าง abc, 321 หรือ qwerty',
    pwRepeat: 'มีตัวอักษรหรือรูปแบบซ้ำกัน',
    pwContext: 'มีคำว่า "zetaphy", "wallet" หรือส่วนหนึ่งของที่อยู่กระเป๋าคุณ',
    pwYear: 'มีปี ค.ศ. อยู่ข้างใน',
    pwVariety: 'เพิ่มคำ หรือผสมตัวพิมพ์ใหญ่ ตัวพิมพ์เล็ก ตัวเลข และสัญลักษณ์',
    weakNudge: 'รหัสผ่านของคุณอ่อน (ระดับ {label}) ใครที่คัดลอกข้อมูลของเบราว์เซอร์นี้ไปได้อาจเดาได้ ควรเปลี่ยนเป็นรหัสที่แข็งแรงกว่านี้',
    weakNudgeGo: 'เปลี่ยนตอนนี้',
    secTitle: 'ความปลอดภัย',
    autoLockLabel: 'ล็อกอัตโนมัติเมื่อไม่มีการใช้งาน หรืออยู่ในแท็บเบื้องหลัง นานเท่านี้',
    nMinutes: '{n} นาที',
    autoLockIn: 'ล็อกอัตโนมัติใน {time} ถ้าไม่มีการใช้งาน',
    autoLocked: 'ล็อกอัตโนมัติแล้ว เพราะไม่มีการใช้งาน {n} นาที ลบกุญแจออกจากหน่วยความจำแล้ว',
    autoLockSaved: 'ตั้งล็อกอัตโนมัติเป็น {n} นาทีแล้ว',
    lockedErr: 'กระเป๋าถูกล็อกอยู่ ปลดล็อกก่อน ยังไม่ได้เซ็นอะไร',
    chpwTitle: 'เปลี่ยนรหัสผ่าน',
    chpwOld: 'รหัสผ่านปัจจุบัน',
    chpwNew: 'รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร ระดับ "แข็งแรง" ขึ้นไป)',
    chpwSave: 'เปลี่ยนรหัสผ่าน',
    chpwDone: 'เปลี่ยนรหัสผ่านแล้ว',
    pkTitle: 'ปลดล็อกด้วยลายนิ้วมือ / Face ID (passkey)',
    pkIntro: 'สร้าง passkey ของเว็บนี้ในอุปกรณ์นี้ ความลับ PRF ของมันจะออกมาก็ต่อเมื่อสแกนนิ้ว ใบหน้า หรือใส่ PIN ของเครื่อง แล้วใช้เข้ารหัสสำเนาที่สองของ seed ในเบราว์เซอร์นี้ รหัสผ่านยังใช้ได้เป็นทางสำรอง',
    pkSyncNote: 'passkey อาจซิงก์ผ่าน iCloud Keychain, Google Password Manager หรือโปรแกรมจัดการ passkey อื่น จึงอาจมี passkey นี้อยู่ในอุปกรณ์อื่นของคุณด้วย ดูแลบัญชีนั้นให้ดี',
    pkEnable: 'เปิดการปลดล็อกด้วยลายนิ้วมือ / Face ID',
    pkDisable: 'ปิดการปลดล็อกด้วยลายนิ้วมือ / Face ID',
    pkUnlock: 'ปลดล็อกด้วยลายนิ้วมือ / Face ID',
    pkOn: 'เปิดการปลดล็อกด้วยลายนิ้วมือ / Face ID อยู่ รหัสผ่านยังใช้ได้',
    pkOff: 'ปิดการปลดล็อกด้วยลายนิ้วมือ / Face ID อยู่',
    pkOtherSite: 'passkey นี้สร้างไว้สำหรับ {host} ที่นี่ให้ใช้รหัสผ่าน',
    pkUnsupported: 'เบราว์เซอร์นี้ใช้ passkey ในหน้านี้ไม่ได้ ใช้รหัสผ่านต่อไป',
    pkNoPlatform: 'ไม่พบตัวยืนยันตัวตนด้วยลายนิ้วมือ ใบหน้า หรือ PIN ในอุปกรณ์นี้ ใช้รหัสผ่านต่อไป',
    pkNoPrf: 'เบราว์เซอร์หรือโปรแกรมจัดการ passkey นี้ไม่รองรับส่วนขยาย PRF ที่ต้องใช้ จึงปลดล็อกกระเป๋าด้วย passkey ที่นี่ไม่ได้ ใช้รหัสผ่านต่อไป',
    pkCancelled: 'ยกเลิกหรือหมดเวลา ไม่มีอะไรเปลี่ยน',
    pkFailed: 'passkey ปลดล็อกกระเป๋านี้ไม่ได้ ใช้รหัสผ่านแทน',
    pkWorking: 'รอสแกนลายนิ้วมือ / Face ID…',
    pkEnabled: 'สร้าง passkey แล้ว ปลดล็อกด้วยลายนิ้วมือ / Face ID ได้แล้ว รหัสผ่านยังใช้ได้',
    pkDisabled: 'ปิดการปลดล็อกด้วย passkey และลบสำเนาที่เข้ารหัสแล้ว ลบ passkey "ZETAPHY PQ Wallet" ในการตั้งค่า passkey ของเครื่องได้ด้วย',
    pkDisableConfirm: 'ปิดการปลดล็อกด้วยลายนิ้วมือ / Face ID? หลังจากนี้ปลดล็อกได้ด้วยรหัสผ่านเท่านั้น',
    bigTitle: 'ยอดเงินสูง: ควรเก็บกุญแจไว้ในที่ที่ปลอดภัยกว่านี้',
    bigLocal: 'บัญชีนี้มี {amount} ZETAPHY กุญแจในหน้าเว็บปลอดภัยได้เท่ากับเบราว์เซอร์และคอมพิวเตอร์เครื่องนี้เท่านั้น ถ้ายอดสูง ควรย้ายเงินไปที่ ZETAPHY Snap ซึ่งกุญแจอยู่ใน MetaMask',
    bigEvm: 'บัญชี EVM ที่เชื่อมอยู่มี {amount} ZETAPHY ถ้ายอดสูง ควรใช้ฮาร์ดแวร์วอลเล็ต (Ledger หรือ Trezor) ผ่าน MetaMask หรือ Rabby',
    bigHow: 'วิธีทำ',
    bigLater: 'ซ่อนไว้ 7 วัน',
    helpOpen: 'เก็บเงินจำนวนมากให้ปลอดภัย',
    helpTitle: 'เก็บเงินจำนวนมากให้ปลอดภัย',
    helpIntro: 'กุญแจในหน้าเว็บปลอดภัยได้เท่ากับเบราว์เซอร์และคอมพิวเตอร์ที่ใช้เท่านั้น ส่วนขยายที่ไม่ดีหรือมัลแวร์อ่านกุญแจได้ขณะกระเป๋าปลดล็อกอยู่ เก็บไว้ที่นี่แค่จำนวนน้อย',
    helpSnapTitle: 'บัญชี PQ แบบเนทีฟ: ย้ายไป ZETAPHY Snap (กุญแจอยู่ใน MetaMask)',
    helpSnap1: 'ติดตั้ง MetaMask (ใช้ MetaMask Flask จนกว่า snap จะเผยแพร่) และสำรอง Secret Recovery Phrase ของมันไว้',
    helpSnap2: 'ล็อกกระเป๋านี้ แล้วกด "เชื่อม MetaMask" และอนุมัติ ZETAPHY Snap',
    helpSnap3: 'คัดลอกที่อยู่ zetaphy1… ที่แสดง นั่นคือบัญชีใหม่ที่สร้างใน MetaMask',
    helpSnap4: 'ปลดล็อกกระเป๋านี้อีกครั้งด้วยรหัสผ่าน แล้วโอนเงินไปที่อยู่นั้น ตรวจที่อยู่ในหน้าต่างของ MetaMask ด้วย',
    helpHwTitle: 'บัญชี EVM: ฮาร์ดแวร์วอลเล็ต',
    helpHw1: 'เชื่อม Ledger หรือ Trezor กับ MetaMask หรือ Rabby (เพิ่มบัญชีฮาร์ดแวร์วอลเล็ตในนั้น)',
    helpHw2: 'เพิ่มเครือข่าย ZETAPHY Testnet ด้วยปุ่มในส่วน "ใช้ ZETAPHY กับกระเป๋าอื่น" ของหน้านี้',
    helpHw3: 'โอนเงินไปที่อยู่ 0x… ของบัญชีฮาร์ดแวร์ และยืนยันทุกธุรกรรมบนหน้าจอของอุปกรณ์เอง',
    helpMore: 'รายละเอียดอยู่ในส่วนความปลอดภัยของ README นี่คือ testnet ไม่ใช่เงินจริง',
    helpClose: 'ปิด',
  },
  en: {
    subtitle: 'Quantum-safe wallet (ML-DSA-44) · no ECDSA key',
    warnTitle: 'Testnet only',
    warnTestnet: 'ZETAPHY testnet is not real money. Do not put anything of value here.',
    warnSeed: 'The seed is the only key to this wallet. Lose it or forget the passphrase and the funds are gone for good. Nobody can recover them.',
    warnLocal: 'The seed stays in this browser only, encrypted with your passphrase, and is never sent anywhere.',
    rpcLabel: 'Your ZETAPHY node RPC URL (JSON-RPC, port 8545)',
    rpcSave: 'Save',
    rpcHint: 'If this page is opened over https, the RPC must be https too (browsers block http).',
    setupTitle: 'Get started',
    modeNew: 'Create a new key',
    modeImport: 'Import a seed',
    seedLabel: 'Seed (64 hex digits, 0x optional)',
    pass1: 'Choose a passphrase (at least 12 characters, rated Strong)',
    pass2: 'Type the passphrase again',
    saveKey: 'Create wallet',
    lockedTitle: 'Wallet locked',
    unlockLabel: 'Passphrase',
    unlock: 'Unlock',
    forget: 'Remove the wallet from this browser',
    accountTitle: 'Your account',
    sameAccount: 'Both are the same account. It can receive funds at either.',
    copy: 'Copy',
    balance: 'Balance',
    refresh: 'Refresh',
    sendTitle: 'Send ZETAPHY',
    toLabel: 'To (0x… or zetaphy1…)',
    amountLabel: 'Amount (ZETAPHY)',
    advanced: 'More settings',
    gasLabel: 'Gas limit',
    review: 'Review',
    confirmTitle: 'Confirm the transfer',
    cTo: 'To',
    cAmount: 'Amount',
    cFee: 'Max fee',
    cTotal: 'Total',
    confirmSend: 'Confirm, sign with ML-DSA and send',
    cancel: 'Cancel',
    txSent: 'Sent. tx hash:',
    backupTitle: 'Back up the seed',
    backupWarn: 'The backup file is the seed in plain form. Anyone who gets it can move the funds. Keep it offline and safe, and never share it.',
    backupOk: 'I understand',
    backup: 'Download seed backup',
    backupCli: 'The file works as ~/.zetaphy/pq.seed for the zetaphy pq native command.',
    lock: 'Lock wallet',
    footer: 'All code is in this page; no scripts from elsewhere · Transactions are signed with ML-DSA-44 (FIPS 204) in the browser, or in MetaMask with the ZETAPHY Snap',
    working: 'Working…',
    deriving: 'Encrypting the seed (takes a moment)…',
    created: 'Wallet created. Download the seed backup before receiving funds.',
    imported: 'Seed imported.',
    unlocked: 'Unlocked.',
    lockedMsg: 'Locked.',
    badPass: 'Wrong passphrase.',
    passShort: 'The passphrase must be at least {n} characters.',
    passMismatch: 'The two passphrases differ.',
    badSeed: 'The seed must be 64 hex digits.',
    storeFailed: 'This browser cannot save data (private mode?). The wallet disappears when the page closes: download the backup.',
    rpcSaved: 'RPC saved.',
    needRpc: 'Enter your node RPC URL first.',
    badRpc: 'The RPC URL must start with http:// or https://',
    wrongChain: 'That RPC is not ZETAPHY testnet (chain id {id}).',
    rpcDown: 'Cannot reach the RPC (down, CORS not allowed, or http on an https page).',
    notFunded: 'The account is not on chain yet: send ZETAPHY to this address first, then it can send.',
    onChain: 'On chain (account {n}, {s} txs sent).',
    badAddress: 'Invalid recipient address (check spelling or checksum).',
    badAmount: 'Invalid amount.',
    badGas: 'Gas limit must be a whole number above 0.',
    notEnough: 'Not enough: need {need} ZETAPHY (with fee), have {have}.',
    signing: 'Signing with ML-DSA-44 and sending…',
    sent: 'Sent. The node accepted it; it lands in a block within seconds.',
    rejected: 'The node rejected the transaction',
    copied: 'Copied.',
    forgetConfirm: 'Remove the wallet from this browser? Without a seed backup the funds are lost for good.',
    forgotten: 'Wallet removed from this browser.',
    backupDone: 'Backup downloaded. Keep it offline.',
    tokenTitle: 'ERC-20 tokens',
    tokenLabel: 'Token contract address (0x…)',
    tokenLoad: 'Look up',
    tokenBalance: 'Token balance',
    tokenMeta: '{sym} · {d} decimals · contract {addr}',
    tokenAmountLabel: 'Amount of the token',
    evmGasLabel: 'EVM gas limit (the fee is for this gas plus the tx itself)',
    tokenConfirmTitle: 'Confirm the token transfer',
    cToken: 'Token',
    tokenChecked: 'Simulated on the node: it succeeds (it is simulated again just before signing).',
    tokenNote: 'The fee is paid in ZETAPHY. If the contract reverts, the whole tx fails and the fee is still paid, so this page simulates every transfer before signing.',
    badToken: 'The token contract must be 0x and 40 hex digits (check the checksum).',
    noContract: 'There is no contract at {addr}.',
    notToken: 'That contract is not an ERC-20 token (no decimals()).',
    tokenDecimals: 'The amount has more than {d} decimal places for {sym}.',
    badEvmGas: 'The EVM gas limit must be a whole number from {min} to {max}.',
    tokenNotEnough: 'Not enough of the token: sending {need} {sym}, have {have}.',
    callFails: 'Not sent: simulated on the node, the transfer would fail (revert)',
    tokenRefused: 'Not sent: the token refused the transfer (transfer returned false).',
    tokenSent: 'Sent. The node accepted it. (It is a Cosmos tx, so its EVM logs are not in eth_getLogs; balances are correct.)',
    stakeTitle: 'Stake ZETAPHY',
    validatorLabel: 'Validator (zetaphyvaloper1…)',
    stakeAmountLabel: 'Amount (ZETAPHY), not needed to claim rewards',
    stake: 'Stake',
    unstake: 'Unstake',
    claim: 'Claim rewards',
    confirmStake: 'Confirm the stake',
    confirmUnstake: 'Confirm the unstake',
    confirmClaim: 'Confirm claiming rewards',
    cValidator: 'Validator',
    unbondNote: 'Unstaked ZETAPHY comes back after the chain\'s unbonding period. Until then it cannot be used and earns no rewards.',
    badValidator: 'The validator must be a zetaphyvaloper1… address (check spelling or checksum).',
    staked: 'Stake sent. The node accepted it.',
    unstaked: 'Unstake sent. The ZETAPHY comes back after the unbonding period.',
    claimed: 'Claim sent. The rewards arrive when the tx lands in a block.',
    ownedTitle: 'Accounts this wallet controls',
    ownedHint: 'ECDSA accounts (e.g. MetaMask) quantum-locked to this wallet. Their own keys no longer work; this wallet sends, sends tokens and stakes for them (signed with ML-DSA-44, fees paid by this wallet).',
    ownerLabel: 'Locked account address (0x… or zetaphy1…)',
    ownerUse: 'Act as this account',
    actingAs: 'Acting as',
    ownerBalance: 'Its balance',
    actingHint: 'Send, token transfers and staking below act for this account (as_owner). Fees come from this wallet.',
    ownerStop: 'Back to my account',
    ownedMine: 'locked to this wallet',
    ownedNotMine: 'not locked to this wallet (or not in a block yet)',
    ownedOther: 'locked to another account: {to}',
    asTag: 'For {owner}',
    asNote: 'For {owner}, which is quantum-locked to this wallet: funds and tokens leave that account; the fee is paid by this wallet.',
    nowActing: 'Now acting as {owner}.',
    stopActing: 'Back to your own account.',
    ownerNotLocked: 'That account is not quantum-locked to this wallet, so this wallet cannot act for it.',
    ownerOther: 'That account is locked to another account ({to}), not to this wallet.',
    ownerSelf: 'That is this wallet\'s own account.',
    ownerNotEnough: 'That account does not have enough: needs {need} ZETAPHY, has {have}.',
    mmTitle: 'Lock a MetaMask account to this wallet',
    mmIntro: 'Hand control of an ECDSA account in MetaMask to this quantum-safe wallet. Its address, balance, tokens and stake stay where they are, but from now on only this wallet can move them.',
    mmWarnPermanent: 'Permanent, no undo: after the lock the chain refuses every transaction that account\'s MetaMask key signs, and contracts no longer accept its signatures (e.g. permits).',
    mmWarnSeed: 'If you lose this wallet\'s seed, the locked account is lost too. Download the seed backup first.',
    mmWarnTx: 'This wallet must have sent at least one transaction on chain (so the chain knows its ML-DSA-44 public key).',
    mmOk: 'I understand the lock is permanent',
    mmLock: 'Connect MetaMask and lock',
    mmSentLabel: 'MetaMask sent the lock. tx hash:',
    mmConfirm: 'Lock the MetaMask account {owner} to this wallet ({me}) for good?\n\nIts MetaMask key will never work on ZETAPHY again, and if this wallet\'s seed is lost, so is that account.',
    mmMissing: 'MetaMask (window.ethereum) was not found in this browser.',
    mmDenied: 'MetaMask did not allow connecting an account.',
    mmRejected: 'Rejected in MetaMask. Nothing was sent.',
    mmWrongChain: 'MetaMask is not on ZETAPHY testnet (chain id {id}). Switch networks in MetaMask first.',
    mmNeedTx: 'This wallet has not sent a transaction yet: send one first (e.g. to itself), then the chain accepts it as a controller.',
    mmSelfLocked: 'This wallet is itself locked to another account, so it cannot be a controller.',
    mmAlreadyLocked: 'That MetaMask account is already locked to {to}.',
    mmAlreadyMine: 'That MetaMask account is already locked to this wallet.',
    mmCancelled: 'Cancelled. Nothing was sent.',
    mmSent: 'MetaMask sent the lock. Once it is in a block, the account shows up in the list above.',
    mmWarnSeedSnap: 'If you lose your MetaMask Secret Recovery Phrase, the locked account is lost too.',
    // security core: Q-day and the threat gate's consent (docs/SECURITY-CORE.md)
    qdTitle: 'Prepare for Q-day',
    qdIntro: 'Q-day is when the network stops trusting ECDSA signatures (MetaMask-style keys), because a quantum computer may forge them. From then on an ECDSA account that has not moved is frozen (its funds stay, but it cannot send). The safest way is to lock your MetaMask account to this wallet beforehand (the card above).',
    qdCheck: 'Check my MetaMask account',
    qdNone: 'Q-day: not scheduled (the network announces it by a vote, well ahead).',
    qdScheduled: 'Q-day: block {h} (now {now}). From then on ECDSA-signed transactions are refused.',
    qdPassed: 'Q-day has passed (block {h}): ECDSA-signed transactions are refused.',
    qdOff: 'The security core is not on at this node.',
    qdPQ: '{acct}: an ML-DSA-44 account already; nothing to do.',
    qdMigrated: '{acct}: migrated; its controller is {to}.',
    qdPending: '{acct}: moving to {to}, final at block {h}.',
    qdExposed: '{acct}: not migrated, and its public key has been used on chain. Lock it before Q-day (the card above), or it will be frozen.',
    qdUnexposed: '{acct}: not migrated, but its key was never used on chain. Lock it now (recommended), or after Q-day move it with the commit–reveal below.',
    qdRecoverWarn: 'Warning: the text MetaMask asks you to sign in these two steps gives full control of {acct} to {ctrl} (this wallet\'s ML-DSA-44 account). Check that its "New ML-DSA-44 controller" line is {ctrl}, and sign this text only in the official ZETAPHY wallet. Any other site that asks you to sign a "ZETAPHY Q-day migration" text can take the account.',
    qdRecoverIntro: 'Recover after Q-day (only keys never used on chain): MetaMask signs a text locally and sends nothing. This wallet records a commitment (step 1), waits {d} blocks, then reveals (step 2); {d} blocks later the account is this wallet\'s.',
    qdCommit: 'Step 1: record the commitment',
    qdReveal: 'Step 2: reveal',
    qdCommitted: 'Commitment recorded. Reveal from block {h}.',
    qdAlready: 'This commitment was recorded in block {h}: reveal from block {r}.',
    qdNoCommit: 'No commitment yet: do step 1 first.',
    qdTooEarly: 'Too early: reveal from block {h} (now {now}).',
    qdNotYet: 'The reveal opens at Q-day. Before it, lock the account from MetaMask (the card above).',
    qdRevealed: 'Revealed: the account becomes this wallet\'s at the final block.',
    qdCannot: 'This account cannot use commit–reveal (migrated already, or its key was used on chain).',
    csTitle: 'Consent to a flagged contract',
    csIntro: 'With the threat gate on, the network does not deliver a transaction to a contract with an enforced Neuro flag unless the account itself consents (one transaction, at most a day). This is consent, not censorship: you can still go ahead, but read the flag\'s reason first.',
    csTarget: 'Contract (0x…)',
    csSeconds: 'For how long',
    csOk: 'I have read the flag\'s reason and take the risk myself',
    csSend: 'Send consent from this wallet',
    csSendMM: 'Send consent from MetaMask',
    csSent: 'Consent sent. tx hash:',
    csBad: 'Enter the contract address: 0x and 40 hex digits.',
    threatConsented: 'Warning: {addr} has an enforced flag ({what} · reason: {reason}), but you consented, so it can be sent. · {details}',
    snapTitle: 'Use MetaMask (ZETAPHY Snap)',
    snapIntro: 'The ML-DSA-44 key is made inside MetaMask from your Secret Recovery Phrase; this page never sees it. MetaMask shows every transaction in plain words before it signs.',
    snapFlask: 'Until the snap is published and MetaMask has reviewed it, it installs only in MetaMask Flask (the developer build).',
    snapIdLabel: 'Snap ID (npm:@zetaphy/snap, or local:http://localhost:8080 in development)',
    snapIdHint: 'The account depends on the snap ID: the same snap always gives the same account (recoverable from the Secret Recovery Phrase), a local:… snap gives another one.',
    snapConnect: 'Connect MetaMask',
    snapConnected: 'Connected to MetaMask (ZETAPHY Snap).',
    snapMode: 'The key is in MetaMask (ZETAPHY Snap), not in this page. Your MetaMask Secret Recovery Phrase is its backup.',
    snapDisconnect: 'Disconnect MetaMask from this page',
    snapDisconnected: 'MetaMask disconnected from this page (the snap stays installed in MetaMask).',
    snapBadId: 'The snap ID must be npm:<package> or local:http://localhost:<port>.',
    snapDenied: 'MetaMask did not install or allow the snap.',
    snapUnsupported: 'This MetaMask cannot run snaps (use MetaMask Flask, or a version with snaps).',
    snapBadAccount: 'The snap answered with an account that does not match its public key, so it is not used.',
    snapConfirm: 'Check the details and approve in the MetaMask window…',
    snapRejected: 'Rejected in MetaMask. Nothing was signed or sent.',
    snapMismatch: 'The snap signed a different transaction than the one asked for, so nothing was sent.',
    deployTitle: 'Deploy a contract',
    initCodeLabel: 'Creation bytecode (hex, with any constructor arguments)',
    deployConfirmTitle: 'Confirm the contract creation',
    cCodeSize: 'Code size',
    cCodeHash: 'Code hash (keccak-256)',
    bytesN: '{n} bytes',
    deployChecked: 'Simulated on the node: it succeeds (it is simulated again just before signing). Compare the code hash with the one the contract\'s author published. A contract creation has no destination, so it is not checked against the ThreatRegistry.',
    deployedAt: 'New contract address:',
    badInitCode: 'The bytecode must be non-empty hex (0x…).',
    deploySent: 'Sent. The node accepted it; the contract exists once the tx is in a block.',
    walletsTitle: 'Use ZETAPHY in other wallets',
    walletsIntro: 'Add the ZETAPHY Testnet network to the wallet you already use (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap, …) with the buttons below, or type the values in yourself. Everything comes from the RPC URL above.',
    evmWalletsTitle: 'EVM wallets in this browser',
    evmNone: 'No EVM wallet found in this browser. Install an extension (MetaMask, Rabby, Trust, OKX, Coinbase Wallet, …), or on a phone open this page in your wallet app\'s browser.',
    evmAdd: 'Add ZETAPHY to this wallet',
    evmConnect: 'Connect this wallet',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (phone wallets when this page is open in another browser, e.g. Binance Wallet) is off: it needs a Reown projectId first.',
    wcOn: 'A projectId is set, but this page does not include WalletConnect yet (it is the next step).',
    wcNotYet: 'This page does not include WalletConnect yet (it is the next step). Meanwhile, on a phone open this page in your wallet app\'s browser.',
    wcIdLabel: 'WalletConnect projectId (from Reown, 32 hex digits)',
    wcIdHint: 'Free at cloud.reown.com. Set it here (remembered in this browser), or for everyone in index.html\'s zetaphy-walletconnect-project-id meta tag.',
    wcSaved: 'projectId saved.',
    wcBadId: 'The projectId must be 32 hex digits.',
    manualTitle: 'Add the network by hand: the values to type in',
    mNetwork: 'Network name',
    mRpc: 'RPC URL',
    mChainId: 'Chain ID',
    mSymbol: 'Currency symbol',
    mDecimals: 'Decimals',
    mExplorer: 'Block explorer',
    mNone: 'none (leave empty)',
    mRpcUnset: '(enter an https RPC URL above first)',
    mSymbolNote: '{sym} is ZETAPHY: MetaMask and chainlist take a symbol of at most 6 letters, so EVM wallets show the balance as {sym}. Do not import the token at {precompile}: it is the same coin (you would see the balance twice).',
    cosmosTitle: 'Cosmos wallets (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'They show the zetaphy1… address of the same account as in an EVM wallet (eth_secp256k1 key, coin type 60). They need the node\'s https address, which serves /rpc and /rest (nodes set up with setup-node.sh do).',
    keplrAdd: 'Add to Keplr',
    leapAdd: 'Add to Leap',
    cosmostationAdd: 'Add to Cosmostation',
    supportTitle: 'Which wallets work',
    supWorks: 'Work now (custom networks): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame, and Ledger/Trezor through them. Keplr, Leap and Cosmostation with the buttons above.',
    supMaybe: 'May work (not confirmed): Binance Wallet, inside the Binance app, if it accepts the network; outside the app it needs WalletConnect.',
    supNot: 'Not until the wallet adds ZETAPHY itself: Phantom, and wallets with a fixed list of chains.',
    supNever: 'Never: Solana-only or Bitcoin-only wallets. They are not EVM or Cosmos wallets.',
    supPq: 'Quantum-safe: only this page\'s own ML-DSA-44 key and the ZETAPHY Snap. Every other wallet signs with ECDSA (secp256k1), which a large enough quantum computer can break; lock such an account to this wallet to protect it.',
    usingWallet: 'Wallet used: {name}',
    usingNone: 'No EVM wallet found in this browser yet.',
    changeWallet: 'Pick another wallet',
    inApp: 'This page is open in {name}\'s in-app browser: the buttons below use it.',
    mobileNoWallet: 'On a phone: open this page in your wallet app\'s browser (use a link below, or copy this page\'s address into the app\'s Browser tab).',
    phantomNote: 'Phantom does not let anyone add networks: it supports only the chains Phantom chose, so it cannot use ZETAPHY until Phantom adds it. Use another wallet (MetaMask, Rabby, Trust, OKX, Coinbase).',
    binanceNote: 'Binance Wallet may not accept new networks yet. If adding fails, type the values below in by hand, or use another wallet.',
    evmMissing: 'No EVM wallet was found in this browser.',
    evmRejected: 'Cancelled in the wallet.',
    evmDenied: 'The wallet did not allow connecting an account.',
    chainNeedHttps: 'Wallets take only an https RPC URL (or localhost). Enter the node\'s https address above, e.g. https://1-2-3-4.sslip.io',
    chainAdding: 'Approve adding ZETAPHY Testnet in {name}\'s window…',
    chainAdded: 'ZETAPHY Testnet added to {name} and selected.',
    chainAddedNoSwitch: 'ZETAPHY Testnet added to {name}, but not selected: pick the network in the wallet.',
    addChainUnsupported: '{name} did not add the network ({why}). It may not accept new networks yet: type the values below into the wallet by hand, or use another wallet.',
    evmConnected: 'Connected to {name}.',
    evmOnZetaphy: 'On ZETAPHY Testnet.',
    evmOtherChain: 'On another network (chain id {id}): press "Add ZETAPHY to this wallet".',
    evmBalance: 'Balance {amount} ZETAPHY',
    cosmosMissing: '{name} was not found in this browser.',
    cosmosAdding: 'Approve in {name}\'s window…',
    cosmosRejected: '{name} did not add the network ({why}).',
    cosmosAdded: 'ZETAPHY Testnet added to {name}. Your address is below.',
    cosmosBadAddress: 'The wallet answered with an address that is not zetaphy1…, so it is not used.',
    walletPicked: '{name} picked.',
    snapNotMetaMask: '{name} cannot run MetaMask Snaps. Pick MetaMask (or MetaMask Flask) under "Use ZETAPHY in other wallets" below.',
    // vaccine: ThreatRegistry
    threatLabel: 'ThreatRegistry (immune system: never sign transactions to flagged code)',
    threatHint: 'Its 0x… address on ZETAPHY (remembered in this browser), or for everyone in index.html\'s zetaphy-threat-registry meta tag. Empty = the meta tag.',
    threatSaved: 'ThreatRegistry address saved.',
    threatBadAddress: 'The ThreatRegistry address must be 0x and 40 hex digits.',
    threatFlagged: 'Not signed: {addr} is flagged by the ZETAPHY immune system ({what} · reason: {reason}). This wallet does not send transactions to code whose flag is enforced unless you consent first (card "Consent to a flagged contract"). · {details}',
    threatUnchecked: 'Not signed: {addr} could not be checked against the ThreatRegistry {reg}. Once a ThreatRegistry is set, no check means no send.',
    threatUnset: 'Destination code NOT checked: no ThreatRegistry address is set (advanced settings under the RPC box).',
    threatClean: 'Checked against the ThreatRegistry: the destination is not flagged (best effort: the address, its code and the code behind an EIP-1967 / beacon / EIP-1167 proxy; checked again before signing).',
    threatWarned: 'Warning: {addr} was flagged by Neuro runners ({what} · reason: {reason}), but the flag is not enforced yet (governance can still review it). This wallet refuses once it is enforced (a flag a supermajority of runners or governance put on the fast lane is enforced at once); sending now is your choice. · {details}',
    threatNewWarning: 'Not signed: {addr} was flagged after you reviewed this ({what} · reason: {reason}). Review it again to see the warning. · {details}',
    threatBehind: '{impl} (the code behind proxy {proxy})',
    threatWhatFingerprint: 'its code fingerprint (fp1) matches flagged code',
    threatWhatCode: 'its code is byte-for-byte flagged code',
    threatWhatAddress: 'this address is flagged',
    ...Object.fromEntries(REASON_TEXT.map((r, i) => [`reason${i}`, r.en]).slice(1)),
    threatEvidence: 'Evidence: reportHash {hash}{uri} · ' + REPRODUCE.en,
    threatNoEvidence: 'Evidence: none stored',
    threatEvidenceUnread: 'Evidence: could not be read',
    threatResponse: 'Response from {by}: "{text}"',
    threatResponseAssigned: 'Response from the governance-assigned responder ({by}): "{text}"',
    threatNoResponse: 'No response yet',
    threatDisclaimer: DISCLAIMER.en,
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'Tip: four or five random, unrelated words make a passphrase that is both strong and easy to remember.',
    passWeak: 'This passphrase is too easy to guess (rated {label}). It must be rated at least Strong',
    pwStrength: 'Strength: {label}',
    pwVeryWeak: 'very weak',
    pwWeak: 'weak',
    pwFair: 'fair',
    pwStrong: 'strong',
    pwVeryStrong: 'very strong',
    pwLength: 'Use at least {n} characters; longer is better.',
    pwCommon: 'It is one of the most common passwords.',
    pwDictionary: 'It contains a common password or word.',
    pwSequence: 'It contains a sequence such as abc, 321 or qwerty.',
    pwRepeat: 'It contains repeated characters or patterns.',
    pwContext: 'It contains "zetaphy", "wallet" or part of your address.',
    pwYear: 'It contains a year.',
    pwVariety: 'Add more words, or mix upper and lower case, digits and symbols.',
    weakNudge: 'Your passphrase is weak (rated {label}). Anyone who copies this browser\'s data could try to guess it. Please change it to a stronger one.',
    weakNudgeGo: 'Change it now',
    secTitle: 'Security',
    autoLockLabel: 'Lock automatically after this long without activity, or in a background tab',
    nMinutes: '{n} min',
    autoLockIn: 'Locks automatically in {time} without activity.',
    autoLocked: 'Locked automatically after {n} min without activity. The key was wiped from memory.',
    autoLockSaved: 'Auto-lock set to {n} min.',
    lockedErr: 'The wallet is locked. Unlock it first; nothing was signed.',
    chpwTitle: 'Change the passphrase',
    chpwOld: 'Current passphrase',
    chpwNew: 'New passphrase (at least 12 characters, rated Strong)',
    chpwSave: 'Change passphrase',
    chpwDone: 'Passphrase changed.',
    pkTitle: 'Unlock with fingerprint / Face ID (passkey)',
    pkIntro: 'Creates a passkey for this site on this device. Its PRF secret, released only after your fingerprint, face or device PIN, encrypts a second copy of the seed in this browser. The passphrase keeps working as a fallback.',
    pkSyncNote: 'Passkeys may sync through iCloud Keychain, Google Password Manager or another passkey manager, so this passkey can exist on your other devices too. Protect that account well.',
    pkEnable: 'Turn on fingerprint / Face ID unlock',
    pkDisable: 'Turn off fingerprint / Face ID unlock',
    pkUnlock: 'Unlock with fingerprint / Face ID',
    pkOn: 'Fingerprint / Face ID unlock is on. The passphrase still works.',
    pkOff: 'Fingerprint / Face ID unlock is off.',
    pkOtherSite: 'The passkey was made for {host}. Here, use your passphrase.',
    pkUnsupported: 'This browser cannot use passkeys on this page. Keep using your passphrase.',
    pkNoPlatform: 'No fingerprint, face or device-PIN authenticator was found on this device. Keep using your passphrase.',
    pkNoPrf: 'This browser or passkey manager does not support the PRF extension this needs, so a passkey cannot unlock the wallet here. Keep using your passphrase.',
    pkCancelled: 'Cancelled or timed out. Nothing changed.',
    pkFailed: 'The passkey did not unlock this wallet. Use your passphrase.',
    pkWorking: 'Waiting for your fingerprint / Face ID…',
    pkEnabled: 'Passkey created: you can now unlock with fingerprint / Face ID. The passphrase still works.',
    pkDisabled: 'Passkey unlock turned off and its encrypted copy deleted. You can also delete the passkey "ZETAPHY PQ Wallet" in your device\'s passkey settings.',
    pkDisableConfirm: 'Turn off fingerprint / Face ID unlock? You will unlock with the passphrase only.',
    bigTitle: 'Large balance: consider a safer place for the key',
    bigLocal: 'This account holds {amount} ZETAPHY. A key in a web page is only as safe as this browser and computer. For larger amounts, move the funds to the ZETAPHY Snap, where the key stays inside MetaMask.',
    bigEvm: 'The connected EVM account holds {amount} ZETAPHY. For larger amounts, use a hardware wallet (Ledger or Trezor) through MetaMask or Rabby.',
    bigHow: 'How to',
    bigLater: 'Hide for 7 days',
    helpOpen: 'Keeping a larger balance safe',
    helpTitle: 'Keeping a larger balance safe',
    helpIntro: 'A key in a web page is only as safe as the browser and the computer it runs on: a bad extension or malware can read it while the wallet is unlocked. Keep only small amounts here.',
    helpSnapTitle: 'Native PQ account: move to the ZETAPHY Snap (key inside MetaMask)',
    helpSnap1: 'Install MetaMask (MetaMask Flask until the snap is published) and back up its Secret Recovery Phrase.',
    helpSnap2: 'Lock this wallet, then click "Connect MetaMask" and approve the ZETAPHY Snap.',
    helpSnap3: 'Copy the zetaphy1… address it shows: that is the new account, made inside MetaMask.',
    helpSnap4: 'Unlock this wallet again with its passphrase and send the funds to that address. Check the address in MetaMask\'s dialog too.',
    helpHwTitle: 'EVM accounts: a hardware wallet',
    helpHw1: 'Connect a Ledger or Trezor to MetaMask or Rabby (add a hardware wallet account there).',
    helpHw2: 'Add the ZETAPHY Testnet network to it with the "Use ZETAPHY in other wallets" buttons on this page.',
    helpHw3: 'Send the funds to the hardware account\'s 0x… address, and confirm every transaction on the device\'s own screen.',
    helpMore: 'The README\'s security section has the details. This is testnet: none of it is real money.',
    helpClose: 'Close',
  },
  // Translated from en (th only to resolve meaning). reason1..7, threatEvidence and
  // threatDisclaimer mirror zetaphy-network/src/vaccine.js, which has only th and en.
  zh: {
    subtitle: '抗量子钱包（ML-DSA-44）· 无 ECDSA 密钥',
    warnTitle: '仅限测试网',
    warnTestnet: 'ZETAPHY 测试网上的币不是真钱。请勿在此存放任何有价值的资产。',
    warnSeed: '种子是这个钱包唯一的密钥。一旦丢失种子或忘记密码，资金将永久丢失，任何人都无法找回。',
    warnLocal: '种子只保存在本浏览器中，并用你的密码加密，绝不会发送到任何地方。',
    rpcLabel: '你的 ZETAPHY 节点 RPC 地址（JSON-RPC，端口 8545）',
    rpcSave: '保存',
    rpcHint: '如果本页面通过 https 打开，RPC 也必须是 https（浏览器会拦截 http）。',
    setupTitle: '开始使用',
    modeNew: '创建新密钥',
    modeImport: '导入种子',
    seedLabel: '种子（64 位十六进制，0x 可选）',
    pass1: '设置密码（至少 12 个字符，强度达到“强”）',
    pass2: '再次输入密码',
    saveKey: '创建钱包',
    lockedTitle: '钱包已锁定',
    unlockLabel: '密码',
    unlock: '解锁',
    forget: '从本浏览器移除钱包',
    accountTitle: '你的账户',
    sameAccount: '两者是同一个账户，用任一地址都可以收款。',
    copy: '复制',
    balance: '余额',
    refresh: '刷新',
    sendTitle: '发送 ZETAPHY',
    toLabel: '收款地址（0x… 或 zetaphy1…）',
    amountLabel: '数量（ZETAPHY）',
    advanced: '更多设置',
    gasLabel: 'Gas 上限',
    review: '检查',
    confirmTitle: '确认转账',
    cTo: '收款方',
    cAmount: '数量',
    cFee: '最高手续费',
    cTotal: '合计',
    confirmSend: '确认，用 ML-DSA 签名并发送',
    cancel: '取消',
    txSent: '已发送。交易哈希：',
    backupTitle: '备份种子',
    backupWarn: '备份文件就是明文种子。任何拿到它的人都能转走资金。请离线妥善保管，切勿分享给任何人。',
    backupOk: '我已了解',
    backup: '下载种子备份',
    backupCli: '该文件可作为 zetaphy pq native 命令使用的 ~/.zetaphy/pq.seed。',
    lock: '锁定钱包',
    footer: '所有代码都在本页面中，不加载其他来源的脚本 · 交易在浏览器中用 ML-DSA-44（FIPS 204）签名，或通过 ZETAPHY Snap 在 MetaMask 中签名',
    working: '处理中…',
    deriving: '正在加密种子（需要一点时间）…',
    created: '钱包已创建。收款前请先下载种子备份。',
    imported: '种子已导入。',
    unlocked: '已解锁。',
    lockedMsg: '已锁定。',
    badPass: '密码错误。',
    passShort: '密码至少需要 {n} 个字符。',
    passMismatch: '两次输入的密码不一致。',
    badSeed: '种子必须是 64 位十六进制。',
    storeFailed: '此浏览器无法保存数据（无痕模式？）。关闭页面后钱包就会消失：请下载备份。',
    rpcSaved: 'RPC 已保存。',
    needRpc: '请先输入节点 RPC 地址。',
    badRpc: 'RPC 地址必须以 http:// 或 https:// 开头',
    wrongChain: '该 RPC 不是 ZETAPHY 测试网（chain id {id}）。',
    rpcDown: '无法连接 RPC（节点宕机、未允许 CORS，或在 https 页面中使用了 http）。',
    notFunded: '该账户尚未上链：请先向此地址转入 ZETAPHY，之后才能发送。',
    onChain: '已上链（账户 {n}，已发送 {s} 笔交易）。',
    badAddress: '收款地址无效（请检查拼写或校验和）。',
    badAmount: '数量无效。',
    badGas: 'Gas 上限必须是大于 0 的整数。',
    notEnough: '余额不足：需要 {need} ZETAPHY（含手续费），当前有 {have}。',
    signing: '正在用 ML-DSA-44 签名并发送…',
    sent: '已发送。节点已接受，几秒内会被打包进区块。',
    rejected: '节点拒绝了该交易',
    copied: '已复制。',
    forgetConfirm: '要从本浏览器移除钱包吗？没有种子备份的话，资金将永久丢失。',
    forgotten: '钱包已从本浏览器移除。',
    backupDone: '备份已下载。请离线保管。',
    tokenTitle: 'ERC-20 代币',
    tokenLabel: '代币合约地址（0x…）',
    tokenLoad: '查询',
    tokenBalance: '代币余额',
    tokenMeta: '{sym} · {d} 位小数 · 合约 {addr}',
    tokenAmountLabel: '代币数量',
    evmGasLabel: 'EVM Gas 上限（手续费包含这部分 Gas 和交易本身）',
    tokenConfirmTitle: '确认代币转账',
    cToken: '代币',
    tokenChecked: '已在节点上模拟：可以成功（签名前会再模拟一次）。',
    tokenNote: '手续费以 ZETAPHY 支付。如果合约 revert，整笔交易失败但手续费照扣，所以本页面在签名前会模拟每一笔转账。',
    badToken: '代币合约必须是 0x 加 40 位十六进制（请检查校验和）。',
    noContract: '{addr} 上没有合约。',
    notToken: '该合约不是 ERC-20 代币（没有 decimals()）。',
    tokenDecimals: '{sym} 的数量超过 {d} 位小数。',
    badEvmGas: 'EVM Gas 上限必须是 {min} 到 {max} 之间的整数。',
    tokenNotEnough: '代币余额不足：要发送 {need} {sym}，当前有 {have}。',
    callFails: '未发送：在节点上模拟时，该转账会失败（revert）',
    tokenRefused: '未发送：代币拒绝了该转账（transfer 返回 false）。',
    tokenSent: '已发送。节点已接受。（这是一笔 Cosmos 交易，其 EVM 日志不会出现在 eth_getLogs 中；余额是正确的。）',
    stakeTitle: '质押 ZETAPHY',
    validatorLabel: '验证人（zetaphyvaloper1…）',
    stakeAmountLabel: '数量（ZETAPHY），领取奖励时无需填写',
    stake: '质押',
    unstake: '解除质押',
    claim: '领取奖励',
    confirmStake: '确认质押',
    confirmUnstake: '确认解除质押',
    confirmClaim: '确认领取奖励',
    cValidator: '验证人',
    unbondNote: '解除质押的 ZETAPHY 要等链上的解绑期结束后才会返还。在此之前无法使用，也没有奖励。',
    badValidator: '验证人必须是 zetaphyvaloper1… 地址（请检查拼写或校验和）。',
    staked: '质押已发送，节点已接受。',
    unstaked: '解除质押已发送。ZETAPHY 会在解绑期结束后返还。',
    claimed: '领取已发送。交易打包进区块后奖励即到账。',
    ownedTitle: '本钱包控制的账户',
    ownedHint: '已量子锁定到本钱包的 ECDSA 账户（例如 MetaMask）。它们自己的私钥已失效；由本钱包代它们转账、发送代币和质押（用 ML-DSA-44 签名，手续费由本钱包支付）。',
    ownerLabel: '已锁定账户地址（0x… 或 zetaphy1…）',
    ownerUse: '以此账户身份操作',
    actingAs: '当前身份',
    ownerBalance: '其余额',
    actingHint: '下方的转账、代币转账和质押都将代表此账户执行（as_owner）。手续费由本钱包支付。',
    ownerStop: '返回我的账户',
    ownedMine: '已锁定到本钱包',
    ownedNotMine: '未锁定到本钱包（或尚未打包进区块）',
    ownedOther: '已锁定到另一个账户：{to}',
    asTag: '代表 {owner}',
    asNote: '代表 {owner}（已量子锁定到本钱包）：资金和代币从该账户转出；手续费由本钱包支付。',
    nowActing: '现在以 {owner} 的身份操作。',
    stopActing: '已返回你自己的账户。',
    ownerNotLocked: '该账户没有量子锁定到本钱包，因此本钱包无法代它操作。',
    ownerOther: '该账户锁定到了另一个账户（{to}），而不是本钱包。',
    ownerSelf: '这是本钱包自己的账户。',
    ownerNotEnough: '该账户余额不足：需要 {need} ZETAPHY，当前有 {have}。',
    mmTitle: '将 MetaMask 账户锁定到本钱包',
    mmIntro: '把 MetaMask 中某个 ECDSA 账户的控制权交给这个抗量子钱包。它的地址、余额、代币和质押都保持不变，但从此只有本钱包能动用它们。',
    mmWarnPermanent: '永久生效，无法撤销：锁定后，链会拒绝该账户 MetaMask 私钥签名的所有交易，合约也不再接受它的签名（例如 permit）。',
    mmWarnSeed: '如果丢失本钱包的种子，被锁定的账户也会一起丢失。请先下载种子备份。',
    mmWarnTx: '本钱包必须已在链上发送过至少一笔交易（这样链才知道它的 ML-DSA-44 公钥）。',
    mmOk: '我了解锁定是永久的',
    mmLock: '连接 MetaMask 并锁定',
    mmSentLabel: 'MetaMask 已发送锁定交易。交易哈希：',
    mmConfirm: '确定要将 MetaMask 账户 {owner} 永久锁定到本钱包（{me}）吗？\n\n它的 MetaMask 私钥将再也无法在 ZETAPHY 上使用；如果本钱包的种子丢失，该账户也会一起丢失。',
    mmMissing: '在此浏览器中找不到 MetaMask（window.ethereum）。',
    mmDenied: 'MetaMask 未允许连接账户。',
    mmRejected: '已在 MetaMask 中拒绝，未发送任何内容。',
    mmWrongChain: 'MetaMask 当前不在 ZETAPHY 测试网（chain id {id}）。请先在 MetaMask 中切换网络。',
    mmNeedTx: '本钱包还没有发送过交易：请先发送一笔（例如转给自己），之后链才会接受它作为控制者。',
    mmSelfLocked: '本钱包自身已锁定到另一个账户，因此不能作为控制者。',
    mmAlreadyLocked: '该 MetaMask 账户已锁定到 {to}。',
    mmAlreadyMine: '该 MetaMask 账户已锁定到本钱包。',
    mmCancelled: '已取消，未发送任何内容。',
    mmSent: 'MetaMask 已发送锁定交易。打包进区块后，该账户会出现在上方列表中。',
    mmWarnSeedSnap: '如果丢失 MetaMask 助记词（Secret Recovery Phrase），被锁定的账户也会一起丢失。',
    qdTitle: '为 Q-day 做准备',
    qdIntro: 'Q-day 是指网络不再信任 ECDSA 签名（MetaMask 一类的密钥）的那一天，因为量子计算机可能伪造这类签名。从那时起，尚未迁移的 ECDSA 账户会被冻结（资金还在，但无法转出）。最安全的做法是提前把你的 MetaMask 账户锁定到本钱包（上方卡片）。',
    qdCheck: '检查我的 MetaMask 账户',
    qdNone: 'Q-day：尚未排定（网络会通过投票提前很久公布）。',
    qdScheduled: 'Q-day：区块 {h}（当前 {now}）。从那时起，ECDSA 签名的交易将被拒绝。',
    qdPassed: 'Q-day 已过（区块 {h}）：ECDSA 签名的交易将被拒绝。',
    qdOff: '此节点未启用安全核心。',
    qdPQ: '{acct}：已经是 ML-DSA-44 账户，无需操作。',
    qdMigrated: '{acct}：已迁移，其控制者为 {to}。',
    qdPending: '{acct}：正在迁移到 {to}，将在区块 {h} 最终生效。',
    qdExposed: '{acct}：未迁移，且其公钥已在链上暴露。请在 Q-day 之前锁定（上方卡片），否则将被冻结。',
    qdUnexposed: '{acct}：未迁移，但其密钥从未在链上使用过。建议现在就锁定，或在 Q-day 之后用下方的提交–揭示（commit–reveal）迁移。',
    qdRecoverWarn: '警告：在这两步中 MetaMask 要求你签名的文本会把 {acct} 的全部控制权交给 {ctrl}（本钱包的 ML-DSA-44 账户）。请确认其中的 “New ML-DSA-44 controller” 一行是 {ctrl}，并且只在官方 ZETAPHY 钱包中签署此文本。任何其他要求你签署 “ZETAPHY Q-day migration” 文本的网站都可能夺走该账户。',
    qdRecoverIntro: 'Q-day 之后找回（仅限从未在链上使用过的密钥）：MetaMask 只在本地签署一段文本，不发送任何内容。本钱包先记录承诺（第 1 步），等待 {d} 个区块后揭示（第 2 步）；再过 {d} 个区块，该账户即归本钱包所有。',
    qdCommit: '第 1 步：记录承诺',
    qdReveal: '第 2 步：揭示',
    qdCommitted: '承诺已记录。可从区块 {h} 开始揭示。',
    qdAlready: '此承诺已记录在区块 {h}：可从区块 {r} 开始揭示。',
    qdNoCommit: '尚无承诺：请先完成第 1 步。',
    qdTooEarly: '太早了：可从区块 {h} 开始揭示（当前 {now}）。',
    qdNotYet: '揭示要到 Q-day 才开放。在此之前，请从 MetaMask 锁定该账户（上方卡片）。',
    qdRevealed: '已揭示：在最终区块时，该账户将归本钱包所有。',
    qdCannot: '该账户无法使用提交–揭示（已经迁移，或其密钥已在链上使用过）。',
    csTitle: '同意与被标记的合约交互',
    csIntro: '启用威胁闸门后，网络不会把交易送达带有强制 Neuro 标记的合约，除非账户本人表示同意（一笔交易，最长一天）。这是知情同意，不是审查：你仍然可以继续，但请先阅读标记的原因。',
    csTarget: '合约（0x…）',
    csSeconds: '有效时长',
    csOk: '我已阅读标记原因，并自行承担风险',
    csSend: '从本钱包发送同意',
    csSendMM: '从 MetaMask 发送同意',
    csSent: '同意已发送。交易哈希：',
    csBad: '请输入合约地址：0x 加 40 位十六进制。',
    threatConsented: '警告：{addr} 带有强制标记（{what} · 原因：{reason}），但你已同意，因此可以发送。· {details}',
    snapTitle: '使用 MetaMask（ZETAPHY Snap）',
    snapIntro: 'ML-DSA-44 密钥在 MetaMask 内部由你的助记词派生，本页面永远看不到它。MetaMask 会在签名前用通俗的语言展示每一笔交易。',
    snapFlask: '在 Snap 正式发布并通过 MetaMask 审核之前，只能安装在 MetaMask Flask（开发者版本）中。',
    snapIdLabel: 'Snap ID（npm:@zetaphy/snap，开发时用 local:http://localhost:8080）',
    snapIdHint: '账户取决于 Snap ID：同一个 Snap 总是得到同一个账户（可通过助记词恢复），local:… Snap 会得到另一个账户。',
    snapConnect: '连接 MetaMask',
    snapConnected: '已连接 MetaMask（ZETAPHY Snap）。',
    snapMode: '密钥在 MetaMask（ZETAPHY Snap）中，不在本页面。你的 MetaMask 助记词就是它的备份。',
    snapDisconnect: '断开 MetaMask 与本页面的连接',
    snapDisconnected: 'MetaMask 已与本页面断开（Snap 仍安装在 MetaMask 中）。',
    snapBadId: 'Snap ID 必须是 npm:<package> 或 local:http://localhost:<port>。',
    snapDenied: 'MetaMask 未安装或未允许该 Snap。',
    snapUnsupported: '此 MetaMask 无法运行 Snap（请使用 MetaMask Flask 或支持 Snap 的版本）。',
    snapBadAccount: 'Snap 返回的账户与其公钥不匹配，因此不予使用。',
    snapConfirm: '请在 MetaMask 窗口中核对详情并批准…',
    snapRejected: '已在 MetaMask 中拒绝，未签名也未发送任何内容。',
    snapMismatch: 'Snap 签名的交易与请求的不一致，因此未发送任何内容。',
    deployTitle: '部署合约',
    initCodeLabel: '创建字节码（十六进制，含构造函数参数）',
    deployConfirmTitle: '确认创建合约',
    cCodeSize: '代码大小',
    cCodeHash: '代码哈希（keccak-256）',
    bytesN: '{n} 字节',
    deployChecked: '已在节点上模拟：可以成功（签名前会再模拟一次）。请将代码哈希与合约作者公布的哈希进行比对。创建合约没有目标地址，因此不会对照 ThreatRegistry 检查。',
    deployedAt: '新合约地址：',
    badInitCode: '字节码必须是非空的十六进制（0x…）。',
    deploySent: '已发送。节点已接受；交易打包进区块后合约即存在。',
    walletsTitle: '在其他钱包中使用 ZETAPHY',
    walletsIntro: '用下方按钮把 ZETAPHY Testnet 网络添加到你正在使用的钱包（MetaMask、Rabby、Trust、OKX、Coinbase、Keplr、Leap…），或自己手动填写参数。所有参数都来自上方的 RPC 地址。',
    evmWalletsTitle: '此浏览器中的 EVM 钱包',
    evmNone: '此浏览器中没有找到 EVM 钱包。请安装扩展（MetaMask、Rabby、Trust、OKX、Coinbase Wallet…），或在手机上用钱包 App 内置浏览器打开本页面。',
    evmAdd: '将 ZETAPHY 添加到此钱包',
    evmConnect: '连接此钱包',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect（在其他浏览器打开本页面时连接手机钱包，例如 Binance Wallet）未启用：需要先设置 Reown projectId。',
    wcOn: '已设置 projectId，但本页面尚未集成 WalletConnect（这是下一步）。',
    wcNotYet: '本页面尚未集成 WalletConnect（这是下一步）。在此期间，请在手机上用钱包 App 内置浏览器打开本页面。',
    wcIdLabel: 'WalletConnect projectId（来自 Reown，32 位十六进制）',
    wcIdHint: '可在 cloud.reown.com 免费获取。在这里设置（保存在本浏览器中），或在 index.html 的 zetaphy-walletconnect-project-id meta 标签中为所有人设置。',
    wcSaved: 'projectId 已保存。',
    wcBadId: 'projectId 必须是 32 位十六进制。',
    manualTitle: '手动添加网络：需要填写的参数',
    mNetwork: '网络名称',
    mRpc: 'RPC URL',
    mChainId: '链 ID',
    mSymbol: '货币符号',
    mDecimals: '小数位数',
    mExplorer: '区块浏览器',
    mNone: '无（留空）',
    mRpcUnset: '（请先在上方输入 https RPC 地址）',
    mSymbolNote: '{sym} 就是 ZETAPHY：MetaMask 和 chainlist 只接受最多 6 个字母的符号，所以 EVM 钱包会以 {sym} 显示余额。不要导入 {precompile} 处的代币：它是同一种币（余额会显示两次）。',
    cosmosTitle: 'Cosmos 钱包（Keplr、Leap、Cosmostation）',
    cosmosIntro: '它们显示的是与 EVM 钱包中同一账户的 zetaphy1… 地址（eth_secp256k1 密钥，coin type 60）。需要节点的 https 地址，并提供 /rpc 和 /rest（用 setup-node.sh 部署的节点都有）。',
    keplrAdd: '添加到 Keplr',
    leapAdd: '添加到 Leap',
    cosmostationAdd: '添加到 Cosmostation',
    supportTitle: '支持哪些钱包',
    supWorks: '现在可用（自定义网络）：MetaMask、Rabby、Trust、OKX、Coinbase Wallet、Brave、Rainbow、Zerion、Frame，以及通过它们使用的 Ledger/Trezor。Keplr、Leap 和 Cosmostation 可用上方按钮添加。',
    supMaybe: '可能可用（未确认）：Binance Wallet，在 Binance App 内，如果它接受该网络；在 App 外需要 WalletConnect。',
    supNot: '要等钱包自己添加 ZETAPHY 后才可用：Phantom，以及链列表固定的钱包。',
    supNever: '永远不可用：仅支持 Solana 或仅支持 Bitcoin 的钱包。它们不是 EVM 或 Cosmos 钱包。',
    supPq: '抗量子：只有本页面自己的 ML-DSA-44 密钥和 ZETAPHY Snap。其他所有钱包都用 ECDSA（secp256k1）签名，足够强大的量子计算机可以破解它；把这类账户锁定到本钱包即可保护它。',
    usingWallet: '当前钱包：{name}',
    usingNone: '此浏览器中尚未找到 EVM 钱包。',
    changeWallet: '选择其他钱包',
    inApp: '本页面正在 {name} 的内置浏览器中打开：下方按钮将使用它。',
    mobileNoWallet: '在手机上：请用钱包 App 内置浏览器打开本页面（使用下方链接，或把本页地址复制到 App 的浏览器标签页中）。',
    phantomNote: 'Phantom 不允许任何人添加网络：它只支持 Phantom 自己选定的链，所以在 Phantom 添加 ZETAPHY 之前无法使用。请使用其他钱包（MetaMask、Rabby、Trust、OKX、Coinbase）。',
    binanceNote: 'Binance Wallet 可能还不接受新网络。如果添加失败，请手动填写下方参数，或使用其他钱包。',
    evmMissing: '此浏览器中没有找到 EVM 钱包。',
    evmRejected: '已在钱包中取消。',
    evmDenied: '钱包未允许连接账户。',
    chainNeedHttps: '钱包只接受 https RPC 地址（或 localhost）。请在上方输入节点的 https 地址，例如 https://1-2-3-4.sslip.io',
    chainAdding: '请在 {name} 窗口中批准添加 ZETAPHY Testnet…',
    chainAdded: 'ZETAPHY Testnet 已添加到 {name} 并已选中。',
    chainAddedNoSwitch: 'ZETAPHY Testnet 已添加到 {name}，但未选中：请在钱包中选择该网络。',
    addChainUnsupported: '{name} 未添加该网络（{why}）。它可能还不接受新网络：请在钱包中手动填写下方参数，或使用其他钱包。',
    evmConnected: '已连接 {name}。',
    evmOnZetaphy: '当前在 ZETAPHY Testnet。',
    evmOtherChain: '当前在其他网络（chain id {id}）：请点击“将 ZETAPHY 添加到此钱包”。',
    evmBalance: '余额 {amount} ZETAPHY',
    cosmosMissing: '此浏览器中没有找到 {name}。',
    cosmosAdding: '请在 {name} 窗口中批准…',
    cosmosRejected: '{name} 未添加该网络（{why}）。',
    cosmosAdded: 'ZETAPHY Testnet 已添加到 {name}。你的地址如下。',
    cosmosBadAddress: '钱包返回的地址不是 zetaphy1…，因此不予使用。',
    walletPicked: '已选择 {name}。',
    snapNotMetaMask: '{name} 无法运行 MetaMask Snap。请在下方“在其他钱包中使用 ZETAPHY”中选择 MetaMask（或 MetaMask Flask）。',
    threatLabel: 'ThreatRegistry（免疫系统：绝不签署发往被标记代码的交易）',
    threatHint: '它在 ZETAPHY 上的 0x… 地址（保存在本浏览器中），或在 index.html 的 zetaphy-threat-registry meta 标签中为所有人设置。留空 = 使用 meta 标签。',
    threatSaved: 'ThreatRegistry 地址已保存。',
    threatBadAddress: 'ThreatRegistry 地址必须是 0x 加 40 位十六进制。',
    threatFlagged: '未签名：{addr} 被 ZETAPHY 免疫系统标记（{what} · 原因：{reason}）。对于标记已强制执行的代码，除非你先表示同意（“同意与被标记的合约交互”卡片），本钱包不会向其发送交易。· {details}',
    threatUnchecked: '未签名：无法对照 ThreatRegistry {reg} 检查 {addr}。一旦设置了 ThreatRegistry，未经检查就不发送。',
    threatUnset: '目标代码未经检查：尚未设置 ThreatRegistry 地址（在 RPC 输入框下方的高级设置中）。',
    threatClean: '已对照 ThreatRegistry 检查：目标未被标记（尽力而为：检查地址、其代码以及 EIP-1967 / beacon / EIP-1167 代理背后的代码；签名前会再检查一次）。',
    threatWarned: '警告：{addr} 已被 Neuro 运行者标记（{what} · 原因：{reason}），但标记尚未强制执行（治理仍可复审）。一旦强制执行，本钱包将拒绝发送（由绝大多数运行者标记或经治理走快速通道的标记会立即强制执行）；现在是否发送由你决定。· {details}',
    threatNewWarning: '未签名：在你检查之后，{addr} 被标记了（{what} · 原因：{reason}）。请重新检查以查看警告。· {details}',
    threatBehind: '{impl}（代理 {proxy} 背后的代码）',
    threatWhatFingerprint: '其代码指纹（fp1）与被标记的代码匹配',
    threatWhatCode: '其代码与被标记的代码逐字节相同',
    threatWhatAddress: '该地址已被标记',
    reason1: '在模拟交易中，可以买入但卖出失败或几乎拿不回钱',
    reason2: '有地址可以无上限地增发代币',
    reason3: '所有者或管理员可以阻止持有人转账或卖出',
    reason4: '所有者或管理员可以转走或销毁他人持有的代币或资金',
    reason5: '使用了与已知代币相同的名称或符号，但地址不同',
    reason6: '在可复现的测试中，它把授权（approve）给它的代币转到了持有人未指定的地址',
    reason7: '其他代码事实（见证据）',
    threatEvidence: '证据：reportHash {hash}{uri} · 复现：对同一代码运行 Neuro（zetaphy-neuro: node cli.js <chain> <address> --json），并比对 reportHash',
    threatNoEvidence: '证据：未存储',
    threatEvidenceUnread: '证据：无法读取',
    threatResponse: '来自 {by} 的回应：“{text}”',
    threatResponseAssigned: '来自治理指定回应人（{by}）的回应：“{text}”',
    threatNoResponse: '暂无回应',
    threatDisclaimer: '自动代码分析结果，并非指控',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: '提示：四五个随机、互不相关的词，组成的密码既强又好记。',
    passWeak: '这个密码太容易被猜到（强度：{label}）。强度必须至少为“强”',
    pwStrength: '强度：{label}',
    pwVeryWeak: '很弱',
    pwWeak: '弱',
    pwFair: '一般',
    pwStrong: '强',
    pwVeryStrong: '很强',
    pwLength: '至少使用 {n} 个字符，越长越好。',
    pwCommon: '这是最常见的密码之一。',
    pwDictionary: '包含常见的密码或单词。',
    pwSequence: '包含 abc、321 或 qwerty 这样的序列。',
    pwRepeat: '包含重复的字符或模式。',
    pwContext: '包含“zetaphy”“wallet”或你的地址的一部分。',
    pwYear: '包含年份。',
    pwVariety: '多加几个词，或混用大小写字母、数字和符号。',
    weakNudge: '你的密码较弱（强度：{label}）。复制了本浏览器数据的人可能猜出它。请换一个更强的密码。',
    weakNudgeGo: '立即修改',
    secTitle: '安全',
    autoLockLabel: '无操作或处于后台标签页达到此时长后自动锁定',
    nMinutes: '{n} 分钟',
    autoLockIn: '无操作时将在 {time} 后自动锁定。',
    autoLocked: '已因 {n} 分钟无操作自动锁定，密钥已从内存中清除。',
    autoLockSaved: '自动锁定已设为 {n} 分钟。',
    lockedErr: '钱包已锁定。请先解锁；没有签署任何内容。',
    chpwTitle: '修改密码',
    chpwOld: '当前密码',
    chpwNew: '新密码（至少 12 个字符，强度达到“强”）',
    chpwSave: '修改密码',
    chpwDone: '密码已修改。',
    pkTitle: '用指纹 / 面容 ID 解锁（通行密钥）',
    pkIntro: '在本设备上为本网站创建一个通行密钥。只有验证指纹、面容或设备 PIN 后，它的 PRF 密值才会给出，用来加密本浏览器中种子的第二份副本。密码仍可作为备用。',
    pkSyncNote: '通行密钥可能通过 iCloud 钥匙串、Google 密码管理器或其他通行密钥管理器同步，因此它也可能存在于你的其他设备上。请保护好该账户。',
    pkEnable: '开启指纹 / 面容 ID 解锁',
    pkDisable: '关闭指纹 / 面容 ID 解锁',
    pkUnlock: '用指纹 / 面容 ID 解锁',
    pkOn: '指纹 / 面容 ID 解锁已开启。密码仍然可用。',
    pkOff: '指纹 / 面容 ID 解锁未开启。',
    pkOtherSite: '该通行密钥是为 {host} 创建的。在这里请使用密码。',
    pkUnsupported: '此浏览器无法在本页面使用通行密钥。请继续使用密码。',
    pkNoPlatform: '本设备上没有找到指纹、面容或设备 PIN 验证器。请继续使用密码。',
    pkNoPrf: '此浏览器或通行密钥管理器不支持所需的 PRF 扩展，因此无法在这里用通行密钥解锁钱包。请继续使用密码。',
    pkCancelled: '已取消或超时，没有任何更改。',
    pkFailed: '通行密钥无法解锁此钱包。请使用密码。',
    pkWorking: '等待指纹 / 面容 ID…',
    pkEnabled: '通行密钥已创建：现在可以用指纹 / 面容 ID 解锁。密码仍然可用。',
    pkDisabled: '已关闭通行密钥解锁并删除其加密副本。你也可以在设备的通行密钥设置中删除“ZETAPHY PQ Wallet”通行密钥。',
    pkDisableConfirm: '关闭指纹 / 面容 ID 解锁？之后只能用密码解锁。',
    bigTitle: '余额较大：建议把密钥放在更安全的地方',
    bigLocal: '此账户持有 {amount} ZETAPHY。网页中的密钥只和这个浏览器及电脑一样安全。金额较大时，请把资金转到 ZETAPHY Snap，密钥保存在 MetaMask 内。',
    bigEvm: '已连接的 EVM 账户持有 {amount} ZETAPHY。金额较大时，请通过 MetaMask 或 Rabby 使用硬件钱包（Ledger 或 Trezor）。',
    bigHow: '怎么做',
    bigLater: '7 天内不再显示',
    helpOpen: '如何安全保管较大余额',
    helpTitle: '如何安全保管较大余额',
    helpIntro: '网页中的密钥只和所运行的浏览器及电脑一样安全：钱包解锁时，恶意扩展或恶意软件可以读取它。这里只放少量资金。',
    helpSnapTitle: '原生 PQ 账户：迁移到 ZETAPHY Snap（密钥在 MetaMask 内）',
    helpSnap1: '安装 MetaMask（snap 发布前请用 MetaMask Flask），并备份它的私钥助记词。',
    helpSnap2: '锁定本钱包，然后点击“连接 MetaMask”并批准 ZETAPHY Snap。',
    helpSnap3: '复制显示的 zetaphy1… 地址：这就是在 MetaMask 内生成的新账户。',
    helpSnap4: '用密码再次解锁本钱包，把资金转到该地址。也请在 MetaMask 的对话框中核对地址。',
    helpHwTitle: 'EVM 账户：硬件钱包',
    helpHw1: '将 Ledger 或 Trezor 连接到 MetaMask 或 Rabby（在其中添加硬件钱包账户）。',
    helpHw2: '用本页“在其他钱包中使用 ZETAPHY”部分的按钮添加 ZETAPHY Testnet 网络。',
    helpHw3: '把资金转到硬件账户的 0x… 地址，并在设备自己的屏幕上确认每笔交易。',
    helpMore: '详情见 README 的安全部分。这是测试网，都不是真钱。',
    helpClose: '关闭',
  },
  es: {
    subtitle: 'Billetera resistente a la computación cuántica (ML-DSA-44) · sin clave ECDSA',
    warnTitle: 'Solo testnet',
    warnTestnet: 'La testnet de ZETAPHY no es dinero real. No guardes aquí nada de valor.',
    warnSeed: 'La semilla es la única clave de esta billetera. Si la pierdes u olvidas la contraseña, los fondos se pierden para siempre. Nadie puede recuperarlos.',
    warnLocal: 'La semilla se queda solo en este navegador, cifrada con tu contraseña, y nunca se envía a ningún sitio.',
    rpcLabel: 'URL RPC de tu nodo ZETAPHY (JSON-RPC, puerto 8545)',
    rpcSave: 'Guardar',
    rpcHint: 'Si esta página se abre por https, el RPC también debe ser https (los navegadores bloquean http).',
    setupTitle: 'Empezar',
    modeNew: 'Crear una clave nueva',
    modeImport: 'Importar una semilla',
    seedLabel: 'Semilla (64 dígitos hex, 0x opcional)',
    pass1: 'Elige una contraseña (al menos 12 caracteres, nivel Fuerte)',
    pass2: 'Escribe la contraseña otra vez',
    saveKey: 'Crear billetera',
    lockedTitle: 'Billetera bloqueada',
    unlockLabel: 'Contraseña',
    unlock: 'Desbloquear',
    forget: 'Eliminar la billetera de este navegador',
    accountTitle: 'Tu cuenta',
    sameAccount: 'Ambas son la misma cuenta. Puede recibir fondos en cualquiera de las dos.',
    copy: 'Copiar',
    balance: 'Saldo',
    refresh: 'Actualizar',
    sendTitle: 'Enviar ZETAPHY',
    toLabel: 'Para (0x… o zetaphy1…)',
    amountLabel: 'Cantidad (ZETAPHY)',
    advanced: 'Más ajustes',
    gasLabel: 'Límite de gas',
    review: 'Revisar',
    confirmTitle: 'Confirmar la transferencia',
    cTo: 'Para',
    cAmount: 'Cantidad',
    cFee: 'Comisión máxima',
    cTotal: 'Total',
    confirmSend: 'Confirmar, firmar con ML-DSA y enviar',
    cancel: 'Cancelar',
    txSent: 'Enviado. Hash de la tx:',
    backupTitle: 'Respaldar la semilla',
    backupWarn: 'El archivo de respaldo es la semilla sin cifrar. Quien lo obtenga puede mover los fondos. Guárdalo sin conexión y en un lugar seguro, y nunca lo compartas.',
    backupOk: 'Lo entiendo',
    backup: 'Descargar respaldo de la semilla',
    backupCli: 'El archivo sirve como ~/.zetaphy/pq.seed para el comando zetaphy pq native.',
    lock: 'Bloquear billetera',
    footer: 'Todo el código está en esta página; sin scripts de otros sitios · Las transacciones se firman con ML-DSA-44 (FIPS 204) en el navegador, o en MetaMask con el ZETAPHY Snap',
    working: 'Procesando…',
    deriving: 'Cifrando la semilla (tarda un momento)…',
    created: 'Billetera creada. Descarga el respaldo de la semilla antes de recibir fondos.',
    imported: 'Semilla importada.',
    unlocked: 'Desbloqueada.',
    lockedMsg: 'Bloqueada.',
    badPass: 'Contraseña incorrecta.',
    passShort: 'La contraseña debe tener al menos {n} caracteres.',
    passMismatch: 'Las dos contraseñas no coinciden.',
    badSeed: 'La semilla debe tener 64 dígitos hex.',
    storeFailed: 'Este navegador no puede guardar datos (¿modo privado?). La billetera desaparecerá al cerrar la página: descarga el respaldo.',
    rpcSaved: 'RPC guardado.',
    needRpc: 'Primero introduce la URL RPC de tu nodo.',
    badRpc: 'La URL RPC debe empezar por http:// o https://',
    wrongChain: 'Ese RPC no es la testnet de ZETAPHY (chain id {id}).',
    rpcDown: 'No se puede conectar con el RPC (caído, CORS no permitido o http en una página https).',
    notFunded: 'La cuenta aún no está en la cadena: primero envía ZETAPHY a esta dirección y después podrá enviar.',
    onChain: 'En la cadena (cuenta {n}, {s} txs enviadas).',
    badAddress: 'Dirección del destinatario no válida (revisa la escritura o el checksum).',
    badAmount: 'Cantidad no válida.',
    badGas: 'El límite de gas debe ser un número entero mayor que 0.',
    notEnough: 'Saldo insuficiente: necesitas {need} ZETAPHY (con comisión), tienes {have}.',
    signing: 'Firmando con ML-DSA-44 y enviando…',
    sent: 'Enviado. El nodo la aceptó; entrará en un bloque en unos segundos.',
    rejected: 'El nodo rechazó la transacción',
    copied: 'Copiado.',
    forgetConfirm: '¿Eliminar la billetera de este navegador? Sin un respaldo de la semilla, los fondos se pierden para siempre.',
    forgotten: 'Billetera eliminada de este navegador.',
    backupDone: 'Respaldo descargado. Guárdalo sin conexión.',
    tokenTitle: 'Tokens ERC-20',
    tokenLabel: 'Dirección del contrato del token (0x…)',
    tokenLoad: 'Consultar',
    tokenBalance: 'Saldo del token',
    tokenMeta: '{sym} · {d} decimales · contrato {addr}',
    tokenAmountLabel: 'Cantidad del token',
    evmGasLabel: 'Límite de gas EVM (la comisión cubre este gas más la propia tx)',
    tokenConfirmTitle: 'Confirmar la transferencia del token',
    cToken: 'Token',
    tokenChecked: 'Simulada en el nodo: se completa con éxito (se vuelve a simular justo antes de firmar).',
    tokenNote: 'La comisión se paga en ZETAPHY. Si el contrato hace revert, toda la tx falla y la comisión se paga igualmente, por eso esta página simula cada transferencia antes de firmar.',
    badToken: 'El contrato del token debe ser 0x y 40 dígitos hex (revisa el checksum).',
    noContract: 'No hay ningún contrato en {addr}.',
    notToken: 'Ese contrato no es un token ERC-20 (no tiene decimals()).',
    tokenDecimals: 'La cantidad tiene más de {d} decimales para {sym}.',
    badEvmGas: 'El límite de gas EVM debe ser un número entero entre {min} y {max}.',
    tokenNotEnough: 'Saldo del token insuficiente: envías {need} {sym}, tienes {have}.',
    callFails: 'No enviado: simulada en el nodo, la transferencia fallaría (revert)',
    tokenRefused: 'No enviado: el token rechazó la transferencia (transfer devolvió false).',
    tokenSent: 'Enviado. El nodo la aceptó. (Es una tx de Cosmos, así que sus logs EVM no aparecen en eth_getLogs; los saldos son correctos.)',
    stakeTitle: 'Hacer staking de ZETAPHY',
    validatorLabel: 'Validador (zetaphyvaloper1…)',
    stakeAmountLabel: 'Cantidad (ZETAPHY), no hace falta para reclamar recompensas',
    stake: 'Hacer staking',
    unstake: 'Retirar staking',
    claim: 'Reclamar recompensas',
    confirmStake: 'Confirmar el staking',
    confirmUnstake: 'Confirmar el retiro del staking',
    confirmClaim: 'Confirmar el reclamo de recompensas',
    cValidator: 'Validador',
    unbondNote: 'Los ZETAPHY retirados del staking vuelven tras el período de unbonding de la cadena. Hasta entonces no se pueden usar ni generan recompensas.',
    badValidator: 'El validador debe ser una dirección zetaphyvaloper1… (revisa la escritura o el checksum).',
    staked: 'Staking enviado. El nodo lo aceptó.',
    unstaked: 'Retiro del staking enviado. Los ZETAPHY vuelven tras el período de unbonding.',
    claimed: 'Reclamo enviado. Las recompensas llegan cuando la tx entra en un bloque.',
    ownedTitle: 'Cuentas que controla esta billetera',
    ownedHint: 'Cuentas ECDSA (p. ej., MetaMask) con bloqueo cuántico a esta billetera. Sus propias claves ya no funcionan; esta billetera envía, envía tokens y hace staking por ellas (firmado con ML-DSA-44, comisiones pagadas por esta billetera).',
    ownerLabel: 'Dirección de la cuenta bloqueada (0x… o zetaphy1…)',
    ownerUse: 'Actuar como esta cuenta',
    actingAs: 'Actuando como',
    ownerBalance: 'Su saldo',
    actingHint: 'Los envíos, transferencias de tokens y staking de abajo actúan por esta cuenta (as_owner). Las comisiones salen de esta billetera.',
    ownerStop: 'Volver a mi cuenta',
    ownedMine: 'bloqueada a esta billetera',
    ownedNotMine: 'no bloqueada a esta billetera (o aún no está en un bloque)',
    ownedOther: 'bloqueada a otra cuenta: {to}',
    asTag: 'Por {owner}',
    asNote: 'Por {owner}, que tiene bloqueo cuántico a esta billetera: los fondos y tokens salen de esa cuenta; la comisión la paga esta billetera.',
    nowActing: 'Ahora actúas como {owner}.',
    stopActing: 'De vuelta en tu propia cuenta.',
    ownerNotLocked: 'Esa cuenta no tiene bloqueo cuántico a esta billetera, así que esta billetera no puede actuar por ella.',
    ownerOther: 'Esa cuenta está bloqueada a otra cuenta ({to}), no a esta billetera.',
    ownerSelf: 'Esa es la propia cuenta de esta billetera.',
    ownerNotEnough: 'Esa cuenta no tiene saldo suficiente: necesita {need} ZETAPHY, tiene {have}.',
    mmTitle: 'Bloquear una cuenta de MetaMask a esta billetera',
    mmIntro: 'Cede el control de una cuenta ECDSA de MetaMask a esta billetera resistente a la computación cuántica. Su dirección, saldo, tokens y staking se quedan donde están, pero a partir de ahora solo esta billetera puede moverlos.',
    mmWarnPermanent: 'Permanente, sin vuelta atrás: tras el bloqueo, la cadena rechaza toda transacción firmada con la clave de MetaMask de esa cuenta, y los contratos dejan de aceptar sus firmas (p. ej., permits).',
    mmWarnSeed: 'Si pierdes la semilla de esta billetera, también pierdes la cuenta bloqueada. Descarga primero el respaldo de la semilla.',
    mmWarnTx: 'Esta billetera debe haber enviado al menos una transacción en la cadena (para que la cadena conozca su clave pública ML-DSA-44).',
    mmOk: 'Entiendo que el bloqueo es permanente',
    mmLock: 'Conectar MetaMask y bloquear',
    mmSentLabel: 'MetaMask envió el bloqueo. Hash de la tx:',
    mmConfirm: '¿Bloquear para siempre la cuenta de MetaMask {owner} a esta billetera ({me})?\n\nSu clave de MetaMask nunca volverá a funcionar en ZETAPHY, y si se pierde la semilla de esta billetera, también se pierde esa cuenta.',
    mmMissing: 'No se encontró MetaMask (window.ethereum) en este navegador.',
    mmDenied: 'MetaMask no permitió conectar una cuenta.',
    mmRejected: 'Rechazado en MetaMask. No se envió nada.',
    mmWrongChain: 'MetaMask no está en la testnet de ZETAPHY (chain id {id}). Cambia primero de red en MetaMask.',
    mmNeedTx: 'Esta billetera aún no ha enviado ninguna transacción: envía una primero (p. ej., a sí misma) y luego la cadena la aceptará como controladora.',
    mmSelfLocked: 'Esta billetera está a su vez bloqueada a otra cuenta, así que no puede ser controladora.',
    mmAlreadyLocked: 'Esa cuenta de MetaMask ya está bloqueada a {to}.',
    mmAlreadyMine: 'Esa cuenta de MetaMask ya está bloqueada a esta billetera.',
    mmCancelled: 'Cancelado. No se envió nada.',
    mmSent: 'MetaMask envió el bloqueo. Cuando esté en un bloque, la cuenta aparecerá en la lista de arriba.',
    mmWarnSeedSnap: 'Si pierdes tu Frase secreta de recuperación de MetaMask, también pierdes la cuenta bloqueada.',
    qdTitle: 'Prepárate para el Q-day',
    qdIntro: 'El Q-day es cuando la red deja de confiar en las firmas ECDSA (claves tipo MetaMask), porque una computadora cuántica podría falsificarlas. A partir de entonces, una cuenta ECDSA que no se haya migrado queda congelada (sus fondos siguen ahí, pero no puede enviar). Lo más seguro es bloquear tu cuenta de MetaMask a esta billetera antes de esa fecha (la tarjeta de arriba).',
    qdCheck: 'Comprobar mi cuenta de MetaMask',
    qdNone: 'Q-day: sin programar (la red lo anuncia mediante votación, con mucha antelación).',
    qdScheduled: 'Q-day: bloque {h} (ahora {now}). A partir de entonces se rechazan las transacciones firmadas con ECDSA.',
    qdPassed: 'El Q-day ya pasó (bloque {h}): se rechazan las transacciones firmadas con ECDSA.',
    qdOff: 'El núcleo de seguridad no está activado en este nodo.',
    qdPQ: '{acct}: ya es una cuenta ML-DSA-44; no hay nada que hacer.',
    qdMigrated: '{acct}: migrada; su controladora es {to}.',
    qdPending: '{acct}: migrando a {to}, definitivo en el bloque {h}.',
    qdExposed: '{acct}: no migrada, y su clave pública ya se usó en la cadena. Bloquéala antes del Q-day (la tarjeta de arriba) o quedará congelada.',
    qdUnexposed: '{acct}: no migrada, pero su clave nunca se usó en la cadena. Bloquéala ahora (recomendado) o, tras el Q-day, muévela con el commit–reveal de abajo.',
    qdRecoverWarn: 'Atención: el texto que MetaMask te pide firmar en estos dos pasos da el control total de {acct} a {ctrl} (la cuenta ML-DSA-44 de esta billetera). Comprueba que su línea "New ML-DSA-44 controller" sea {ctrl}, y firma este texto solo en la billetera oficial de ZETAPHY. Cualquier otro sitio que te pida firmar un texto "ZETAPHY Q-day migration" puede quedarse con la cuenta.',
    qdRecoverIntro: 'Recuperar tras el Q-day (solo claves nunca usadas en la cadena): MetaMask firma un texto localmente y no envía nada. Esta billetera registra un compromiso (paso 1), espera {d} bloques y luego lo revela (paso 2); {d} bloques después, la cuenta es de esta billetera.',
    qdCommit: 'Paso 1: registrar el compromiso',
    qdReveal: 'Paso 2: revelar',
    qdCommitted: 'Compromiso registrado. Revela a partir del bloque {h}.',
    qdAlready: 'Este compromiso se registró en el bloque {h}: revela a partir del bloque {r}.',
    qdNoCommit: 'Aún no hay compromiso: haz primero el paso 1.',
    qdTooEarly: 'Demasiado pronto: revela a partir del bloque {h} (ahora {now}).',
    qdNotYet: 'La revelación se abre en el Q-day. Antes de eso, bloquea la cuenta desde MetaMask (la tarjeta de arriba).',
    qdRevealed: 'Revelado: la cuenta pasa a ser de esta billetera en el bloque final.',
    qdCannot: 'Esta cuenta no puede usar commit–reveal (ya está migrada o su clave se usó en la cadena).',
    csTitle: 'Dar consentimiento a un contrato marcado',
    csIntro: 'Con la barrera de amenazas activa, la red no entrega una transacción a un contrato con una marca Neuro aplicada a menos que la propia cuenta dé su consentimiento (una transacción, como máximo un día). Es consentimiento, no censura: puedes seguir adelante, pero lee primero el motivo de la marca.',
    csTarget: 'Contrato (0x…)',
    csSeconds: 'Durante cuánto tiempo',
    csOk: 'He leído el motivo de la marca y asumo el riesgo',
    csSend: 'Enviar consentimiento desde esta billetera',
    csSendMM: 'Enviar consentimiento desde MetaMask',
    csSent: 'Consentimiento enviado. Hash de la tx:',
    csBad: 'Introduce la dirección del contrato: 0x y 40 dígitos hex.',
    threatConsented: 'Atención: {addr} tiene una marca aplicada ({what} · motivo: {reason}), pero diste tu consentimiento, así que se puede enviar. · {details}',
    snapTitle: 'Usar MetaMask (ZETAPHY Snap)',
    snapIntro: 'La clave ML-DSA-44 se genera dentro de MetaMask a partir de tu Frase secreta de recuperación; esta página nunca la ve. MetaMask muestra cada transacción en lenguaje claro antes de firmarla.',
    snapFlask: 'Hasta que el snap se publique y MetaMask lo revise, solo se instala en MetaMask Flask (la versión para desarrolladores).',
    snapIdLabel: 'ID del snap (npm:@zetaphy/snap, o local:http://localhost:8080 en desarrollo)',
    snapIdHint: 'La cuenta depende del ID del snap: el mismo snap siempre da la misma cuenta (recuperable con la Frase secreta de recuperación); un snap local:… da otra distinta.',
    snapConnect: 'Conectar MetaMask',
    snapConnected: 'Conectado a MetaMask (ZETAPHY Snap).',
    snapMode: 'La clave está en MetaMask (ZETAPHY Snap), no en esta página. Tu Frase secreta de recuperación de MetaMask es su respaldo.',
    snapDisconnect: 'Desconectar MetaMask de esta página',
    snapDisconnected: 'MetaMask desconectado de esta página (el snap sigue instalado en MetaMask).',
    snapBadId: 'El ID del snap debe ser npm:<package> o local:http://localhost:<port>.',
    snapDenied: 'MetaMask no instaló ni permitió el snap.',
    snapUnsupported: 'Este MetaMask no puede ejecutar snaps (usa MetaMask Flask o una versión con snaps).',
    snapBadAccount: 'El snap respondió con una cuenta que no coincide con su clave pública, así que no se usa.',
    snapConfirm: 'Revisa los detalles y aprueba en la ventana de MetaMask…',
    snapRejected: 'Rechazado en MetaMask. No se firmó ni envió nada.',
    snapMismatch: 'El snap firmó una transacción distinta de la solicitada, así que no se envió nada.',
    deployTitle: 'Desplegar un contrato',
    initCodeLabel: 'Bytecode de creación (hex, con los argumentos del constructor)',
    deployConfirmTitle: 'Confirmar la creación del contrato',
    cCodeSize: 'Tamaño del código',
    cCodeHash: 'Hash del código (keccak-256)',
    bytesN: '{n} bytes',
    deployChecked: 'Simulada en el nodo: se completa con éxito (se vuelve a simular justo antes de firmar). Compara el hash del código con el que publicó el autor del contrato. Crear un contrato no tiene destino, así que no se comprueba contra el ThreatRegistry.',
    deployedAt: 'Dirección del nuevo contrato:',
    badInitCode: 'El bytecode debe ser hex no vacío (0x…).',
    deploySent: 'Enviado. El nodo lo aceptó; el contrato existirá cuando la tx entre en un bloque.',
    walletsTitle: 'Usar ZETAPHY en otras billeteras',
    walletsIntro: 'Añade la red ZETAPHY Testnet a la billetera que ya usas (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap, …) con los botones de abajo, o escribe los valores tú mismo. Todo proviene de la URL RPC de arriba.',
    evmWalletsTitle: 'Billeteras EVM en este navegador',
    evmNone: 'No se encontró ninguna billetera EVM en este navegador. Instala una extensión (MetaMask, Rabby, Trust, OKX, Coinbase Wallet, …) o, en el móvil, abre esta página en el navegador de tu app de billetera.',
    evmAdd: 'Añadir ZETAPHY a esta billetera',
    evmConnect: 'Conectar esta billetera',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (billeteras móviles cuando esta página está abierta en otro navegador, p. ej., Binance Wallet) está desactivado: primero necesita un projectId de Reown.',
    wcOn: 'Hay un projectId configurado, pero esta página aún no incluye WalletConnect (es el siguiente paso).',
    wcNotYet: 'Esta página aún no incluye WalletConnect (es el siguiente paso). Mientras tanto, en el móvil abre esta página en el navegador de tu app de billetera.',
    wcIdLabel: 'projectId de WalletConnect (de Reown, 32 dígitos hex)',
    wcIdHint: 'Gratis en cloud.reown.com. Configúralo aquí (se recuerda en este navegador) o, para todos, en la etiqueta meta zetaphy-walletconnect-project-id de index.html.',
    wcSaved: 'projectId guardado.',
    wcBadId: 'El projectId debe tener 32 dígitos hex.',
    manualTitle: 'Añadir la red a mano: los valores a introducir',
    mNetwork: 'Nombre de la red',
    mRpc: 'URL RPC',
    mChainId: 'ID de cadena',
    mSymbol: 'Símbolo de la moneda',
    mDecimals: 'Decimales',
    mExplorer: 'Explorador de bloques',
    mNone: 'ninguno (dejar vacío)',
    mRpcUnset: '(primero introduce arriba una URL RPC https)',
    mSymbolNote: '{sym} es ZETAPHY: MetaMask y chainlist aceptan un símbolo de 6 letras como máximo, así que las billeteras EVM muestran el saldo como {sym}. No importes el token en {precompile}: es la misma moneda (verías el saldo dos veces).',
    cosmosTitle: 'Billeteras Cosmos (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'Muestran la dirección zetaphy1… de la misma cuenta que en una billetera EVM (clave eth_secp256k1, coin type 60). Necesitan la dirección https del nodo, que sirva /rpc y /rest (los nodos instalados con setup-node.sh lo hacen).',
    keplrAdd: 'Añadir a Keplr',
    leapAdd: 'Añadir a Leap',
    cosmostationAdd: 'Añadir a Cosmostation',
    supportTitle: 'Qué billeteras funcionan',
    supWorks: 'Funcionan ya (redes personalizadas): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame, y Ledger/Trezor a través de ellas. Keplr, Leap y Cosmostation con los botones de arriba.',
    supMaybe: 'Pueden funcionar (sin confirmar): Binance Wallet, dentro de la app de Binance, si acepta la red; fuera de la app necesita WalletConnect.',
    supNot: 'No hasta que la propia billetera añada ZETAPHY: Phantom y las billeteras con una lista fija de cadenas.',
    supNever: 'Nunca: billeteras solo de Solana o solo de Bitcoin. No son billeteras EVM ni Cosmos.',
    supPq: 'Resistentes a la computación cuántica: solo la clave ML-DSA-44 propia de esta página y el ZETAPHY Snap. Todas las demás billeteras firman con ECDSA (secp256k1), que una computadora cuántica lo bastante grande puede romper; bloquea esa cuenta a esta billetera para protegerla.',
    usingWallet: 'Billetera en uso: {name}',
    usingNone: 'Aún no se encontró ninguna billetera EVM en este navegador.',
    changeWallet: 'Elegir otra billetera',
    inApp: 'Esta página está abierta en el navegador integrado de {name}: los botones de abajo lo usan.',
    mobileNoWallet: 'En el móvil: abre esta página en el navegador de tu app de billetera (usa un enlace de abajo o copia la dirección de esta página en la pestaña Navegador de la app).',
    phantomNote: 'Phantom no permite añadir redes: solo admite las cadenas que Phantom eligió, así que no puede usar ZETAPHY hasta que Phantom la añada. Usa otra billetera (MetaMask, Rabby, Trust, OKX, Coinbase).',
    binanceNote: 'Puede que Binance Wallet aún no acepte redes nuevas. Si falla al añadirla, escribe los valores de abajo a mano o usa otra billetera.',
    evmMissing: 'No se encontró ninguna billetera EVM en este navegador.',
    evmRejected: 'Cancelado en la billetera.',
    evmDenied: 'La billetera no permitió conectar una cuenta.',
    chainNeedHttps: 'Las billeteras solo aceptan una URL RPC https (o localhost). Introduce arriba la dirección https del nodo, p. ej., https://1-2-3-4.sslip.io',
    chainAdding: 'Aprueba añadir ZETAPHY Testnet en la ventana de {name}…',
    chainAdded: 'ZETAPHY Testnet añadida a {name} y seleccionada.',
    chainAddedNoSwitch: 'ZETAPHY Testnet añadida a {name}, pero no seleccionada: elige la red en la billetera.',
    addChainUnsupported: '{name} no añadió la red ({why}). Puede que aún no acepte redes nuevas: escribe los valores de abajo en la billetera a mano o usa otra billetera.',
    evmConnected: 'Conectado a {name}.',
    evmOnZetaphy: 'En ZETAPHY Testnet.',
    evmOtherChain: 'En otra red (chain id {id}): pulsa "Añadir ZETAPHY a esta billetera".',
    evmBalance: 'Saldo {amount} ZETAPHY',
    cosmosMissing: 'No se encontró {name} en este navegador.',
    cosmosAdding: 'Aprueba en la ventana de {name}…',
    cosmosRejected: '{name} no añadió la red ({why}).',
    cosmosAdded: 'ZETAPHY Testnet añadida a {name}. Tu dirección está abajo.',
    cosmosBadAddress: 'La billetera respondió con una dirección que no es zetaphy1…, así que no se usa.',
    walletPicked: '{name} seleccionada.',
    snapNotMetaMask: '{name} no puede ejecutar MetaMask Snaps. Elige MetaMask (o MetaMask Flask) en "Usar ZETAPHY en otras billeteras" más abajo.',
    threatLabel: 'ThreatRegistry (sistema inmunitario: nunca firmar transacciones hacia código marcado)',
    threatHint: 'Su dirección 0x… en ZETAPHY (se recuerda en este navegador) o, para todos, en la etiqueta meta zetaphy-threat-registry de index.html. Vacío = la etiqueta meta.',
    threatSaved: 'Dirección del ThreatRegistry guardada.',
    threatBadAddress: 'La dirección del ThreatRegistry debe ser 0x y 40 dígitos hex.',
    threatFlagged: 'No firmado: {addr} está marcado por el sistema inmunitario de ZETAPHY ({what} · motivo: {reason}). Esta billetera no envía transacciones a código cuya marca esté aplicada a menos que primero des tu consentimiento (tarjeta "Dar consentimiento a un contrato marcado"). · {details}',
    threatUnchecked: 'No firmado: no se pudo comprobar {addr} contra el ThreatRegistry {reg}. Con un ThreatRegistry configurado, sin comprobación no hay envío.',
    threatUnset: 'Código de destino NO comprobado: no hay dirección de ThreatRegistry configurada (ajustes avanzados bajo el campo RPC).',
    threatClean: 'Comprobado contra el ThreatRegistry: el destino no está marcado (en la medida de lo posible: la dirección, su código y el código detrás de un proxy EIP-1967 / beacon / EIP-1167; se comprueba otra vez antes de firmar).',
    threatWarned: 'Atención: los runners de Neuro marcaron {addr} ({what} · motivo: {reason}), pero la marca aún no se aplica (la gobernanza todavía puede revisarla). Esta billetera lo rechazará cuando se aplique (una marca puesta por una supermayoría de runners o por la gobernanza por la vía rápida se aplica de inmediato); enviar ahora es decisión tuya. · {details}',
    threatNewWarning: 'No firmado: {addr} fue marcado después de que lo revisaras ({what} · motivo: {reason}). Revísalo otra vez para ver la advertencia. · {details}',
    threatBehind: '{impl} (el código detrás del proxy {proxy})',
    threatWhatFingerprint: 'la huella de su código (fp1) coincide con código marcado',
    threatWhatCode: 'su código es idéntico byte a byte a código marcado',
    threatWhatAddress: 'esta dirección está marcada',
    reason1: 'en una operación simulada, la compra funcionó pero la venta falló o devolvió casi nada',
    reason2: 'una dirección puede acuñar tokens nuevos sin límite',
    reason3: 'un propietario o administrador puede impedir que los holders transfieran o vendan',
    reason4: 'un propietario o administrador puede mover o quemar tokens o fondos de otros',
    reason5: 'usa el mismo nombre o símbolo que un token conocido, en otra dirección',
    reason6: 'en una prueba reproducible, movió tokens aprobados a su favor (approve) a una dirección que el holder no eligió',
    reason7: 'otro hecho del código (ver la evidencia)',
    threatEvidence: 'Evidencia: reportHash {hash}{uri} · reproducir: ejecuta Neuro sobre el mismo código (zetaphy-neuro: node cli.js <chain> <address> --json) y compara el reportHash',
    threatNoEvidence: 'Evidencia: no hay ninguna guardada',
    threatEvidenceUnread: 'Evidencia: no se pudo leer',
    threatResponse: 'Respuesta de {by}: "{text}"',
    threatResponseAssigned: 'Respuesta del respondedor asignado por la gobernanza ({by}): "{text}"',
    threatNoResponse: 'Aún no hay respuesta',
    threatDisclaimer: 'Análisis automático de código, no una acusación',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'Consejo: cuatro o cinco palabras al azar y sin relación forman una contraseña fuerte y fácil de recordar.',
    passWeak: 'Esta contraseña es demasiado fácil de adivinar (nivel {label}). Debe tener al menos nivel Fuerte',
    pwStrength: 'Seguridad: {label}',
    pwVeryWeak: 'muy débil',
    pwWeak: 'débil',
    pwFair: 'aceptable',
    pwStrong: 'fuerte',
    pwVeryStrong: 'muy fuerte',
    pwLength: 'Usa al menos {n} caracteres; cuanto más larga, mejor.',
    pwCommon: 'Es una de las contraseñas más comunes.',
    pwDictionary: 'Contiene una contraseña o palabra común.',
    pwSequence: 'Contiene una secuencia como abc, 321 o qwerty.',
    pwRepeat: 'Contiene caracteres o patrones repetidos.',
    pwContext: 'Contiene «zetaphy», «wallet» o parte de tu dirección.',
    pwYear: 'Contiene un año.',
    pwVariety: 'Añade más palabras, o mezcla mayúsculas, minúsculas, números y símbolos.',
    weakNudge: 'Tu contraseña es débil (nivel {label}). Quien copie los datos de este navegador podría adivinarla. Cámbiala por una más fuerte.',
    weakNudgeGo: 'Cambiarla ahora',
    secTitle: 'Seguridad',
    autoLockLabel: 'Bloquear automáticamente tras este tiempo sin actividad, o en una pestaña en segundo plano',
    nMinutes: '{n} min',
    autoLockIn: 'Se bloquea automáticamente en {time} sin actividad.',
    autoLocked: 'Bloqueada automáticamente tras {n} min sin actividad. La clave se borró de la memoria.',
    autoLockSaved: 'Bloqueo automático: {n} min.',
    lockedErr: 'La billetera está bloqueada. Desbloquéala primero; no se firmó nada.',
    chpwTitle: 'Cambiar la contraseña',
    chpwOld: 'Contraseña actual',
    chpwNew: 'Nueva contraseña (al menos 12 caracteres, nivel Fuerte)',
    chpwSave: 'Cambiar contraseña',
    chpwDone: 'Contraseña cambiada.',
    pkTitle: 'Desbloquear con huella / Face ID (llave de acceso)',
    pkIntro: 'Crea una llave de acceso (passkey) para este sitio en este dispositivo. Su secreto PRF, que solo se entrega tras tu huella, tu cara o el PIN del dispositivo, cifra una segunda copia de la semilla en este navegador. La contraseña sigue sirviendo como respaldo.',
    pkSyncNote: 'Las llaves de acceso pueden sincronizarse con el Llavero de iCloud, el Gestor de contraseñas de Google u otro gestor, así que esta llave puede estar también en tus otros dispositivos. Protege bien esa cuenta.',
    pkEnable: 'Activar desbloqueo con huella / Face ID',
    pkDisable: 'Desactivar desbloqueo con huella / Face ID',
    pkUnlock: 'Desbloquear con huella / Face ID',
    pkOn: 'El desbloqueo con huella / Face ID está activado. La contraseña sigue funcionando.',
    pkOff: 'El desbloqueo con huella / Face ID está desactivado.',
    pkOtherSite: 'La llave de acceso se creó para {host}. Aquí usa tu contraseña.',
    pkUnsupported: 'Este navegador no puede usar llaves de acceso en esta página. Sigue usando tu contraseña.',
    pkNoPlatform: 'No se encontró en este dispositivo un autenticador con huella, cara o PIN. Sigue usando tu contraseña.',
    pkNoPrf: 'Este navegador o gestor de llaves de acceso no admite la extensión PRF necesaria, así que aquí una llave de acceso no puede desbloquear la billetera. Sigue usando tu contraseña.',
    pkCancelled: 'Cancelado o tiempo agotado. No cambió nada.',
    pkFailed: 'La llave de acceso no desbloqueó esta billetera. Usa tu contraseña.',
    pkWorking: 'Esperando tu huella / Face ID…',
    pkEnabled: 'Llave de acceso creada: ya puedes desbloquear con huella / Face ID. La contraseña sigue funcionando.',
    pkDisabled: 'Desbloqueo con llave de acceso desactivado y su copia cifrada borrada. También puedes borrar la llave «ZETAPHY PQ Wallet» en los ajustes de llaves de acceso del dispositivo.',
    pkDisableConfirm: '¿Desactivar el desbloqueo con huella / Face ID? Solo podrás desbloquear con la contraseña.',
    bigTitle: 'Saldo alto: considera un lugar más seguro para la clave',
    bigLocal: 'Esta cuenta tiene {amount} ZETAPHY. Una clave en una página web es tan segura como este navegador y este equipo. Para montos grandes, mueve los fondos a la ZETAPHY Snap, donde la clave queda dentro de MetaMask.',
    bigEvm: 'La cuenta EVM conectada tiene {amount} ZETAPHY. Para montos grandes, usa una billetera de hardware (Ledger o Trezor) a través de MetaMask o Rabby.',
    bigHow: 'Cómo hacerlo',
    bigLater: 'Ocultar 7 días',
    helpOpen: 'Cómo proteger un saldo alto',
    helpTitle: 'Cómo proteger un saldo alto',
    helpIntro: 'Una clave en una página web es tan segura como el navegador y el equipo donde se ejecuta: una extensión maliciosa o un malware puede leerla mientras la billetera está desbloqueada. Guarda aquí solo montos pequeños.',
    helpSnapTitle: 'Cuenta PQ nativa: pásate a la ZETAPHY Snap (clave dentro de MetaMask)',
    helpSnap1: 'Instala MetaMask (MetaMask Flask hasta que se publique la snap) y respalda su frase secreta de recuperación.',
    helpSnap2: 'Bloquea esta billetera, pulsa «Conectar MetaMask» y aprueba la ZETAPHY Snap.',
    helpSnap3: 'Copia la dirección zetaphy1… que aparece: es la cuenta nueva, creada dentro de MetaMask.',
    helpSnap4: 'Desbloquea de nuevo esta billetera con su contraseña y envía los fondos a esa dirección. Comprueba la dirección también en el cuadro de MetaMask.',
    helpHwTitle: 'Cuentas EVM: una billetera de hardware',
    helpHw1: 'Conecta un Ledger o Trezor a MetaMask o Rabby (añade allí una cuenta de billetera de hardware).',
    helpHw2: 'Añade la red ZETAPHY Testnet con los botones de «Usar ZETAPHY en otras billeteras» de esta página.',
    helpHw3: 'Envía los fondos a la dirección 0x… de la cuenta de hardware y confirma cada transacción en la propia pantalla del dispositivo.',
    helpMore: 'La sección de seguridad del README tiene los detalles. Esto es testnet: nada es dinero real.',
    helpClose: 'Cerrar',
  },
  ko: {
    subtitle: '양자 내성 지갑 (ML-DSA-44) · ECDSA 키 없음',
    warnTitle: '테스트넷 전용',
    warnTestnet: 'ZETAPHY 테스트넷은 실제 돈이 아닙니다. 가치 있는 자산을 여기에 두지 마세요.',
    warnSeed: '시드는 이 지갑의 유일한 키입니다. 시드를 잃어버리거나 비밀번호를 잊으면 자금은 영구히 사라지며, 누구도 복구할 수 없습니다.',
    warnLocal: '시드는 비밀번호로 암호화되어 이 브라우저에만 저장되며, 어디로도 전송되지 않습니다.',
    rpcLabel: 'ZETAPHY 노드 RPC URL (JSON-RPC, 포트 8545)',
    rpcSave: '저장',
    rpcHint: '이 페이지를 https로 열었다면 RPC도 https여야 합니다 (브라우저가 http를 차단합니다).',
    setupTitle: '시작하기',
    modeNew: '새 키 만들기',
    modeImport: '시드 가져오기',
    seedLabel: '시드 (16진수 64자리, 0x는 선택)',
    pass1: '비밀번호 설정 (12자 이상, "강함" 등급 이상)',
    pass2: '비밀번호 다시 입력',
    saveKey: '지갑 만들기',
    lockedTitle: '지갑 잠김',
    unlockLabel: '비밀번호',
    unlock: '잠금 해제',
    forget: '이 브라우저에서 지갑 삭제',
    accountTitle: '내 계정',
    sameAccount: '두 주소는 같은 계정입니다. 어느 주소로든 자금을 받을 수 있습니다.',
    copy: '복사',
    balance: '잔액',
    refresh: '새로고침',
    sendTitle: 'ZETAPHY 보내기',
    toLabel: '받는 주소 (0x… 또는 zetaphy1…)',
    amountLabel: '수량 (ZETAPHY)',
    advanced: '추가 설정',
    gasLabel: '가스 한도',
    review: '검토',
    confirmTitle: '송금 확인',
    cTo: '받는 주소',
    cAmount: '수량',
    cFee: '최대 수수료',
    cTotal: '합계',
    confirmSend: '확인, ML-DSA로 서명 후 전송',
    cancel: '취소',
    txSent: '전송됨. 트랜잭션 해시:',
    backupTitle: '시드 백업',
    backupWarn: '백업 파일은 암호화되지 않은 시드입니다. 이 파일을 가진 사람은 누구나 자금을 옮길 수 있습니다. 오프라인에 안전하게 보관하고 절대 공유하지 마세요.',
    backupOk: '이해했습니다',
    backup: '시드 백업 다운로드',
    backupCli: '이 파일은 zetaphy pq native 명령의 ~/.zetaphy/pq.seed로 사용할 수 있습니다.',
    lock: '지갑 잠그기',
    footer: '모든 코드는 이 페이지 안에 있으며 외부 스크립트를 쓰지 않습니다 · 트랜잭션은 브라우저에서 ML-DSA-44 (FIPS 204)로, 또는 ZETAPHY Snap을 통해 MetaMask에서 서명됩니다',
    working: '처리 중…',
    deriving: '시드 암호화 중 (잠시 걸립니다)…',
    created: '지갑이 생성되었습니다. 자금을 받기 전에 시드 백업을 다운로드하세요.',
    imported: '시드를 가져왔습니다.',
    unlocked: '잠금 해제됨.',
    lockedMsg: '잠김.',
    badPass: '비밀번호가 틀렸습니다.',
    passShort: '비밀번호는 {n}자 이상이어야 합니다.',
    passMismatch: '두 비밀번호가 일치하지 않습니다.',
    badSeed: '시드는 16진수 64자리여야 합니다.',
    storeFailed: '이 브라우저는 데이터를 저장할 수 없습니다 (시크릿 모드?). 페이지를 닫으면 지갑이 사라지니 백업을 다운로드하세요.',
    rpcSaved: 'RPC가 저장되었습니다.',
    needRpc: '먼저 노드 RPC URL을 입력하세요.',
    badRpc: 'RPC URL은 http:// 또는 https://로 시작해야 합니다',
    wrongChain: '이 RPC는 ZETAPHY 테스트넷이 아닙니다 (chain id {id}).',
    rpcDown: 'RPC에 연결할 수 없습니다 (다운, CORS 미허용, 또는 https 페이지에서 http 사용).',
    notFunded: '이 계정은 아직 온체인에 없습니다: 먼저 이 주소로 ZETAPHY를 보내야 송금할 수 있습니다.',
    onChain: '온체인 (계정 {n}, 보낸 트랜잭션 {s}건).',
    badAddress: '받는 주소가 올바르지 않습니다 (철자나 체크섬을 확인하세요).',
    badAmount: '수량이 올바르지 않습니다.',
    badGas: '가스 한도는 0보다 큰 정수여야 합니다.',
    notEnough: '잔액 부족: 수수료 포함 {need} ZETAPHY가 필요하지만 {have} 보유 중입니다.',
    signing: 'ML-DSA-44로 서명하고 전송 중…',
    sent: '전송됨. 노드가 수락했으며 몇 초 안에 블록에 포함됩니다.',
    rejected: '노드가 트랜잭션을 거부했습니다',
    copied: '복사됨.',
    forgetConfirm: '이 브라우저에서 지갑을 삭제할까요? 시드 백업이 없으면 자금을 영구히 잃습니다.',
    forgotten: '이 브라우저에서 지갑을 삭제했습니다.',
    backupDone: '백업을 다운로드했습니다. 오프라인에 보관하세요.',
    tokenTitle: 'ERC-20 토큰',
    tokenLabel: '토큰 컨트랙트 주소 (0x…)',
    tokenLoad: '조회',
    tokenBalance: '토큰 잔액',
    tokenMeta: '{sym} · 소수점 {d}자리 · 컨트랙트 {addr}',
    tokenAmountLabel: '토큰 수량',
    evmGasLabel: 'EVM 가스 한도 (수수료는 이 가스와 트랜잭션 자체에 대한 것)',
    tokenConfirmTitle: '토큰 전송 확인',
    cToken: '토큰',
    tokenChecked: '노드에서 시뮬레이션: 성공합니다 (서명 직전에 다시 시뮬레이션합니다).',
    tokenNote: '수수료는 ZETAPHY로 지불됩니다. 컨트랙트가 revert되면 트랜잭션 전체가 실패해도 수수료는 지불되므로, 이 페이지는 서명 전에 모든 전송을 시뮬레이션합니다.',
    badToken: '토큰 컨트랙트는 0x와 16진수 40자리여야 합니다 (체크섬을 확인하세요).',
    noContract: '{addr}에 컨트랙트가 없습니다.',
    notToken: '이 컨트랙트는 ERC-20 토큰이 아닙니다 (decimals() 없음).',
    tokenDecimals: '{sym}의 수량이 소수점 {d}자리를 초과합니다.',
    badEvmGas: 'EVM 가스 한도는 {min}에서 {max} 사이의 정수여야 합니다.',
    tokenNotEnough: '토큰 잔액 부족: {need} {sym}를 보내려 하지만 {have} 보유 중입니다.',
    callFails: '전송 안 됨: 노드에서 시뮬레이션한 결과 전송이 실패합니다 (revert)',
    tokenRefused: '전송 안 됨: 토큰이 전송을 거부했습니다 (transfer가 false 반환).',
    tokenSent: '전송됨. 노드가 수락했습니다. (Cosmos 트랜잭션이므로 EVM 로그는 eth_getLogs에 나타나지 않지만 잔액은 정확합니다.)',
    stakeTitle: 'ZETAPHY 스테이킹',
    validatorLabel: '검증인 (zetaphyvaloper1…)',
    stakeAmountLabel: '수량 (ZETAPHY), 보상 수령 시에는 필요 없음',
    stake: '스테이킹',
    unstake: '언스테이킹',
    claim: '보상 수령',
    confirmStake: '스테이킹 확인',
    confirmUnstake: '언스테이킹 확인',
    confirmClaim: '보상 수령 확인',
    cValidator: '검증인',
    unbondNote: '언스테이킹한 ZETAPHY는 체인의 언본딩 기간이 끝난 뒤 돌아옵니다. 그때까지는 사용할 수 없고 보상도 없습니다.',
    badValidator: '검증인은 zetaphyvaloper1… 주소여야 합니다 (철자나 체크섬을 확인하세요).',
    staked: '스테이킹을 보냈습니다. 노드가 수락했습니다.',
    unstaked: '언스테이킹을 보냈습니다. ZETAPHY는 언본딩 기간 후 돌아옵니다.',
    claimed: '보상 수령을 보냈습니다. 트랜잭션이 블록에 포함되면 보상이 도착합니다.',
    ownedTitle: '이 지갑이 제어하는 계정',
    ownedHint: '이 지갑에 퀀텀 잠금된 ECDSA 계정 (예: MetaMask). 해당 계정의 자체 키는 더 이상 작동하지 않으며, 이 지갑이 대신 송금, 토큰 전송, 스테이킹을 합니다 (ML-DSA-44로 서명, 수수료는 이 지갑이 지불).',
    ownerLabel: '잠금된 계정 주소 (0x… 또는 zetaphy1…)',
    ownerUse: '이 계정으로 작업',
    actingAs: '현재 작업 계정',
    ownerBalance: '해당 계정 잔액',
    actingHint: '아래의 송금, 토큰 전송, 스테이킹은 이 계정을 대신해 실행됩니다 (as_owner). 수수료는 이 지갑에서 나갑니다.',
    ownerStop: '내 계정으로 돌아가기',
    ownedMine: '이 지갑에 잠금됨',
    ownedNotMine: '이 지갑에 잠금되지 않음 (또는 아직 블록에 포함되지 않음)',
    ownedOther: '다른 계정에 잠금됨: {to}',
    asTag: '{owner} 대신',
    asNote: '이 지갑에 퀀텀 잠금된 {owner}를 대신합니다: 자금과 토큰은 그 계정에서 나가고, 수수료는 이 지갑이 지불합니다.',
    nowActing: '이제 {owner}로 작업합니다.',
    stopActing: '내 계정으로 돌아왔습니다.',
    ownerNotLocked: '이 계정은 이 지갑에 퀀텀 잠금되지 않았으므로 이 지갑이 대신 작업할 수 없습니다.',
    ownerOther: '이 계정은 이 지갑이 아닌 다른 계정({to})에 잠금되어 있습니다.',
    ownerSelf: '이 지갑 자신의 계정입니다.',
    ownerNotEnough: '해당 계정의 잔액이 부족합니다: {need} ZETAPHY 필요, {have} 보유.',
    mmTitle: 'MetaMask 계정을 이 지갑에 잠그기',
    mmIntro: 'MetaMask의 ECDSA 계정 제어권을 이 양자 내성 지갑에 넘깁니다. 주소, 잔액, 토큰, 스테이킹은 그대로 유지되지만 이제부터는 이 지갑만 옮길 수 있습니다.',
    mmWarnPermanent: '영구적이며 되돌릴 수 없습니다: 잠금 후 체인은 해당 계정의 MetaMask 키로 서명한 모든 트랜잭션을 거부하고, 컨트랙트도 그 서명(예: permit)을 더 이상 받지 않습니다.',
    mmWarnSeed: '이 지갑의 시드를 잃으면 잠금된 계정도 함께 잃습니다. 먼저 시드 백업을 다운로드하세요.',
    mmWarnTx: '이 지갑은 온체인에서 트랜잭션을 최소 한 번 보낸 적이 있어야 합니다 (체인이 ML-DSA-44 공개키를 알 수 있도록).',
    mmOk: '잠금이 영구적임을 이해했습니다',
    mmLock: 'MetaMask 연결 후 잠그기',
    mmSentLabel: 'MetaMask가 잠금을 보냈습니다. 트랜잭션 해시:',
    mmConfirm: 'MetaMask 계정 {owner}를 이 지갑({me})에 영구히 잠글까요?\n\n해당 MetaMask 키는 ZETAPHY에서 다시는 작동하지 않으며, 이 지갑의 시드를 잃으면 그 계정도 잃게 됩니다.',
    mmMissing: '이 브라우저에서 MetaMask (window.ethereum)를 찾을 수 없습니다.',
    mmDenied: 'MetaMask가 계정 연결을 허용하지 않았습니다.',
    mmRejected: 'MetaMask에서 거부했습니다. 아무것도 전송되지 않았습니다.',
    mmWrongChain: 'MetaMask가 ZETAPHY 테스트넷에 있지 않습니다 (chain id {id}). 먼저 MetaMask에서 네트워크를 전환하세요.',
    mmNeedTx: '이 지갑은 아직 트랜잭션을 보낸 적이 없습니다: 먼저 하나를 보내세요 (예: 자기 자신에게). 그러면 체인이 컨트롤러로 인정합니다.',
    mmSelfLocked: '이 지갑 자체가 다른 계정에 잠금되어 있어 컨트롤러가 될 수 없습니다.',
    mmAlreadyLocked: '이 MetaMask 계정은 이미 {to}에 잠금되어 있습니다.',
    mmAlreadyMine: '이 MetaMask 계정은 이미 이 지갑에 잠금되어 있습니다.',
    mmCancelled: '취소했습니다. 아무것도 전송되지 않았습니다.',
    mmSent: 'MetaMask가 잠금을 보냈습니다. 블록에 포함되면 위 목록에 계정이 나타납니다.',
    mmWarnSeedSnap: 'MetaMask 비밀 복구 구문을 잃으면 잠금된 계정도 함께 잃습니다.',
    qdTitle: 'Q-day 대비',
    qdIntro: 'Q-day는 양자 컴퓨터가 ECDSA 서명(MetaMask 방식의 키)을 위조할 수 있기 때문에 네트워크가 이를 더 이상 신뢰하지 않게 되는 날입니다. 그 이후 이전되지 않은 ECDSA 계정은 동결됩니다 (자금은 남아 있지만 보낼 수 없음). 가장 안전한 방법은 미리 MetaMask 계정을 이 지갑에 잠그는 것입니다 (위 카드).',
    qdCheck: '내 MetaMask 계정 확인',
    qdNone: 'Q-day: 예정 없음 (네트워크가 투표로 충분히 미리 공지합니다).',
    qdScheduled: 'Q-day: 블록 {h} (현재 {now}). 그 이후로 ECDSA 서명 트랜잭션은 거부됩니다.',
    qdPassed: 'Q-day가 지났습니다 (블록 {h}): ECDSA 서명 트랜잭션은 거부됩니다.',
    qdOff: '이 노드에서는 보안 코어가 켜져 있지 않습니다.',
    qdPQ: '{acct}: 이미 ML-DSA-44 계정입니다. 할 일이 없습니다.',
    qdMigrated: '{acct}: 이전 완료. 컨트롤러는 {to}입니다.',
    qdPending: '{acct}: {to}로 이전 중, 블록 {h}에서 확정됩니다.',
    qdExposed: '{acct}: 이전되지 않았고 공개키가 온체인에서 사용되었습니다. Q-day 전에 잠그지 않으면 (위 카드) 동결됩니다.',
    qdUnexposed: '{acct}: 이전되지 않았지만 키가 온체인에서 사용된 적이 없습니다. 지금 잠그거나 (권장), Q-day 이후 아래의 커밋–리빌로 옮기세요.',
    qdRecoverWarn: '경고: 이 두 단계에서 MetaMask가 서명을 요청하는 텍스트는 {acct}의 모든 제어권을 {ctrl} (이 지갑의 ML-DSA-44 계정)에 넘깁니다. "New ML-DSA-44 controller" 줄이 {ctrl}인지 확인하고, 이 텍스트는 공식 ZETAPHY 지갑에서만 서명하세요. "ZETAPHY Q-day migration" 텍스트 서명을 요구하는 다른 사이트는 계정을 탈취할 수 있습니다.',
    qdRecoverIntro: 'Q-day 이후 복구 (온체인에서 사용된 적 없는 키만): MetaMask는 로컬에서 텍스트에 서명만 하고 아무것도 보내지 않습니다. 이 지갑이 커밋을 기록하고 (1단계), {d} 블록을 기다린 뒤 리빌합니다 (2단계). 그로부터 {d} 블록 후 계정은 이 지갑의 것이 됩니다.',
    qdCommit: '1단계: 커밋 기록',
    qdReveal: '2단계: 리빌',
    qdCommitted: '커밋을 기록했습니다. 블록 {h}부터 리빌하세요.',
    qdAlready: '이 커밋은 블록 {h}에 기록되었습니다: 블록 {r}부터 리빌하세요.',
    qdNoCommit: '아직 커밋이 없습니다: 먼저 1단계를 진행하세요.',
    qdTooEarly: '너무 이릅니다: 블록 {h}부터 리빌하세요 (현재 {now}).',
    qdNotYet: '리빌은 Q-day에 열립니다. 그 전에는 MetaMask에서 계정을 잠그세요 (위 카드).',
    qdRevealed: '리빌 완료: 최종 블록에서 계정이 이 지갑의 것이 됩니다.',
    qdCannot: '이 계정은 커밋–리빌을 사용할 수 없습니다 (이미 이전되었거나 키가 온체인에서 사용됨).',
    csTitle: '플래그된 컨트랙트에 동의하기',
    csIntro: '위협 게이트가 켜져 있으면, 네트워크는 Neuro 플래그가 강제 적용된 컨트랙트로 가는 트랜잭션을 계정 본인이 동의하지 않는 한 전달하지 않습니다 (트랜잭션 1건, 최대 하루). 이는 검열이 아니라 동의입니다: 계속 진행할 수 있지만 먼저 플래그 사유를 읽으세요.',
    csTarget: '컨트랙트 (0x…)',
    csSeconds: '유효 기간',
    csOk: '플래그 사유를 읽었으며 위험을 스스로 감수합니다',
    csSend: '이 지갑에서 동의 보내기',
    csSendMM: 'MetaMask에서 동의 보내기',
    csSent: '동의를 보냈습니다. 트랜잭션 해시:',
    csBad: '컨트랙트 주소를 입력하세요: 0x와 16진수 40자리.',
    threatConsented: '경고: {addr}에 강제 적용된 플래그가 있지만 ({what} · 사유: {reason}) 동의하셨으므로 보낼 수 있습니다. · {details}',
    snapTitle: 'MetaMask 사용 (ZETAPHY Snap)',
    snapIntro: 'ML-DSA-44 키는 MetaMask 안에서 비밀 복구 구문으로부터 만들어지며, 이 페이지는 절대 볼 수 없습니다. MetaMask는 서명 전에 모든 트랜잭션을 알기 쉬운 말로 보여줍니다.',
    snapFlask: 'Snap이 게시되고 MetaMask 검토를 통과하기 전까지는 MetaMask Flask (개발자 빌드)에만 설치됩니다.',
    snapIdLabel: 'Snap ID (npm:@zetaphy/snap, 개발 중에는 local:http://localhost:8080)',
    snapIdHint: '계정은 Snap ID에 따라 달라집니다: 같은 Snap은 항상 같은 계정을 주며 (비밀 복구 구문으로 복구 가능), local:… Snap은 다른 계정을 줍니다.',
    snapConnect: 'MetaMask 연결',
    snapConnected: 'MetaMask (ZETAPHY Snap)에 연결되었습니다.',
    snapMode: '키는 이 페이지가 아닌 MetaMask (ZETAPHY Snap)에 있습니다. MetaMask 비밀 복구 구문이 그 백업입니다.',
    snapDisconnect: '이 페이지에서 MetaMask 연결 해제',
    snapDisconnected: '이 페이지에서 MetaMask 연결을 해제했습니다 (Snap은 MetaMask에 설치된 채로 남습니다).',
    snapBadId: 'Snap ID는 npm:<package> 또는 local:http://localhost:<port> 형식이어야 합니다.',
    snapDenied: 'MetaMask가 Snap을 설치하거나 허용하지 않았습니다.',
    snapUnsupported: '이 MetaMask는 Snap을 실행할 수 없습니다 (MetaMask Flask 또는 Snap을 지원하는 버전을 사용하세요).',
    snapBadAccount: 'Snap이 공개키와 일치하지 않는 계정을 응답했으므로 사용하지 않습니다.',
    snapConfirm: 'MetaMask 창에서 세부 정보를 확인하고 승인하세요…',
    snapRejected: 'MetaMask에서 거부했습니다. 아무것도 서명되거나 전송되지 않았습니다.',
    snapMismatch: 'Snap이 요청한 것과 다른 트랜잭션에 서명했으므로 아무것도 전송하지 않았습니다.',
    deployTitle: '컨트랙트 배포',
    initCodeLabel: '생성 바이트코드 (16진수, 생성자 인자 포함)',
    deployConfirmTitle: '컨트랙트 생성 확인',
    cCodeSize: '코드 크기',
    cCodeHash: '코드 해시 (keccak-256)',
    bytesN: '{n} 바이트',
    deployChecked: '노드에서 시뮬레이션: 성공합니다 (서명 직전에 다시 시뮬레이션합니다). 코드 해시를 컨트랙트 작성자가 공개한 해시와 비교하세요. 컨트랙트 생성에는 목적지가 없으므로 ThreatRegistry와 대조하지 않습니다.',
    deployedAt: '새 컨트랙트 주소:',
    badInitCode: '바이트코드는 비어 있지 않은 16진수여야 합니다 (0x…).',
    deploySent: '전송됨. 노드가 수락했으며, 트랜잭션이 블록에 포함되면 컨트랙트가 생성됩니다.',
    walletsTitle: '다른 지갑에서 ZETAPHY 사용',
    walletsIntro: '아래 버튼으로 이미 쓰고 있는 지갑 (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap, …)에 ZETAPHY Testnet 네트워크를 추가하거나, 값을 직접 입력하세요. 모든 값은 위의 RPC URL에서 가져옵니다.',
    evmWalletsTitle: '이 브라우저의 EVM 지갑',
    evmNone: '이 브라우저에서 EVM 지갑을 찾지 못했습니다. 확장 프로그램 (MetaMask, Rabby, Trust, OKX, Coinbase Wallet, …)을 설치하거나, 휴대폰에서는 지갑 앱의 브라우저로 이 페이지를 여세요.',
    evmAdd: '이 지갑에 ZETAPHY 추가',
    evmConnect: '이 지갑 연결',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (이 페이지를 다른 브라우저에서 열었을 때 모바일 지갑 연결, 예: Binance Wallet)가 꺼져 있습니다: 먼저 Reown projectId가 필요합니다.',
    wcOn: 'projectId는 설정되었지만 이 페이지에는 아직 WalletConnect가 포함되어 있지 않습니다 (다음 단계입니다).',
    wcNotYet: '이 페이지에는 아직 WalletConnect가 포함되어 있지 않습니다 (다음 단계입니다). 그동안 휴대폰에서는 지갑 앱의 브라우저로 이 페이지를 여세요.',
    wcIdLabel: 'WalletConnect projectId (Reown 발급, 16진수 32자리)',
    wcIdHint: 'cloud.reown.com에서 무료로 받을 수 있습니다. 여기에 설정하거나 (이 브라우저에 저장됨), 모든 사용자에게 적용하려면 index.html의 zetaphy-walletconnect-project-id 메타 태그에 설정하세요.',
    wcSaved: 'projectId가 저장되었습니다.',
    wcBadId: 'projectId는 16진수 32자리여야 합니다.',
    manualTitle: '네트워크 수동 추가: 입력할 값',
    mNetwork: '네트워크 이름',
    mRpc: 'RPC URL',
    mChainId: '체인 ID',
    mSymbol: '통화 기호',
    mDecimals: '소수점 자리수',
    mExplorer: '블록 탐색기',
    mNone: '없음 (비워 두기)',
    mRpcUnset: '(먼저 위에 https RPC URL을 입력하세요)',
    mSymbolNote: '{sym}는 ZETAPHY입니다: MetaMask와 chainlist는 최대 6글자의 기호만 받으므로 EVM 지갑은 잔액을 {sym}로 표시합니다. {precompile}의 토큰은 가져오지 마세요: 같은 코인입니다 (잔액이 두 번 보입니다).',
    cosmosTitle: 'Cosmos 지갑 (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'EVM 지갑과 같은 계정의 zetaphy1… 주소를 보여줍니다 (eth_secp256k1 키, coin type 60). /rpc와 /rest를 제공하는 노드의 https 주소가 필요합니다 (setup-node.sh로 설치한 노드는 제공합니다).',
    keplrAdd: 'Keplr에 추가',
    leapAdd: 'Leap에 추가',
    cosmostationAdd: 'Cosmostation에 추가',
    supportTitle: '지원되는 지갑',
    supWorks: '지금 사용 가능 (사용자 지정 네트워크): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame, 그리고 이들을 통한 Ledger/Trezor. Keplr, Leap, Cosmostation은 위 버튼으로 추가.',
    supMaybe: '사용 가능할 수 있음 (미확인): Binance 앱 안의 Binance Wallet (네트워크를 받아들이는 경우). 앱 밖에서는 WalletConnect가 필요합니다.',
    supNot: '지갑이 직접 ZETAPHY를 추가할 때까지 불가: Phantom, 그리고 체인 목록이 고정된 지갑.',
    supNever: '불가: Solana 전용 또는 Bitcoin 전용 지갑. EVM이나 Cosmos 지갑이 아닙니다.',
    supPq: '양자 내성: 이 페이지 자체의 ML-DSA-44 키와 ZETAPHY Snap뿐입니다. 다른 모든 지갑은 충분히 큰 양자 컴퓨터가 깰 수 있는 ECDSA (secp256k1)로 서명합니다. 그런 계정은 이 지갑에 잠가서 보호하세요.',
    usingWallet: '사용 중인 지갑: {name}',
    usingNone: '이 브라우저에서 아직 EVM 지갑을 찾지 못했습니다.',
    changeWallet: '다른 지갑 선택',
    inApp: '이 페이지는 {name}의 인앱 브라우저에서 열려 있습니다: 아래 버튼은 이 지갑을 사용합니다.',
    mobileNoWallet: '휴대폰에서: 지갑 앱의 브라우저로 이 페이지를 여세요 (아래 링크를 사용하거나 이 페이지 주소를 앱의 브라우저 탭에 복사하세요).',
    phantomNote: 'Phantom은 네트워크 추가를 허용하지 않습니다: Phantom이 선택한 체인만 지원하므로 Phantom이 ZETAPHY를 추가하기 전까지는 사용할 수 없습니다. 다른 지갑 (MetaMask, Rabby, Trust, OKX, Coinbase)을 사용하세요.',
    binanceNote: 'Binance Wallet은 아직 새 네트워크를 받지 않을 수 있습니다. 추가에 실패하면 아래 값을 직접 입력하거나 다른 지갑을 사용하세요.',
    evmMissing: '이 브라우저에서 EVM 지갑을 찾지 못했습니다.',
    evmRejected: '지갑에서 취소했습니다.',
    evmDenied: '지갑이 계정 연결을 허용하지 않았습니다.',
    chainNeedHttps: '지갑은 https RPC URL (또는 localhost)만 받습니다. 위에 노드의 https 주소를 입력하세요. 예: https://1-2-3-4.sslip.io',
    chainAdding: '{name} 창에서 ZETAPHY Testnet 추가를 승인하세요…',
    chainAdded: 'ZETAPHY Testnet을 {name}에 추가하고 선택했습니다.',
    chainAddedNoSwitch: 'ZETAPHY Testnet을 {name}에 추가했지만 선택되지 않았습니다: 지갑에서 네트워크를 선택하세요.',
    addChainUnsupported: '{name}이(가) 네트워크를 추가하지 않았습니다 ({why}). 아직 새 네트워크를 받지 않을 수 있습니다: 아래 값을 지갑에 직접 입력하거나 다른 지갑을 사용하세요.',
    evmConnected: '{name}에 연결되었습니다.',
    evmOnZetaphy: 'ZETAPHY Testnet에 있습니다.',
    evmOtherChain: '다른 네트워크에 있습니다 (chain id {id}): "이 지갑에 ZETAPHY 추가"를 누르세요.',
    evmBalance: '잔액 {amount} ZETAPHY',
    cosmosMissing: '이 브라우저에서 {name}을(를) 찾을 수 없습니다.',
    cosmosAdding: '{name} 창에서 승인하세요…',
    cosmosRejected: '{name}이(가) 네트워크를 추가하지 않았습니다 ({why}).',
    cosmosAdded: 'ZETAPHY Testnet을 {name}에 추가했습니다. 주소는 아래에 있습니다.',
    cosmosBadAddress: '지갑이 zetaphy1…이 아닌 주소를 응답했으므로 사용하지 않습니다.',
    walletPicked: '{name} 선택됨.',
    snapNotMetaMask: '{name}은(는) MetaMask Snap을 실행할 수 없습니다. 아래 "다른 지갑에서 ZETAPHY 사용"에서 MetaMask (또는 MetaMask Flask)를 선택하세요.',
    threatLabel: 'ThreatRegistry (면역 시스템: 플래그된 코드로 가는 트랜잭션에는 절대 서명하지 않음)',
    threatHint: 'ZETAPHY상의 0x… 주소 (이 브라우저에 저장됨), 또는 모든 사용자용으로 index.html의 zetaphy-threat-registry 메타 태그. 비워 두면 메타 태그를 사용합니다.',
    threatSaved: 'ThreatRegistry 주소가 저장되었습니다.',
    threatBadAddress: 'ThreatRegistry 주소는 0x와 16진수 40자리여야 합니다.',
    threatFlagged: '서명 안 됨: {addr}은(는) ZETAPHY 면역 시스템에 의해 플래그되었습니다 ({what} · 사유: {reason}). 이 지갑은 플래그가 강제 적용된 코드로는 먼저 동의하지 않는 한 트랜잭션을 보내지 않습니다 ("플래그된 컨트랙트에 동의하기" 카드). · {details}',
    threatUnchecked: '서명 안 됨: {addr}을(를) ThreatRegistry {reg}와 대조할 수 없었습니다. ThreatRegistry가 설정된 이상, 확인되지 않으면 보내지 않습니다.',
    threatUnset: '목적지 코드 확인 안 됨: ThreatRegistry 주소가 설정되지 않았습니다 (RPC 입력란 아래 고급 설정).',
    threatClean: 'ThreatRegistry와 대조함: 목적지는 플래그되지 않았습니다 (최선의 노력: 주소, 그 코드, EIP-1967 / beacon / EIP-1167 프록시 뒤의 코드. 서명 전에 다시 확인합니다).',
    threatWarned: '경고: Neuro 러너가 {addr}을(를) 플래그했지만 ({what} · 사유: {reason}) 아직 강제 적용되지 않았습니다 (거버넌스가 아직 검토할 수 있음). 강제 적용되면 이 지갑은 거부합니다 (러너의 압도적 다수 또는 거버넌스가 패스트 트랙에 올린 플래그는 즉시 적용). 지금 보낼지는 본인의 선택입니다. · {details}',
    threatNewWarning: '서명 안 됨: 검토 후에 {addr}이(가) 플래그되었습니다 ({what} · 사유: {reason}). 경고를 보려면 다시 검토하세요. · {details}',
    threatBehind: '{impl} (프록시 {proxy} 뒤의 코드)',
    threatWhatFingerprint: '코드 지문 (fp1)이 플래그된 코드와 일치',
    threatWhatCode: '코드가 플래그된 코드와 바이트 단위로 동일',
    threatWhatAddress: '이 주소가 플래그됨',
    reason1: '시뮬레이션 거래에서 매수는 됐지만 매도가 실패하거나 거의 돌려받지 못함',
    reason2: '어떤 주소가 상한 없이 새 토큰을 민팅할 수 있음',
    reason3: '소유자나 관리자가 보유자의 전송이나 매도를 막을 수 있음',
    reason4: '소유자나 관리자가 다른 사람이 보유한 토큰이나 자금을 옮기거나 소각할 수 있음',
    reason5: '알려진 토큰과 같은 이름이나 심볼을 다른 주소에서 사용함',
    reason6: '재현 가능한 테스트에서, 자신에게 승인(approve)된 토큰을 보유자가 선택하지 않은 주소로 옮김',
    reason7: '기타 코드 사실 (증거 참조)',
    threatEvidence: '증거: reportHash {hash}{uri} · 재현: 같은 코드에 Neuro를 실행하고 (zetaphy-neuro: node cli.js <chain> <address> --json) reportHash를 비교하세요',
    threatNoEvidence: '증거: 저장된 것 없음',
    threatEvidenceUnread: '증거: 읽을 수 없음',
    threatResponse: '{by}의 응답: "{text}"',
    threatResponseAssigned: '거버넌스가 지정한 응답자 ({by})의 응답: "{text}"',
    threatNoResponse: '아직 응답 없음',
    threatDisclaimer: '자동 코드 분석 결과이며, 비난이 아닙니다',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: '팁: 서로 관련 없는 무작위 단어 4~5개로 만들면 강하면서도 기억하기 쉬운 비밀번호가 됩니다.',
    passWeak: '이 비밀번호는 너무 쉽게 추측됩니다 (등급: {label}). 최소 "강함" 등급이어야 합니다',
    pwStrength: '강도: {label}',
    pwVeryWeak: '매우 약함',
    pwWeak: '약함',
    pwFair: '보통',
    pwStrong: '강함',
    pwVeryStrong: '매우 강함',
    pwLength: '{n}자 이상 사용하세요. 길수록 좋습니다.',
    pwCommon: '가장 흔한 비밀번호 중 하나입니다.',
    pwDictionary: '흔한 비밀번호나 단어가 들어 있습니다.',
    pwSequence: 'abc, 321, qwerty 같은 연속 문자가 들어 있습니다.',
    pwRepeat: '반복되는 문자나 패턴이 들어 있습니다.',
    pwContext: '"zetaphy", "wallet" 또는 주소의 일부가 들어 있습니다.',
    pwYear: '연도가 들어 있습니다.',
    pwVariety: '단어를 더 넣거나 대문자, 소문자, 숫자, 기호를 섞으세요.',
    weakNudge: '비밀번호가 약합니다 (등급: {label}). 이 브라우저의 데이터를 복사한 사람이 추측할 수 있습니다. 더 강한 비밀번호로 바꾸세요.',
    weakNudgeGo: '지금 변경',
    secTitle: '보안',
    autoLockLabel: '활동이 없거나 백그라운드 탭에 있는 시간이 이만큼 지나면 자동 잠금',
    nMinutes: '{n}분',
    autoLockIn: '활동이 없으면 {time} 후 자동으로 잠깁니다.',
    autoLocked: '{n}분 동안 활동이 없어 자동으로 잠겼습니다. 키를 메모리에서 지웠습니다.',
    autoLockSaved: '자동 잠금을 {n}분으로 설정했습니다.',
    lockedErr: '지갑이 잠겨 있습니다. 먼저 잠금 해제하세요. 아무것도 서명하지 않았습니다.',
    chpwTitle: '비밀번호 변경',
    chpwOld: '현재 비밀번호',
    chpwNew: '새 비밀번호 (12자 이상, "강함" 등급 이상)',
    chpwSave: '비밀번호 변경',
    chpwDone: '비밀번호를 변경했습니다.',
    pkTitle: '지문 / Face ID로 잠금 해제 (패스키)',
    pkIntro: '이 기기에 이 사이트용 패스키를 만듭니다. 지문, 얼굴 또는 기기 PIN 인증 후에만 나오는 PRF 비밀 값으로 이 브라우저에 시드의 두 번째 사본을 암호화합니다. 비밀번호는 예비 수단으로 계속 쓸 수 있습니다.',
    pkSyncNote: '패스키는 iCloud 키체인, Google 비밀번호 관리자 등으로 동기화될 수 있어 다른 기기에도 이 패스키가 있을 수 있습니다. 해당 계정을 잘 보호하세요.',
    pkEnable: '지문 / Face ID 잠금 해제 켜기',
    pkDisable: '지문 / Face ID 잠금 해제 끄기',
    pkUnlock: '지문 / Face ID로 잠금 해제',
    pkOn: '지문 / Face ID 잠금 해제가 켜져 있습니다. 비밀번호도 계속 쓸 수 있습니다.',
    pkOff: '지문 / Face ID 잠금 해제가 꺼져 있습니다.',
    pkOtherSite: '이 패스키는 {host}용으로 만들어졌습니다. 여기서는 비밀번호를 사용하세요.',
    pkUnsupported: '이 브라우저는 이 페이지에서 패스키를 쓸 수 없습니다. 비밀번호를 계속 사용하세요.',
    pkNoPlatform: '이 기기에서 지문, 얼굴 또는 PIN 인증기를 찾지 못했습니다. 비밀번호를 계속 사용하세요.',
    pkNoPrf: '이 브라우저나 패스키 관리자는 필요한 PRF 확장을 지원하지 않아 여기서는 패스키로 지갑을 잠금 해제할 수 없습니다. 비밀번호를 계속 사용하세요.',
    pkCancelled: '취소되었거나 시간이 초과되었습니다. 바뀐 것은 없습니다.',
    pkFailed: '패스키로 이 지갑을 잠금 해제하지 못했습니다. 비밀번호를 사용하세요.',
    pkWorking: '지문 / Face ID를 기다리는 중…',
    pkEnabled: '패스키를 만들었습니다. 이제 지문 / Face ID로 잠금 해제할 수 있습니다. 비밀번호도 계속 쓸 수 있습니다.',
    pkDisabled: '패스키 잠금 해제를 끄고 암호화된 사본을 삭제했습니다. 기기의 패스키 설정에서 "ZETAPHY PQ Wallet" 패스키도 삭제할 수 있습니다.',
    pkDisableConfirm: '지문 / Face ID 잠금 해제를 끌까요? 이후에는 비밀번호로만 잠금 해제할 수 있습니다.',
    bigTitle: '잔액이 큽니다: 키를 더 안전한 곳에 두는 것을 고려하세요',
    bigLocal: '이 계정에는 {amount} ZETAPHY가 있습니다. 웹 페이지의 키는 이 브라우저와 컴퓨터만큼만 안전합니다. 금액이 크면 키가 MetaMask 안에 있는 ZETAPHY Snap으로 자금을 옮기세요.',
    bigEvm: '연결된 EVM 계정에 {amount} ZETAPHY가 있습니다. 금액이 크면 MetaMask나 Rabby를 통해 하드웨어 지갑(Ledger 또는 Trezor)을 사용하세요.',
    bigHow: '방법 보기',
    bigLater: '7일 동안 숨기기',
    helpOpen: '큰 잔액을 안전하게 보관하기',
    helpTitle: '큰 잔액을 안전하게 보관하기',
    helpIntro: '웹 페이지의 키는 실행되는 브라우저와 컴퓨터만큼만 안전합니다. 지갑이 잠금 해제된 동안 악성 확장 프로그램이나 악성 코드가 키를 읽을 수 있습니다. 여기에는 소액만 두세요.',
    helpSnapTitle: '네이티브 PQ 계정: ZETAPHY Snap으로 옮기기 (키는 MetaMask 안에)',
    helpSnap1: 'MetaMask를 설치하고(snap이 게시되기 전에는 MetaMask Flask) 비밀 복구 구문을 백업하세요.',
    helpSnap2: '이 지갑을 잠근 다음 "MetaMask 연결"을 누르고 ZETAPHY Snap을 승인하세요.',
    helpSnap3: '표시되는 zetaphy1… 주소를 복사하세요. MetaMask 안에서 만들어진 새 계정입니다.',
    helpSnap4: '비밀번호로 이 지갑을 다시 잠금 해제하고 그 주소로 자금을 보내세요. MetaMask 창에서도 주소를 확인하세요.',
    helpHwTitle: 'EVM 계정: 하드웨어 지갑',
    helpHw1: 'Ledger 또는 Trezor를 MetaMask나 Rabby에 연결하세요 (하드웨어 지갑 계정 추가).',
    helpHw2: '이 페이지의 "다른 지갑에서 ZETAPHY 사용" 버튼으로 ZETAPHY Testnet 네트워크를 추가하세요.',
    helpHw3: '하드웨어 계정의 0x… 주소로 자금을 보내고, 모든 거래를 기기 자체 화면에서 확인하세요.',
    helpMore: '자세한 내용은 README의 보안 섹션에 있습니다. 테스트넷이므로 실제 돈이 아닙니다.',
    helpClose: '닫기',
  },
  ja: {
    subtitle: '耐量子ウォレット（ML-DSA-44）· ECDSA 鍵なし',
    warnTitle: 'テストネット専用',
    warnTestnet: 'ZETAPHY テストネットのコインは本物のお金ではありません。価値のあるものをここに置かないでください。',
    warnSeed: 'シードはこのウォレットの唯一の鍵です。シードを失くすかパスフレーズを忘れると、資金は永久に失われます。誰も復元できません。',
    warnLocal: 'シードはパスフレーズで暗号化され、このブラウザ内にのみ保存されます。どこにも送信されません。',
    rpcLabel: 'ZETAPHY ノードの RPC URL（JSON-RPC、ポート 8545）',
    rpcSave: '保存',
    rpcHint: 'このページを https で開いている場合、RPC も https である必要があります（ブラウザは http をブロックします）。',
    setupTitle: 'はじめる',
    modeNew: '新しい鍵を作成',
    modeImport: 'シードをインポート',
    seedLabel: 'シード（16 進数 64 桁、0x は任意）',
    pass1: 'パスフレーズを設定（12 文字以上、強度「強い」以上）',
    pass2: 'パスフレーズをもう一度入力',
    saveKey: 'ウォレットを作成',
    lockedTitle: 'ウォレットはロック中',
    unlockLabel: 'パスフレーズ',
    unlock: 'ロック解除',
    forget: 'このブラウザからウォレットを削除',
    accountTitle: 'あなたのアカウント',
    sameAccount: 'どちらも同じアカウントです。どちらのアドレスでも受け取れます。',
    copy: 'コピー',
    balance: '残高',
    refresh: '更新',
    sendTitle: 'ZETAPHY を送金',
    toLabel: '送金先（0x… または zetaphy1…）',
    amountLabel: '数量（ZETAPHY）',
    advanced: '詳細設定',
    gasLabel: 'ガスリミット',
    review: '確認',
    confirmTitle: '送金の確認',
    cTo: '送金先',
    cAmount: '数量',
    cFee: '最大手数料',
    cTotal: '合計',
    confirmSend: '確認して ML-DSA で署名・送信',
    cancel: 'キャンセル',
    txSent: '送信しました。トランザクションハッシュ：',
    backupTitle: 'シードのバックアップ',
    backupWarn: 'バックアップファイルは暗号化されていないシードそのものです。入手した人は誰でも資金を動かせます。オフラインで安全に保管し、絶対に共有しないでください。',
    backupOk: '理解しました',
    backup: 'シードのバックアップをダウンロード',
    backupCli: 'このファイルは zetaphy pq native コマンド用の ~/.zetaphy/pq.seed として使えます。',
    lock: 'ウォレットをロック',
    footer: 'すべてのコードはこのページ内にあり、外部のスクリプトは使いません · トランザクションはブラウザ内で ML-DSA-44（FIPS 204）により、または ZETAPHY Snap を使って MetaMask 内で署名されます',
    working: '処理中…',
    deriving: 'シードを暗号化しています（少し時間がかかります）…',
    created: 'ウォレットを作成しました。資金を受け取る前にシードのバックアップをダウンロードしてください。',
    imported: 'シードをインポートしました。',
    unlocked: 'ロックを解除しました。',
    lockedMsg: 'ロックしました。',
    badPass: 'パスフレーズが違います。',
    passShort: 'パスフレーズは {n} 文字以上にしてください。',
    passMismatch: '2 つのパスフレーズが一致しません。',
    badSeed: 'シードは 16 進数 64 桁である必要があります。',
    storeFailed: 'このブラウザはデータを保存できません（プライベートモード？）。ページを閉じるとウォレットが消えます：バックアップをダウンロードしてください。',
    rpcSaved: 'RPC を保存しました。',
    needRpc: '先にノードの RPC URL を入力してください。',
    badRpc: 'RPC URL は http:// または https:// で始まる必要があります',
    wrongChain: 'その RPC は ZETAPHY テストネットではありません（chain id {id}）。',
    rpcDown: 'RPC に接続できません（停止中、CORS が許可されていない、または https ページで http を使用）。',
    notFunded: 'このアカウントはまだオンチェーンにありません：まずこのアドレスに ZETAPHY を送ると、送金できるようになります。',
    onChain: 'オンチェーン（アカウント {n}、送信済みトランザクション {s} 件）。',
    badAddress: '送金先アドレスが無効です（スペルまたはチェックサムを確認してください）。',
    badAmount: '数量が無効です。',
    badGas: 'ガスリミットは 0 より大きい整数である必要があります。',
    notEnough: '残高不足：手数料込みで {need} ZETAPHY 必要ですが、残高は {have} です。',
    signing: 'ML-DSA-44 で署名して送信中…',
    sent: '送信しました。ノードが受理し、数秒以内にブロックに取り込まれます。',
    rejected: 'ノードがトランザクションを拒否しました',
    copied: 'コピーしました。',
    forgetConfirm: 'このブラウザからウォレットを削除しますか？シードのバックアップがなければ資金は永久に失われます。',
    forgotten: 'このブラウザからウォレットを削除しました。',
    backupDone: 'バックアップをダウンロードしました。オフラインで保管してください。',
    tokenTitle: 'ERC-20 トークン',
    tokenLabel: 'トークンコントラクトのアドレス（0x…）',
    tokenLoad: '照会',
    tokenBalance: 'トークン残高',
    tokenMeta: '{sym} · 小数点以下 {d} 桁 · コントラクト {addr}',
    tokenAmountLabel: 'トークンの数量',
    evmGasLabel: 'EVM ガスリミット（手数料はこのガスとトランザクション本体の分）',
    tokenConfirmTitle: 'トークン送金の確認',
    cToken: 'トークン',
    tokenChecked: 'ノードでシミュレーション済み：成功します（署名直前に再度シミュレーションします）。',
    tokenNote: '手数料は ZETAPHY で支払われます。コントラクトが revert するとトランザクション全体が失敗しても手数料は支払われるため、このページは署名前にすべての送金をシミュレーションします。',
    badToken: 'トークンコントラクトは 0x と 16 進数 40 桁である必要があります（チェックサムを確認してください）。',
    noContract: '{addr} にコントラクトがありません。',
    notToken: 'そのコントラクトは ERC-20 トークンではありません（decimals() がありません）。',
    tokenDecimals: '{sym} の数量が小数点以下 {d} 桁を超えています。',
    badEvmGas: 'EVM ガスリミットは {min} から {max} までの整数である必要があります。',
    tokenNotEnough: 'トークン残高不足：{need} {sym} を送ろうとしていますが、残高は {have} です。',
    callFails: '送信されませんでした：ノードでシミュレーションすると送金は失敗します（revert）',
    tokenRefused: '送信されませんでした：トークンが送金を拒否しました（transfer が false を返しました）。',
    tokenSent: '送信しました。ノードが受理しました。（Cosmos トランザクションのため EVM ログは eth_getLogs に出ませんが、残高は正しいです。）',
    stakeTitle: 'ZETAPHY をステーキング',
    validatorLabel: 'バリデーター（zetaphyvaloper1…）',
    stakeAmountLabel: '数量（ZETAPHY）、報酬の請求には不要',
    stake: 'ステーク',
    unstake: 'アンステーク',
    claim: '報酬を請求',
    confirmStake: 'ステークの確認',
    confirmUnstake: 'アンステークの確認',
    confirmClaim: '報酬請求の確認',
    cValidator: 'バリデーター',
    unbondNote: 'アンステークした ZETAPHY はチェーンのアンボンディング期間の後に戻ってきます。それまでは使えず、報酬も得られません。',
    badValidator: 'バリデーターは zetaphyvaloper1… アドレスである必要があります（スペルまたはチェックサムを確認してください）。',
    staked: 'ステークを送信しました。ノードが受理しました。',
    unstaked: 'アンステークを送信しました。ZETAPHY はアンボンディング期間の後に戻ります。',
    claimed: '請求を送信しました。トランザクションがブロックに取り込まれると報酬が届きます。',
    ownedTitle: 'このウォレットが管理するアカウント',
    ownedHint: 'このウォレットに量子ロックされた ECDSA アカウント（例：MetaMask）。それら自身の鍵はもう使えません。このウォレットが代わりに送金、トークン送金、ステーキングを行います（ML-DSA-44 で署名、手数料はこのウォレットが支払い）。',
    ownerLabel: 'ロックされたアカウントのアドレス（0x… または zetaphy1…）',
    ownerUse: 'このアカウントとして操作',
    actingAs: '操作中のアカウント',
    ownerBalance: 'そのアカウントの残高',
    actingHint: '下の送金、トークン送金、ステーキングはこのアカウントの代わりに実行されます（as_owner）。手数料はこのウォレットから支払われます。',
    ownerStop: '自分のアカウントに戻る',
    ownedMine: 'このウォレットにロック済み',
    ownedNotMine: 'このウォレットにロックされていない（またはまだブロックに入っていない）',
    ownedOther: '別のアカウントにロック済み：{to}',
    asTag: '{owner} の代理',
    asNote: 'このウォレットに量子ロックされた {owner} の代理：資金とトークンはそのアカウントから出て、手数料はこのウォレットが支払います。',
    nowActing: '{owner} として操作しています。',
    stopActing: '自分のアカウントに戻りました。',
    ownerNotLocked: 'そのアカウントはこのウォレットに量子ロックされていないため、このウォレットは代理で操作できません。',
    ownerOther: 'そのアカウントはこのウォレットではなく、別のアカウント（{to}）にロックされています。',
    ownerSelf: 'それはこのウォレット自身のアカウントです。',
    ownerNotEnough: 'そのアカウントの残高が足りません：{need} ZETAPHY 必要ですが、残高は {have} です。',
    mmTitle: 'MetaMask アカウントをこのウォレットにロック',
    mmIntro: 'MetaMask の ECDSA アカウントの管理権をこの耐量子ウォレットに移します。アドレス、残高、トークン、ステークはそのままですが、今後はこのウォレットだけがそれらを動かせます。',
    mmWarnPermanent: '永続的で元に戻せません：ロック後、チェーンはそのアカウントの MetaMask 鍵で署名されたすべてのトランザクションを拒否し、コントラクトもその署名（例：permit）を受け付けなくなります。',
    mmWarnSeed: 'このウォレットのシードを失うと、ロックしたアカウントも失われます。先にシードのバックアップをダウンロードしてください。',
    mmWarnTx: 'このウォレットはオンチェーンで少なくとも 1 件のトランザクションを送信済みである必要があります（チェーンが ML-DSA-44 公開鍵を知るため）。',
    mmOk: 'ロックが永続的であることを理解しました',
    mmLock: 'MetaMask に接続してロック',
    mmSentLabel: 'MetaMask がロックを送信しました。トランザクションハッシュ：',
    mmConfirm: 'MetaMask アカウント {owner} をこのウォレット（{me}）に永久にロックしますか？\n\nその MetaMask 鍵は ZETAPHY で二度と使えなくなり、このウォレットのシードを失うとそのアカウントも失われます。',
    mmMissing: 'このブラウザに MetaMask（window.ethereum）が見つかりません。',
    mmDenied: 'MetaMask がアカウントの接続を許可しませんでした。',
    mmRejected: 'MetaMask で拒否されました。何も送信されていません。',
    mmWrongChain: 'MetaMask が ZETAPHY テストネットに接続されていません（chain id {id}）。先に MetaMask でネットワークを切り替えてください。',
    mmNeedTx: 'このウォレットはまだトランザクションを送信していません：まず 1 件送信してください（例：自分宛て）。そうすればチェーンがコントローラーとして受け付けます。',
    mmSelfLocked: 'このウォレット自体が別のアカウントにロックされているため、コントローラーになれません。',
    mmAlreadyLocked: 'その MetaMask アカウントはすでに {to} にロックされています。',
    mmAlreadyMine: 'その MetaMask アカウントはすでにこのウォレットにロックされています。',
    mmCancelled: 'キャンセルしました。何も送信されていません。',
    mmSent: 'MetaMask がロックを送信しました。ブロックに取り込まれると、上のリストにアカウントが表示されます。',
    mmWarnSeedSnap: 'MetaMask のシークレットリカバリーフレーズを失うと、ロックしたアカウントも失われます。',
    qdTitle: 'Q-day に備える',
    qdIntro: 'Q-day とは、量子コンピューターが ECDSA 署名（MetaMask 型の鍵）を偽造できる恐れがあるため、ネットワークがそれを信頼しなくなる日です。それ以降、移行していない ECDSA アカウントは凍結されます（資金は残りますが送金できません）。最も安全なのは、事前に MetaMask アカウントをこのウォレットにロックしておくことです（上のカード）。',
    qdCheck: '自分の MetaMask アカウントを確認',
    qdNone: 'Q-day：未定（ネットワークが投票により、十分前もって告知します）。',
    qdScheduled: 'Q-day：ブロック {h}（現在 {now}）。それ以降、ECDSA 署名のトランザクションは拒否されます。',
    qdPassed: 'Q-day は過ぎました（ブロック {h}）：ECDSA 署名のトランザクションは拒否されます。',
    qdOff: 'このノードではセキュリティコアが有効になっていません。',
    qdPQ: '{acct}：すでに ML-DSA-44 アカウントです。対応は不要です。',
    qdMigrated: '{acct}：移行済み。コントローラーは {to} です。',
    qdPending: '{acct}：{to} へ移行中。ブロック {h} で確定します。',
    qdExposed: '{acct}：未移行で、公開鍵がすでにオンチェーンで使われています。Q-day より前にロックしないと（上のカード）凍結されます。',
    qdUnexposed: '{acct}：未移行ですが、鍵はオンチェーンで一度も使われていません。今すぐロックするか（推奨）、Q-day 後に下のコミット–リビールで移してください。',
    qdRecoverWarn: '警告：この 2 つのステップで MetaMask が署名を求めるテキストは、{acct} の完全な管理権を {ctrl}（このウォレットの ML-DSA-44 アカウント）に渡します。「New ML-DSA-44 controller」の行が {ctrl} であることを確認し、このテキストには公式の ZETAPHY ウォレットでのみ署名してください。「ZETAPHY Q-day migration」テキストへの署名を求める他のサイトは、アカウントを奪う可能性があります。',
    qdRecoverIntro: 'Q-day 後の復旧（オンチェーンで一度も使われていない鍵のみ）：MetaMask はローカルでテキストに署名するだけで、何も送信しません。このウォレットがコミットメントを記録し（ステップ 1）、{d} ブロック待ってからリビールします（ステップ 2）。その {d} ブロック後、アカウントはこのウォレットのものになります。',
    qdCommit: 'ステップ 1：コミットメントを記録',
    qdReveal: 'ステップ 2：リビール',
    qdCommitted: 'コミットメントを記録しました。ブロック {h} からリビールできます。',
    qdAlready: 'このコミットメントはブロック {h} で記録されています：ブロック {r} からリビールできます。',
    qdNoCommit: 'まだコミットメントがありません：先にステップ 1 を行ってください。',
    qdTooEarly: '早すぎます：ブロック {h} からリビールできます（現在 {now}）。',
    qdNotYet: 'リビールは Q-day に開始されます。それまでは MetaMask からアカウントをロックしてください（上のカード）。',
    qdRevealed: 'リビールしました：最終ブロックでアカウントはこのウォレットのものになります。',
    qdCannot: 'このアカウントはコミット–リビールを使えません（移行済み、または鍵がオンチェーンで使用済み）。',
    csTitle: 'フラグ付きコントラクトへの同意',
    csIntro: '脅威ゲートが有効な場合、ネットワークは Neuro フラグが適用されたコントラクトへのトランザクションを、アカウント本人が同意しない限り届けません（トランザクション 1 件、最大 1 日）。これは検閲ではなく同意です：先に進むこともできますが、まずフラグの理由を読んでください。',
    csTarget: 'コントラクト（0x…）',
    csSeconds: '有効期間',
    csOk: 'フラグの理由を読み、リスクを自分で負います',
    csSend: 'このウォレットから同意を送信',
    csSendMM: 'MetaMask から同意を送信',
    csSent: '同意を送信しました。トランザクションハッシュ：',
    csBad: 'コントラクトのアドレスを入力してください：0x と 16 進数 40 桁。',
    threatConsented: '警告：{addr} には適用中のフラグがあります（{what} · 理由：{reason}）が、同意済みのため送信できます。· {details}',
    snapTitle: 'MetaMask を使う（ZETAPHY Snap）',
    snapIntro: 'ML-DSA-44 鍵は MetaMask 内でシークレットリカバリーフレーズから生成され、このページからは決して見えません。MetaMask は署名前にすべてのトランザクションをわかりやすい言葉で表示します。',
    snapFlask: 'Snap が公開され MetaMask の審査を通過するまでは、MetaMask Flask（開発者向けビルド）にのみインストールできます。',
    snapIdLabel: 'Snap ID（npm:@zetaphy/snap、開発中は local:http://localhost:8080）',
    snapIdHint: 'アカウントは Snap ID によって決まります：同じ Snap なら常に同じアカウント（シークレットリカバリーフレーズから復元可能）、local:… の Snap では別のアカウントになります。',
    snapConnect: 'MetaMask に接続',
    snapConnected: 'MetaMask（ZETAPHY Snap）に接続しました。',
    snapMode: '鍵はこのページではなく MetaMask（ZETAPHY Snap）内にあります。MetaMask のシークレットリカバリーフレーズがそのバックアップです。',
    snapDisconnect: 'このページから MetaMask を切断',
    snapDisconnected: 'このページから MetaMask を切断しました（Snap は MetaMask にインストールされたままです）。',
    snapBadId: 'Snap ID は npm:<package> または local:http://localhost:<port> である必要があります。',
    snapDenied: 'MetaMask が Snap をインストールまたは許可しませんでした。',
    snapUnsupported: 'この MetaMask は Snap を実行できません（MetaMask Flask か Snap 対応版を使ってください）。',
    snapBadAccount: 'Snap が公開鍵と一致しないアカウントを返したため、使用しません。',
    snapConfirm: 'MetaMask のウィンドウで詳細を確認して承認してください…',
    snapRejected: 'MetaMask で拒否されました。何も署名・送信されていません。',
    snapMismatch: 'Snap が要求とは異なるトランザクションに署名したため、何も送信しませんでした。',
    deployTitle: 'コントラクトをデプロイ',
    initCodeLabel: '作成用バイトコード（16 進数、コンストラクター引数を含む）',
    deployConfirmTitle: 'コントラクト作成の確認',
    cCodeSize: 'コードサイズ',
    cCodeHash: 'コードハッシュ（keccak-256）',
    bytesN: '{n} バイト',
    deployChecked: 'ノードでシミュレーション済み：成功します（署名直前に再度シミュレーションします）。コードハッシュをコントラクト作者が公開したものと比較してください。コントラクト作成には宛先がないため、ThreatRegistry との照合は行いません。',
    deployedAt: '新しいコントラクトのアドレス：',
    badInitCode: 'バイトコードは空でない 16 進数（0x…）である必要があります。',
    deploySent: '送信しました。ノードが受理しました。トランザクションがブロックに取り込まれるとコントラクトが存在します。',
    walletsTitle: '他のウォレットで ZETAPHY を使う',
    walletsIntro: '下のボタンで、お使いのウォレット（MetaMask、Rabby、Trust、OKX、Coinbase、Keplr、Leap など）に ZETAPHY Testnet ネットワークを追加するか、値を自分で入力してください。すべて上の RPC URL から取得します。',
    evmWalletsTitle: 'このブラウザの EVM ウォレット',
    evmNone: 'このブラウザに EVM ウォレットが見つかりません。拡張機能（MetaMask、Rabby、Trust、OKX、Coinbase Wallet など）をインストールするか、スマートフォンではウォレットアプリのブラウザでこのページを開いてください。',
    evmAdd: 'このウォレットに ZETAPHY を追加',
    evmConnect: 'このウォレットに接続',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect（このページを別のブラウザで開いたときのモバイルウォレット、例：Binance Wallet）は無効です：まず Reown の projectId が必要です。',
    wcOn: 'projectId は設定されていますが、このページにはまだ WalletConnect が組み込まれていません（次のステップです）。',
    wcNotYet: 'このページにはまだ WalletConnect が組み込まれていません（次のステップです）。それまでは、スマートフォンでウォレットアプリのブラウザからこのページを開いてください。',
    wcIdLabel: 'WalletConnect projectId（Reown 発行、16 進数 32 桁）',
    wcIdHint: 'cloud.reown.com で無料で取得できます。ここで設定するか（このブラウザに保存）、全員向けに index.html の zetaphy-walletconnect-project-id メタタグで設定してください。',
    wcSaved: 'projectId を保存しました。',
    wcBadId: 'projectId は 16 進数 32 桁である必要があります。',
    manualTitle: 'ネットワークを手動で追加：入力する値',
    mNetwork: 'ネットワーク名',
    mRpc: 'RPC URL',
    mChainId: 'チェーン ID',
    mSymbol: '通貨記号',
    mDecimals: '小数点以下の桁数',
    mExplorer: 'ブロックエクスプローラー',
    mNone: 'なし（空欄のまま）',
    mRpcUnset: '（先に上で https の RPC URL を入力してください）',
    mSymbolNote: '{sym} は ZETAPHY です：MetaMask と chainlist は最大 6 文字のシンボルしか受け付けないため、EVM ウォレットでは残高が {sym} と表示されます。{precompile} のトークンはインポートしないでください：同じコインです（残高が二重に表示されます）。',
    cosmosTitle: 'Cosmos ウォレット（Keplr、Leap、Cosmostation）',
    cosmosIntro: 'EVM ウォレットと同じアカウントの zetaphy1… アドレスを表示します（eth_secp256k1 鍵、coin type 60）。/rpc と /rest を提供するノードの https アドレスが必要です（setup-node.sh で構築したノードは対応しています）。',
    keplrAdd: 'Keplr に追加',
    leapAdd: 'Leap に追加',
    cosmostationAdd: 'Cosmostation に追加',
    supportTitle: '対応ウォレット',
    supWorks: '現在利用可能（カスタムネットワーク）：MetaMask、Rabby、Trust、OKX、Coinbase Wallet、Brave、Rainbow、Zerion、Frame、およびそれらを介した Ledger/Trezor。Keplr、Leap、Cosmostation は上のボタンで。',
    supMaybe: '利用できる可能性あり（未確認）：Binance アプリ内の Binance Wallet（ネットワークを受け付ける場合）。アプリ外では WalletConnect が必要です。',
    supNot: 'ウォレット側が ZETAPHY を追加するまで不可：Phantom、およびチェーン一覧が固定のウォレット。',
    supNever: '利用不可：Solana 専用または Bitcoin 専用のウォレット。EVM や Cosmos のウォレットではありません。',
    supPq: '耐量子：このページ自身の ML-DSA-44 鍵と ZETAPHY Snap のみ。他のすべてのウォレットは ECDSA（secp256k1）で署名しており、十分大きな量子コンピューターなら破れます。そのようなアカウントはこのウォレットにロックして保護してください。',
    usingWallet: '使用中のウォレット：{name}',
    usingNone: 'このブラウザではまだ EVM ウォレットが見つかっていません。',
    changeWallet: '別のウォレットを選ぶ',
    inApp: 'このページは {name} のアプリ内ブラウザで開かれています：下のボタンはこのウォレットを使います。',
    mobileNoWallet: 'スマートフォンの場合：ウォレットアプリのブラウザでこのページを開いてください（下のリンクを使うか、このページのアドレスをアプリのブラウザタブにコピーしてください）。',
    phantomNote: 'Phantom ではネットワークを追加できません：Phantom が選んだチェーンにしか対応していないため、Phantom が ZETAPHY を追加するまで使えません。別のウォレット（MetaMask、Rabby、Trust、OKX、Coinbase）を使ってください。',
    binanceNote: 'Binance Wallet はまだ新しいネットワークを受け付けない可能性があります。追加に失敗したら、下の値を手動で入力するか、別のウォレットを使ってください。',
    evmMissing: 'このブラウザに EVM ウォレットが見つかりませんでした。',
    evmRejected: 'ウォレットでキャンセルされました。',
    evmDenied: 'ウォレットがアカウントの接続を許可しませんでした。',
    chainNeedHttps: 'ウォレットは https の RPC URL（または localhost）しか受け付けません。上にノードの https アドレスを入力してください（例：https://1-2-3-4.sslip.io）',
    chainAdding: '{name} のウィンドウで ZETAPHY Testnet の追加を承認してください…',
    chainAdded: 'ZETAPHY Testnet を {name} に追加し、選択しました。',
    chainAddedNoSwitch: 'ZETAPHY Testnet を {name} に追加しましたが、選択されていません：ウォレットでネットワークを選んでください。',
    addChainUnsupported: '{name} はネットワークを追加しませんでした（{why}）。まだ新しいネットワークを受け付けない可能性があります：下の値をウォレットに手動で入力するか、別のウォレットを使ってください。',
    evmConnected: '{name} に接続しました。',
    evmOnZetaphy: 'ZETAPHY Testnet に接続中。',
    evmOtherChain: '別のネットワークに接続中（chain id {id}）：「このウォレットに ZETAPHY を追加」を押してください。',
    evmBalance: '残高 {amount} ZETAPHY',
    cosmosMissing: 'このブラウザに {name} が見つかりませんでした。',
    cosmosAdding: '{name} のウィンドウで承認してください…',
    cosmosRejected: '{name} はネットワークを追加しませんでした（{why}）。',
    cosmosAdded: 'ZETAPHY Testnet を {name} に追加しました。アドレスは下にあります。',
    cosmosBadAddress: 'ウォレットが zetaphy1… ではないアドレスを返したため、使用しません。',
    walletPicked: '{name} を選択しました。',
    snapNotMetaMask: '{name} は MetaMask Snap を実行できません。下の「他のウォレットで ZETAPHY を使う」で MetaMask（または MetaMask Flask）を選んでください。',
    threatLabel: 'ThreatRegistry（免疫システム：フラグ付きコードへのトランザクションには決して署名しない）',
    threatHint: 'ZETAPHY 上の 0x… アドレス（このブラウザに保存）、または全員向けに index.html の zetaphy-threat-registry メタタグ。空欄 = メタタグを使用。',
    threatSaved: 'ThreatRegistry のアドレスを保存しました。',
    threatBadAddress: 'ThreatRegistry のアドレスは 0x と 16 進数 40 桁である必要があります。',
    threatFlagged: '署名していません：{addr} は ZETAPHY 免疫システムによりフラグが付いています（{what} · 理由：{reason}）。このウォレットは、フラグが適用されたコードへは、先に同意しない限りトランザクションを送りません（「フラグ付きコントラクトへの同意」カード）。· {details}',
    threatUnchecked: '署名していません：{addr} を ThreatRegistry {reg} で確認できませんでした。ThreatRegistry が設定されている場合、確認できなければ送信しません。',
    threatUnset: '宛先コードは未確認です：ThreatRegistry のアドレスが設定されていません（RPC 欄の下の詳細設定）。',
    threatClean: 'ThreatRegistry で確認済み：宛先にフラグはありません（ベストエフォート：アドレス、そのコード、EIP-1967 / beacon / EIP-1167 プロキシの背後のコード。署名前に再確認します）。',
    threatWarned: '警告：{addr} は Neuro ランナーによりフラグが付けられています（{what} · 理由：{reason}）が、まだ適用されていません（ガバナンスが再審査できます）。適用されるとこのウォレットは送信を拒否します（ランナーの圧倒的多数、またはガバナンスがファストレーンに載せたフラグは即時適用）。今送るかどうかはあなたの判断です。· {details}',
    threatNewWarning: '署名していません：確認した後に {addr} にフラグが付けられました（{what} · 理由：{reason}）。もう一度確認して警告を表示してください。· {details}',
    threatBehind: '{impl}（プロキシ {proxy} の背後のコード）',
    threatWhatFingerprint: 'コードのフィンガープリント（fp1）がフラグ付きコードと一致',
    threatWhatCode: 'コードがフラグ付きコードとバイト単位で同一',
    threatWhatAddress: 'このアドレスにフラグが付いています',
    reason1: 'シミュレーション取引で、購入はできたが売却が失敗したか、ほとんど戻らなかった',
    reason2: 'あるアドレスが上限なしで新しいトークンをミントできる',
    reason3: 'オーナーまたは管理者が保有者の送金や売却を止められる',
    reason4: 'オーナーまたは管理者が他人の保有するトークンや資金を移動・バーンできる',
    reason5: '既知のトークンと同じ名前またはシンボルを、別のアドレスで使用している',
    reason6: '再現可能なテストで、承認（approve）されたトークンを保有者が選んでいないアドレスへ移した',
    reason7: 'その他のコード上の事実（証拠を参照）',
    threatEvidence: '証拠：reportHash {hash}{uri} · 再現方法：同じコードで Neuro を実行し（zetaphy-neuro: node cli.js <chain> <address> --json）、reportHash を比較',
    threatNoEvidence: '証拠：保存なし',
    threatEvidenceUnread: '証拠：読み取れませんでした',
    threatResponse: '{by} からの回答：「{text}」',
    threatResponseAssigned: 'ガバナンスが指名した回答者（{by}）からの回答：「{text}」',
    threatNoResponse: 'まだ回答はありません',
    threatDisclaimer: '自動コード解析の結果であり、告発ではありません',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'ヒント：無関係なランダムな単語を 4～5 個並べると、強くて覚えやすいパスフレーズになります。',
    passWeak: 'このパスフレーズは推測されやすすぎます（強度：{label}）。「強い」以上が必要です',
    pwStrength: '強度：{label}',
    pwVeryWeak: 'とても弱い',
    pwWeak: '弱い',
    pwFair: 'ふつう',
    pwStrong: '強い',
    pwVeryStrong: 'とても強い',
    pwLength: '{n} 文字以上にしてください。長いほど安全です。',
    pwCommon: '最もよく使われるパスワードの一つです。',
    pwDictionary: 'よく使われるパスワードや単語が含まれています。',
    pwSequence: 'abc、321、qwerty のような並びが含まれています。',
    pwRepeat: '繰り返しの文字やパターンが含まれています。',
    pwContext: '「zetaphy」「wallet」やアドレスの一部が含まれています。',
    pwYear: '年が含まれています。',
    pwVariety: '単語を増やすか、大文字・小文字・数字・記号を混ぜてください。',
    weakNudge: 'パスフレーズが弱いです（強度：{label}）。このブラウザのデータをコピーした人に推測されるおそれがあります。より強いものに変更してください。',
    weakNudgeGo: '今すぐ変更',
    secTitle: 'セキュリティ',
    autoLockLabel: '操作がない、またはバックグラウンドのタブにある状態がこの時間続いたら自動ロック',
    nMinutes: '{n} 分',
    autoLockIn: '操作がなければ {time} 後に自動ロックします。',
    autoLocked: '{n} 分間操作がなかったため自動ロックしました。鍵はメモリから消去しました。',
    autoLockSaved: '自動ロックを {n} 分に設定しました。',
    lockedErr: 'ウォレットはロックされています。先にロックを解除してください。何も署名していません。',
    chpwTitle: 'パスフレーズを変更',
    chpwOld: '現在のパスフレーズ',
    chpwNew: '新しいパスフレーズ（12 文字以上、強度「強い」以上）',
    chpwSave: 'パスフレーズを変更',
    chpwDone: 'パスフレーズを変更しました。',
    pkTitle: '指紋 / Face ID でロック解除（パスキー）',
    pkIntro: 'この端末にこのサイト用のパスキーを作成します。指紋・顔・端末の PIN で確認したときだけ得られる PRF の秘密値で、このブラウザ内にシードの 2 つ目のコピーを暗号化します。パスフレーズは予備として引き続き使えます。',
    pkSyncNote: 'パスキーは iCloud キーチェーンや Google パスワード マネージャーなどで同期されることがあり、このパスキーがほかの端末にも存在しうるということです。そのアカウントをしっかり守ってください。',
    pkEnable: '指紋 / Face ID でのロック解除をオン',
    pkDisable: '指紋 / Face ID でのロック解除をオフ',
    pkUnlock: '指紋 / Face ID でロック解除',
    pkOn: '指紋 / Face ID でのロック解除はオンです。パスフレーズも使えます。',
    pkOff: '指紋 / Face ID でのロック解除はオフです。',
    pkOtherSite: 'このパスキーは {host} 用に作成されました。ここではパスフレーズを使ってください。',
    pkUnsupported: 'このブラウザはこのページでパスキーを使えません。パスフレーズを使い続けてください。',
    pkNoPlatform: 'この端末に指紋・顔・PIN の認証器が見つかりません。パスフレーズを使い続けてください。',
    pkNoPrf: 'このブラウザまたはパスキー マネージャーは必要な PRF 拡張に対応していないため、ここではパスキーでウォレットを解除できません。パスフレーズを使い続けてください。',
    pkCancelled: 'キャンセルまたはタイムアウトしました。何も変わっていません。',
    pkFailed: 'パスキーでこのウォレットを解除できませんでした。パスフレーズを使ってください。',
    pkWorking: '指紋 / Face ID を待っています…',
    pkEnabled: 'パスキーを作成しました。指紋 / Face ID でロック解除できます。パスフレーズも使えます。',
    pkDisabled: 'パスキーでのロック解除をオフにし、暗号化したコピーを削除しました。端末のパスキー設定で「ZETAPHY PQ Wallet」のパスキーも削除できます。',
    pkDisableConfirm: '指紋 / Face ID でのロック解除をオフにしますか？以後はパスフレーズでのみ解除できます。',
    bigTitle: '残高が大きくなっています：鍵をより安全な場所に置くことを検討してください',
    bigLocal: 'このアカウントには {amount} ZETAPHY あります。ウェブページ内の鍵は、このブラウザとパソコンと同じ程度にしか安全ではありません。大きな金額は、鍵が MetaMask の中にある ZETAPHY Snap に移してください。',
    bigEvm: '接続中の EVM アカウントには {amount} ZETAPHY あります。大きな金額は MetaMask や Rabby 経由でハードウェアウォレット（Ledger または Trezor）を使ってください。',
    bigHow: '方法',
    bigLater: '7 日間表示しない',
    helpOpen: '大きな残高を安全に保つ',
    helpTitle: '大きな残高を安全に保つ',
    helpIntro: 'ウェブページ内の鍵は、動いているブラウザとパソコンと同じ程度にしか安全ではありません。ウォレットのロック解除中は、悪意ある拡張機能やマルウェアに読まれるおそれがあります。ここには少額だけを置いてください。',
    helpSnapTitle: 'ネイティブ PQ アカウント：ZETAPHY Snap に移す（鍵は MetaMask の中）',
    helpSnap1: 'MetaMask をインストールし（snap の公開までは MetaMask Flask）、シークレットリカバリーフレーズをバックアップします。',
    helpSnap2: 'このウォレットをロックし、「MetaMask に接続」を押して ZETAPHY Snap を承認します。',
    helpSnap3: '表示された zetaphy1… アドレスをコピーします。これが MetaMask の中で作られた新しいアカウントです。',
    helpSnap4: 'パスフレーズでこのウォレットを再び解除し、そのアドレスに資金を送ります。MetaMask のダイアログでもアドレスを確認してください。',
    helpHwTitle: 'EVM アカウント：ハードウェアウォレット',
    helpHw1: 'Ledger または Trezor を MetaMask や Rabby に接続します（ハードウェアウォレットのアカウントを追加）。',
    helpHw2: 'このページの「他のウォレットで ZETAPHY を使う」のボタンで ZETAPHY Testnet ネットワークを追加します。',
    helpHw3: 'ハードウェアアカウントの 0x… アドレスに資金を送り、すべての取引を端末自身の画面で確認します。',
    helpMore: '詳しくは README のセキュリティの節にあります。これはテストネットで、本物のお金ではありません。',
    helpClose: '閉じる',
  },
  ru: {
    subtitle: 'Квантово-устойчивый кошелёк (ML-DSA-44) · без ключа ECDSA',
    warnTitle: 'Только тестнет',
    warnTestnet: 'Тестнет ZETAPHY — это не настоящие деньги. Не храните здесь ничего ценного.',
    warnSeed: 'Сид — единственный ключ к этому кошельку. Потеряете его или забудете пароль — средства пропадут навсегда. Восстановить их не сможет никто.',
    warnLocal: 'Сид хранится только в этом браузере, зашифрованный вашим паролем, и никуда не отправляется.',
    rpcLabel: 'RPC URL вашей ноды ZETAPHY (JSON-RPC, порт 8545)',
    rpcSave: 'Сохранить',
    rpcHint: 'Если страница открыта по https, RPC тоже должен быть https (браузеры блокируют http).',
    setupTitle: 'Начало работы',
    modeNew: 'Создать новый ключ',
    modeImport: 'Импортировать сид',
    seedLabel: 'Сид (64 hex-цифры, 0x необязательно)',
    pass1: 'Придумайте пароль (не менее 12 символов, уровень «надёжный»)',
    pass2: 'Введите пароль ещё раз',
    saveKey: 'Создать кошелёк',
    lockedTitle: 'Кошелёк заблокирован',
    unlockLabel: 'Пароль',
    unlock: 'Разблокировать',
    forget: 'Удалить кошелёк из этого браузера',
    accountTitle: 'Ваш аккаунт',
    sameAccount: 'Оба адреса — один и тот же аккаунт. Получать средства можно на любой из них.',
    copy: 'Копировать',
    balance: 'Баланс',
    refresh: 'Обновить',
    sendTitle: 'Отправить ZETAPHY',
    toLabel: 'Кому (0x… или zetaphy1…)',
    amountLabel: 'Сумма (ZETAPHY)',
    advanced: 'Дополнительные настройки',
    gasLabel: 'Лимит газа',
    review: 'Проверить',
    confirmTitle: 'Подтвердите перевод',
    cTo: 'Кому',
    cAmount: 'Сумма',
    cFee: 'Макс. комиссия',
    cTotal: 'Итого',
    confirmSend: 'Подтвердить, подписать ML-DSA и отправить',
    cancel: 'Отмена',
    txSent: 'Отправлено. Хеш транзакции:',
    backupTitle: 'Резервная копия сида',
    backupWarn: 'Файл резервной копии — это сид в открытом виде. Любой, кто его получит, сможет вывести средства. Храните его офлайн в надёжном месте и никому не передавайте.',
    backupOk: 'Понятно',
    backup: 'Скачать резервную копию сида',
    backupCli: 'Файл подходит как ~/.zetaphy/pq.seed для команды zetaphy pq native.',
    lock: 'Заблокировать кошелёк',
    footer: 'Весь код находится на этой странице; никаких сторонних скриптов · Транзакции подписываются ML-DSA-44 (FIPS 204) в браузере или в MetaMask через ZETAPHY Snap',
    working: 'Выполняется…',
    deriving: 'Шифруем сид (это займёт немного времени)…',
    created: 'Кошелёк создан. Скачайте резервную копию сида, прежде чем получать средства.',
    imported: 'Сид импортирован.',
    unlocked: 'Разблокирован.',
    lockedMsg: 'Заблокирован.',
    badPass: 'Неверный пароль.',
    passShort: 'Пароль должен содержать не менее {n} символов.',
    passMismatch: 'Пароли не совпадают.',
    badSeed: 'Сид должен состоять из 64 hex-цифр.',
    storeFailed: 'Этот браузер не может сохранять данные (режим инкогнито?). Кошелёк исчезнет после закрытия страницы: скачайте резервную копию.',
    rpcSaved: 'RPC сохранён.',
    needRpc: 'Сначала введите RPC URL вашей ноды.',
    badRpc: 'RPC URL должен начинаться с http:// или https://',
    wrongChain: 'Этот RPC не относится к тестнету ZETAPHY (chain id {id}).',
    rpcDown: 'Не удаётся подключиться к RPC (нода недоступна, CORS не разрешён или http на странице https).',
    notFunded: 'Аккаунта ещё нет в сети: сначала отправьте ZETAPHY на этот адрес, тогда с него можно будет отправлять.',
    onChain: 'В сети (аккаунт {n}, отправлено транзакций: {s}).',
    badAddress: 'Неверный адрес получателя (проверьте написание или контрольную сумму).',
    badAmount: 'Неверная сумма.',
    badGas: 'Лимит газа должен быть целым числом больше 0.',
    notEnough: 'Недостаточно средств: нужно {need} ZETAPHY (с комиссией), есть {have}.',
    signing: 'Подписываем ML-DSA-44 и отправляем…',
    sent: 'Отправлено. Нода приняла транзакцию; она попадёт в блок через несколько секунд.',
    rejected: 'Нода отклонила транзакцию',
    copied: 'Скопировано.',
    forgetConfirm: 'Удалить кошелёк из этого браузера? Без резервной копии сида средства будут потеряны навсегда.',
    forgotten: 'Кошелёк удалён из этого браузера.',
    backupDone: 'Резервная копия скачана. Храните её офлайн.',
    tokenTitle: 'Токены ERC-20',
    tokenLabel: 'Адрес контракта токена (0x…)',
    tokenLoad: 'Найти',
    tokenBalance: 'Баланс токена',
    tokenMeta: '{sym} · знаков после запятой: {d} · контракт {addr}',
    tokenAmountLabel: 'Количество токена',
    evmGasLabel: 'Лимит газа EVM (комиссия — за этот газ плюс саму транзакцию)',
    tokenConfirmTitle: 'Подтвердите перевод токена',
    cToken: 'Токен',
    tokenChecked: 'Симуляция на ноде: перевод проходит (перед подписью симулируется ещё раз).',
    tokenNote: 'Комиссия оплачивается в ZETAPHY. Если контракт сделает revert, вся транзакция завершится ошибкой, а комиссия всё равно будет списана, поэтому эта страница симулирует каждый перевод перед подписью.',
    badToken: 'Контракт токена должен быть 0x и 40 hex-цифр (проверьте контрольную сумму).',
    noContract: 'По адресу {addr} нет контракта.',
    notToken: 'Этот контракт не является токеном ERC-20 (нет decimals()).',
    tokenDecimals: 'У суммы больше {d} знаков после запятой для {sym}.',
    badEvmGas: 'Лимит газа EVM должен быть целым числом от {min} до {max}.',
    tokenNotEnough: 'Недостаточно токенов: отправляется {need} {sym}, есть {have}.',
    callFails: 'Не отправлено: по симуляции на ноде перевод завершится ошибкой (revert)',
    tokenRefused: 'Не отправлено: токен отклонил перевод (transfer вернул false).',
    tokenSent: 'Отправлено. Нода приняла транзакцию. (Это Cosmos-транзакция, поэтому её EVM-логов нет в eth_getLogs; балансы при этом верные.)',
    stakeTitle: 'Стейкинг ZETAPHY',
    validatorLabel: 'Валидатор (zetaphyvaloper1…)',
    stakeAmountLabel: 'Сумма (ZETAPHY), для получения наград не нужна',
    stake: 'Застейкать',
    unstake: 'Вывести из стейкинга',
    claim: 'Получить награды',
    confirmStake: 'Подтвердите стейкинг',
    confirmUnstake: 'Подтвердите вывод из стейкинга',
    confirmClaim: 'Подтвердите получение наград',
    cValidator: 'Валидатор',
    unbondNote: 'Выведенные из стейкинга ZETAPHY вернутся после периода анбондинга сети. До этого их нельзя использовать, и награды на них не начисляются.',
    badValidator: 'Валидатор должен быть адресом zetaphyvaloper1… (проверьте написание или контрольную сумму).',
    staked: 'Стейкинг отправлен. Нода приняла транзакцию.',
    unstaked: 'Вывод из стейкинга отправлен. ZETAPHY вернутся после периода анбондинга.',
    claimed: 'Запрос наград отправлен. Награды поступят, когда транзакция попадёт в блок.',
    ownedTitle: 'Аккаунты под управлением этого кошелька',
    ownedHint: 'ECDSA-аккаунты (например, MetaMask), квантово заблокированные на этот кошелёк. Их собственные ключи больше не работают; этот кошелёк отправляет монеты, токены и делает стейкинг за них (подпись ML-DSA-44, комиссии платит этот кошелёк).',
    ownerLabel: 'Адрес заблокированного аккаунта (0x… или zetaphy1…)',
    ownerUse: 'Действовать от имени этого аккаунта',
    actingAs: 'Действуете от имени',
    ownerBalance: 'Его баланс',
    actingHint: 'Отправка, переводы токенов и стейкинг ниже выполняются от имени этого аккаунта (as_owner). Комиссии списываются с этого кошелька.',
    ownerStop: 'Вернуться к моему аккаунту',
    ownedMine: 'заблокирован на этот кошелёк',
    ownedNotMine: 'не заблокирован на этот кошелёк (или ещё не в блоке)',
    ownedOther: 'заблокирован на другой аккаунт: {to}',
    asTag: 'От имени {owner}',
    asNote: 'От имени {owner}, квантово заблокированного на этот кошелёк: средства и токены списываются с того аккаунта; комиссию платит этот кошелёк.',
    nowActing: 'Теперь вы действуете от имени {owner}.',
    stopActing: 'Вы вернулись к своему аккаунту.',
    ownerNotLocked: 'Этот аккаунт не заблокирован квантово на этот кошелёк, поэтому кошелёк не может действовать от его имени.',
    ownerOther: 'Этот аккаунт заблокирован на другой аккаунт ({to}), а не на этот кошелёк.',
    ownerSelf: 'Это собственный аккаунт этого кошелька.',
    ownerNotEnough: 'На том аккаунте недостаточно средств: нужно {need} ZETAPHY, есть {have}.',
    mmTitle: 'Заблокировать аккаунт MetaMask на этот кошелёк',
    mmIntro: 'Передайте управление ECDSA-аккаунтом из MetaMask этому квантово-устойчивому кошельку. Адрес, баланс, токены и стейк остаются на месте, но двигать их отныне может только этот кошелёк.',
    mmWarnPermanent: 'Навсегда, без отмены: после блокировки сеть отклоняет любую транзакцию, подписанную ключом MetaMask этого аккаунта, а контракты больше не принимают его подписи (например, permit).',
    mmWarnSeed: 'Если вы потеряете сид этого кошелька, заблокированный аккаунт тоже будет потерян. Сначала скачайте резервную копию сида.',
    mmWarnTx: 'Этот кошелёк должен был отправить в сети хотя бы одну транзакцию (чтобы сеть знала его публичный ключ ML-DSA-44).',
    mmOk: 'Я понимаю, что блокировка необратима',
    mmLock: 'Подключить MetaMask и заблокировать',
    mmSentLabel: 'MetaMask отправил блокировку. Хеш транзакции:',
    mmConfirm: 'Навсегда заблокировать аккаунт MetaMask {owner} на этот кошелёк ({me})?\n\nЕго ключ MetaMask больше никогда не будет работать в ZETAPHY, а если сид этого кошелька будет потерян, пропадёт и этот аккаунт.',
    mmMissing: 'MetaMask (window.ethereum) не найден в этом браузере.',
    mmDenied: 'MetaMask не разрешил подключить аккаунт.',
    mmRejected: 'Отклонено в MetaMask. Ничего не отправлено.',
    mmWrongChain: 'MetaMask не подключён к тестнету ZETAPHY (chain id {id}). Сначала переключите сеть в MetaMask.',
    mmNeedTx: 'Этот кошелёк ещё не отправил ни одной транзакции: сначала отправьте одну (например, самому себе), тогда сеть примет его как контроллер.',
    mmSelfLocked: 'Этот кошелёк сам заблокирован на другой аккаунт, поэтому не может быть контроллером.',
    mmAlreadyLocked: 'Этот аккаунт MetaMask уже заблокирован на {to}.',
    mmAlreadyMine: 'Этот аккаунт MetaMask уже заблокирован на этот кошелёк.',
    mmCancelled: 'Отменено. Ничего не отправлено.',
    mmSent: 'MetaMask отправил блокировку. Когда она попадёт в блок, аккаунт появится в списке выше.',
    mmWarnSeedSnap: 'Если вы потеряете Секретную фразу для восстановления MetaMask, заблокированный аккаунт тоже будет потерян.',
    qdTitle: 'Подготовка к Q-day',
    qdIntro: 'Q-day — момент, когда сеть перестаёт доверять подписям ECDSA (ключам вроде MetaMask), потому что квантовый компьютер может их подделать. С этого момента ECDSA-аккаунт, который не был перенесён, замораживается (средства остаются, но отправлять нельзя). Самый надёжный путь — заранее заблокировать свой аккаунт MetaMask на этот кошелёк (карточка выше).',
    qdCheck: 'Проверить мой аккаунт MetaMask',
    qdNone: 'Q-day: не назначен (сеть объявляет его голосованием, заблаговременно).',
    qdScheduled: 'Q-day: блок {h} (сейчас {now}). С этого момента транзакции с подписью ECDSA отклоняются.',
    qdPassed: 'Q-day наступил (блок {h}): транзакции с подписью ECDSA отклоняются.',
    qdOff: 'Ядро безопасности на этой ноде не включено.',
    qdPQ: '{acct}: уже аккаунт ML-DSA-44; ничего делать не нужно.',
    qdMigrated: '{acct}: перенесён; его контроллер — {to}.',
    qdPending: '{acct}: переносится на {to}, окончательно в блоке {h}.',
    qdExposed: '{acct}: не перенесён, и его публичный ключ уже использовался в сети. Заблокируйте его до Q-day (карточка выше), иначе он будет заморожен.',
    qdUnexposed: '{acct}: не перенесён, но его ключ ни разу не использовался в сети. Заблокируйте его сейчас (рекомендуется) или после Q-day перенесите через commit–reveal ниже.',
    qdRecoverWarn: 'Внимание: текст, который MetaMask просит подписать на этих двух шагах, передаёт полный контроль над {acct} аккаунту {ctrl} (аккаунт ML-DSA-44 этого кошелька). Убедитесь, что в строке «New ML-DSA-44 controller» указан {ctrl}, и подписывайте этот текст только в официальном кошельке ZETAPHY. Любой другой сайт, который просит подписать текст «ZETAPHY Q-day migration», может забрать аккаунт.',
    qdRecoverIntro: 'Восстановление после Q-day (только для ключей, ни разу не использованных в сети): MetaMask подписывает текст локально и ничего не отправляет. Этот кошелёк записывает обязательство (шаг 1), ждёт {d} блоков, затем раскрывает его (шаг 2); ещё через {d} блоков аккаунт переходит к этому кошельку.',
    qdCommit: 'Шаг 1: записать обязательство',
    qdReveal: 'Шаг 2: раскрыть',
    qdCommitted: 'Обязательство записано. Раскрыть можно с блока {h}.',
    qdAlready: 'Это обязательство записано в блоке {h}: раскрыть можно с блока {r}.',
    qdNoCommit: 'Обязательства пока нет: сначала выполните шаг 1.',
    qdTooEarly: 'Слишком рано: раскрыть можно с блока {h} (сейчас {now}).',
    qdNotYet: 'Раскрытие откроется в Q-day. До этого заблокируйте аккаунт из MetaMask (карточка выше).',
    qdRevealed: 'Раскрыто: аккаунт перейдёт к этому кошельку в финальном блоке.',
    qdCannot: 'Этот аккаунт не может использовать commit–reveal (уже перенесён или его ключ использовался в сети).',
    csTitle: 'Согласие на помеченный контракт',
    csIntro: 'Когда включён фильтр угроз, сеть не доставляет транзакцию в контракт с действующей меткой Neuro, если сам аккаунт не дал согласие (одна транзакция, не более суток). Это согласие, а не цензура: вы можете продолжить, но сначала прочтите причину метки.',
    csTarget: 'Контракт (0x…)',
    csSeconds: 'На какой срок',
    csOk: 'Я прочитал причину метки и беру риск на себя',
    csSend: 'Отправить согласие из этого кошелька',
    csSendMM: 'Отправить согласие из MetaMask',
    csSent: 'Согласие отправлено. Хеш транзакции:',
    csBad: 'Введите адрес контракта: 0x и 40 hex-цифр.',
    threatConsented: 'Внимание: у {addr} действующая метка ({what} · причина: {reason}), но вы дали согласие, поэтому отправка возможна. · {details}',
    snapTitle: 'Использовать MetaMask (ZETAPHY Snap)',
    snapIntro: 'Ключ ML-DSA-44 создаётся внутри MetaMask из вашей Секретной фразы для восстановления; эта страница его никогда не видит. MetaMask показывает каждую транзакцию простыми словами перед подписью.',
    snapFlask: 'Пока снап не опубликован и не проверен MetaMask, он устанавливается только в MetaMask Flask (сборка для разработчиков).',
    snapIdLabel: 'ID снапа (npm:@zetaphy/snap или local:http://localhost:8080 при разработке)',
    snapIdHint: 'Аккаунт зависит от ID снапа: один и тот же снап всегда даёт один и тот же аккаунт (восстанавливается из Секретной фразы для восстановления), снап local:… даёт другой.',
    snapConnect: 'Подключить MetaMask',
    snapConnected: 'Подключено к MetaMask (ZETAPHY Snap).',
    snapMode: 'Ключ находится в MetaMask (ZETAPHY Snap), а не на этой странице. Его резервная копия — ваша Секретная фраза для восстановления MetaMask.',
    snapDisconnect: 'Отключить MetaMask от этой страницы',
    snapDisconnected: 'MetaMask отключён от этой страницы (снап остаётся установленным в MetaMask).',
    snapBadId: 'ID снапа должен быть npm:<package> или local:http://localhost:<port>.',
    snapDenied: 'MetaMask не установил или не разрешил снап.',
    snapUnsupported: 'Этот MetaMask не умеет запускать снапы (используйте MetaMask Flask или версию с поддержкой снапов).',
    snapBadAccount: 'Снап вернул аккаунт, не соответствующий его публичному ключу, поэтому он не используется.',
    snapConfirm: 'Проверьте детали и подтвердите в окне MetaMask…',
    snapRejected: 'Отклонено в MetaMask. Ничего не подписано и не отправлено.',
    snapMismatch: 'Снап подписал не ту транзакцию, которую запрашивали, поэтому ничего не отправлено.',
    deployTitle: 'Развернуть контракт',
    initCodeLabel: 'Байткод создания (hex, с аргументами конструктора)',
    deployConfirmTitle: 'Подтвердите создание контракта',
    cCodeSize: 'Размер кода',
    cCodeHash: 'Хеш кода (keccak-256)',
    bytesN: '{n} байт',
    deployChecked: 'Симуляция на ноде: проходит (перед подписью симулируется ещё раз). Сравните хеш кода с тем, что опубликовал автор контракта. У создания контракта нет получателя, поэтому оно не проверяется по ThreatRegistry.',
    deployedAt: 'Адрес нового контракта:',
    badInitCode: 'Байткод должен быть непустым hex (0x…).',
    deploySent: 'Отправлено. Нода приняла транзакцию; контракт появится, когда транзакция попадёт в блок.',
    walletsTitle: 'ZETAPHY в других кошельках',
    walletsIntro: 'Добавьте сеть ZETAPHY Testnet в кошелёк, которым вы уже пользуетесь (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap, …), кнопками ниже или введите параметры вручную. Всё берётся из RPC URL выше.',
    evmWalletsTitle: 'EVM-кошельки в этом браузере',
    evmNone: 'В этом браузере не найден EVM-кошелёк. Установите расширение (MetaMask, Rabby, Trust, OKX, Coinbase Wallet, …) или на телефоне откройте эту страницу во встроенном браузере приложения кошелька.',
    evmAdd: 'Добавить ZETAPHY в этот кошелёк',
    evmConnect: 'Подключить этот кошелёк',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (мобильные кошельки, когда страница открыта в другом браузере, например Binance Wallet) выключен: сначала нужен projectId от Reown.',
    wcOn: 'projectId задан, но WalletConnect на этой странице пока нет (это следующий шаг).',
    wcNotYet: 'WalletConnect на этой странице пока нет (это следующий шаг). А пока на телефоне откройте эту страницу во встроенном браузере приложения кошелька.',
    wcIdLabel: 'projectId WalletConnect (от Reown, 32 hex-цифры)',
    wcIdHint: 'Бесплатно на cloud.reown.com. Укажите его здесь (запоминается в этом браузере) или для всех в meta-теге zetaphy-walletconnect-project-id в index.html.',
    wcSaved: 'projectId сохранён.',
    wcBadId: 'projectId должен состоять из 32 hex-цифр.',
    manualTitle: 'Добавить сеть вручную: что вводить',
    mNetwork: 'Название сети',
    mRpc: 'RPC URL',
    mChainId: 'ID сети',
    mSymbol: 'Символ валюты',
    mDecimals: 'Знаков после запятой',
    mExplorer: 'Обозреватель блоков',
    mNone: 'нет (оставьте пустым)',
    mRpcUnset: '(сначала введите выше https RPC URL)',
    mSymbolNote: '{sym} — это ZETAPHY: MetaMask и chainlist принимают символ не длиннее 6 букв, поэтому EVM-кошельки показывают баланс как {sym}. Не импортируйте токен по адресу {precompile}: это та же монета (вы увидите баланс дважды).',
    cosmosTitle: 'Cosmos-кошельки (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'Они показывают адрес zetaphy1… того же аккаунта, что и в EVM-кошельке (ключ eth_secp256k1, coin type 60). Им нужен https-адрес ноды, отдающей /rpc и /rest (ноды, настроенные через setup-node.sh, это умеют).',
    keplrAdd: 'Добавить в Keplr',
    leapAdd: 'Добавить в Leap',
    cosmostationAdd: 'Добавить в Cosmostation',
    supportTitle: 'Какие кошельки работают',
    supWorks: 'Работают сейчас (пользовательские сети): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame, а через них и Ledger/Trezor. Keplr, Leap и Cosmostation — кнопками выше.',
    supMaybe: 'Могут работать (не подтверждено): Binance Wallet внутри приложения Binance, если он примет сеть; вне приложения нужен WalletConnect.',
    supNot: 'Не работают, пока кошелёк сам не добавит ZETAPHY: Phantom и кошельки с фиксированным списком сетей.',
    supNever: 'Никогда: кошельки только для Solana или только для Bitcoin. Это не EVM- и не Cosmos-кошельки.',
    supPq: 'Квантово-устойчивы: только собственный ключ ML-DSA-44 этой страницы и ZETAPHY Snap. Все остальные кошельки подписывают ECDSA (secp256k1), который достаточно мощный квантовый компьютер может взломать; заблокируйте такой аккаунт на этот кошелёк, чтобы защитить его.',
    usingWallet: 'Используемый кошелёк: {name}',
    usingNone: 'В этом браузере пока не найден EVM-кошелёк.',
    changeWallet: 'Выбрать другой кошелёк',
    inApp: 'Эта страница открыта во встроенном браузере {name}: кнопки ниже используют его.',
    mobileNoWallet: 'На телефоне: откройте эту страницу во встроенном браузере приложения кошелька (по ссылке ниже или скопировав адрес страницы во вкладку «Браузер» приложения).',
    phantomNote: 'Phantom не позволяет добавлять сети: он поддерживает только выбранные Phantom сети, поэтому не сможет использовать ZETAPHY, пока Phantom её не добавит. Используйте другой кошелёк (MetaMask, Rabby, Trust, OKX, Coinbase).',
    binanceNote: 'Binance Wallet может пока не принимать новые сети. Если добавить не получится, введите параметры ниже вручную или используйте другой кошелёк.',
    evmMissing: 'В этом браузере не найден EVM-кошелёк.',
    evmRejected: 'Отменено в кошельке.',
    evmDenied: 'Кошелёк не разрешил подключить аккаунт.',
    chainNeedHttps: 'Кошельки принимают только https RPC URL (или localhost). Введите выше https-адрес ноды, например https://1-2-3-4.sslip.io',
    chainAdding: 'Подтвердите добавление ZETAPHY Testnet в окне {name}…',
    chainAdded: 'ZETAPHY Testnet добавлена в {name} и выбрана.',
    chainAddedNoSwitch: 'ZETAPHY Testnet добавлена в {name}, но не выбрана: выберите сеть в кошельке.',
    addChainUnsupported: '{name} не добавил сеть ({why}). Возможно, он пока не принимает новые сети: введите параметры ниже в кошелёк вручную или используйте другой кошелёк.',
    evmConnected: 'Подключено к {name}.',
    evmOnZetaphy: 'В сети ZETAPHY Testnet.',
    evmOtherChain: 'В другой сети (chain id {id}): нажмите «Добавить ZETAPHY в этот кошелёк».',
    evmBalance: 'Баланс {amount} ZETAPHY',
    cosmosMissing: '{name} не найден в этом браузере.',
    cosmosAdding: 'Подтвердите в окне {name}…',
    cosmosRejected: '{name} не добавил сеть ({why}).',
    cosmosAdded: 'ZETAPHY Testnet добавлена в {name}. Ваш адрес ниже.',
    cosmosBadAddress: 'Кошелёк вернул адрес, не начинающийся с zetaphy1…, поэтому он не используется.',
    walletPicked: 'Выбран {name}.',
    snapNotMetaMask: '{name} не умеет запускать MetaMask Snaps. Выберите MetaMask (или MetaMask Flask) в разделе «ZETAPHY в других кошельках» ниже.',
    threatLabel: 'ThreatRegistry (иммунная система: никогда не подписывать транзакции в помеченный код)',
    threatHint: 'Его адрес 0x… в ZETAPHY (запоминается в этом браузере) или для всех в meta-теге zetaphy-threat-registry в index.html. Пусто = meta-тег.',
    threatSaved: 'Адрес ThreatRegistry сохранён.',
    threatBadAddress: 'Адрес ThreatRegistry должен быть 0x и 40 hex-цифр.',
    threatFlagged: 'Не подписано: {addr} помечен иммунной системой ZETAPHY ({what} · причина: {reason}). Этот кошелёк не отправляет транзакции в код с действующей меткой, пока вы сначала не дадите согласие (карточка «Согласие на помеченный контракт»). · {details}',
    threatUnchecked: 'Не подписано: не удалось проверить {addr} по ThreatRegistry {reg}. Если ThreatRegistry задан, без проверки отправки нет.',
    threatUnset: 'Код получателя НЕ проверен: адрес ThreatRegistry не задан (дополнительные настройки под полем RPC).',
    threatClean: 'Проверено по ThreatRegistry: получатель не помечен (по возможности: адрес, его код и код за прокси EIP-1967 / beacon / EIP-1167; перед подписью проверяется ещё раз).',
    threatWarned: 'Внимание: раннеры Neuro пометили {addr} ({what} · причина: {reason}), но метка ещё не действует (управление ещё может её пересмотреть). Когда метка вступит в силу, этот кошелёк откажет (метка, поставленная квалифицированным большинством раннеров или управлением по ускоренной процедуре, действует сразу); отправлять ли сейчас — решать вам. · {details}',
    threatNewWarning: 'Не подписано: {addr} пометили после вашей проверки ({what} · причина: {reason}). Проверьте ещё раз, чтобы увидеть предупреждение. · {details}',
    threatBehind: '{impl} (код за прокси {proxy})',
    threatWhatFingerprint: 'отпечаток его кода (fp1) совпадает с помеченным кодом',
    threatWhatCode: 'его код побайтно совпадает с помеченным кодом',
    threatWhatAddress: 'этот адрес помечен',
    reason1: 'в симулированной сделке покупка прошла, а продажа не удалась или вернула почти ничего',
    reason2: 'какой-то адрес может минтить новые токены без ограничений',
    reason3: 'владелец или администратор может запретить держателям переводить или продавать',
    reason4: 'владелец или администратор может перемещать или сжигать токены или средства других держателей',
    reason5: 'использует то же название или тикер, что и известный токен, но по другому адресу',
    reason6: 'в воспроизводимом тесте перевёл одобренные ему (approve) токены на адрес, который держатель не выбирал',
    reason7: 'другой факт о коде (см. доказательства)',
    threatEvidence: 'Доказательства: reportHash {hash}{uri} · проверить: запустите Neuro на том же коде (zetaphy-neuro: node cli.js <chain> <address> --json) и сравните reportHash',
    threatNoEvidence: 'Доказательства: не сохранены',
    threatEvidenceUnread: 'Доказательства: не удалось прочитать',
    threatResponse: 'Ответ от {by}: «{text}»',
    threatResponseAssigned: 'Ответ назначенного управлением ответчика ({by}): «{text}»',
    threatNoResponse: 'Ответа пока нет',
    threatDisclaimer: 'Автоматический анализ кода, а не обвинение',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'Совет: четыре-пять случайных несвязанных слов дают пароль, надёжный и лёгкий для запоминания.',
    passWeak: 'Этот пароль слишком легко подобрать (уровень: {label}). Нужен уровень не ниже «надёжный»',
    pwStrength: 'Надёжность: {label}',
    pwVeryWeak: 'очень слабый',
    pwWeak: 'слабый',
    pwFair: 'средний',
    pwStrong: 'надёжный',
    pwVeryStrong: 'очень надёжный',
    pwLength: 'Используйте не менее {n} символов; чем длиннее, тем лучше.',
    pwCommon: 'Это один из самых распространённых паролей.',
    pwDictionary: 'Содержит распространённый пароль или слово.',
    pwSequence: 'Содержит последовательность вроде abc, 321 или qwerty.',
    pwRepeat: 'Содержит повторяющиеся символы или шаблоны.',
    pwContext: 'Содержит «zetaphy», «wallet» или часть вашего адреса.',
    pwYear: 'Содержит год.',
    pwVariety: 'Добавьте слов или смешайте заглавные и строчные буквы, цифры и символы.',
    weakNudge: 'Ваш пароль слабый (уровень: {label}). Тот, кто скопирует данные этого браузера, может его подобрать. Смените его на более надёжный.',
    weakNudgeGo: 'Сменить сейчас',
    secTitle: 'Безопасность',
    autoLockLabel: 'Блокировать автоматически после такого времени без действий или в фоновой вкладке',
    nMinutes: '{n} мин',
    autoLockIn: 'Автоблокировка через {time} без действий.',
    autoLocked: 'Заблокирован автоматически после {n} мин без действий. Ключ стёрт из памяти.',
    autoLockSaved: 'Автоблокировка: {n} мин.',
    lockedErr: 'Кошелёк заблокирован. Сначала разблокируйте его; ничего не подписано.',
    chpwTitle: 'Сменить пароль',
    chpwOld: 'Текущий пароль',
    chpwNew: 'Новый пароль (не менее 12 символов, уровень «надёжный»)',
    chpwSave: 'Сменить пароль',
    chpwDone: 'Пароль изменён.',
    pkTitle: 'Разблокировка отпечатком / Face ID (ключ доступа)',
    pkIntro: 'Создаёт ключ доступа (passkey) для этого сайта на этом устройстве. Его секрет PRF, который выдаётся только после отпечатка, лица или PIN-кода устройства, шифрует вторую копию сида в этом браузере. Пароль остаётся запасным способом.',
    pkSyncNote: 'Ключи доступа могут синхронизироваться через Связку ключей iCloud, Диспетчер паролей Google или другой менеджер, поэтому этот ключ может оказаться и на других ваших устройствах. Хорошо защитите эту учётную запись.',
    pkEnable: 'Включить разблокировку отпечатком / Face ID',
    pkDisable: 'Выключить разблокировку отпечатком / Face ID',
    pkUnlock: 'Разблокировать отпечатком / Face ID',
    pkOn: 'Разблокировка отпечатком / Face ID включена. Пароль тоже работает.',
    pkOff: 'Разблокировка отпечатком / Face ID выключена.',
    pkOtherSite: 'Ключ доступа создан для {host}. Здесь используйте пароль.',
    pkUnsupported: 'Этот браузер не может использовать ключи доступа на этой странице. Продолжайте пользоваться паролем.',
    pkNoPlatform: 'На этом устройстве не найден аутентификатор с отпечатком, лицом или PIN-кодом. Продолжайте пользоваться паролем.',
    pkNoPrf: 'Этот браузер или менеджер ключей доступа не поддерживает нужное расширение PRF, поэтому здесь ключ доступа не может разблокировать кошелёк. Продолжайте пользоваться паролем.',
    pkCancelled: 'Отменено или истекло время. Ничего не изменилось.',
    pkFailed: 'Ключ доступа не разблокировал этот кошелёк. Используйте пароль.',
    pkWorking: 'Ожидание отпечатка / Face ID…',
    pkEnabled: 'Ключ доступа создан: теперь можно разблокировать отпечатком / Face ID. Пароль тоже работает.',
    pkDisabled: 'Разблокировка ключом доступа выключена, его зашифрованная копия удалена. Ключ «ZETAPHY PQ Wallet» можно также удалить в настройках ключей доступа устройства.',
    pkDisableConfirm: 'Выключить разблокировку отпечатком / Face ID? Разблокировать можно будет только паролем.',
    bigTitle: 'Крупный баланс: подумайте о более надёжном месте для ключа',
    bigLocal: 'На этом счёте {amount} ZETAPHY. Ключ на веб-странице защищён не лучше, чем этот браузер и компьютер. Крупные суммы переведите в ZETAPHY Snap, где ключ остаётся внутри MetaMask.',
    bigEvm: 'На подключённом EVM-счёте {amount} ZETAPHY. Для крупных сумм используйте аппаратный кошелёк (Ledger или Trezor) через MetaMask или Rabby.',
    bigHow: 'Как это сделать',
    bigLater: 'Скрыть на 7 дней',
    helpOpen: 'Как хранить крупный баланс безопасно',
    helpTitle: 'Как хранить крупный баланс безопасно',
    helpIntro: 'Ключ на веб-странице защищён не лучше, чем браузер и компьютер, на которых она открыта: вредоносное расширение или программа может прочитать его, пока кошелёк разблокирован. Держите здесь только небольшие суммы.',
    helpSnapTitle: 'Собственный PQ-счёт: переход на ZETAPHY Snap (ключ внутри MetaMask)',
    helpSnap1: 'Установите MetaMask (MetaMask Flask, пока snap не опубликован) и сохраните его секретную фразу восстановления.',
    helpSnap2: 'Заблокируйте этот кошелёк, нажмите «Подключить MetaMask» и подтвердите ZETAPHY Snap.',
    helpSnap3: 'Скопируйте показанный адрес zetaphy1…: это новый счёт, созданный внутри MetaMask.',
    helpSnap4: 'Снова разблокируйте этот кошелёк паролем и переведите средства на этот адрес. Сверьте адрес и в окне MetaMask.',
    helpHwTitle: 'EVM-счета: аппаратный кошелёк',
    helpHw1: 'Подключите Ledger или Trezor к MetaMask или Rabby (добавьте там счёт аппаратного кошелька).',
    helpHw2: 'Добавьте сеть ZETAPHY Testnet кнопками раздела «ZETAPHY в других кошельках» на этой странице.',
    helpHw3: 'Переведите средства на адрес 0x… аппаратного счёта и подтверждайте каждую транзакцию на экране самого устройства.',
    helpMore: 'Подробности — в разделе безопасности README. Это тестовая сеть: всё это не настоящие деньги.',
    helpClose: 'Закрыть',
  },
  vi: {
    subtitle: 'Ví kháng lượng tử (ML-DSA-44) · không có khóa ECDSA',
    warnTitle: 'Chỉ dành cho testnet',
    warnTestnet: 'Testnet ZETAPHY không phải tiền thật. Đừng để bất cứ thứ gì có giá trị ở đây.',
    warnSeed: 'Seed là khóa duy nhất của ví này. Mất seed hoặc quên mật khẩu thì tiền sẽ mất vĩnh viễn. Không ai có thể khôi phục được.',
    warnLocal: 'Seed chỉ được lưu trong trình duyệt này, mã hóa bằng mật khẩu của bạn, và không bao giờ được gửi đi đâu.',
    rpcLabel: 'URL RPC của node ZETAPHY của bạn (JSON-RPC, cổng 8545)',
    rpcSave: 'Lưu',
    rpcHint: 'Nếu trang này được mở qua https thì RPC cũng phải là https (trình duyệt chặn http).',
    setupTitle: 'Bắt đầu',
    modeNew: 'Tạo khóa mới',
    modeImport: 'Nhập seed',
    seedLabel: 'Seed (64 chữ số hex, 0x tùy chọn)',
    pass1: 'Đặt mật khẩu (ít nhất 12 ký tự, mức Mạnh trở lên)',
    pass2: 'Nhập lại mật khẩu',
    saveKey: 'Tạo ví',
    lockedTitle: 'Ví đã khóa',
    unlockLabel: 'Mật khẩu',
    unlock: 'Mở khóa',
    forget: 'Xóa ví khỏi trình duyệt này',
    accountTitle: 'Tài khoản của bạn',
    sameAccount: 'Cả hai là cùng một tài khoản. Có thể nhận tiền ở bất kỳ địa chỉ nào.',
    copy: 'Sao chép',
    balance: 'Số dư',
    refresh: 'Làm mới',
    sendTitle: 'Gửi ZETAPHY',
    toLabel: 'Đến (0x… hoặc zetaphy1…)',
    amountLabel: 'Số lượng (ZETAPHY)',
    advanced: 'Cài đặt thêm',
    gasLabel: 'Giới hạn gas',
    review: 'Xem lại',
    confirmTitle: 'Xác nhận chuyển',
    cTo: 'Đến',
    cAmount: 'Số lượng',
    cFee: 'Phí tối đa',
    cTotal: 'Tổng',
    confirmSend: 'Xác nhận, ký bằng ML-DSA và gửi',
    cancel: 'Hủy',
    txSent: 'Đã gửi. Mã hash giao dịch:',
    backupTitle: 'Sao lưu seed',
    backupWarn: 'Tệp sao lưu chính là seed ở dạng không mã hóa. Ai có được nó đều có thể chuyển tiền đi. Hãy cất giữ ngoại tuyến, an toàn, và không bao giờ chia sẻ.',
    backupOk: 'Tôi đã hiểu',
    backup: 'Tải bản sao lưu seed',
    backupCli: 'Tệp này dùng được làm ~/.zetaphy/pq.seed cho lệnh zetaphy pq native.',
    lock: 'Khóa ví',
    footer: 'Toàn bộ mã nằm trong trang này; không có script từ nơi khác · Giao dịch được ký bằng ML-DSA-44 (FIPS 204) trong trình duyệt, hoặc trong MetaMask với ZETAPHY Snap',
    working: 'Đang xử lý…',
    deriving: 'Đang mã hóa seed (mất một lúc)…',
    created: 'Đã tạo ví. Hãy tải bản sao lưu seed trước khi nhận tiền.',
    imported: 'Đã nhập seed.',
    unlocked: 'Đã mở khóa.',
    lockedMsg: 'Đã khóa.',
    badPass: 'Sai mật khẩu.',
    passShort: 'Mật khẩu phải có ít nhất {n} ký tự.',
    passMismatch: 'Hai mật khẩu không khớp.',
    badSeed: 'Seed phải gồm 64 chữ số hex.',
    storeFailed: 'Trình duyệt này không lưu được dữ liệu (chế độ ẩn danh?). Ví sẽ biến mất khi đóng trang: hãy tải bản sao lưu.',
    rpcSaved: 'Đã lưu RPC.',
    needRpc: 'Hãy nhập URL RPC của node trước.',
    badRpc: 'URL RPC phải bắt đầu bằng http:// hoặc https://',
    wrongChain: 'RPC đó không phải testnet ZETAPHY (chain id {id}).',
    rpcDown: 'Không kết nối được RPC (node ngừng hoạt động, CORS không được phép, hoặc dùng http trên trang https).',
    notFunded: 'Tài khoản chưa có trên chuỗi: hãy gửi ZETAPHY đến địa chỉ này trước, sau đó mới gửi đi được.',
    onChain: 'Đã có trên chuỗi (tài khoản {n}, đã gửi {s} giao dịch).',
    badAddress: 'Địa chỉ người nhận không hợp lệ (kiểm tra chính tả hoặc checksum).',
    badAmount: 'Số lượng không hợp lệ.',
    badGas: 'Giới hạn gas phải là số nguyên lớn hơn 0.',
    notEnough: 'Không đủ: cần {need} ZETAPHY (gồm phí), đang có {have}.',
    signing: 'Đang ký bằng ML-DSA-44 và gửi…',
    sent: 'Đã gửi. Node đã chấp nhận; giao dịch sẽ vào khối trong vài giây.',
    rejected: 'Node đã từ chối giao dịch',
    copied: 'Đã sao chép.',
    forgetConfirm: 'Xóa ví khỏi trình duyệt này? Nếu không có bản sao lưu seed, tiền sẽ mất vĩnh viễn.',
    forgotten: 'Đã xóa ví khỏi trình duyệt này.',
    backupDone: 'Đã tải bản sao lưu. Hãy cất giữ ngoại tuyến.',
    tokenTitle: 'Token ERC-20',
    tokenLabel: 'Địa chỉ hợp đồng token (0x…)',
    tokenLoad: 'Tra cứu',
    tokenBalance: 'Số dư token',
    tokenMeta: '{sym} · {d} chữ số thập phân · hợp đồng {addr}',
    tokenAmountLabel: 'Số lượng token',
    evmGasLabel: 'Giới hạn gas EVM (phí tính cho lượng gas này cộng với bản thân giao dịch)',
    tokenConfirmTitle: 'Xác nhận chuyển token',
    cToken: 'Token',
    tokenChecked: 'Đã mô phỏng trên node: thành công (sẽ được mô phỏng lại ngay trước khi ký).',
    tokenNote: 'Phí được trả bằng ZETAPHY. Nếu hợp đồng bị revert, toàn bộ giao dịch thất bại mà phí vẫn bị trừ, vì vậy trang này mô phỏng mọi lần chuyển trước khi ký.',
    badToken: 'Hợp đồng token phải là 0x và 40 chữ số hex (kiểm tra checksum).',
    noContract: 'Không có hợp đồng nào tại {addr}.',
    notToken: 'Hợp đồng đó không phải token ERC-20 (không có decimals()).',
    tokenDecimals: 'Số lượng có nhiều hơn {d} chữ số thập phân đối với {sym}.',
    badEvmGas: 'Giới hạn gas EVM phải là số nguyên từ {min} đến {max}.',
    tokenNotEnough: 'Không đủ token: đang gửi {need} {sym}, chỉ có {have}.',
    callFails: 'Chưa gửi: mô phỏng trên node cho thấy lần chuyển sẽ thất bại (revert)',
    tokenRefused: 'Chưa gửi: token từ chối lần chuyển (transfer trả về false).',
    tokenSent: 'Đã gửi. Node đã chấp nhận. (Đây là giao dịch Cosmos nên log EVM của nó không có trong eth_getLogs; số dư vẫn chính xác.)',
    stakeTitle: 'Stake ZETAPHY',
    validatorLabel: 'Validator (zetaphyvaloper1…)',
    stakeAmountLabel: 'Số lượng (ZETAPHY), không cần khi nhận thưởng',
    stake: 'Stake',
    unstake: 'Unstake',
    claim: 'Nhận thưởng',
    confirmStake: 'Xác nhận stake',
    confirmUnstake: 'Xác nhận unstake',
    confirmClaim: 'Xác nhận nhận thưởng',
    cValidator: 'Validator',
    unbondNote: 'ZETAPHY đã unstake sẽ trở về sau thời gian unbonding của chuỗi. Trước đó không thể dùng và không được nhận thưởng.',
    badValidator: 'Validator phải là địa chỉ zetaphyvaloper1… (kiểm tra chính tả hoặc checksum).',
    staked: 'Đã gửi lệnh stake. Node đã chấp nhận.',
    unstaked: 'Đã gửi lệnh unstake. ZETAPHY sẽ trở về sau thời gian unbonding.',
    claimed: 'Đã gửi lệnh nhận thưởng. Phần thưởng về khi giao dịch vào khối.',
    ownedTitle: 'Tài khoản do ví này kiểm soát',
    ownedHint: 'Các tài khoản ECDSA (ví dụ MetaMask) đã khóa lượng tử vào ví này. Khóa riêng của chúng không còn dùng được; ví này gửi tiền, gửi token và stake thay cho chúng (ký bằng ML-DSA-44, phí do ví này trả).',
    ownerLabel: 'Địa chỉ tài khoản đã khóa (0x… hoặc zetaphy1…)',
    ownerUse: 'Thao tác với tư cách tài khoản này',
    actingAs: 'Đang thao tác với tư cách',
    ownerBalance: 'Số dư của nó',
    actingHint: 'Các lệnh gửi, chuyển token và stake bên dưới được thực hiện thay cho tài khoản này (as_owner). Phí lấy từ ví này.',
    ownerStop: 'Quay lại tài khoản của tôi',
    ownedMine: 'đã khóa vào ví này',
    ownedNotMine: 'chưa khóa vào ví này (hoặc chưa vào khối)',
    ownedOther: 'đã khóa vào tài khoản khác: {to}',
    asTag: 'Thay cho {owner}',
    asNote: 'Thay cho {owner}, tài khoản đã khóa lượng tử vào ví này: tiền và token đi ra từ tài khoản đó; phí do ví này trả.',
    nowActing: 'Đang thao tác với tư cách {owner}.',
    stopActing: 'Đã quay lại tài khoản của bạn.',
    ownerNotLocked: 'Tài khoản đó chưa khóa lượng tử vào ví này, nên ví này không thể thao tác thay cho nó.',
    ownerOther: 'Tài khoản đó đã khóa vào tài khoản khác ({to}), không phải ví này.',
    ownerSelf: 'Đó là tài khoản của chính ví này.',
    ownerNotEnough: 'Tài khoản đó không đủ: cần {need} ZETAPHY, đang có {have}.',
    mmTitle: 'Khóa tài khoản MetaMask vào ví này',
    mmIntro: 'Giao quyền kiểm soát một tài khoản ECDSA trong MetaMask cho ví kháng lượng tử này. Địa chỉ, số dư, token và stake vẫn giữ nguyên, nhưng từ giờ chỉ ví này mới chuyển được chúng.',
    mmWarnPermanent: 'Vĩnh viễn, không thể hoàn tác: sau khi khóa, chuỗi từ chối mọi giao dịch được ký bằng khóa MetaMask của tài khoản đó, và các hợp đồng không còn chấp nhận chữ ký của nó (ví dụ permit).',
    mmWarnSeed: 'Nếu bạn mất seed của ví này, tài khoản đã khóa cũng mất theo. Hãy tải bản sao lưu seed trước.',
    mmWarnTx: 'Ví này phải đã gửi ít nhất một giao dịch trên chuỗi (để chuỗi biết khóa công khai ML-DSA-44 của nó).',
    mmOk: 'Tôi hiểu việc khóa là vĩnh viễn',
    mmLock: 'Kết nối MetaMask và khóa',
    mmSentLabel: 'MetaMask đã gửi lệnh khóa. Mã hash giao dịch:',
    mmConfirm: 'Khóa vĩnh viễn tài khoản MetaMask {owner} vào ví này ({me})?\n\nKhóa MetaMask của nó sẽ không bao giờ dùng được trên ZETAPHY nữa, và nếu mất seed của ví này thì tài khoản đó cũng mất.',
    mmMissing: 'Không tìm thấy MetaMask (window.ethereum) trong trình duyệt này.',
    mmDenied: 'MetaMask không cho phép kết nối tài khoản.',
    mmRejected: 'Đã bị từ chối trong MetaMask. Chưa gửi gì.',
    mmWrongChain: 'MetaMask không ở testnet ZETAPHY (chain id {id}). Hãy chuyển mạng trong MetaMask trước.',
    mmNeedTx: 'Ví này chưa gửi giao dịch nào: hãy gửi một giao dịch trước (ví dụ cho chính nó), sau đó chuỗi mới chấp nhận nó làm controller.',
    mmSelfLocked: 'Bản thân ví này đã bị khóa vào tài khoản khác, nên không thể làm controller.',
    mmAlreadyLocked: 'Tài khoản MetaMask đó đã khóa vào {to}.',
    mmAlreadyMine: 'Tài khoản MetaMask đó đã khóa vào ví này.',
    mmCancelled: 'Đã hủy. Chưa gửi gì.',
    mmSent: 'MetaMask đã gửi lệnh khóa. Khi vào khối, tài khoản sẽ hiện trong danh sách phía trên.',
    mmWarnSeedSnap: 'Nếu bạn mất Cụm từ khôi phục bí mật của MetaMask, tài khoản đã khóa cũng mất theo.',
    qdTitle: 'Chuẩn bị cho Q-day',
    qdIntro: 'Q-day là thời điểm mạng ngừng tin tưởng chữ ký ECDSA (loại khóa như MetaMask), vì máy tính lượng tử có thể giả mạo chúng. Từ đó, tài khoản ECDSA chưa chuyển đổi sẽ bị đóng băng (tiền vẫn còn nhưng không gửi được). Cách an toàn nhất là khóa tài khoản MetaMask của bạn vào ví này từ trước (thẻ phía trên).',
    qdCheck: 'Kiểm tra tài khoản MetaMask của tôi',
    qdNone: 'Q-day: chưa lên lịch (mạng sẽ công bố bằng bỏ phiếu, từ rất sớm).',
    qdScheduled: 'Q-day: khối {h} (hiện tại {now}). Từ đó, giao dịch ký bằng ECDSA sẽ bị từ chối.',
    qdPassed: 'Q-day đã qua (khối {h}): giao dịch ký bằng ECDSA bị từ chối.',
    qdOff: 'Lõi bảo mật chưa được bật trên node này.',
    qdPQ: '{acct}: đã là tài khoản ML-DSA-44; không cần làm gì.',
    qdMigrated: '{acct}: đã chuyển đổi; controller của nó là {to}.',
    qdPending: '{acct}: đang chuyển sang {to}, hoàn tất tại khối {h}.',
    qdExposed: '{acct}: chưa chuyển đổi, và khóa công khai của nó đã được dùng trên chuỗi. Hãy khóa nó trước Q-day (thẻ phía trên), nếu không nó sẽ bị đóng băng.',
    qdUnexposed: '{acct}: chưa chuyển đổi, nhưng khóa của nó chưa từng được dùng trên chuỗi. Hãy khóa ngay (khuyến nghị), hoặc sau Q-day chuyển nó bằng commit–reveal bên dưới.',
    qdRecoverWarn: 'Cảnh báo: đoạn văn bản MetaMask yêu cầu bạn ký trong hai bước này trao toàn quyền kiểm soát {acct} cho {ctrl} (tài khoản ML-DSA-44 của ví này). Hãy kiểm tra dòng "New ML-DSA-44 controller" là {ctrl}, và chỉ ký văn bản này trong ví ZETAPHY chính thức. Bất kỳ trang nào khác yêu cầu bạn ký văn bản "ZETAPHY Q-day migration" đều có thể chiếm tài khoản.',
    qdRecoverIntro: 'Khôi phục sau Q-day (chỉ với khóa chưa từng dùng trên chuỗi): MetaMask ký một văn bản cục bộ và không gửi gì. Ví này ghi lại cam kết (bước 1), chờ {d} khối rồi tiết lộ (bước 2); {d} khối sau đó tài khoản thuộc về ví này.',
    qdCommit: 'Bước 1: ghi cam kết',
    qdReveal: 'Bước 2: tiết lộ',
    qdCommitted: 'Đã ghi cam kết. Tiết lộ từ khối {h}.',
    qdAlready: 'Cam kết này đã được ghi ở khối {h}: tiết lộ từ khối {r}.',
    qdNoCommit: 'Chưa có cam kết: hãy làm bước 1 trước.',
    qdTooEarly: 'Quá sớm: tiết lộ từ khối {h} (hiện tại {now}).',
    qdNotYet: 'Việc tiết lộ mở ra vào Q-day. Trước đó, hãy khóa tài khoản từ MetaMask (thẻ phía trên).',
    qdRevealed: 'Đã tiết lộ: tài khoản thuộc về ví này tại khối cuối cùng.',
    qdCannot: 'Tài khoản này không dùng được commit–reveal (đã chuyển đổi, hoặc khóa của nó đã được dùng trên chuỗi).',
    csTitle: 'Đồng ý với hợp đồng bị gắn cờ',
    csIntro: 'Khi cổng chặn mối đe dọa được bật, mạng không chuyển giao dịch đến hợp đồng có cờ Neuro đang áp dụng, trừ khi chính tài khoản đồng ý (một giao dịch, tối đa một ngày). Đây là sự đồng ý, không phải kiểm duyệt: bạn vẫn có thể tiếp tục, nhưng hãy đọc lý do gắn cờ trước.',
    csTarget: 'Hợp đồng (0x…)',
    csSeconds: 'Trong bao lâu',
    csOk: 'Tôi đã đọc lý do gắn cờ và tự chịu rủi ro',
    csSend: 'Gửi sự đồng ý từ ví này',
    csSendMM: 'Gửi sự đồng ý từ MetaMask',
    csSent: 'Đã gửi sự đồng ý. Mã hash giao dịch:',
    csBad: 'Nhập địa chỉ hợp đồng: 0x và 40 chữ số hex.',
    threatConsented: 'Cảnh báo: {addr} có cờ đang áp dụng ({what} · lý do: {reason}), nhưng bạn đã đồng ý nên có thể gửi. · {details}',
    snapTitle: 'Dùng MetaMask (ZETAPHY Snap)',
    snapIntro: 'Khóa ML-DSA-44 được tạo bên trong MetaMask từ Cụm từ khôi phục bí mật của bạn; trang này không bao giờ thấy nó. MetaMask hiển thị mọi giao dịch bằng lời dễ hiểu trước khi ký.',
    snapFlask: 'Cho đến khi snap được phát hành và MetaMask xét duyệt, nó chỉ cài được trong MetaMask Flask (bản dành cho nhà phát triển).',
    snapIdLabel: 'Snap ID (npm:@zetaphy/snap, hoặc local:http://localhost:8080 khi phát triển)',
    snapIdHint: 'Tài khoản phụ thuộc vào snap ID: cùng một snap luôn cho cùng một tài khoản (khôi phục được từ Cụm từ khôi phục bí mật), snap local:… cho tài khoản khác.',
    snapConnect: 'Kết nối MetaMask',
    snapConnected: 'Đã kết nối MetaMask (ZETAPHY Snap).',
    snapMode: 'Khóa nằm trong MetaMask (ZETAPHY Snap), không nằm trong trang này. Cụm từ khôi phục bí mật MetaMask của bạn chính là bản sao lưu.',
    snapDisconnect: 'Ngắt kết nối MetaMask khỏi trang này',
    snapDisconnected: 'Đã ngắt MetaMask khỏi trang này (snap vẫn được cài trong MetaMask).',
    snapBadId: 'Snap ID phải là npm:<package> hoặc local:http://localhost:<port>.',
    snapDenied: 'MetaMask không cài hoặc không cho phép snap.',
    snapUnsupported: 'MetaMask này không chạy được snap (dùng MetaMask Flask, hoặc phiên bản có hỗ trợ snap).',
    snapBadAccount: 'Snap trả về một tài khoản không khớp với khóa công khai của nó, nên không được dùng.',
    snapConfirm: 'Kiểm tra chi tiết và phê duyệt trong cửa sổ MetaMask…',
    snapRejected: 'Đã bị từ chối trong MetaMask. Không có gì được ký hay gửi.',
    snapMismatch: 'Snap đã ký một giao dịch khác với giao dịch được yêu cầu, nên không gửi gì.',
    deployTitle: 'Triển khai hợp đồng',
    initCodeLabel: 'Bytecode khởi tạo (hex, kèm tham số constructor nếu có)',
    deployConfirmTitle: 'Xác nhận tạo hợp đồng',
    cCodeSize: 'Kích thước mã',
    cCodeHash: 'Hash của mã (keccak-256)',
    bytesN: '{n} byte',
    deployChecked: 'Đã mô phỏng trên node: thành công (sẽ được mô phỏng lại ngay trước khi ký). Hãy so sánh hash của mã với hash mà tác giả hợp đồng đã công bố. Việc tạo hợp đồng không có địa chỉ đích nên không được đối chiếu với ThreatRegistry.',
    deployedAt: 'Địa chỉ hợp đồng mới:',
    badInitCode: 'Bytecode phải là chuỗi hex không rỗng (0x…).',
    deploySent: 'Đã gửi. Node đã chấp nhận; hợp đồng tồn tại khi giao dịch vào khối.',
    walletsTitle: 'Dùng ZETAPHY trong các ví khác',
    walletsIntro: 'Thêm mạng ZETAPHY Testnet vào ví bạn đang dùng (MetaMask, Rabby, Trust, OKX, Coinbase, Keplr, Leap, …) bằng các nút bên dưới, hoặc tự nhập các giá trị. Mọi thứ đều lấy từ URL RPC phía trên.',
    evmWalletsTitle: 'Ví EVM trong trình duyệt này',
    evmNone: 'Không tìm thấy ví EVM nào trong trình duyệt này. Hãy cài một tiện ích (MetaMask, Rabby, Trust, OKX, Coinbase Wallet, …), hoặc trên điện thoại hãy mở trang này trong trình duyệt của ứng dụng ví.',
    evmAdd: 'Thêm ZETAPHY vào ví này',
    evmConnect: 'Kết nối ví này',
    wcConnect: 'WalletConnect',
    wcOff: 'WalletConnect (ví trên điện thoại khi trang này mở trong trình duyệt khác, ví dụ Binance Wallet) đang tắt: cần có projectId của Reown trước.',
    wcOn: 'Đã đặt projectId, nhưng trang này chưa tích hợp WalletConnect (đó là bước tiếp theo).',
    wcNotYet: 'Trang này chưa tích hợp WalletConnect (đó là bước tiếp theo). Trong lúc chờ, trên điện thoại hãy mở trang này trong trình duyệt của ứng dụng ví.',
    wcIdLabel: 'projectId WalletConnect (từ Reown, 32 chữ số hex)',
    wcIdHint: 'Miễn phí tại cloud.reown.com. Đặt ở đây (được ghi nhớ trong trình duyệt này), hoặc cho mọi người trong thẻ meta zetaphy-walletconnect-project-id của index.html.',
    wcSaved: 'Đã lưu projectId.',
    wcBadId: 'projectId phải gồm 32 chữ số hex.',
    manualTitle: 'Thêm mạng thủ công: các giá trị cần nhập',
    mNetwork: 'Tên mạng',
    mRpc: 'URL RPC',
    mChainId: 'Chain ID',
    mSymbol: 'Ký hiệu tiền tệ',
    mDecimals: 'Số chữ số thập phân',
    mExplorer: 'Trình khám phá khối',
    mNone: 'không có (để trống)',
    mRpcUnset: '(hãy nhập URL RPC https ở trên trước)',
    mSymbolNote: '{sym} chính là ZETAPHY: MetaMask và chainlist chỉ nhận ký hiệu tối đa 6 chữ cái, nên ví EVM hiển thị số dư là {sym}. Đừng nhập token tại {precompile}: đó là cùng một đồng (bạn sẽ thấy số dư hai lần).',
    cosmosTitle: 'Ví Cosmos (Keplr, Leap, Cosmostation)',
    cosmosIntro: 'Chúng hiển thị địa chỉ zetaphy1… của cùng tài khoản như trong ví EVM (khóa eth_secp256k1, coin type 60). Chúng cần địa chỉ https của node, có phục vụ /rpc và /rest (các node cài bằng setup-node.sh đều có).',
    keplrAdd: 'Thêm vào Keplr',
    leapAdd: 'Thêm vào Leap',
    cosmostationAdd: 'Thêm vào Cosmostation',
    supportTitle: 'Những ví nào dùng được',
    supWorks: 'Dùng được ngay (mạng tùy chỉnh): MetaMask, Rabby, Trust, OKX, Coinbase Wallet, Brave, Rainbow, Zerion, Frame, và Ledger/Trezor thông qua chúng. Keplr, Leap và Cosmostation dùng các nút phía trên.',
    supMaybe: 'Có thể dùng được (chưa xác nhận): Binance Wallet, bên trong ứng dụng Binance, nếu nó chấp nhận mạng; bên ngoài ứng dụng thì cần WalletConnect.',
    supNot: 'Chưa dùng được cho đến khi chính ví thêm ZETAPHY: Phantom, và các ví có danh sách chuỗi cố định.',
    supNever: 'Không bao giờ: ví chỉ dành cho Solana hoặc chỉ dành cho Bitcoin. Chúng không phải ví EVM hay Cosmos.',
    supPq: 'Kháng lượng tử: chỉ khóa ML-DSA-44 của chính trang này và ZETAPHY Snap. Mọi ví khác đều ký bằng ECDSA (secp256k1), thứ mà máy tính lượng tử đủ mạnh có thể phá; hãy khóa tài khoản như vậy vào ví này để bảo vệ nó.',
    usingWallet: 'Ví đang dùng: {name}',
    usingNone: 'Chưa tìm thấy ví EVM nào trong trình duyệt này.',
    changeWallet: 'Chọn ví khác',
    inApp: 'Trang này đang mở trong trình duyệt tích hợp của {name}: các nút bên dưới sẽ dùng ví này.',
    mobileNoWallet: 'Trên điện thoại: hãy mở trang này trong trình duyệt của ứng dụng ví (dùng liên kết bên dưới, hoặc sao chép địa chỉ trang này vào tab Trình duyệt của ứng dụng).',
    phantomNote: 'Phantom không cho ai thêm mạng: nó chỉ hỗ trợ các chuỗi do Phantom chọn, nên không dùng được ZETAPHY cho đến khi Phantom thêm vào. Hãy dùng ví khác (MetaMask, Rabby, Trust, OKX, Coinbase).',
    binanceNote: 'Binance Wallet có thể chưa chấp nhận mạng mới. Nếu thêm không được, hãy nhập thủ công các giá trị bên dưới, hoặc dùng ví khác.',
    evmMissing: 'Không tìm thấy ví EVM nào trong trình duyệt này.',
    evmRejected: 'Đã hủy trong ví.',
    evmDenied: 'Ví không cho phép kết nối tài khoản.',
    chainNeedHttps: 'Ví chỉ nhận URL RPC https (hoặc localhost). Hãy nhập địa chỉ https của node ở trên, ví dụ https://1-2-3-4.sslip.io',
    chainAdding: 'Hãy phê duyệt thêm ZETAPHY Testnet trong cửa sổ của {name}…',
    chainAdded: 'Đã thêm ZETAPHY Testnet vào {name} và chọn mạng này.',
    chainAddedNoSwitch: 'Đã thêm ZETAPHY Testnet vào {name}, nhưng chưa chọn: hãy chọn mạng trong ví.',
    addChainUnsupported: '{name} không thêm mạng ({why}). Có thể nó chưa chấp nhận mạng mới: hãy nhập thủ công các giá trị bên dưới vào ví, hoặc dùng ví khác.',
    evmConnected: 'Đã kết nối {name}.',
    evmOnZetaphy: 'Đang ở ZETAPHY Testnet.',
    evmOtherChain: 'Đang ở mạng khác (chain id {id}): hãy bấm "Thêm ZETAPHY vào ví này".',
    evmBalance: 'Số dư {amount} ZETAPHY',
    cosmosMissing: 'Không tìm thấy {name} trong trình duyệt này.',
    cosmosAdding: 'Hãy phê duyệt trong cửa sổ của {name}…',
    cosmosRejected: '{name} không thêm mạng ({why}).',
    cosmosAdded: 'Đã thêm ZETAPHY Testnet vào {name}. Địa chỉ của bạn ở bên dưới.',
    cosmosBadAddress: 'Ví trả về một địa chỉ không phải zetaphy1…, nên không được dùng.',
    walletPicked: 'Đã chọn {name}.',
    snapNotMetaMask: '{name} không chạy được MetaMask Snaps. Hãy chọn MetaMask (hoặc MetaMask Flask) trong mục "Dùng ZETAPHY trong các ví khác" bên dưới.',
    threatLabel: 'ThreatRegistry (hệ miễn dịch: không bao giờ ký giao dịch gửi đến mã bị gắn cờ)',
    threatHint: 'Địa chỉ 0x… của nó trên ZETAPHY (được ghi nhớ trong trình duyệt này), hoặc cho mọi người trong thẻ meta zetaphy-threat-registry của index.html. Để trống = dùng thẻ meta.',
    threatSaved: 'Đã lưu địa chỉ ThreatRegistry.',
    threatBadAddress: 'Địa chỉ ThreatRegistry phải là 0x và 40 chữ số hex.',
    threatFlagged: 'Chưa ký: {addr} bị hệ miễn dịch ZETAPHY gắn cờ ({what} · lý do: {reason}). Ví này không gửi giao dịch đến mã có cờ đang áp dụng, trừ khi bạn đồng ý trước (thẻ "Đồng ý với hợp đồng bị gắn cờ"). · {details}',
    threatUnchecked: 'Chưa ký: không thể đối chiếu {addr} với ThreatRegistry {reg}. Khi đã đặt ThreatRegistry, không kiểm tra được thì không gửi.',
    threatUnset: 'Mã đích CHƯA được kiểm tra: chưa đặt địa chỉ ThreatRegistry (cài đặt nâng cao bên dưới ô RPC).',
    threatClean: 'Đã đối chiếu với ThreatRegistry: đích không bị gắn cờ (trong khả năng: địa chỉ, mã của nó và mã phía sau proxy EIP-1967 / beacon / EIP-1167; kiểm tra lại trước khi ký).',
    threatWarned: 'Cảnh báo: {addr} đã bị các runner Neuro gắn cờ ({what} · lý do: {reason}), nhưng cờ chưa được áp dụng (quản trị vẫn có thể xem xét lại). Ví này sẽ từ chối khi cờ được áp dụng (cờ do đa số áp đảo các runner hoặc quản trị đưa vào luồng nhanh được áp dụng ngay); gửi bây giờ hay không là lựa chọn của bạn. · {details}',
    threatNewWarning: 'Chưa ký: {addr} bị gắn cờ sau khi bạn xem lại ({what} · lý do: {reason}). Hãy xem lại lần nữa để thấy cảnh báo. · {details}',
    threatBehind: '{impl} (mã phía sau proxy {proxy})',
    threatWhatFingerprint: 'dấu vân tay mã (fp1) của nó trùng với mã bị gắn cờ',
    threatWhatCode: 'mã của nó giống hệt từng byte với mã bị gắn cờ',
    threatWhatAddress: 'địa chỉ này bị gắn cờ',
    reason1: 'trong giao dịch mô phỏng, mua được nhưng bán thất bại hoặc gần như không nhận lại được gì',
    reason2: 'một địa chỉ có thể mint token mới không giới hạn',
    reason3: 'chủ sở hữu hoặc admin có thể chặn người nắm giữ chuyển hoặc bán',
    reason4: 'chủ sở hữu hoặc admin có thể chuyển hoặc đốt token hay tiền của người khác',
    reason5: 'dùng cùng tên hoặc ký hiệu với một token đã biết nhưng ở địa chỉ khác',
    reason6: 'trong một thử nghiệm tái lập được, nó đã chuyển token được approve cho nó đến địa chỉ mà người nắm giữ không chọn',
    reason7: 'một sự thật khác về mã (xem bằng chứng)',
    threatEvidence: 'Bằng chứng: reportHash {hash}{uri} · kiểm tra lại: chạy Neuro trên cùng mã (zetaphy-neuro: node cli.js <chain> <address> --json) rồi so sánh reportHash',
    threatNoEvidence: 'Bằng chứng: không có',
    threatEvidenceUnread: 'Bằng chứng: không đọc được',
    threatResponse: 'Phản hồi từ {by}: "{text}"',
    threatResponseAssigned: 'Phản hồi từ người phản hồi do quản trị chỉ định ({by}): "{text}"',
    threatNoResponse: 'Chưa có phản hồi',
    threatDisclaimer: 'Phân tích mã tự động, không phải lời buộc tội',
    // security: auto-lock, passphrase strength, passkey (WebAuthn PRF) unlock, large-balance advice
    pwTip: 'Mẹo: bốn hoặc năm từ ngẫu nhiên, không liên quan nhau tạo thành mật khẩu vừa mạnh vừa dễ nhớ.',
    passWeak: 'Mật khẩu này quá dễ đoán (mức {label}). Mật khẩu phải đạt ít nhất mức Mạnh',
    pwStrength: 'Độ mạnh: {label}',
    pwVeryWeak: 'rất yếu',
    pwWeak: 'yếu',
    pwFair: 'trung bình',
    pwStrong: 'mạnh',
    pwVeryStrong: 'rất mạnh',
    pwLength: 'Dùng ít nhất {n} ký tự; càng dài càng tốt.',
    pwCommon: 'Đây là một trong những mật khẩu phổ biến nhất.',
    pwDictionary: 'Có chứa một mật khẩu hoặc từ phổ biến.',
    pwSequence: 'Có chứa chuỗi liên tiếp như abc, 321 hoặc qwerty.',
    pwRepeat: 'Có chứa ký tự hoặc mẫu lặp lại.',
    pwContext: 'Có chứa "zetaphy", "wallet" hoặc một phần địa chỉ của bạn.',
    pwYear: 'Có chứa một năm.',
    pwVariety: 'Thêm từ, hoặc trộn chữ hoa, chữ thường, chữ số và ký hiệu.',
    weakNudge: 'Mật khẩu của bạn yếu (mức {label}). Ai sao chép được dữ liệu của trình duyệt này có thể đoán ra. Hãy đổi sang mật khẩu mạnh hơn.',
    weakNudgeGo: 'Đổi ngay',
    secTitle: 'Bảo mật',
    autoLockLabel: 'Tự khóa sau khoảng thời gian này không hoạt động, hoặc khi ở thẻ nền',
    nMinutes: '{n} phút',
    autoLockIn: 'Tự khóa sau {time} nếu không hoạt động.',
    autoLocked: 'Đã tự khóa sau {n} phút không hoạt động. Khóa đã được xóa khỏi bộ nhớ.',
    autoLockSaved: 'Đã đặt tự khóa {n} phút.',
    lockedErr: 'Ví đang khóa. Hãy mở khóa trước; chưa ký gì cả.',
    chpwTitle: 'Đổi mật khẩu',
    chpwOld: 'Mật khẩu hiện tại',
    chpwNew: 'Mật khẩu mới (ít nhất 12 ký tự, mức Mạnh trở lên)',
    chpwSave: 'Đổi mật khẩu',
    chpwDone: 'Đã đổi mật khẩu.',
    pkTitle: 'Mở khóa bằng vân tay / Face ID (passkey)',
    pkIntro: 'Tạo một passkey cho trang này trên thiết bị này. Giá trị bí mật PRF của nó, chỉ được trả về sau khi xác thực vân tay, khuôn mặt hoặc PIN thiết bị, dùng để mã hóa bản sao thứ hai của seed trong trình duyệt này. Mật khẩu vẫn dùng được để dự phòng.',
    pkSyncNote: 'Passkey có thể đồng bộ qua iCloud Keychain, Trình quản lý mật khẩu của Google hoặc trình quản lý passkey khác, nên passkey này có thể có trên các thiết bị khác của bạn. Hãy bảo vệ kỹ tài khoản đó.',
    pkEnable: 'Bật mở khóa bằng vân tay / Face ID',
    pkDisable: 'Tắt mở khóa bằng vân tay / Face ID',
    pkUnlock: 'Mở khóa bằng vân tay / Face ID',
    pkOn: 'Mở khóa bằng vân tay / Face ID đang bật. Mật khẩu vẫn dùng được.',
    pkOff: 'Mở khóa bằng vân tay / Face ID đang tắt.',
    pkOtherSite: 'Passkey này được tạo cho {host}. Ở đây hãy dùng mật khẩu.',
    pkUnsupported: 'Trình duyệt này không dùng được passkey trên trang này. Hãy tiếp tục dùng mật khẩu.',
    pkNoPlatform: 'Không tìm thấy trình xác thực vân tay, khuôn mặt hoặc PIN trên thiết bị này. Hãy tiếp tục dùng mật khẩu.',
    pkNoPrf: 'Trình duyệt hoặc trình quản lý passkey này không hỗ trợ phần mở rộng PRF cần thiết, nên ở đây passkey không mở khóa được ví. Hãy tiếp tục dùng mật khẩu.',
    pkCancelled: 'Đã hủy hoặc hết thời gian. Không có gì thay đổi.',
    pkFailed: 'Passkey không mở khóa được ví này. Hãy dùng mật khẩu.',
    pkWorking: 'Đang chờ vân tay / Face ID…',
    pkEnabled: 'Đã tạo passkey: giờ có thể mở khóa bằng vân tay / Face ID. Mật khẩu vẫn dùng được.',
    pkDisabled: 'Đã tắt mở khóa bằng passkey và xóa bản sao đã mã hóa. Bạn cũng có thể xóa passkey "ZETAPHY PQ Wallet" trong phần cài đặt passkey của thiết bị.',
    pkDisableConfirm: 'Tắt mở khóa bằng vân tay / Face ID? Sau đó chỉ mở khóa được bằng mật khẩu.',
    bigTitle: 'Số dư lớn: hãy cân nhắc chỗ an toàn hơn cho khóa',
    bigLocal: 'Tài khoản này có {amount} ZETAPHY. Khóa trong một trang web chỉ an toàn bằng trình duyệt và máy tính này. Với số tiền lớn, hãy chuyển sang ZETAPHY Snap, nơi khóa nằm trong MetaMask.',
    bigEvm: 'Tài khoản EVM đang kết nối có {amount} ZETAPHY. Với số tiền lớn, hãy dùng ví phần cứng (Ledger hoặc Trezor) qua MetaMask hoặc Rabby.',
    bigHow: 'Cách làm',
    bigLater: 'Ẩn trong 7 ngày',
    helpOpen: 'Giữ an toàn cho số dư lớn',
    helpTitle: 'Giữ an toàn cho số dư lớn',
    helpIntro: 'Khóa trong một trang web chỉ an toàn bằng trình duyệt và máy tính đang chạy nó: tiện ích xấu hoặc phần mềm độc hại có thể đọc khóa khi ví đang mở. Chỉ để số tiền nhỏ ở đây.',
    helpSnapTitle: 'Tài khoản PQ gốc: chuyển sang ZETAPHY Snap (khóa nằm trong MetaMask)',
    helpSnap1: 'Cài MetaMask (MetaMask Flask cho đến khi snap được phát hành) và sao lưu Cụm từ khôi phục bí mật của nó.',
    helpSnap2: 'Khóa ví này, rồi bấm "Kết nối MetaMask" và chấp thuận ZETAPHY Snap.',
    helpSnap3: 'Sao chép địa chỉ zetaphy1… hiện ra: đó là tài khoản mới, được tạo trong MetaMask.',
    helpSnap4: 'Mở khóa lại ví này bằng mật khẩu và gửi tiền đến địa chỉ đó. Kiểm tra địa chỉ cả trong hộp thoại của MetaMask.',
    helpHwTitle: 'Tài khoản EVM: ví phần cứng',
    helpHw1: 'Kết nối Ledger hoặc Trezor với MetaMask hoặc Rabby (thêm tài khoản ví phần cứng ở đó).',
    helpHw2: 'Thêm mạng ZETAPHY Testnet bằng các nút ở mục "Dùng ZETAPHY trong các ví khác" của trang này.',
    helpHw3: 'Gửi tiền đến địa chỉ 0x… của tài khoản phần cứng, và xác nhận mọi giao dịch trên màn hình của chính thiết bị.',
    helpMore: 'Chi tiết có trong phần bảo mật của README. Đây là testnet: không có gì là tiền thật.',
    helpClose: 'Đóng',
  },
};

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

// ---- localStorage, never trusted to work ----
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: (k) => { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---- language ----
// The menu (code, native name) in the order shared by every ZETAPHY app; English is the default.
const LANGS = [['en', 'English'], ['zh', '中文'], ['es', 'Español'], ['ko', '한국어'], ['ja', '日本語'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'], ['th', 'ไทย']];
const pickLang = (code) => (LANGS.some(([c]) => c === code) ? code : 'en');
// The snap describes transactions only in these; any other page language asks it for English.
const SNAP_LANGS = ['en', 'th'];
let lang = pickLang(store.get(KEYS.lang));
let lastStatus = null;
// A key missing in this language falls back to English (text that is not a key is shown as is).
const t = (k, vars = {}) => (T[lang][k] ?? T.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ''));

function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  const menu = $('lang');
  if (menu.options.length !== LANGS.length) {
    menu.replaceChildren(...LANGS.map(([code, name]) => Object.assign(document.createElement('option'), { value: code, lang: code, textContent: name })));
  }
  menu.value = lang;
  if (lastStatus) status(...lastStatus);
  if (wallet) { showAccount(); showToken(); showOwned(); autoLockTick(); }
  if (discovery) { renderWallets(); showManual(); showEvmAccount(); }
  showAutoLockChoices();
  showMeter('pass1'); showMeter('chpw-new1');
  showNudge();
  showPasskey();
  showBigBalance();
}

/** status(key, vars, isError, extra): extra is raw text (e.g. a node's log). */
function status(key, vars = {}, isError = false, extra = '') {
  lastStatus = [key, vars, isError, extra];
  $('status').textContent = key ? t(key, vars) + (extra ? `: ${extra}` : '') : extra;
  $('status').classList.toggle('error', isError);
}
const fail = (key, vars, extra) => status(key, vars, true, extra);

// ---- encrypted seed: PBKDF2-SHA256 (600k) -> AES-256-GCM (security.js seal / unseal) ----
const sealedBlob = () => { try { return JSON.parse(store.get(KEYS.seed)); } catch { return null; } };

// ---- the unlocked key, in memory only ----
let wallet = null;

// wallet.kind: 'local' (the seed is in this page) or 'snap' (MetaMask holds the key).
function openSeed(seed) {
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  wallet = { kind: 'local', seed, publicKey, secretKey, addr: pqAddress(publicKey) };
}

/**
 * Forgets the unlocked key: the seed and the ML-DSA secret key are overwritten with zeros
 * and every reference this page holds is dropped, then the unlock screen is shown.
 */
function lock() {
  if (wallet?.kind === 'local') {
    wallet.seed?.fill(0); wallet.secretKey?.fill(0);
    wallet.seed = null; wallet.secretKey = null;
  }
  if (wallet) wallet.locked = true;
  wallet = null;
  pending = null; tokenPending = null; stakePending = null; deployPending = null;
  account = null;
  token = null;
  acting = null; owned = [];
  for (const id of ['confirm', 'token-confirm', 'stake-confirm', 'deploy-confirm', 'tx-result', 'token-result', 'stake-result', 'deploy-result', 'mm-result']) $(id).hidden = true;
  render();
}

/** What pqClient signs with: the key in this page, or the snap (it gets the messages, never bytes). */
/** Signing needs the unlocked wallet, checked again at the moment of signing (an auto-lock may come in between). */
function signer() {
  const w = wallet;
  if (!w || w.locked || (w.kind === 'local' && !w.secretKey)) throw new Error('lockedErr');
  const live = () => { if (wallet !== w || w.locked) throw new Error('lockedErr'); };
  if (w.kind === 'snap') return { publicKey: w.publicKey, signTx: (request) => { live(); return snapSignTx(request); } };
  return { publicKey: w.publicKey, sign: (bytes) => { live(); return ml_dsa44.sign(bytes, w.secretKey); } };
}
const signingStatus = () => status(wallet.kind === 'snap' ? 'snapConfirm' : 'signing');

// ---- JSON-RPC to the user's node ----
let rpcId = 0;
let checkedRpc = null;

function rpcUrl() {
  const u = $('rpc').value.trim();
  if (!u) throw new Error('needRpc');
  if (!/^https?:\/\//i.test(u)) throw new Error('badRpc');
  return u;
}

async function rpcCall(method, params) {
  const url = rpcUrl();
  let r;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer' });
  } catch { throw new Error('rpcDown'); }
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message ?? 'RPC error');
  return j.result;
}

async function checkedCall(method, params) {
  const url = rpcUrl();
  if (checkedRpc !== url) {
    const id = BigInt(await rpcCall('eth_chainId', []));
    if (id !== EVM_CHAIN_ID) throw Object.assign(new Error('wrongChain'), { vars: { id } });
    checkedRpc = url;
  }
  return rpcCall(method, params);
}

const client = pqClient(checkedCall);

/** Shows any error in the user's language where we know it. */
function showError(e) {
  const m = String(e?.message ?? e);
  if (T.en[m]) { if (e.manual) $('manual').open = true; return fail(m, e.vars); }
  if (/does not exist on chain yet/.test(m)) return fail('notFunded');
  const callFails = /the call would fail, so nothing was sent: (.*)$/.exec(m);
  if (callFails) return fail('callFails', {}, T.en[callFails[1]] ? t(callFails[1]) : callFails[1]);
  const other = /quantum-locked to (\S+), not to/.exec(m);
  if (other) return fail('ownerOther', { to: other[1] });
  if (/is not quantum-locked to/.test(m)) return fail('ownerNotLocked');
  const ownerShort = /does not have enough ZETAPHY: it needs (\S+), it has (\S+)$/.exec(m);
  if (ownerShort) return fail('ownerNotEnough', { need: ownerShort[1], have: ownerShort[2] });
  if (/no ML-DSA-44 public key on chain/.test(m)) return fail('mmNeedTx');
  if (/is itself quantum-locked/.test(m)) return fail('mmSelfLocked');
  const short = /not enough ZETAPHY: need (\S+) .*have (\S+)$/.exec(m);
  if (short) return fail('notEnough', { need: short[1], have: short[2] });
  if (/expected zetaphyvaloper1/.test(m)) return fail('badValidator');
  if (/invalid address/.test(m)) return fail('badAddress');
  if (/not an amount|decimal places|more than 0/.test(m)) return fail('badAmount');
  if (/signed another transaction than the one asked for/.test(m)) return fail('snapMismatch');
  const rej = /rejected the transaction (.*)$/.exec(m);
  if (rej) return fail('rejected', {}, rej[1]);
  return fail('', {}, m);
}

// ---- screens ----
function render() {
  const sealed = sealedBlob();
  $('setup').hidden = !!(wallet || sealed);
  $('locked').hidden = !!wallet || !sealed;
  $('snap-card').hidden = !!wallet;
  $('wallet').hidden = !wallet;
  if (!wallet && sealed) $('locked-addr').textContent = sealed.address ?? '';
  const snapMode = wallet?.kind === 'snap';
  $('snap-mode').hidden = $('snap-disconnect').hidden = !snapMode;
  $('backup-card').hidden = snapMode;
  setI18n($('mm-warn-seed'), snapMode ? 'mmWarnSeedSnap' : 'mmWarnSeed');
  $('chpw-box').hidden = $('pk-box').hidden = snapMode;
  if (wallet) { if (!owned.length) loadOwned(); showAccount(); showToken(); showOwned(); }
  if (wallet) { if (!autoLockTimer) startAutoLock(); } else stopAutoLock();
  if (!wallet) $('weak-nudge').hidden = true;
  showPasskey();
  showBigBalance();
}

let account = null;
function showAccount() {
  $('addr-bech32').textContent = wallet.addr.bech32;
  $('addr-hex').textContent = wallet.addr.hex;
  if (!account) { $('acct-status').textContent = ''; return; }
  $('balance').textContent = `${formatZeta(account.balance)} ZETAPHY`;
  showBigBalance();
  $('acct-status').textContent = (account.exists ? t('onChain', { n: account.accountNumber, s: account.sequence }) : t('notFunded'))
    + (account.quantumLockedTo ? ' · ' + t('ownedOther', { to: account.quantumLockedTo }) : '');
}

async function refresh() {
  if (!wallet) return;
  try {
    const [a, balance] = await Promise.all([client.account(wallet.addr.bech32), client.balance(wallet.addr.hex)]);
    account = { ...a, balance };
    showAccount();
    await refreshOwned();
  } catch (e) { return showError(e); }
  // The token panel follows: the one looked up, or the one remembered from last time.
  try {
    if (token) { token.balance = await tokenBalanceOf(token.address); showToken(); } else if ($('token').value.trim()) await loadToken(true);
  } catch (e) { showError(e); }
}

/** Runs fn with the button(s) disabled; any error is shown in the status line. */
async function busy(btns, fn) {
  const list = [].concat(btns);
  for (const b of list) b.disabled = true;
  try { await fn(); } catch (e) { showError(e); } finally { for (const b of list) b.disabled = false; }
}

// ---- setup: new key or import ----
let mode = 'new';
function setMode(m) {
  mode = m;
  $('mode-new').classList.toggle('on', m === 'new');
  $('mode-import').classList.toggle('on', m === 'import');
  $('seed-row').hidden = m !== 'import';
  $('save-key').dataset.i18n = m === 'new' ? 'saveKey' : 'modeImport';
  $('save-key').textContent = t($('save-key').dataset.i18n);
}

async function setupWallet() {
  const p1 = $('pass1').value; const p2 = $('pass2').value;
  let seed;
  if (mode === 'import') {
    const s = $('seed-in').value.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return fail('badSeed');
    seed = hexToBytes(s);
  }
  // An imported seed's address counts as text to keep out of the passphrase.
  let context = [];
  if (seed) {
    const kp = ml_dsa44.keygen(seed);
    kp.secretKey.fill(0);
    context = addressWords(pqAddress(kp.publicKey));
  }
  if (!checkNewPass(p1, p2, context)) { seed?.fill(0); return; }
  seed ??= crypto.getRandomValues(new Uint8Array(32));
  status('deriving');
  openSeed(seed);
  const blob = await seal(seed, p1, wallet.addr.bech32);
  for (const id of ['pass1', 'pass2', 'seed-in']) $(id).value = '';
  showMeter('pass1');
  // A passkey blob left from a wallet removed earlier is not this wallet's.
  if (passkeyBlob() && passkeyBlob().address !== wallet.addr.bech32) store.del(KEYS.passkey);
  account = null;
  render();
  if (!store.set(KEYS.seed, blob)) return fail('storeFailed');
  status(mode === 'import' ? 'imported' : 'created');
  if ($('rpc').value.trim()) refresh();
}

async function unlock() {
  const sealed = store.get(KEYS.seed);
  if (!sealed) return render();
  status('deriving');
  const pass = $('unlock-pass').value;
  const seed = await unseal(sealed, pass);
  openSeed(seed);
  if (wallet.addr.bech32 !== sealedBlob().address) { lock(); throw new Error('unknown wallet format'); }
  $('unlock-pass').value = '';
  account = null;
  render();
  status('unlocked');
  nudgeWeak(pass);
  if ($('rpc').value.trim()) refresh();
}

/** After the seed is open by a passkey: the same screens as a passphrase unlock. */
function opened(msg) {
  account = null;
  render();
  status(msg);
  if ($('rpc').value.trim()) refresh();
}

// ---- passphrase strength (security.js passwordStrength) ----
const addressWords = (addr) => [addr.bech32, addr.hex];
const STRENGTH_KEY = { veryWeak: 'pwVeryWeak', weak: 'pwWeak', fair: 'pwFair', strong: 'pwStrong', veryStrong: 'pwVeryStrong' };
const reasonText = (r) => r.reasons.map((k) => t(k, { n: MIN_PASSWORD_LENGTH }));

/** Fills the meter under input `id` (pass1 or chpw-new1) for what is typed now. */
function showMeter(id) {
  const box = $(id === 'pass1' ? 'pass1-meter' : 'chpw-meter');
  const pw = $(id).value;
  box.hidden = !pw;
  if (!pw) return;
  const r = passwordStrength(pw, { context: wallet?.addr ? addressWords(wallet.addr) : [] });
  box.querySelector('meter').value = r.score;
  const label = box.querySelector('.pw-label');
  label.textContent = t('pwStrength', { label: t(STRENGTH_KEY[r.label]) }) + (r.ok ? ' ✓' : '');
  label.classList.toggle('ok', r.ok);
  label.classList.toggle('bad', !r.ok);
  box.querySelector('.pw-reasons').replaceChildren(...reasonText(r).map((text) => Object.assign(document.createElement('li'), { textContent: text })));
}

/** A new passphrase: at least MIN_PASSWORD_LENGTH characters, rated at least "strong", typed the same twice. */
function checkNewPass(p1, p2, context) {
  if (Array.from(p1).length < MIN_PASSWORD_LENGTH) { fail('passShort', { n: MIN_PASSWORD_LENGTH }); return false; }
  const r = passwordStrength(p1, { context });
  if (!r.ok) { fail('passWeak', { label: t(STRENGTH_KEY[r.label]) }, reasonText(r).join(' ')); return false; }
  if (p1 !== p2) { fail('passMismatch'); return false; }
  return true;
}

/** A wallet unlocked with a weak passphrase: a nudge to change it (the old one keeps working). */
function nudgeWeak(pass) {
  const r = passwordStrength(pass, { context: wallet ? addressWords(wallet.addr) : [] });
  $('weak-nudge').hidden = r.ok;
  $('weak-nudge').dataset.label = r.label;
  showNudge();
}
const showNudge = () => { $('weak-nudge-text').textContent = t('weakNudge', { label: t(STRENGTH_KEY[$('weak-nudge').dataset.label] ?? 'pwWeak') }); };

/** Changes the passphrase: the current one is checked against the stored blob, then the seed in memory is sealed again. */
async function changePassword() {
  if (wallet?.kind !== 'local') throw new Error('lockedErr');
  const w = wallet;
  const p1 = $('chpw-new1').value;
  if (!checkNewPass(p1, $('chpw-new2').value, addressWords(w.addr))) return;
  status('deriving');
  const old = await unseal(store.get(KEYS.seed), $('chpw-old').value); // throws badPass
  const same = !!w.seed && old.length === w.seed.length && old.every((b, i) => b === w.seed[i]);
  old.fill(0);
  if (!same || wallet !== w) throw new Error('lockedErr');
  const blob = await seal(w.seed, p1, w.addr.bech32);
  if (wallet !== w) throw new Error('lockedErr');
  if (!store.set(KEYS.seed, blob)) throw new Error('storeFailed');
  for (const id of ['chpw-old', 'chpw-new1', 'chpw-new2']) $(id).value = '';
  showMeter('chpw-new1');
  $('weak-nudge').hidden = true;
  status('chpwDone');
}

// ---- auto-lock ----
// While unlocked, the key is forgotten (lock(): zeroed, references dropped) after
// autoLockMin minutes with no keyboard / pointer activity, or when the tab comes back
// after being hidden that long. A timer shows the time left and checks every second
// (browsers slow timers down in background tabs, so coming back also checks at once).
const AUTOLOCK_CHOICES = [30, 60, 120, 240];
const AUTOLOCK_DEFAULT = 30;
let autoLockMin = (() => { const n = Number(store.get(KEYS.autolock)); return AUTOLOCK_CHOICES.includes(n) ? n : AUTOLOCK_DEFAULT; })();
let lastActive = Date.now();
let hiddenAt = null;
let autoLockTimer = null;
const autoLockMs = () => autoLockMin * 60_000;

function startAutoLock() {
  lastActive = Date.now();
  hiddenAt = document.hidden ? Date.now() : null;
  clearInterval(autoLockTimer);
  autoLockTimer = setInterval(autoLockTick, 1000);
  autoLockTick();
}

function stopAutoLock() {
  clearInterval(autoLockTimer);
  autoLockTimer = null;
  $('autolock-hint').textContent = '';
}

function autoLockTick() {
  if (!wallet) return stopAutoLock();
  const now = Date.now();
  if (now - lastActive >= autoLockMs() || (hiddenAt != null && now - hiddenAt >= autoLockMs())) return autoLock();
  const left = Math.ceil((autoLockMs() - (now - lastActive)) / 1000);
  $('autolock-hint').textContent = t('autoLockIn', { time: (left >= 3600 ? `${Math.floor(left / 3600)}:${String(Math.floor(left / 60) % 60).padStart(2, '0')}` : `${Math.floor(left / 60)}`) + `:${String(left % 60).padStart(2, '0')}` });
}

function autoLock() {
  if (!wallet) return;
  lock();
  status('autoLocked', { n: autoLockMin });
}

function onActivity() { if (!document.hidden) lastActive = Date.now(); }

function onVisibility() {
  if (document.hidden) { hiddenAt ??= Date.now(); return; }
  const away = hiddenAt == null ? 0 : Date.now() - hiddenAt;
  hiddenAt = null;
  if (wallet && away >= autoLockMs()) autoLock(); else if (wallet) autoLockTick();
}

function setAutoLock(n) {
  if (!AUTOLOCK_CHOICES.includes(n)) return;
  autoLockMin = n;
  store.set(KEYS.autolock, String(n));
  lastActive = Date.now();
  if (wallet) autoLockTick();
}

function showAutoLockChoices() {
  for (const o of $('autolock-min').options) o.textContent = t('nMinutes', { n: o.value });
  $('autolock-min').value = String(autoLockMin);
}

// ---- passkey unlock: WebAuthn PRF (security.js wrapSeed / unwrapSeed) ----
// Turning it on creates a platform passkey for this hostname (user verification required)
// with the prf extension. The PRF output for a random input (stored) goes through
// HKDF-SHA256 to an AES-256-GCM key that wraps the same seed into a second blob; the
// passphrase blob stays as the fallback. The PRF output itself is never stored: it is
// zeroed once the key is derived. There is no server, so no signature is checked; what
// protects the seed is that only the authenticator, after user verification, can compute
// the PRF output.
const passkeyBlob = () => { try { const b = JSON.parse(store.get(KEYS.passkey)); return isPasskeyBlob(b) ? b : null; } catch { return null; } };
const pkUsable = (b) => !!b && b.address === sealedBlob()?.address && b.rpId === location.hostname;

function showPasskey() {
  const b = passkeyBlob();
  $('pk-unlock').hidden = !!wallet || !pkUsable(b);
  if (wallet?.kind !== 'local') return;
  const on = !!b && b.address === wallet.addr.bech32;
  $('pk-enable').hidden = on;
  $('pk-disable').hidden = !on;
  $('pk-state').textContent = !on ? t('pkOff') : b.rpId === location.hostname ? t('pkOn') : t('pkOtherSite', { host: b.rpId });
}

/** Why passkeys cannot be used here (a message key), or null. */
async function passkeyUnsupported() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials?.create) return 'pkUnsupported';
  try {
    const caps = await PublicKeyCredential.getClientCapabilities?.();
    if (caps && caps['extension:prf'] === false) return 'pkNoPrf';
    if (caps && caps.userVerifyingPlatformAuthenticator === false) return 'pkNoPlatform';
  } catch { /* not known: try */ }
  try {
    if (PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable && !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return 'pkNoPlatform';
  } catch { /* not known: try */ }
  return null;
}

/** A WebAuthn refusal or cancel as one of our message keys. */
const webauthnError = (e) => new Error(e?.name === 'NotAllowedError' || e?.name === 'AbortError' ? 'pkCancelled'
  : e?.name === 'SecurityError' || e?.name === 'NotSupportedError' ? 'pkUnsupported' : 'pkFailed');

/** credentials.get with prf.eval: the 32-byte PRF output (the caller zeroes it). */
async function prfOutput(credentialId, rpId, prfSalt) {
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      rpId, challenge: crypto.getRandomValues(new Uint8Array(32)), timeout: 120000, userVerification: 'required',
      allowCredentials: [{ type: 'public-key', id: fromB64url(credentialId) }],
      extensions: { prf: { eval: { first: prfSalt } } },
    } });
  } catch (e) { throw webauthnError(e); }
  const first = cred?.getClientExtensionResults?.().prf?.results?.first;
  if (!first) throw new Error('pkNoPrf');
  return new Uint8Array(first);
}

async function enablePasskey() {
  if (wallet?.kind !== 'local') throw new Error('lockedErr');
  const w = wallet;
  const why = await passkeyUnsupported();
  if (why) throw new Error(why);
  status('pkWorking');
  const rpId = location.hostname;
  const prfSalt = newPrfSalt();
  const short = `${w.addr.bech32.slice(0, 12)}…${w.addr.bech32.slice(-6)}`;
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      rp: { id: rpId, name: 'ZETAPHY PQ Wallet' },
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `ZETAPHY ${short}`, displayName: `ZETAPHY PQ Wallet ${short}` },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -8 }, { type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 120000,
      extensions: { prf: { eval: { first: prfSalt } } },
    } });
  } catch (e) { throw webauthnError(e); }
  const credentialId = toB64url(new Uint8Array(cred.rawId));
  const prf = cred.getClientExtensionResults?.().prf;
  // A passkey made without PRF is no use here: ask the provider to forget it (where supported).
  const useless = () => {
    PublicKeyCredential.signalUnknownCredential?.({ rpId, credentialId })?.catch?.(() => {});
    return new Error('pkNoPrf');
  };
  if (!prf || (!prf.enabled && !prf.results?.first)) throw useless();
  // Some providers give the PRF output only on get(), not at creation.
  let out;
  try {
    out = prf.results?.first ? new Uint8Array(prf.results.first) : await prfOutput(credentialId, rpId, prfSalt);
  } catch (e) { if (e.message === 'pkNoPrf') throw useless(); throw e; }
  try {
    if (wallet !== w || !w.seed) throw new Error('lockedErr');
    const blob = await wrapSeed(w.seed, out, { address: w.addr.bech32, credentialId, rpId, prfSalt });
    if (!store.set(KEYS.passkey, JSON.stringify(blob))) throw new Error('storeFailed');
  } finally { out.fill(0); }
  showPasskey();
  status('pkEnabled');
}

function disablePasskey() {
  const b = passkeyBlob();
  store.del(KEYS.passkey);
  if (b) window.PublicKeyCredential?.signalUnknownCredential?.({ rpId: b.rpId, credentialId: b.credentialId })?.catch?.(() => {});
  showPasskey();
  status('pkDisabled');
}

async function unlockPasskey() {
  const b = passkeyBlob();
  if (!b) throw new Error('pkFailed');
  if (!pkUsable(b)) throw Object.assign(new Error('pkOtherSite'), { vars: { host: b.rpId } });
  if (!window.PublicKeyCredential || !navigator.credentials?.get) throw new Error('pkUnsupported');
  status('pkWorking');
  const out = await prfOutput(b.credentialId, b.rpId, hexToBytes(b.prfSalt));
  let seed;
  try { seed = await unwrapSeed(b, out); } finally { out.fill(0); }
  openSeed(seed);
  if (wallet.addr.bech32 !== sealedBlob()?.address || wallet.addr.bech32 !== b.address) { lock(); throw new Error('pkFailed'); }
  $('unlock-pass').value = '';
  opened('unlocked');
}

// ---- large balance: suggest a safer place for the key ----
// Above LARGE_BALANCE (native ZETAPHY; staked coins are not counted, this page does not read
// delegations) a banner suggests the ZETAPHY Snap (key inside MetaMask) for this page's own
// account, or a hardware wallet for a connected EVM account. "Hide for 7 days" is
// remembered per address in this browser.
const LARGE_BALANCE = 1000n * 10n ** 18n; // 1,000 ZETAPHY
const BIG_HIDE_MS = 7 * 24 * 60 * 60 * 1000;
let bigShown = null; // the address the banner is about

function bigCandidate() {
  if (wallet?.kind === 'local' && account?.balance != null && account.balance >= LARGE_BALANCE) return { key: 'bigLocal', address: wallet.addr.bech32, amount: account.balance };
  if (wallet && evmAccount?.balance != null && evmAccount.balance >= LARGE_BALANCE) return { key: 'bigEvm', address: evmAccount.address.bech32, amount: evmAccount.balance };
  return null;
}

function showBigBalance() {
  const c = bigCandidate();
  const until = c ? Number(store.get(KEYS.bigHidden + c.address)) || 0 : 0;
  const show = !!c && Date.now() >= until;
  $('big-balance').hidden = !show;
  bigShown = show ? c.address : null;
  if (show) $('big-balance-text').textContent = t(c.key, { amount: formatZeta(c.amount) });
}

function hideBigBalance() {
  if (bigShown) store.set(KEYS.bigHidden + bigShown, String(Date.now() + BIG_HIDE_MS));
  showBigBalance();
}

function openHelp() {
  const d = $('help-dialog');
  if (typeof d.showModal === 'function') { if (!d.open) d.showModal(); } else d.setAttribute('open', '');
}

// ---- send: review, then confirm ----
let pending = null;

async function review() {
  pending = null;
  $('confirm').hidden = true;
  $('tx-result').hidden = true;
  let to; let amount; let gasLimit;
  try { to = normalizeAddress($('to').value); } catch { return fail('badAddress'); }
  try { amount = parseZeta($('amount').value); } catch { return fail('badAmount'); }
  if (amount <= 0n) return fail('badAmount');
  const g = $('gas').value.trim() || String(DEFAULT_GAS_LIMIT);
  if (!/^\d+$/.test(g) || BigInt(g) <= 0n) return fail('badGas');
  gasLimit = BigInt(g);
  // As an owner: a MsgEVMCall carrying the value (the gas field is for plain sends).
  const as = acting;
  if (as) gasLimit = DEFAULT_EVM_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD;
  status('working');
  const q = await client.quote({ publicKey: wallet.publicKey, gasLimit });
  account = { ...q.account, balance: q.balance };
  showAccount();
  if (!q.exists) return fail('notFunded');
  if (as) {
    await refreshActing();
    if (amount > as.balance) return fail('ownerNotEnough', { need: formatZeta(amount), have: formatZeta(as.balance) });
    if (q.fee > q.balance) return fail('notEnough', { need: formatZeta(q.fee), have: formatZeta(q.balance) });
  } else if (amount + q.fee > q.balance) return fail('notEnough', { need: formatZeta(amount + q.fee), have: formatZeta(q.balance) });
  const checked = await vaccinate([to.hex]); // refuses flagged code before the confirm step
  pending = { to, amount, gasLimit, gasPrice: q.gasPrice, fee: q.fee, asOwner: as?.address, checked };
  showAsNote($('confirm'), as);
  showVaccine($('confirm'), checked);
  $('c-to').textContent = `${to.bech32}\n${to.hex}`;
  $('c-amount').textContent = `${formatZeta(amount)} ZETAPHY`;
  $('c-fee').textContent = `${formatZeta(q.fee)} ZETAPHY`;
  $('c-total').textContent = `${formatZeta(amount + q.fee)} ZETAPHY`;
  $('confirm').hidden = false;
  status('');
}

async function confirmSend() {
  if (!pending || !wallet) return;
  const p = pending;
  pending = null;
  $('confirm').hidden = true;
  status('working');
  noNewWarnings(p.checked, await vaccinate([p.to.hex])); // again, just before signing: a flag may have landed meanwhile
  signingStatus();
  const r = await client.send({
    ...signer(),
    to: p.to.bech32, amount: p.amount, gasLimit: p.gasLimit, gasPrice: p.gasPrice,
    ...(p.asOwner ? { asOwner: p.asOwner.bech32, evmGasLimit: DEFAULT_EVM_GAS_LIMIT } : {}),
  });
  $('tx-hash').textContent = r.txHash;
  $('tx-result').hidden = false;
  $('amount').value = '';
  status('sent');
  setTimeout(refresh, 6000);
}

// ---- ERC-20 tokens: calldata is encoded here, results read with eth_call ----
// Contract calls are a /zetaphy.pq.v1.MsgEVMCall signed with ML-DSA-44. A revert
// fails the whole tx and the fee is still paid, so every transfer is simulated
// with eth_call first (here at review, and again by callEVM just before signing).
const SEL = { transfer: 'a9059cbb', balanceOf: '70a08231', decimals: '313ce567', symbol: '95d89b41' };
const UINT256_LIMIT = 2n ** 256n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const readWord = (b, at) => BigInt('0x' + (bytesToHex(b.slice(at, at + 32)) || '0'));
const addrWord = (bytes) => bytesToHex(bytes).padStart(64, '0');
const qty = (v) => '0x' + BigInt(v).toString(16);

let token = null; // { address, symbol, decimals, balance }
let tokenPending = null;

/** The token input as a checksummed 0x address (a mixed-case one must pass EIP-55). */
function tokenInput() {
  const s = $('token').value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('badToken');
  try { return normalizeAddress(s).hex; } catch { throw new Error('badToken'); }
}

/** eth_call; a node error is null, so callers decide what it means. Network and chain errors still throw. */
async function ethCall(to, data) {
  try { return await checkedCall('eth_call', [{ to, data: '0x' + data }, 'latest']); } catch (e) {
    if (T.en[e.message] || /^RPC HTTP/.test(e.message)) throw e;
    return null;
  }
}

function resultBytes(hex) {
  if (typeof hex !== 'string') return null;
  try { return hexToBytes(hex); } catch { return null; }
}

/** symbol() as an ABI string, or bytes32 for old tokens. Control and bidi characters are dropped. */
function decodeSymbol(hex) {
  const b = resultBytes(hex);
  if (!b) return '?';
  let raw = null;
  if (b.length >= 64) {
    const off = readWord(b, 0);
    if (off + 32n <= BigInt(b.length)) {
      const n = readWord(b, Number(off));
      if (Number(off) + 32 + Number(n) <= b.length && n <= 256n) raw = b.slice(Number(off) + 32, Number(off) + 32 + Number(n));
    }
  } else if (b.length === 32) {
    const end = b.indexOf(0);
    raw = b.slice(0, end < 0 ? 32 : end);
  }
  if (!raw) return '?';
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return '?'; }
  text = text.replace(/\p{C}/gu, '').trim().slice(0, 24);
  return text || '?';
}

/** The account the token panel is for: this wallet, or the locked account it acts as. */
const holder = () => (acting ? acting.address : wallet.addr);

async function tokenBalanceOf(address) {
  const b = resultBytes(await ethCall(address, SEL.balanceOf + addrWord(holder().bytes)));
  if (!b || b.length < 32) throw new Error('notToken');
  return readWord(b, 0);
}

/** Reads symbol, decimals and this account's balance; remembers the address. quiet: no "working" status. */
async function loadToken(quiet = false) {
  const address = tokenInput();
  if (!quiet) status('working');
  const code = await checkedCall('eth_getCode', [address, 'latest']);
  if (typeof code !== 'string' || /^0x0*$/.test(code)) throw Object.assign(new Error('noContract'), { vars: { addr: address } });
  const d = resultBytes(await ethCall(address, SEL.decimals));
  if (!d || d.length < 32 || readWord(d, 0) > 255n) throw new Error('notToken');
  const decimals = Number(readWord(d, 0));
  const symbol = decodeSymbol(await ethCall(address, SEL.symbol));
  const balance = await tokenBalanceOf(address);
  if (!wallet || $('token').value.trim().toLowerCase() !== address.toLowerCase()) return; // changed meanwhile
  token = { address, symbol, decimals, balance };
  store.set(KEYS.token, address);
  showToken();
  if (!quiet) status('');
}

function formatUnits(v, decimals) {
  const unit = 10n ** BigInt(decimals);
  const frac = decimals ? (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${v / unit}${frac ? '.' + frac : ''}`;
}

/** '1.5' -> base units of a token with `decimals` decimals. Trailing zeros past them are fine. */
function parseUnits(text, decimals, symbol) {
  const s = String(text).trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s) ?? /^()\.(\d+)$/.exec(s);
  if (!m || s.length > 100) throw new Error('badAmount');
  const frac = (m[2] ?? '').replace(/0+$/, '');
  if (frac.length > decimals) throw Object.assign(new Error('tokenDecimals'), { vars: { d: decimals, sym: symbol } });
  const v = BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
  if (v <= 0n || v >= UINT256_LIMIT) throw new Error('badAmount');
  return v;
}

/** transfer()'s result: nothing (old tokens such as USDT) or a true bool. */
function checkTransfer(ret) {
  if (ret === '0x') return;
  const b = resultBytes(ret);
  if (!b || b.length < 32 || readWord(b, 0) === 0n) throw new Error('tokenRefused');
}

function showToken() {
  $('token-info').hidden = !token;
  if (!token) return;
  $('token-balance').textContent = `${formatUnits(token.balance, token.decimals)} ${token.symbol}`;
  $('token-meta').textContent = t('tokenMeta', { sym: token.symbol, d: token.decimals, addr: token.address });
}

async function tokenReview() {
  tokenPending = null;
  $('token-confirm').hidden = true;
  $('token-result').hidden = true;
  const address = tokenInput();
  if (!token || token.address !== address) await loadToken();
  if (!token) return status('');
  let to;
  try { to = normalizeAddress($('token-to').value); } catch { return fail('badAddress'); }
  const units = parseUnits($('token-amount').value, token.decimals, token.symbol);
  const g = $('token-gas').value.trim() || String(DEFAULT_EVM_GAS_LIMIT);
  if (!/^\d{1,9}$/.test(g) || BigInt(g) < MIN_EVM_GAS_LIMIT || BigInt(g) > MAX_EVM_GAS_LIMIT) return fail('badEvmGas', { min: MIN_EVM_GAS_LIMIT, max: MAX_EVM_GAS_LIMIT });
  const evmGas = BigInt(g);
  const txGas = evmGas + EVM_CALL_GAS_OVERHEAD;
  status('working');
  const t0 = token;
  const as = acting;
  const [q, balance] = await Promise.all([client.quote({ publicKey: wallet.publicKey, gasLimit: txGas }), tokenBalanceOf(t0.address)]);
  account = { ...q.account, balance: q.balance };
  t0.balance = balance;
  showAccount(); showToken();
  if (!q.exists) return fail('notFunded');
  if (units > balance) return fail('tokenNotEnough', { need: formatUnits(units, t0.decimals), sym: t0.symbol, have: formatUnits(balance, t0.decimals) });
  if (q.fee > q.balance) return fail('notEnough', { need: formatZeta(q.fee), have: formatZeta(q.balance) });
  const data = '0x' + SEL.transfer + addrWord(to.bytes) + word(units);
  // The same simulation callEVM runs before signing, so a doomed transfer never reaches the confirm step.
  let ret;
  try {
    ret = await checkedCall('eth_call', [{ from: (as ? as.address : wallet.addr).hex, to: t0.address, data, gas: qty(evmGas) }, 'latest']);
  } catch (e) {
    if (T.en[e.message]) throw e;
    return fail('callFails', {}, e.message);
  }
  checkTransfer(ret);
  const checked = await vaccinate([t0.address, to.hex]); // the token contract and the recipient
  tokenPending = { token: t0.address, symbol: t0.symbol, decimals: t0.decimals, to, units, data, evmGas, txGas, gasPrice: q.gasPrice, asOwner: as?.address, checked };
  showAsNote($('token-confirm'), as);
  showVaccine($('token-confirm'), checked);
  $('t-token').textContent = `${t0.symbol}\n${t0.address}`;
  $('t-to').textContent = `${to.bech32}\n${to.hex}`;
  $('t-amount').textContent = `${formatUnits(units, t0.decimals)} ${t0.symbol}`;
  $('t-fee').textContent = `${formatZeta(q.fee)} ZETAPHY`;
  $('token-confirm').hidden = false;
  status('');
}

async function tokenConfirm() {
  if (!tokenPending || !wallet) return;
  const p = tokenPending;
  tokenPending = null;
  $('token-confirm').hidden = true;
  status('working');
  noNewWarnings(p.checked, await vaccinate([p.token, p.to.hex]));
  signingStatus();
  const r = await client.callEVM({
    ...signer(),
    to: p.token, data: p.data, evmGasLimit: p.evmGas, gasLimit: p.txGas, gasPrice: p.gasPrice, checkResult: checkTransfer,
    ...(p.asOwner ? { asOwner: p.asOwner.bech32 } : {}),
  });
  $('token-hash').textContent = r.txHash;
  $('token-result').hidden = false;
  $('token-amount').value = '';
  status('tokenSent');
  setTimeout(refresh, 6000);
}

// ---- staking: delegate, undelegate, withdraw rewards ----
let stakePending = null;
const STAKE = {
  stake: { title: 'confirmStake', done: 'staked', run: (o) => client.delegate(o) },
  unstake: { title: 'confirmUnstake', done: 'unstaked', run: (o) => client.undelegate(o) },
  claim: { title: 'confirmClaim', done: 'claimed', run: (o) => client.withdrawRewards(o) },
};

const setI18n = (el, key) => { el.dataset.i18n = key; el.textContent = t(key); };

async function stakeReview(action) {
  stakePending = null;
  $('stake-confirm').hidden = true;
  $('stake-result').hidden = true;
  let validator;
  try { validator = validatorAddress($('validator').value); } catch { return fail('badValidator'); }
  let amount = 0n;
  if (action !== 'claim') {
    try { amount = parseZeta($('stake-amount').value); } catch { return fail('badAmount'); }
    if (amount <= 0n) return fail('badAmount');
  }
  const g = $('stake-gas').value.trim() || String(DEFAULT_STAKING_GAS_LIMIT);
  if (!/^\d{1,12}$/.test(g) || BigInt(g) <= 0n) return fail('badGas');
  // As an owner: the staking or distribution precompile, called with as_owner.
  const as = acting;
  const gasLimit = as ? DEFAULT_PRECOMPILE_GAS_LIMIT + EVM_CALL_GAS_OVERHEAD : BigInt(g);
  status('working');
  const q = await client.quote({ publicKey: wallet.publicKey, gasLimit });
  account = { ...q.account, balance: q.balance };
  showAccount();
  if (!q.exists) return fail('notFunded');
  const spend = action === 'stake' ? amount : 0n;
  if (as) {
    await refreshActing();
    if (spend > as.balance) return fail('ownerNotEnough', { need: formatZeta(spend), have: formatZeta(as.balance) });
    if (q.fee > q.balance) return fail('notEnough', { need: formatZeta(q.fee), have: formatZeta(q.balance) });
  } else if (spend + q.fee > q.balance) return fail('notEnough', { need: formatZeta(spend + q.fee), have: formatZeta(q.balance) });
  stakePending = { action, validator, amount, gasLimit, gasPrice: q.gasPrice, asOwner: as?.address };
  showAsNote($('stake-confirm'), as);
  setI18n($('stake-confirm-title'), STAKE[action].title);
  $('s-validator').textContent = validator;
  $('s-amount-dt').hidden = $('s-amount').hidden = action === 'claim';
  $('s-amount').textContent = `${formatZeta(amount)} ZETAPHY`;
  $('s-fee').textContent = `${formatZeta(q.fee)} ZETAPHY`;
  $('s-total').textContent = `${formatZeta(spend + q.fee)} ZETAPHY`;
  $('unbond-note').hidden = action !== 'unstake';
  $('stake-confirm').hidden = false;
  status('');
}

async function stakeConfirm() {
  if (!stakePending || !wallet) return;
  const p = stakePending;
  stakePending = null;
  $('stake-confirm').hidden = true;
  signingStatus();
  const r = await STAKE[p.action].run({
    ...signer(),
    validator: p.validator, amount: p.action === 'claim' ? undefined : p.amount, gasLimit: p.gasLimit, gasPrice: p.gasPrice,
    ...(p.asOwner ? { asOwner: p.asOwner.bech32, evmGasLimit: DEFAULT_PRECOMPILE_GAS_LIMIT } : {}),
  });
  $('stake-hash').textContent = r.txHash;
  $('stake-result').hidden = false;
  if (p.action !== 'claim') $('stake-amount').value = '';
  status(STAKE[p.action].done);
  setTimeout(refresh, 6000);
}

// ---- deploy: a contract creation (MsgEVMCall with no `to`), simulated with eth_call first ----
let deployPending = null;

async function deployReview() {
  deployPending = null;
  $('deploy-confirm').hidden = true;
  $('deploy-result').hidden = true;
  const code = $('init-code').value.replace(/\s+/g, '');
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) return fail('badInitCode');
  const g = $('deploy-gas').value.trim() || String(DEFAULT_DEPLOY_GAS_LIMIT);
  if (!/^\d{1,9}$/.test(g) || BigInt(g) < MIN_EVM_GAS_LIMIT || BigInt(g) > MAX_EVM_GAS_LIMIT) return fail('badEvmGas', { min: MIN_EVM_GAS_LIMIT, max: MAX_EVM_GAS_LIMIT });
  const evmGas = BigInt(g);
  const txGas = evmGas + EVM_CALL_GAS_OVERHEAD;
  const as = acting;
  status('working');
  const q = await client.quote({ publicKey: wallet.publicKey, gasLimit: txGas });
  account = { ...q.account, balance: q.balance };
  showAccount();
  if (!q.exists) return fail('notFunded');
  if (q.fee > q.balance) return fail('notEnough', { need: formatZeta(q.fee), have: formatZeta(q.balance) });
  // The same simulation client.deploy runs before signing.
  try {
    await checkedCall('eth_call', [{ from: (as ? as.address : wallet.addr).hex, data: code, gas: qty(evmGas) }, 'latest']);
  } catch (e) {
    if (T.en[e.message]) throw e;
    return fail('callFails', {}, e.message);
  }
  const bytes = hexToBytes(code);
  deployPending = { code, evmGas, txGas, gasPrice: q.gasPrice, asOwner: as?.address };
  showAsNote($('deploy-confirm'), as);
  $('d-size').textContent = t('bytesN', { n: bytes.length });
  $('d-hash').textContent = '0x' + bytesToHex(keccak_256(bytes));
  $('d-fee').textContent = `${formatZeta(q.fee)} ZETAPHY`;
  $('deploy-confirm').hidden = false;
  status('');
}

async function deployConfirm() {
  if (!deployPending || !wallet) return;
  const p = deployPending;
  deployPending = null;
  $('deploy-confirm').hidden = true;
  signingStatus();
  const r = await client.deploy({
    ...signer(),
    initCode: p.code, evmGasLimit: p.evmGas, gasLimit: p.txGas, gasPrice: p.gasPrice,
    ...(p.asOwner ? { asOwner: p.asOwner.bech32 } : {}),
  });
  $('deploy-hash').textContent = r.txHash;
  $('deploy-address').textContent = r.created;
  $('deploy-result').hidden = false;
  status('deploySent');
  setTimeout(refresh, 6000);
}

// ---- vaccine: never sign a call or transfer to code the Neuro runners flagged ----
// Before any EVM call or transfer is signed (here, by the snap, or by an EVM wallet),
// each destination's code is read with eth_getCode and checked against ThreatRegistry:
// its Neuro fingerprint (fp1, the same code as zetaphy-neuro), its keccak-256 code
// hash, and the address itself on ZETAPHY. Proxies (best effort): the code a
// destination forwards to is checked the same way, i.e. the EIP-1967 implementation
// slot, the EIP-1967 beacon (and its implementation()) and an EIP-1167 minimal
// proxy's target, up to PROXY_DEPTH hops. Other forwarding (custom slots, a target
// chosen per call) is not seen. Contract creations have no destination: not checked.
// Two levels, as the registry has them:
//   - enforced (the flag is the registry's enforceDelay old, or enforced at once
//     through its fast lane: a supermajority of runners, or governance / a guardian
//     with enforceNow): refused, no override;
//   - flagged but not enforced yet: a visible warning in the confirm box; sending is
//     the user's choice (a small runner quorum alone cannot stop a wallet at once).
// Registry set but the check fails: refused (fail closed). No registry set yet:
// sent, with a visible "not checked" notice in the confirm box (fail open), so the
// wallet works before the registry exists.
const THREAT_META = document.querySelector('meta[name="zetaphy-threat-registry"]')?.content.trim() ?? '';
// The site's default RPC (<meta name="zetaphy-rpc">, written by zetaphy-launch); a saved RPC wins.
const RPC_META = document.querySelector('meta[name="zetaphy-rpc"]')?.content.trim() ?? '';
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
// THREAT_SEL (the registry's views), PROXY_DEPTH and proxyTargets come from
// zetaphy-network/src/vaccine.js, the same code the ZETAPHY Snap's transaction
// insight uses in plain MetaMask.
const WHAT = { fingerprint: 'threatWhatFingerprint', code: 'threatWhatCode', address: 'threatWhatAddress' };

/** The ThreatRegistry set in this browser, else the page's meta tag; '' when neither is valid. */
function threatRegistry() {
  const a = store.get(KEYS.threats) || THREAT_META;
  return ADDR_RE.test(a) ? a : '';
}

/**
 * Checks each destination (0x…) and the code behind it if it is a proxy. Throws
 * threatFlagged (an enforced flag, or with strict any flag), threatUnchecked (registry
 * set, check failed). Returns { state, warnings }: state 'clean' (checked), 'warned'
 * (checked; flagged but not enforced yet: warnings), 'unset' (a contract, but no
 * registry: not checked) or 'none' (no contract and no registry).
 */
async function vaccinate(targets, { strict = false, from = (acting?.address ?? wallet?.addr)?.hex } = {}) {
  const reg = threatRegistry();
  let contracts = 0;
  const warnings = [];
  const queue = targets.map((a) => ({ addr: a.toLowerCase(), label: a, depth: 0, root: a.toLowerCase() }));
  // Consent given on chain (the security precompile) for a destination: its enforced flags warn instead of refusing.
  const consented = async (root) => {
    if (!from) return false;
    try { return (await client.consentUntil(from, root)) > BigInt(Math.floor(Date.now() / 1000)); } catch { return false; }
  };
  const seen = new Set();
  while (queue.length) {
    const { addr: target, label, depth, root } = queue.shift();
    if (seen.has(target)) continue;
    seen.add(target);
    const unchecked = () => Object.assign(new Error('threatUnchecked'), { vars: { addr: label, reg } });
    let code;
    try { code = await checkedCall('eth_getCode', [target, 'latest']); } catch (e) { if (reg) throw unchecked(); throw e; }
    const valid = typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(code);
    if (!valid && reg) throw unchecked();
    const hasCode = valid && code.length > 2;
    if (hasCode && depth === 0) contracts++;
    if (!reg) continue;
    const checks = [['address', word(EVM_CHAIN_ID) + target.slice(2).padStart(64, '0')]];
    if (hasCode) {
      const fp = (await codeFingerprint(code)).slice('fp1:'.length);
      checks.push(['fingerprint', fp], ['code', bytesToHex(keccak_256(hexToBytes(code)))]);
    }
    // Each key: the warning view and the enforcement view.
    let answers;
    try {
      answers = await Promise.all(checks.flatMap(([what, arg]) => THREAT_SEL[what].map((sel) => checkedCall('eth_call', [{ to: reg, data: '0x' + sel + arg }, 'latest']))));
    } catch { throw unchecked(); }
    for (const [i, [what]] of checks.entries()) {
      const [warn, enforced] = [answers[2 * i], answers[2 * i + 1]].map(resultBytes);
      if (!warn || warn.length < 64 || !enforced || enforced.length < 64) throw unchecked(); // no registry there, or not one
      const flagged = readWord(warn, 0) !== 0n;
      if (!flagged && readWord(enforced, 0) === 0n) continue;
      const reason = Number(readWord(readWord(enforced, 0) !== 0n ? enforced : warn, 32));
      // Shown with every warning or refusal: the code fact, its evidence, the owner's response, the disclaimer.
      // (Objects with toString, so a language switch re-renders them.)
      const keys = checks.map(([w, arg]) => KEY_OF[w](target, arg));
      const vars = { addr: label, what: t(WHAT[what]), reason: { toString: () => (reason > 0 && T.en[`reason${reason}`] ? t(`reason${reason}`) : `#${reason}`) },
        details: await threatDetails(reg, keys[i], keys) };
      if (readWord(enforced, 0) !== 0n || strict) {
        if (strict || !(await consented(root))) {
          if ($('cs-target') && !$('cs-target').value) $('cs-target').value = label.startsWith('0x') ? label : root;
          throw Object.assign(new Error('threatFlagged'), { vars });
        }
        vars.consented = true;
      }
      warnings.push(vars);
    }
    // Best effort: the code a proxy forwards to is checked as if it were the destination.
    if (hasCode && depth < PROXY_DEPTH) {
      let next;
      try { next = await proxyTargets(checkedCall, target, code); } catch { throw unchecked(); }
      for (const impl of next) queue.push({ addr: impl, label: t('threatBehind', { impl, proxy: label }), depth: depth + 1, root });
    }
  }
  return { state: !reg ? (contracts ? 'unset' : 'none') : warnings.length ? 'warned' : 'clean', warnings };
}

const KEY_OF = { address: (target) => addressKey(EVM_CHAIN_ID, target), fingerprint: (_, fp) => '0x' + fp, code: (_, hash) => codeKey(hash) };

/**
 * A flag's evidence (evidenceOf) and the responses of the parties behind it (responseAt:
 * per author, the governance-assigned responder's first, then the newest; the flagged key's,
 * then the other keys of the same destination), each shown with its author, at most 3.
 * Best effort: an unreadable answer is said so; it never turns a refusal into a send.
 */
async function threatDetails(reg, key, keys) {
  const call = (data) => checkedCall('eth_call', [{ to: reg, data }, 'latest']);
  let evidence = null; let unread = false;
  try { evidence = readEvidence(await call(detailQueries(key).evidence)); } catch { unread = true; }
  const responses = [];
  for (const k of [key, ...keys.filter((x) => x !== key)]) {
    for (const q of detailQueries(k).responses) {
      let r;
      try { r = readResponse(await call(q)); } catch { break; } // none shown
      if (!r.text) break; // no more for this key
      if (!responses.some((x) => x.by === r.by)) responses.push(r);
    }
  }
  responses.sort((a, b) => Number(b.assigned) - Number(a.assigned));
  return {
    toString: () => [
      evidence?.reportHash ? t('threatEvidence', { hash: evidence.reportHash, uri: evidence.uri ? ` (${evidence.uri})` : '' }) : t(unread ? 'threatEvidenceUnread' : 'threatNoEvidence'),
      ...(responses.length ? responses.slice(0, 3).map((r) => t(r.assigned ? 'threatResponseAssigned' : 'threatResponse', { by: r.by, text: r.text })) : [t('threatNoResponse')]),
      t('threatDisclaimer'),
    ].join(' · '),
  };
}

/** Before signing: refuses if a warning appeared that the user did not see at review. */
function noNewWarnings(reviewed, now) {
  const key = (w) => `${w.addr}|${w.what}`;
  const known = new Set((reviewed?.warnings ?? []).map(key));
  const fresh = now.warnings.find((w) => !known.has(key(w)));
  if (fresh) throw Object.assign(new Error('threatNewWarning'), { vars: fresh });
}

/** The vaccine line in a confirm box: checked, a warning, or a visible "not checked" notice. */
function showVaccine(box, checked) {
  const el = box.querySelector('.vaccine-note');
  el.hidden = checked.state === 'none';
  el.classList.toggle('unchecked', checked.state === 'unset' || checked.state === 'warned');
  if (checked.state === 'warned') { delete el.dataset.i18n; el.textContent = t(checked.warnings[0].consented ? 'threatConsented' : 'threatWarned', checked.warnings[0]); }
  else if (checked.state !== 'none') setI18n(el, checked.state === 'unset' ? 'threatUnset' : 'threatClean');
}

// ---- quantum lock: accounts this wallet controls (MsgEVMCall.as_owner) ----
// The chain keeps who controls whom (zetaphy_pqAccount.quantumLockedTo); this page
// only remembers which owner addresses to ask about, per wallet, in localStorage.
let acting = null; // { address (normalized), balance } while acting for a locked account
let owned = []; // [{ address, lockedTo }]

const ownersKey = () => KEYS.owners + wallet.addr.bech32;
function loadOwned() {
  let list = [];
  try { list = JSON.parse(store.get(ownersKey()) ?? '[]'); } catch { /* ignore */ }
  owned = (Array.isArray(list) ? list : []).slice(0, 20).flatMap((a) => { try { return [{ address: normalizeAddress(a), lockedTo: undefined }]; } catch { return []; } });
}
function rememberOwner(address) {
  if (!owned.some((o) => o.address.bech32 === address.bech32)) owned.push({ address, lockedTo: wallet.addr.bech32 });
  store.set(ownersKey(), JSON.stringify(owned.map((o) => o.address.hex)));
}

async function refreshOwned() {
  if (!wallet) return;
  if (!owned.length) loadOwned();
  await Promise.all(owned.map(async (o) => { o.lockedTo = (await client.account(o.address.bech32)).quantumLockedTo ?? null; }));
  if (acting) await refreshActing();
  showOwned();
}

async function refreshActing() {
  const a = acting;
  if (!a) return;
  a.balance = await client.balance(a.address.hex);
  showOwned();
}

function showOwned() {
  const list = $('owned-list');
  list.replaceChildren(...owned.map((o) => {
    const li = document.createElement('li');
    const code = document.createElement('code');
    code.textContent = o.address.hex;
    const note = document.createElement('span');
    note.className = 'hint';
    note.textContent = o.lockedTo === undefined ? '' : o.lockedTo === wallet.addr.bech32 ? t('ownedMine') : o.lockedTo ? t('ownedOther', { to: o.lockedTo }) : t('ownedNotMine');
    li.append(code, note);
    if (o.lockedTo === wallet.addr.bech32 && acting?.address.bech32 !== o.address.bech32) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ghost';
      b.textContent = t('ownerUse');
      b.addEventListener('click', () => busy(b, () => useOwner(o.address.hex)));
      li.append(b);
    }
    return li;
  }));
  $('acting').hidden = !acting;
  if (acting) {
    $('acting-addr').textContent = `${acting.address.hex}\n${acting.address.bech32}`;
    $('acting-balance').textContent = acting.balance == null ? '–' : `${formatZeta(acting.balance)} ZETAPHY`;
  }
  for (const el of document.querySelectorAll('.as-tag')) {
    el.hidden = !acting;
    el.textContent = acting ? t('asTag', { owner: acting.address.hex }) : '';
  }
}

/** The "for {owner}" line in a confirm box. */
function showAsNote(box, as) {
  const el = box.querySelector('.as-note');
  el.hidden = !as;
  el.textContent = as ? t('asNote', { owner: as.address.hex }) : '';
}

function clearPending() {
  pending = null; tokenPending = null; stakePending = null; deployPending = null;
  for (const id of ['confirm', 'token-confirm', 'stake-confirm', 'deploy-confirm']) $(id).hidden = true;
}

/** Act for a locked account: only if the chain says it is locked to this wallet. */
async function useOwner(text) {
  let address;
  try { address = normalizeAddress(text); } catch { return fail('badAddress'); }
  if (address.bech32 === wallet.addr.bech32) return fail('ownerSelf');
  status('working');
  const a = await client.account(address.bech32);
  if (a.quantumLockedTo !== wallet.addr.bech32) return a.quantumLockedTo ? fail('ownerOther', { to: a.quantumLockedTo }) : fail('ownerNotLocked');
  clearPending();
  acting = { address, balance: await client.balance(address.hex) };
  rememberOwner(address);
  owned.find((o) => o.address.bech32 === address.bech32).lockedTo = a.quantumLockedTo;
  $('owner').value = '';
  showOwned();
  status('nowActing', { owner: address.hex });
  if (token) { token.balance = await tokenBalanceOf(token.address); showToken(); }
}

async function stopActing() {
  clearPending();
  acting = null;
  showOwned();
  status('stopActing');
  if (token) { token.balance = await tokenBalanceOf(token.address); showToken(); }
}

// ---- quantum lock from MetaMask: an EVM tx to 0x…5051 with this wallet's address as data ----
async function metamaskLock() {
  if (!wallet || !$('mm-ok').checked) return;
  const eth = ethereum(); // the EVM wallet picked under "other wallets" (MetaMask or any other)
  status('working');
  // The chain only accepts an ML-DSA-44 controller whose public key it knows.
  await client.checkController(wallet.addr.bech32);
  let accounts;
  try { accounts = await eth.request({ method: 'eth_requestAccounts' }); } catch (e) { throw new Error(e?.code === 4001 ? 'mmRejected' : 'mmDenied'); }
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('mmDenied');
  let owner;
  try { owner = normalizeAddress(String(accounts[0]).toLowerCase()); } catch { throw new Error('mmDenied'); }
  const chain = BigInt(await eth.request({ method: 'eth_chainId' }));
  if (chain !== EVM_CHAIN_ID) throw Object.assign(new Error('mmWrongChain'), { vars: { id: chain } });
  const a = await client.account(owner.bech32);
  if (a.quantumLockedTo === wallet.addr.bech32) { rememberOwner(owner); showOwned(); return status('mmAlreadyMine'); }
  if (a.quantumLockedTo) throw Object.assign(new Error('mmAlreadyLocked'), { vars: { to: a.quantumLockedTo } });
  if (!window.confirm(t('mmConfirm', { owner: owner.hex, me: wallet.addr.bech32 }))) return status('mmCancelled');
  const tx = quantumLockTx(wallet.addr.hex);
  await vaccinate([tx.to], { strict: true }); // the page checks every EVM tx it builds before a wallet is asked to sign it (no confirm box here: any flag refuses)
  let hash;
  try {
    hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from: owner.hex, to: tx.to, value: '0x0', data: tx.data }] });
  } catch (e) {
    if (e?.code === 4001) throw new Error('mmRejected');
    throw new Error(e?.message ?? String(e));
  }
  $('mm-hash').textContent = String(hash);
  $('mm-result').hidden = false;
  $('mm-ok').checked = false;
  $('mm-lock').disabled = true;
  owned.push({ address: owner, lockedTo: undefined });
  store.set(ownersKey(), JSON.stringify(owned.map((o) => o.address.hex)));
  showOwned();
  status('mmSent');
  setTimeout(() => { refreshOwned().catch(showError); }, 6000);
}

// ---- security core: prepare for Q-day, and consent to a flagged contract ----
// Q-day (zetaphy_securityStatus / zetaphy_migration): the chain refuses ECDSA-signed txs from
// a voted height. Before it, an account moves by the quantum lock (card above). After it, an
// account whose key was never used on chain moves by commit–reveal: MetaMask signs the migration
// text locally (personal_sign; nothing is sent), this wallet records sha256 of (its public key,
// this wallet, a salt) and later reveals it. The salt is keccak-256 of that signature, which
// MetaMask gives again on request, so nothing is stored between the steps.
let qdayOwner = null; // normalized MetaMask account being checked

async function qdayStatus() {
  const el = $('qd-status');
  let st;
  try { st = await client.securityStatus(); } catch { el.textContent = t('qdOff'); return null; }
  if (!Number(st.securityCoreFrom)) { el.textContent = t('qdOff'); return null; }
  const h = Number(st.qdayHeight);
  el.textContent = !h ? t('qdNone') : st.qdayActive ? t('qdPassed', { h }) : t('qdScheduled', { h, now: st.latestHeight });
  return st;
}

async function metamaskAccount() {
  const eth = ethereum();
  let accounts;
  try { accounts = await eth.request({ method: 'eth_requestAccounts' }); } catch (e) { throw new Error(e?.code === 4001 ? 'mmRejected' : 'mmDenied'); }
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('mmDenied');
  try { return normalizeAddress(String(accounts[0]).toLowerCase()); } catch { throw new Error('mmDenied'); }
}

async function qdayCheck() {
  const st = await qdayStatus();
  qdayOwner = await metamaskAccount();
  const m = await client.migration(qdayOwner.hex);
  const acct = qdayOwner.hex;
  const out = $('qd-result');
  out.hidden = false;
  out.textContent = m.postQuantum ? t('qdPQ', { acct }) : m.migrated ? t('qdMigrated', { acct, to: m.controller })
    : m.pendingController ? t('qdPending', { acct, to: m.pendingController, h: m.pendingFinalHeight })
      : m.exposed ? t('qdExposed', { acct }) : t('qdUnexposed', { acct });
  $('qd-recover').hidden = !(st && m.canCommitReveal && !m.migrated);
  if (st) $('qd-recover-intro').textContent = t('qdRecoverIntro', { d: st.revealDelay });
  $('qd-recover-warn').textContent = t('qdRecoverWarn', { acct, ctrl: wallet ? wallet.addr.hex : '?' });
}

/** MetaMask signs the migration text (locally); returns everything both steps need. */
async function qdayMigration() {
  if (!wallet || !qdayOwner) throw new Error('qdCannot');
  const text = qdayRevealText({ owner: qdayOwner.hex, controller: wallet.addr.hex });
  const hex = '0x' + bytesToHex(new TextEncoder().encode(text));
  let sig;
  try { sig = await ethereum().request({ method: 'personal_sign', params: [hex, qdayOwner.hex] }); } catch (e) { throw new Error(e?.code === 4001 ? 'mmRejected' : 'mmDenied'); }
  const s = hexToBytes(sig);
  if (s.length !== 65) throw new Error('mmDenied');
  const msg = new TextEncoder().encode(text);
  const h = keccak_256(new Uint8Array([...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const rec = new Uint8Array(65); rec[0] = s[64] >= 27 ? s[64] - 27 : s[64]; rec.set(s.slice(0, 64), 1);
  const publicKey = secp256k1.recoverPublicKey(rec, h, { prehash: false });
  const salt = qdaySalt(s);
  return { signature: s, salt, commitment: qdayCommitment({ publicKey, controller: wallet.addr.hex, salt }) };
}

async function qdayCommitStep() {
  const st = await qdayStatus();
  const mig = await qdayMigration();
  const c = await client.commitmentHeight(mig.commitment);
  if (c.found) return status('qdAlready', { h: c.height, r: Number(c.height) + Number(st.revealDelay) });
  signingStatus();
  await client.qdayCommit({ ...signer(), commitment: mig.commitment });
  status('qdCommitted', { h: Number(st.latestHeight) + 1 + Number(st.revealDelay) });
}

async function qdayRevealStep() {
  const st = await qdayStatus();
  if (!st?.qdayActive) throw new Error('qdNotYet');
  const mig = await qdayMigration();
  const c = await client.commitmentHeight(mig.commitment);
  if (!c.found) throw new Error('qdNoCommit');
  const ready = Number(c.height) + Number(st.revealDelay);
  if (Number(st.latestHeight) + 1 < ready) throw Object.assign(new Error('qdTooEarly'), { vars: { h: ready, now: st.latestHeight } });
  signingStatus();
  await client.qdayReveal({ ...signer(), owner: qdayOwner.hex, controller: wallet.addr.hex, salt: mig.salt, signature: mig.signature });
  rememberOwner(qdayOwner);
  status('qdRevealed');
}

function consentArgs() {
  const target = $('cs-target').value.trim();
  if (!ADDR_RE.test(target)) throw new Error('csBad');
  const seconds = BigInt($('cs-seconds').value);
  if (seconds <= 0n || seconds > BigInt(MAX_CONSENT_SECONDS)) throw new Error('csBad');
  return { target, seconds };
}

async function consentSend() {
  if (!wallet || !$('cs-ok').checked) return;
  const { target, seconds } = consentArgs();
  signingStatus();
  const r = await client.consent({ ...signer(), target, seconds, ...(acting ? { asOwner: acting.address.bech32 } : {}) });
  $('cs-hash').textContent = r.txHash; $('cs-result').hidden = false; $('cs-ok').checked = false;
  status('csSent');
}

async function consentMetaMask() {
  if (!$('cs-ok').checked) return;
  const { target, seconds } = consentArgs();
  const owner = await metamaskAccount();
  const chain = BigInt(await ethereum().request({ method: 'eth_chainId' }));
  if (chain !== EVM_CHAIN_ID) throw Object.assign(new Error('mmWrongChain'), { vars: { id: chain } });
  const c = consentCall(target, seconds);
  let hash;
  try {
    hash = await ethereum().request({ method: 'eth_sendTransaction', params: [{ from: owner.hex, to: SECURITY_PRECOMPILE, value: '0x0', data: '0x' + bytesToHex(c.data) }] });
  } catch (e) { if (e?.code === 4001) throw new Error('mmRejected'); throw new Error(e?.message ?? String(e)); }
  $('cs-hash').textContent = String(hash); $('cs-result').hidden = false; $('cs-ok').checked = false;
  status('csSent');
}

// ---- MetaMask Snap: the key in MetaMask (zetaphy-snap/), reached through window.ethereum ----
// The page asks MetaMask to install/connect the snap (wallet_requestSnaps), reads the
// account's public key, and hands each tx to it as messages (wallet_invokeSnap ->
// zetaphy_signTx). The snap shows the tx in its own dialog and signs only if approved.
const DEFAULT_SNAP_ID = document.querySelector('meta[name="zetaphy-snap-id"]')?.content || 'npm:@zetaphy/snap';
const SNAP_ID_RE = /^(?:npm:(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*|local:https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/?)$/;

/** The provider of the EVM wallet picked under "other wallets" (window.ethereum when it is the only one). */
function ethereum() {
  const w = pickedWallet();
  if (!w) throw new Error('mmMissing');
  return w.provider;
}

/** A wallet's "this method does not exist" answer. */
const unsupported = (e) => e?.code === -32601 || e?.code === 4200 || /does not exist|not supported|not available|unsupported/i.test(e?.message ?? '');

async function invokeSnap(snapId, method, params, eth = wallet?.snapProvider ?? ethereum()) {
  try {
    return await eth.request({ method: 'wallet_invokeSnap', params: { snapId, request: params === undefined ? { method } : { method, params } } });
  } catch (e) {
    if (e?.code === 4001) throw new Error('snapRejected');
    throw new Error(e?.message ?? String(e));
  }
}

/** pqClient's signTx: the snap builds the tx from these messages, shows it, and signs it. */
const snapSignTx = (request) => invokeSnap(wallet.snapId, 'zetaphy_signTx', { ...request, lang: SNAP_LANGS.includes(lang) ? lang : 'en' });

async function connectSnap() {
  const snapId = $('snap-id').value.trim() || DEFAULT_SNAP_ID;
  if (!SNAP_ID_RE.test(snapId)) return fail('snapBadId');
  const picked = pickedWallet();
  const eth = ethereum();
  status('working');
  // Snaps run only in MetaMask (Flask until the snap is allowlisted): ask the wallet first.
  const noSnaps = () => (mayRunSnaps(picked.kind) ? new Error('snapUnsupported') : Object.assign(new Error('snapNotMetaMask'), { vars: { name: picked.name } }));
  try { await eth.request({ method: 'wallet_getSnaps' }); } catch (e) {
    if (unsupported(e)) throw noSnaps();
  }
  let snaps;
  try {
    snaps = await eth.request({ method: 'wallet_requestSnaps', params: { [snapId]: {} } });
  } catch (e) {
    if (e?.code === 4001) throw new Error('snapDenied');
    if (unsupported(e)) throw noSnaps();
    throw new Error(e?.message ?? String(e));
  }
  if (!snaps?.[snapId] || snaps[snapId].error) throw new Error(snaps?.[snapId]?.error?.message ?? 'snapDenied');
  const a = await invokeSnap(snapId, 'zetaphy_getAccount', undefined, eth);
  // The address is derived here from the public key, never taken from the snap's word.
  let publicKey;
  try { publicKey = hexToBytes(a?.publicKey); } catch { throw new Error('snapBadAccount'); }
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('snapBadAccount');
  const addr = pqAddress(publicKey);
  if (a.address !== addr.bech32 || String(a.hex).toLowerCase() !== addr.hex.toLowerCase()) throw new Error('snapBadAccount');
  if (wallet) lock();
  wallet = { kind: 'snap', snapId, publicKey, addr, snapProvider: eth }; // signing stays with this wallet if another is picked later
  store.set(KEYS.snap, snapId);
  account = null;
  render();
  status('snapConnected');
  if ($('rpc').value.trim()) refresh();
}

/** Forgets the account in this page; the snap ID stays filled in for the next connect. */
function disconnectSnap() {
  lock();
  status('snapDisconnected');
}

function downloadBackup() {
  if (wallet?.kind !== 'local' || !$('backup-ok').checked) return;
  const url = URL.createObjectURL(new Blob([`0x${bytesToHex(wallet.seed)}\n`], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `zetaphy-pq-seed-${wallet.addr.bech32.slice(-8)}.txt`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('backupDone');
}

// ---- other wallets (wallets.js): EVM wallets found with EIP-6963 or injected, Keplr / Leap /
// Cosmostation, WalletConnect (off until a Reown projectId is set; not bundled yet) ----
let discovery = null; // { list() }
let pickedId = store.get(KEYS.evmWallet);
let evmAccount = null; // { name, provider, address, chain, balance } after "connect this wallet"
const MOBILE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
const WC_META_ID = document.querySelector('meta[name="zetaphy-walletconnect-project-id"]')?.content.trim() ?? '';
const WC_ID_RE = /^[0-9a-f]{32}$/i;
const NATIVE_PRECOMPILE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'; // ZETAPHY as an ERC-20: the same coin
/** A wallet's error text, shown as plain text: no control or bidi characters, not too long. */
const clean = (s) => String(s ?? '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** The EVM wallet the page uses: the one picked, else MetaMask, else the first found. */
function pickedWallet() {
  const list = discovery?.list() ?? [];
  return list.find((w) => w.id === pickedId) ?? list.find((w) => w.kind === 'metamask' || w.kind === 'flask') ?? list[0] ?? null;
}

function pickWallet(id) {
  pickedId = id;
  store.set(KEYS.evmWallet, id);
  evmAccount = null;
  renderWallets();
  showEvmAccount();
  const w = pickedWallet();
  if (w) status('walletPicked', { name: w.name });
}

function renderWallets() {
  const list = discovery.list();
  const picked = pickedWallet();
  $('evm-wallets').replaceChildren(...list.map((w) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.wallet = w.id;
    const on = w.id === picked?.id; // injected wallets are new objects on each list()
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    if (w.icon) { // a data:image/… URI only (safeIcon), set as a property: never markup
      const img = document.createElement('img');
      img.src = w.icon;
      img.alt = '';
      img.width = 24; img.height = 24;
      b.append(img);
    } else {
      const i = document.createElement('span');
      i.className = 'wallet-icon';
      i.setAttribute('aria-hidden', 'true');
      i.textContent = w.name.slice(0, 1).toUpperCase();
      b.append(i);
    }
    const name = document.createElement('span');
    name.textContent = w.name;
    b.append(name);
    b.addEventListener('click', () => pickWallet(w.id));
    const li = document.createElement('li');
    li.append(b);
    return li;
  }));
  $('evm-none').hidden = list.length > 0;
  // Before anything is asked of them: wallets that may refuse a new network.
  const note = picked?.kind === 'phantom' ? 'phantomNote' : picked?.kind === 'binance' ? 'binanceNote' : null;
  $('evm-note').hidden = !note;
  if (note) setI18n($('evm-note'), note);
  for (const el of document.querySelectorAll('.using-text')) el.textContent = picked ? t('usingWallet', { name: picked.name }) : t('usingNone');
  // Phones: inside a wallet app's browser its provider is injected, so it is in the list.
  $('wallet-env').hidden = !MOBILE;
  $('wallet-env').textContent = !MOBILE ? '' : picked ? t('inApp', { name: picked.name }) : t('mobileNoWallet');
  const links = $('open-in-app');
  links.hidden = !MOBILE || !!picked;
  if (!links.hidden && !links.childElementCount) {
    links.replaceChildren(...openInAppLinks(location.href).map(({ name, href }) => {
      const a = document.createElement('a');
      a.href = href;
      a.rel = 'noopener noreferrer';
      a.textContent = name;
      const li = document.createElement('li');
      li.append(a);
      return li;
    }));
  }
}

/** The values to type into any EVM wallet by hand. */
function showManual() {
  let rpc = null;
  try { rpc = nodeEndpoints($('rpc').value).evm; } catch { /* not set yet, or not https */ }
  $('m-name').textContent = CHAIN_NAME;
  $('m-rpc').textContent = rpc ?? t('mRpcUnset');
  $('m-rpc').nextElementSibling.hidden = !rpc;
  $('m-chain').textContent = `${EVM_CHAIN_ID} (${EVM_CHAIN_ID_HEX})`;
  $('m-symbol').textContent = EVM_SYMBOL;
  $('m-decimals').textContent = String(DECIMALS);
  $('m-symbol-note').textContent = t('mSymbolNote', { sym: EVM_SYMBOL, precompile: NATIVE_PRECOMPILE });
}

/** The node's endpoints, from the RPC URL above (https, or localhost). */
const endpoints = () => nodeEndpoints(rpcUrl());

/** A wallet refused: say so with its own words, and open the manual values. */
const walletError = (key, w, e) => Object.assign(new Error(key), {
  vars: { name: w.name, why: clean(e?.message) || (e?.code != null ? `code ${e.code}` : '?') }, manual: true,
});

/** EIP-3085: wallet_addEthereumChain, then wallet_switchEthereumChain. */
async function addEvmChain() {
  const w = pickedWallet();
  if (!w) throw new Error('evmMissing');
  const params = evmChainParams(endpoints());
  status('chainAdding', { name: w.name });
  try {
    await w.provider.request({ method: 'wallet_addEthereumChain', params: [params] });
  } catch (e) {
    if (e?.code === 4001) throw new Error('evmRejected');
    throw walletError('addChainUnsupported', w, e); // e.g. 4200 (unsupported), or the chain refused
  }
  try {
    await w.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: EVM_CHAIN_ID_HEX }] });
  } catch (e) {
    if (e?.code === 4001) return status('chainAddedNoSwitch', { name: w.name });
    throw walletError('addChainUnsupported', w, e);
  }
  status('chainAdded', { name: w.name });
  if (evmAccount?.provider === w.provider) { evmAccount.chain = EVM_CHAIN_ID; showEvmAccount(); }
}

/** eth_requestAccounts: shows the wallet's account in both forms (the same 20 bytes). */
async function connectEvm() {
  const w = pickedWallet();
  if (!w) throw new Error('evmMissing');
  status('working');
  let accounts;
  try { accounts = await w.provider.request({ method: 'eth_requestAccounts' }); } catch (e) { throw new Error(e?.code === 4001 ? 'evmRejected' : 'evmDenied'); }
  if (!Array.isArray(accounts) || !accounts.length) throw new Error('evmDenied');
  let address;
  try { address = normalizeAddress(String(accounts[0]).toLowerCase()); } catch { throw new Error('evmDenied'); }
  let chain = null;
  try { chain = BigInt(await w.provider.request({ method: 'eth_chainId' })); } catch { /* not shown */ }
  evmAccount = { name: w.name, provider: w.provider, address, chain, balance: null };
  showEvmAccount();
  status('evmConnected', { name: w.name });
  if (!$('rpc').value.trim()) return;
  try {
    const balance = await client.balance(address.hex);
    if (evmAccount?.address === address) { evmAccount.balance = balance; showEvmAccount(); }
  } catch { /* the node is not reachable: no balance shown */ }
}

function showEvmAccount() {
  const a = evmAccount;
  $('evm-account').hidden = !a;
  if (!a) return;
  $('evm-wallet-name').textContent = a.name;
  $('evm-addr-hex').textContent = a.address.hex;
  $('evm-addr-bech32').textContent = a.address.bech32;
  const parts = [];
  if (a.chain != null) parts.push(a.chain === EVM_CHAIN_ID ? t('evmOnZetaphy') : t('evmOtherChain', { id: a.chain }));
  if (a.balance != null) parts.push(t('evmBalance', { amount: formatZeta(a.balance) }));
  $('evm-chain').textContent = parts.join(' · ');
  showBigBalance();
}

// Keplr's interface: experimentalSuggestChain, enable, getKey. Cosmostation offers it too.
const COSMOS = {
  keplr: { name: 'Keplr', get: () => window.keplr },
  leap: { name: 'Leap', get: () => window.leap },
  cosmostation: { name: 'Cosmostation', get: () => window.cosmostation?.providers?.keplr },
};

async function addCosmos(id) {
  const c = COSMOS[id];
  let w = null;
  try { w = c.get(); } catch { /* a getter that throws: not there */ }
  if (!w || typeof w.experimentalSuggestChain !== 'function' || typeof w.enable !== 'function' || typeof w.getKey !== 'function') {
    throw Object.assign(new Error('cosmosMissing'), { vars: { name: c.name } });
  }
  const info = keplrChainInfo(endpoints());
  status('cosmosAdding', { name: c.name });
  let key;
  try {
    await w.experimentalSuggestChain(info);
    await w.enable(CHAIN_ID);
    key = await w.getKey(CHAIN_ID);
  } catch (e) {
    throw Object.assign(new Error('cosmosRejected'), { vars: { name: c.name, why: clean(e?.message) || '?' } });
  }
  const reported = String(key?.bech32Address ?? '');
  let address;
  try { address = normalizeAddress(reported); } catch { throw new Error('cosmosBadAddress'); }
  if (!reported.toLowerCase().startsWith('zetaphy1')) throw new Error('cosmosBadAddress');
  $('cosmos-wallet-name').textContent = c.name;
  $('cosmos-addr').textContent = address.bech32;
  $('cosmos-hex').textContent = address.hex;
  $('cosmos-account').hidden = false;
  status('cosmosAdded', { name: c.name });
}

/** The projectId set in this browser, else the page's meta tag; '' when neither is valid. */
function wcProjectId() {
  const id = store.get(KEYS.wcId) || WC_META_ID;
  return WC_ID_RE.test(id) ? id : '';
}

function showWalletConnect() {
  const on = !!wcProjectId();
  $('wc-connect').disabled = !on;
  setI18n($('wc-hint'), on ? 'wcOn' : 'wcOff');
}

// ---- wiring ----
function init() {
  $('rpc').value = store.get(KEYS.rpc) ?? RPC_META;
  $('token').value = store.get(KEYS.token) ?? '';
  $('snap-id').value = store.get(KEYS.snap) ?? DEFAULT_SNAP_ID;
  $('lang').addEventListener('change', (e) => { lang = pickLang(e.target.value); store.set(KEYS.lang, lang); applyLang(); });
  $('rpc-save').addEventListener('click', () => {
    const u = $('rpc').value.trim();
    if (u && !/^https?:\/\//i.test(u)) return fail('badRpc');
    if (u) store.set(KEYS.rpc, u); else store.del(KEYS.rpc);
    checkedRpc = null;
    status('rpcSaved');
    refresh();
  });
  $('mode-new').addEventListener('click', () => setMode('new'));
  $('mode-import').addEventListener('click', () => setMode('import'));
  $('setup-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('save-key'), setupWallet); });
  $('unlock-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('unlock'), unlock); });
  $('forget').addEventListener('click', () => {
    if (!window.confirm(t('forgetConfirm'))) return;
    store.del(KEYS.seed);
    store.del(KEYS.passkey);
    lock();
    status('forgotten');
  });
  $('refresh').addEventListener('click', () => busy($('refresh'), refresh));
  $('send-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('review'), review); });
  $('confirm-send').addEventListener('click', () => busy($('confirm-send'), confirmSend));
  $('cancel-send').addEventListener('click', () => { pending = null; $('confirm').hidden = true; status(''); });
  $('token-load').addEventListener('click', () => busy($('token-load'), () => loadToken()));
  $('token').addEventListener('input', () => {
    if (token && $('token').value.trim().toLowerCase() !== token.address.toLowerCase()) { token = null; showToken(); }
    tokenPending = null; $('token-confirm').hidden = true;
  });
  $('token-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('token-review'), tokenReview); });
  $('confirm-token').addEventListener('click', () => busy($('confirm-token'), tokenConfirm));
  $('cancel-token').addEventListener('click', () => { tokenPending = null; $('token-confirm').hidden = true; status(''); });
  const stakeButtons = ['stake', 'unstake', 'claim'].map((id) => $(id));
  for (const b of stakeButtons) b.addEventListener('click', () => busy(stakeButtons, () => stakeReview(b.id)));
  $('stake-form').addEventListener('submit', (e) => e.preventDefault());
  $('confirm-stake').addEventListener('click', () => busy($('confirm-stake'), stakeConfirm));
  $('cancel-stake').addEventListener('click', () => { stakePending = null; $('stake-confirm').hidden = true; status(''); });
  $('deploy-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('deploy-review'), deployReview); });
  $('confirm-deploy').addEventListener('click', () => busy($('confirm-deploy'), deployConfirm));
  $('cancel-deploy').addEventListener('click', () => { deployPending = null; $('deploy-confirm').hidden = true; status(''); });
  $('init-code').addEventListener('input', () => { deployPending = null; $('deploy-confirm').hidden = true; });
  $('snap-connect').addEventListener('click', () => busy($('snap-connect'), connectSnap));
  $('snap-disconnect').addEventListener('click', disconnectSnap);
  $('owner-use').addEventListener('click', () => busy($('owner-use'), () => useOwner($('owner').value)));
  $('owner-stop').addEventListener('click', () => busy($('owner-stop'), stopActing));
  $('mm-ok').addEventListener('change', () => { $('mm-lock').disabled = !$('mm-ok').checked; });
  $('mm-lock').addEventListener('click', () => busy($('mm-lock'), metamaskLock).then(() => { $('mm-lock').disabled = !$('mm-ok').checked; }));
  $('qd-check').addEventListener('click', () => busy($('qd-check'), qdayCheck));
  $('qd-commit').addEventListener('click', () => busy([$('qd-commit'), $('qd-reveal')], qdayCommitStep));
  $('qd-reveal').addEventListener('click', () => busy([$('qd-commit'), $('qd-reveal')], qdayRevealStep));
  $('cs-ok').addEventListener('change', () => { $('cs-send').disabled = $('cs-send-mm').disabled = !$('cs-ok').checked; });
  $('cs-send').addEventListener('click', () => busy([$('cs-send'), $('cs-send-mm')], consentSend).then(() => { $('cs-send').disabled = $('cs-send-mm').disabled = !$('cs-ok').checked; }));
  $('cs-send-mm').addEventListener('click', () => busy([$('cs-send'), $('cs-send-mm')], consentMetaMask).then(() => { $('cs-send').disabled = $('cs-send-mm').disabled = !$('cs-ok').checked; }));
  $('backup-ok').addEventListener('change', () => { $('backup').disabled = !$('backup-ok').checked; });
  $('backup').addEventListener('click', downloadBackup);
  $('lock').addEventListener('click', () => { lock(); status('lockedMsg'); });
  // Security: auto-lock, passphrase strength and change, passkey unlock, large-balance advice.
  for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) document.addEventListener(ev, onActivity, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  $('autolock-min').addEventListener('change', (e) => { setAutoLock(Number(e.target.value)); status('autoLockSaved', { n: autoLockMin }); });
  $('pass1').addEventListener('input', () => showMeter('pass1'));
  $('chpw-new1').addEventListener('input', () => showMeter('chpw-new1'));
  $('chpw-form').addEventListener('submit', (e) => { e.preventDefault(); busy($('chpw-save'), changePassword); });
  $('weak-nudge-go').addEventListener('click', () => { $('chpw-box').scrollIntoView({ block: 'center' }); $('chpw-old').focus(); });
  $('pk-enable').addEventListener('click', () => busy($('pk-enable'), enablePasskey));
  $('pk-disable').addEventListener('click', () => { if (window.confirm(t('pkDisableConfirm'))) disablePasskey(); });
  $('pk-unlock').addEventListener('click', () => busy([$('pk-unlock'), $('unlock')], unlockPasskey));
  $('big-help').addEventListener('click', openHelp);
  $('help-open').addEventListener('click', openHelp);
  $('big-later').addEventListener('click', hideBigBalance);
  $('help-close').addEventListener('click', () => { const d = $('help-dialog'); if (d.close) d.close(); else d.removeAttribute('open'); });
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); status('copied'); } catch { /* clipboard not allowed */ }
    });
  }
  // Other wallets. A wallet may announce itself while discoverWallets runs, before `discovery` is set.
  discovery = discoverWallets(window, () => { if (discovery) renderWallets(); });
  $('evm-add').addEventListener('click', () => busy($('evm-add'), addEvmChain));
  $('evm-connect').addEventListener('click', () => busy($('evm-connect'), connectEvm));
  for (const b of document.querySelectorAll('.cosmos-add')) b.addEventListener('click', () => busy(b, () => addCosmos(b.dataset.cosmos)));
  $('wc-id').value = store.get(KEYS.wcId) ?? '';
  $('wc-save').addEventListener('click', () => {
    const id = $('wc-id').value.trim();
    if (id && !WC_ID_RE.test(id)) return fail('wcBadId');
    if (id) store.set(KEYS.wcId, id); else store.del(KEYS.wcId);
    showWalletConnect();
    status('wcSaved');
  });
  $('wc-connect').addEventListener('click', () => status('wcNotYet'));
  $('threat-registry').value = store.get(KEYS.threats) ?? '';
  $('threat-registry').placeholder = THREAT_META || '0x…';
  $('threat-save').addEventListener('click', () => {
    const a = $('threat-registry').value.trim();
    if (a && !ADDR_RE.test(a)) return fail('threatBadAddress');
    if (a) store.set(KEYS.threats, a); else store.del(KEYS.threats);
    clearPending(); // a confirm box checked against the old setting is not reused
    status('threatSaved');
  });
  // The typed URL is used right away; Save also remembers it.
  $('rpc').addEventListener('input', () => { checkedRpc = null; showManual(); });
  applyLang();
  setMode('new');
  render();
  showWalletConnect();
}

init();
