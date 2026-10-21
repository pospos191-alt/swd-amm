// ZETAPHY PQ Wallet: a native ML-DSA-44 account in the browser.
// The seed is kept only encrypted (PBKDF2-SHA256 600k + AES-256-GCM) in
// localStorage. The only network traffic is JSON-RPC to the node the user
// typed in: addresses, balances and signed transactions. Never the seed.
// Or the key lives in MetaMask (the ZETAPHY Snap, zetaphy-snap/): this page then
// knows only the public key, and the snap builds, shows and signs each tx.
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

const KEYS = { seed: 'zetaphy-wallet:seed:v1', rpc: 'zetaphy-wallet:rpc', lang: 'zetaphy-wallet:lang', token: 'zetaphy-wallet:token',
  owners: 'zetaphy-wallet:owners:v1:', // + this wallet's zetaphy1… address
  snap: 'zetaphy-wallet:snap:v1', // the snap ID last connected (no key: MetaMask holds it)
  evmWallet: 'zetaphy-wallet:evm-wallet', // the EVM wallet picked (its EIP-6963 rdns, or which injected object)
  wcId: 'zetaphy-wallet:walletconnect-project-id',
  threats: 'zetaphy-wallet:threat-registry' }; // ThreatRegistry address (the vaccine), else the page's meta tag
const KDF_ITERATIONS = 600000;
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
    pass1: 'ตั้งรหัสผ่าน (อย่างน้อย 8 ตัวอักษร)',
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
    passShort: 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร',
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
    pass1: 'Choose a passphrase (at least 8 characters)',
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
    passShort: 'The passphrase must be at least 8 characters.',
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
let lang = store.get(KEYS.lang) === 'en' ? 'en' : 'th';
let lastStatus = null;
const t = (k, vars = {}) => (T[lang][k] ?? k).replace(/\{(\w+)\}/g, (_, v) => String(vars[v] ?? ''));

function applyLang() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  $('lang').textContent = lang === 'th' ? 'English' : 'ไทย';
  $('lang').lang = lang === 'th' ? 'en' : 'th';
  if (lastStatus) status(...lastStatus);
  if (wallet) { showAccount(); showToken(); showOwned(); }
  if (discovery) { renderWallets(); showManual(); showEvmAccount(); }
}

/** status(key, vars, isError, extra): extra is raw text (e.g. a node's log). */
function status(key, vars = {}, isError = false, extra = '') {
  lastStatus = [key, vars, isError, extra];
  $('status').textContent = key ? t(key, vars) + (extra ? `: ${extra}` : '') : extra;
  $('status').classList.toggle('error', isError);
}
const fail = (key, vars, extra) => status(key, vars, true, extra);

// ---- encrypted seed: PBKDF2-SHA256 (600k) -> AES-256-GCM ----
const aad = (address) => enc.encode(`zetaphy-wallet v1 ${address}`);

async function aesKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function seal(seed, pass, address) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(pass, salt, KDF_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(address) }, key, seed));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, cipher: 'AES-256-GCM', salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct), address });
}

async function unseal(json, pass) {
  const b = JSON.parse(json);
  if (b.v !== 1 || b.kdf !== 'PBKDF2-SHA256' || !(b.iterations >= KDF_ITERATIONS)) throw new Error('unknown wallet format');
  const key = await aesKey(pass, hexToBytes(b.salt), b.iterations);
  let seed;
  try {
    seed = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(b.iv), additionalData: aad(b.address) }, key, hexToBytes(b.ct)));
  } catch { throw new Error('badPass'); }
  return seed;
}

const sealedBlob = () => { try { return JSON.parse(store.get(KEYS.seed)); } catch { return null; } };

// ---- the unlocked key, in memory only ----
let wallet = null;

// wallet.kind: 'local' (the seed is in this page) or 'snap' (MetaMask holds the key).
function openSeed(seed) {
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  wallet = { kind: 'local', seed, publicKey, secretKey, addr: pqAddress(publicKey) };
}

function lock() {
  if (wallet?.kind === 'local') { wallet.seed.fill(0); wallet.secretKey.fill(0); }
  wallet = null;
  pending = null; tokenPending = null; stakePending = null; deployPending = null;
  account = null;
  token = null;
  acting = null; owned = [];
  for (const id of ['confirm', 'token-confirm', 'stake-confirm', 'deploy-confirm', 'tx-result', 'token-result', 'stake-result', 'deploy-result', 'mm-result']) $(id).hidden = true;
  render();
}

/** What pqClient signs with: the key in this page, or the snap (it gets the messages, never bytes). */
function signer() {
  if (wallet.kind === 'snap') return { signTx: snapSignTx };
  return { sign: (bytes) => ml_dsa44.sign(bytes, wallet.secretKey) };
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
  if (wallet) { if (!owned.length) loadOwned(); showAccount(); showToken(); showOwned(); }
}

let account = null;
function showAccount() {
  $('addr-bech32').textContent = wallet.addr.bech32;
  $('addr-hex').textContent = wallet.addr.hex;
  if (!account) { $('acct-status').textContent = ''; return; }
  $('balance').textContent = `${formatZeta(account.balance)} ZETAPHY`;
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
  if (p1.length < 8) return fail('passShort');
  if (p1 !== p2) return fail('passMismatch');
  let seed;
  if (mode === 'import') {
    const s = $('seed-in').value.trim();
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return fail('badSeed');
    seed = hexToBytes(s);
  } else {
    seed = crypto.getRandomValues(new Uint8Array(32));
  }
  status('deriving');
  openSeed(seed);
  const blob = await seal(seed, p1, wallet.addr.bech32);
  for (const id of ['pass1', 'pass2', 'seed-in']) $(id).value = '';
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
  const seed = await unseal(sealed, $('unlock-pass').value);
  openSeed(seed);
  if (wallet.addr.bech32 !== sealedBlob().address) { lock(); throw new Error('unknown wallet format'); }
  $('unlock-pass').value = '';
  account = null;
  render();
  status('unlocked');
  if ($('rpc').value.trim()) refresh();
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
    publicKey: wallet.publicKey, ...signer(),
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
    publicKey: wallet.publicKey, ...signer(),
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
    publicKey: wallet.publicKey, ...signer(),
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
    publicKey: wallet.publicKey, ...signer(),
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
      const vars = { addr: label, what: t(WHAT[what]), reason: { toString: () => (reason > 0 && T[lang][`reason${reason}`] ? t(`reason${reason}`) : `#${reason}`) },
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
  await client.qdayCommit({ publicKey: wallet.publicKey, ...signer(), commitment: mig.commitment });
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
  await client.qdayReveal({ publicKey: wallet.publicKey, ...signer(), owner: qdayOwner.hex, controller: wallet.addr.hex, salt: mig.salt, signature: mig.signature });
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
  const r = await client.consent({ publicKey: wallet.publicKey, ...signer(), target, seconds, ...(acting ? { asOwner: acting.address.bech32 } : {}) });
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
const snapSignTx = (request) => invokeSnap(wallet.snapId, 'zetaphy_signTx', { ...request, lang });

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
  $('lang').addEventListener('click', () => { lang = lang === 'th' ? 'en' : 'th'; store.set(KEYS.lang, lang); applyLang(); });
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
