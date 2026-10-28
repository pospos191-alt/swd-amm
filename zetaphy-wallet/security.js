// Wallet security helpers, with no DOM access (the browser test also runs them in Node):
//  - the passphrase blob: PBKDF2-SHA256 (600k) -> AES-256-GCM over the 32-byte seed;
//  - the passkey blob: a WebAuthn PRF output -> HKDF-SHA256 -> AES-256-GCM over the same seed;
//  - a passphrase strength estimate (length, character classes, the most common passwords,
//    sequences, repeats, and words tied to this wallet).
import { COMMON_PASSWORDS } from './vendor/common-passwords.js';

const enc = new TextEncoder();
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(h) {
  const s = String(h).replace(/^0x/i, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}
export const toB64url = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64url = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

// ---- passphrase blob: PBKDF2-SHA256 (600k) -> AES-256-GCM ----
export const KDF_ITERATIONS = 600000;
const aad = (address) => enc.encode(`zetaphy-wallet v1 ${address}`);

async function aesKey(pass, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function seal(seed, pass, address) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(pass, salt, KDF_ITERATIONS);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(address) }, key, seed));
  return JSON.stringify({ v: 1, kdf: 'PBKDF2-SHA256', iterations: KDF_ITERATIONS, cipher: 'AES-256-GCM', salt: toHex(salt), iv: toHex(iv), ct: toHex(ct), address });
}

export async function unseal(json, pass) {
  const b = JSON.parse(json);
  if (b.v !== 1 || b.kdf !== 'PBKDF2-SHA256' || !(Number.isSafeInteger(b.iterations) && b.iterations >= KDF_ITERATIONS && b.iterations <= 5_000_000)) throw new Error('unknown wallet format');
  const key = await aesKey(pass, fromHex(b.salt), b.iterations);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(b.iv), additionalData: aad(b.address) }, key, fromHex(b.ct)));
  } catch { throw new Error('badPass'); }
}

// ---- passkey blob: WebAuthn PRF output -> HKDF-SHA256 -> AES-256-GCM ----
// The PRF output (32 bytes, from the authenticator after user verification) is used once,
// as HKDF input key material, and never stored: only the random PRF input ("prfSalt"),
// the HKDF salt, the IV and the ciphertext are. The AAD binds the blob to the address,
// the credential and the rpId, so a blob cannot be moved to another wallet or passkey.
export const PRF_HKDF_INFO = 'zetaphy-wallet passkey-prf v1';
const pkAad = (b) => enc.encode(`zetaphy-wallet passkey v1 ${b.address} ${b.credentialId} ${b.rpId}`);

async function prfKey(prfOutput, hkdfSalt, address) {
  const out = prfOutput instanceof Uint8Array ? prfOutput : new Uint8Array(prfOutput); // no copy: the caller zeroes it
  if (out.length !== 32) throw new Error('pkNoPrf');
  const ikm = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: enc.encode(`${PRF_HKDF_INFO} ${address}`) },
    ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** A fresh random PRF input (WebAuthn prf.eval.first), stored in the blob. */
export const newPrfSalt = () => crypto.getRandomValues(new Uint8Array(32));

/** Wraps the seed under a key derived from the PRF output; returns the blob to store (no secrets in it). */
export async function wrapSeed(seed, prfOutput, { address, credentialId, rpId, prfSalt }) {
  const meta = { v: 1, kind: 'webauthn-prf', kdf: 'HKDF-SHA256', cipher: 'AES-256-GCM', rpId, credentialId, prfSalt: toHex(prfSalt), address };
  const hkdfSalt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await prfKey(prfOutput, hkdfSalt, address);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: pkAad(meta) }, key, seed));
  return { ...meta, hkdfSalt: toHex(hkdfSalt), iv: toHex(iv), ct: toHex(ct) };
}

/** True if b looks like a blob wrapSeed made (does not check the ciphertext). */
export const isPasskeyBlob = (b) => !!b && b.v === 1 && b.kind === 'webauthn-prf' && b.kdf === 'HKDF-SHA256' && b.cipher === 'AES-256-GCM'
  && typeof b.rpId === 'string' && typeof b.credentialId === 'string' && typeof b.address === 'string'
  && [b.prfSalt, b.hkdfSalt, b.iv, b.ct].every((h) => typeof h === 'string' && /^[0-9a-f]+$/.test(h));

