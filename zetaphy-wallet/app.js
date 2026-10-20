// ZETAPHY PQ Wallet: a native ML-DSA-44 account in the browser.
// The seed is kept only encrypted (PBKDF2-SHA256 600k + AES-256-GCM) in
// localStorage. The only network traffic is JSON-RPC to the node the user
// typed in: addresses, balances and signed transactions. Never the seed.
import {
  ml_dsa44, pqAddress, pqClient, normalizeAddress, parseZeta, formatZeta, bytesToHex, hexToBytes, DEFAULT_GAS_LIMIT,
} from './vendor/pqwallet.js';

const KEYS = { seed: 'zetaphy-wallet:seed:v1', rpc: 'zetaphy-wallet:rpc', lang: 'zetaphy-wallet:lang' };
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
  if (wallet) showAccount();
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
  pending = null;
  account = null;
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
  if (wallet) showAccount();
}

let account = null;
function showAccount() {
  $('addr-bech32').textContent = wallet.addr.bech32;
  $('addr-hex').textContent = wallet.addr.hex;
  if (!account) { $('acct-status').textContent = ''; return; }
  $('balance').textContent = `${formatZeta(account.balance)} ZETAPHY`;
  $('acct-status').textContent = account.exists ? t('onChain', { n: account.accountNumber, s: account.sequence }) : t('notFunded');
}

async function refresh() {
  if (!wallet) return;
  try {
    const [a, balance] = await Promise.all([client.account(wallet.addr.bech32), client.balance(wallet.addr.hex)]);
    account = { ...a, balance };
    showAccount();
  } catch (e) { showError(e); }
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { showError(e); } finally { btn.disabled = false; }
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
  status('working');
  const q = await client.quote({ publicKey: wallet.publicKey, gasLimit });
  account = { ...q.account, balance: q.balance };
  showAccount();
  if (!q.exists) return fail('notFunded');
  if (amount + q.fee > q.balance) return fail('notEnough', { need: formatZeta(amount + q.fee), have: formatZeta(q.balance) });
  pending = { to, amount, gasLimit, gasPrice: q.gasPrice, fee: q.fee };
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
  });
  $('tx-hash').textContent = r.txHash;
  $('tx-result').hidden = false;
  $('amount').value = '';
  status('sent');
  setTimeout(refresh, 6000);
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
