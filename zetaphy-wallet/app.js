// ZETAPHY PQ Wallet: a native ML-DSA-44 account in the browser.
// The seed is kept only encrypted (PBKDF2-SHA256 600k + AES-256-GCM) in
// localStorage. The only network traffic is JSON-RPC to the node the user
// typed in: addresses, balances and signed transactions. Never the seed.
import {
  ml_dsa44, pqAddress, pqClient, normalizeAddress, validatorAddress, parseZeta, formatZeta, bytesToHex, hexToBytes,
  DEFAULT_GAS_LIMIT, DEFAULT_STAKING_GAS_LIMIT, DEFAULT_EVM_GAS_LIMIT, EVM_CALL_GAS_OVERHEAD, MIN_EVM_GAS_LIMIT, MAX_EVM_GAS_LIMIT,
  DEFAULT_PRECOMPILE_GAS_LIMIT, quantumLockTx,
} from './vendor/pqwallet.js';

const KEYS = { seed: 'zetaphy-wallet:seed:v1', rpc: 'zetaphy-wallet:rpc', lang: 'zetaphy-wallet:lang', token: 'zetaphy-wallet:token',
  owners: 'zetaphy-wallet:owners:v1:' }; // + this wallet's zetaphy1… address
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
    footer: 'โค้ดทั้งหมดอยู่ในหน้านี้ ไม่โหลดสคริปต์จากที่อื่น · ธุรกรรมเซ็นในเบราว์เซอร์ด้วย ML-DSA-44 (FIPS 204)',
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
    footer: 'All code is in this page; no scripts from elsewhere · Transactions are signed in the browser with ML-DSA-44 (FIPS 204)',
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

function openSeed(seed) {
  const { publicKey, secretKey } = ml_dsa44.keygen(seed);
  wallet = { seed, publicKey, secretKey, addr: pqAddress(publicKey) };
}

function lock() {
  if (wallet) { wallet.seed.fill(0); wallet.secretKey.fill(0); }
  wallet = null;
  pending = null; tokenPending = null; stakePending = null;
  account = null;
  token = null;
  acting = null; owned = [];
  for (const id of ['confirm', 'token-confirm', 'stake-confirm', 'tx-result', 'token-result', 'stake-result', 'mm-result']) $(id).hidden = true;
  render();
}

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
  if (T.en[m]) return fail(m, e.vars);
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
  const rej = /rejected the transaction (.*)$/.exec(m);
  if (rej) return fail('rejected', {}, rej[1]);
  return fail('', {}, m);
}

// ---- screens ----
function render() {
  const sealed = sealedBlob();
  $('setup').hidden = !!(wallet || sealed);
  $('locked').hidden = !!wallet || !sealed;
  $('wallet').hidden = !wallet;
  if (!wallet && sealed) $('locked-addr').textContent = sealed.address ?? '';
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
  pending = { to, amount, gasLimit, gasPrice: q.gasPrice, fee: q.fee, asOwner: as?.address };
  showAsNote($('confirm'), as);
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
  status('signing');
  const r = await client.send({
    publicKey: wallet.publicKey, sign: (bytes) => ml_dsa44.sign(bytes, wallet.secretKey),
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
  tokenPending = { token: t0.address, symbol: t0.symbol, decimals: t0.decimals, to, units, data, evmGas, txGas, gasPrice: q.gasPrice, asOwner: as?.address };
  showAsNote($('token-confirm'), as);
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
  status('signing');
  const r = await client.callEVM({
    publicKey: wallet.publicKey, sign: (bytes) => ml_dsa44.sign(bytes, wallet.secretKey),
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
  status('signing');
  const r = await STAKE[p.action].run({
    publicKey: wallet.publicKey, sign: (bytes) => ml_dsa44.sign(bytes, wallet.secretKey),
    validator: p.validator, amount: p.action === 'claim' ? undefined : p.amount, gasLimit: p.gasLimit, gasPrice: p.gasPrice,
    ...(p.asOwner ? { asOwner: p.asOwner.bech32, evmGasLimit: DEFAULT_PRECOMPILE_GAS_LIMIT } : {}),
  });
  $('stake-hash').textContent = r.txHash;
  $('stake-result').hidden = false;
  if (p.action !== 'claim') $('stake-amount').value = '';
  status(STAKE[p.action].done);
  setTimeout(refresh, 6000);
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
  pending = null; tokenPending = null; stakePending = null;
  for (const id of ['confirm', 'token-confirm', 'stake-confirm']) $(id).hidden = true;
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
  const eth = window.ethereum;
  if (!eth || typeof eth.request !== 'function') throw new Error('mmMissing');
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

function downloadBackup() {
  if (!wallet || !$('backup-ok').checked) return;
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

// ---- wiring ----
function init() {
  $('rpc').value = store.get(KEYS.rpc) ?? '';
  $('token').value = store.get(KEYS.token) ?? '';
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
  $('owner-use').addEventListener('click', () => busy($('owner-use'), () => useOwner($('owner').value)));
  $('owner-stop').addEventListener('click', () => busy($('owner-stop'), stopActing));
  $('mm-ok').addEventListener('change', () => { $('mm-lock').disabled = !$('mm-ok').checked; });
  $('mm-lock').addEventListener('click', () => busy($('mm-lock'), metamaskLock).then(() => { $('mm-lock').disabled = !$('mm-ok').checked; }));
  $('backup-ok').addEventListener('change', () => { $('backup').disabled = !$('backup-ok').checked; });
  $('backup').addEventListener('click', downloadBackup);
  $('lock').addEventListener('click', () => { lock(); status('lockedMsg'); });
  for (const b of document.querySelectorAll('[data-copy]')) {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($(b.dataset.copy).textContent); status('copied'); } catch { /* clipboard not allowed */ }
    });
  }
  // The typed URL is used right away; Save also remembers it.
  $('rpc').addEventListener('input', () => { checkedRpc = null; });
  applyLang();
  setMode('new');
  render();
}

init();