export async function unwrapSeed(blob, prfOutput) {
  if (!isPasskeyBlob(blob)) throw new Error('pkFailed');
  const key = await prfKey(prfOutput, fromHex(blob.hkdfSalt), blob.address);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(blob.iv), additionalData: pkAad(blob) }, key, fromHex(blob.ct)));
  } catch { throw new Error('pkFailed'); }
}

// ---- passphrase strength ----
// An estimate in bits of how many guesses an attacker who knows the usual tricks needs.
// Parts of the passphrase that are a common password, a word tied to this wallet, a
// sequence (abc, 321, qwerty) or a repeat cost only a few bits each; every other
// character costs log2 of the alphabet its character classes give. Then:
//   < 28 very weak · < 45 weak · < 60 fair · < 80 strong · ≥ 80 very strong.
// The wallet asks for at least MIN_PASSWORD_LENGTH characters and "strong".
export const MIN_PASSWORD_LENGTH = 12;
export const STRENGTH = ['veryWeak', 'weak', 'fair', 'strong', 'veryStrong'];
const LEVEL_BITS = [0, 28, 45, 60, 80];
const COMMON = new Set(COMMON_PASSWORDS);
// Longest first, so "password1" wins over "password" and "pass".
const WORDS = COMMON_PASSWORDS.filter((w) => w.length >= 4).sort((a, b) => b.length - a.length);
const WORD_BITS = Math.log2(COMMON_PASSWORDS.length);
const WALLET_WORDS = ['zetaphy', 'wallet', 'password', 'passphrase', 'passwort', 'contrasena', 'parol', 'metamask', 'quantum', 'seed', 'crypto', 'bitcoin'];
const LEET = { '@': 'a', 4: 'a', 3: 'e', '!': 'i', 0: 'o', $: 's', 5: 's', 7: 't', '+': 't', 8: 'b', 9: 'g', '|': 'l', 2: 'z' };
const ROWS = ['`1234567890-=', 'qwertyuiop[]\\', 'asdfghjkl;\'', 'zxcvbnm,./', 'abcdefghijklmnopqrstuvwxyz', 'qazwsxedcrfvtgbyhnujmikolp', '1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik,9ol.0p;/'];
const log2 = Math.log2;

/**
 * passwordStrength(pw, { context }): context is extra text tied to this wallet (its addresses).
 * Returns { bits, score 0..4, label, reasons: [message keys], ok }.
 */
