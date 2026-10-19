// The runner's own keys, made on its machine and never sent anywhere.
//   ~/.zetaphy/worker.key       (plain, testnet convenience) or
//   ~/.zetaphy/worker.key.json  (Ethereum keystore, scrypt) when ZETAPHY_PASSPHRASE is set.
// Never put a key that holds real funds here without a passphrase.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { Wallet } from 'ethers';

export const HOME = process.env.ZETAPHY_HOME ?? join(os.homedir(), '.zetaphy');
const passphrase = () => process.env.ZETAPHY_PASSPHRASE || null;

function tighten(file) {
  if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) chmodSync(file, 0o600);
}
function writeSecret(file, text) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
}

// ---- small secrets (the ML-DSA seed): scrypt + AES-256-GCM ----
const SCRYPT = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };

export function sealSecret(plain, pass) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const key = scryptSync(pass, salt, 32, SCRYPT);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return JSON.stringify({ v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), ct: ct.toString('hex') });
}

export function openSecret(json, pass) {
  const b = JSON.parse(json);
  if (b.v !== 1 || b.kdf !== 'scrypt') throw new Error('unknown secret format');
  const key = scryptSync(pass, Buffer.from(b.salt, 'hex'), 32, { N: b.N, r: b.r, p: b.p, maxmem: SCRYPT.maxmem });
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'hex'));
  d.setAuthTag(Buffer.from(b.tag, 'hex'));
  try {
    return Buffer.concat([d.update(Buffer.from(b.ct, 'hex')), d.final()]).toString('utf8');
  } catch {
    throw new Error('wrong ZETAPHY_PASSPHRASE');
  }
}

/** Reads a secret stored plain at `file` or sealed at `file + '.json'`; creates it with make() if neither exists. */
export function loadOrCreateSecret(file, make, { encrypt = (text, pass) => sealSecret(text, pass), decrypt = (json, pass) => openSecret(json, pass) } = {}) {
  const sealed = file + '.json';
  if (existsSync(sealed)) {
    tighten(sealed);
    if (!passphrase()) throw new Error(`${sealed} is encrypted: set ZETAPHY_PASSPHRASE`);
    return { value: decrypt(readFileSync(sealed, 'utf8'), passphrase()), created: false, file: sealed, encrypted: true };
  }
  if (existsSync(file)) {
    tighten(file);
    return { value: readFileSync(file, 'utf8').trim(), created: false, file, encrypted: false };
  }
  const value = make();
  if (passphrase()) { writeSecret(sealed, encrypt(value, passphrase())); return { value, created: true, file: sealed, encrypted: true }; }
  writeSecret(file, value + '\n');
  return { value, created: true, file, encrypted: false };
}

/** Turns a plain secret file into its sealed form and removes the plain one. */
export function sealExisting(file, { encrypt = (text, pass) => sealSecret(text, pass) } = {}) {
  if (!passphrase()) throw new Error('set ZETAPHY_PASSPHRASE first');
  if (!existsSync(file)) return false;
  writeSecret(file + '.json', encrypt(readFileSync(file, 'utf8').trim(), passphrase()));
  unlinkSync(file);
  return true;
}

// ---- the runner's Ethereum key: standard keystore JSON ----
const keystore = {
  encrypt: (hex, pass) => new Wallet(hex).encryptSync(pass),
  decrypt: (json, pass) => {
    try { return Wallet.fromEncryptedJsonSync(json, pass).privateKey; } catch { throw new Error('wrong ZETAPHY_PASSPHRASE'); }
  },
};

export function loadOrCreateKey(file = join(HOME, 'worker.key')) {
  const r = loadOrCreateSecret(file, () => Wallet.createRandom().privateKey, keystore);
  if (!/^0x[0-9a-fA-F]{64}$/.test(r.value)) throw new Error(`${r.file} is not a key file`);
  return { wallet: new Wallet(r.value), created: r.created, file: r.file, encrypted: r.encrypted };
}

export function sealWorkerKey(file = join(HOME, 'worker.key')) {
  return sealExisting(file, keystore);
}