export function passwordStrength(pw, { context = [] } = {}) {
  const chars = Array.from(String(pw ?? ''));
  // One UTF-16 unit per character, so string indexes are character indexes.
  const lower = chars.map((c) => { const l = c.toLowerCase(); return l.length === 1 ? l : c.length === 1 ? c : '�'; }).join('');
  const n = lower.length;
  const reasons = new Set();
  if (n < MIN_PASSWORD_LENGTH) reasons.add('pwLength');

  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[\x20-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/.test(pw)) pool += 33;
  if (/[^\x00-\x7f]/.test(pw)) pool += 100; // other scripts (Thai, CJK, Cyrillic, …)
  const charBits = log2(Math.max(pool, 10));

  const covered = new Array(n).fill(false);
  let bits = 0;
  const free = (i, len) => { for (let k = i; k < i + len; k++) if (covered[k]) return false; return true; };
  const cover = (i, len) => { for (let k = i; k < i + len; k++) covered[k] = true; };
  const hasUpper = (i, len) => /[A-Z]/.test(chars.slice(i, i + len).join(''));

  // Whole passphrase (or with digits/symbols only around it) is a common password.
  const core = lower.replace(/^[^a-z]+|[^a-z]+$/g, '');
  const unleet = (s) => s.replace(/[@4!3058$7+9|2]/g, (c) => LEET[c] ?? c);
  const common = COMMON.has(lower) || COMMON.has(unleet(lower)) || (core.length >= 3 && (COMMON.has(core) || COMMON.has(unleet(core))))
    || (n > 0 && new Set(lower).size === 1);
  if (common) reasons.add('pwCommon');

  // Words tied to this wallet: "zetaphy" and friends, and any 6+ characters of its addresses.
  const ctx = context.map((c) => String(c).toLowerCase().replace(/^0x|^zetaphy1/, '')).filter((c) => c.length >= 6);
  const variants = [lower, unleet(lower), unleet(lower.replace(/1/g, 'i')), unleet(lower.replace(/1/g, 'l'))];
  for (const v of variants) {
    for (const w of WALLET_WORDS) {
      for (let i = v.indexOf(w); i >= 0; i = v.indexOf(w, i + 1)) {
        if (free(i, w.length)) { cover(i, w.length); bits += 2; reasons.add('pwContext'); }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (let len = n - i; len >= 6; len--) {
      if (free(i, len) && ctx.some((c) => c.includes(lower.slice(i, i + len)))) { cover(i, len); bits += 2; reasons.add('pwContext'); break; }
    }
  }

  // Common passwords inside it (also with leetspeak), each costs about log2(list size).
  for (const [vi, v] of variants.entries()) {
    for (const w of WORDS) {
      if (w.length > n) continue;
      for (let i = v.indexOf(w); i >= 0; i = v.indexOf(w, i + 1)) {
        if (!free(i, w.length)) continue;
        cover(i, w.length);
        bits += WORD_BITS + (hasUpper(i, w.length) ? 1 : 0) + (vi ? 1 : 0);
        reasons.add('pwDictionary');
      }
    }
  }

  // The same character 3+ times in a row.
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && lower[j] === lower[i]) j++;
    if (j - i >= 3 && free(i, j - i)) { cover(i, j - i); bits += charBits + log2(j - i); reasons.add('pwRepeat'); }
    i = j;
  }
  // A chunk repeated right after itself (abcabc, 1212): the copies cost almost nothing.
  for (const m of lower.matchAll(/(.{2,}?)\1+/gu)) {
    const unit = m[1].length;
    const at = m.index + unit;
    const len = m[0].length - unit;
    if (len >= 2 && free(at, len)) { cover(at, len); bits += log2(len / unit + 1) + 1; reasons.add('pwRepeat'); }
  }

  // Sequences of 3+: alphabet or digits up or down (abc, 987), or along a keyboard row.
  const step = (a, b) => {
    if (/[a-z0-9]/.test(a) && /[a-z0-9]/.test(b)) { const d = b.charCodeAt(0) - a.charCodeAt(0); if (d === 1 || d === -1) return d; }
    for (const r of ROWS) {
      const x = r.indexOf(a);
      if (x >= 0 && r[x + 1] === b) return 2;
      if (x > 0 && r[x - 1] === b) return -2;
    }
    return 0;
  };
  for (let i = 0; i < n - 2;) {
    const d = step(lower[i], lower[i + 1]);
    let j = i + 1;
    if (d) while (j < n - 1 && step(lower[j], lower[j + 1]) === d) j++;
    const len = j - i + 1;
    if (d && len >= 3 && free(i, len)) { cover(i, len); bits += log2(26) + 1 + log2(len); reasons.add('pwSequence'); i = j + 1; } else i++;
  }

  // Years (1900–2099): about 200 likely values.
  for (const m of lower.matchAll(/(?:19|20)\d\d/g)) {
    if (free(m.index, 4)) { cover(m.index, 4); bits += log2(200); reasons.add('pwYear'); }
  }

  // Everything else: one character from the alphabet its classes give.
  bits += covered.filter((c) => !c).length * charBits;
  if (common) bits = Math.min(bits, WORD_BITS);
  bits = Math.round(bits);
  let score = 0;
  for (let s = 0; s < LEVEL_BITS.length; s++) if (bits >= LEVEL_BITS[s]) score = s;
  if (common) score = 0;
  if (score < 3 && pool < 60 && !reasons.has('pwCommon')) reasons.add('pwVariety');
  const ok = n >= MIN_PASSWORD_LENGTH && score >= 3 && !common;
  return { bits, score, label: STRENGTH[score], reasons: [...reasons], ok };
}
