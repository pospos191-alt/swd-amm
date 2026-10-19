// Tiny ABI decoders for the handful of read-only calls the reader makes.

const strip = (h) => (h?.startsWith('0x') ? h.slice(2) : h ?? '');

/** 32-byte word -> lowercase 0x address, or null when the word is empty. */
export function decodeAddress(hex) {
  const h = strip(hex);
  if (h.length < 64) return null;
  return '0x' + h.slice(24, 64).toLowerCase();
}

/** 32-byte word -> BigInt, or null. */
export function decodeUint(hex) {
  const h = strip(hex);
  if (h.length < 64) return null;
  return BigInt('0x' + h.slice(0, 64));
}

function utf8(hexBytes) {
  const bytes = new Uint8Array(hexBytes.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hexBytes.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** ABI `string` return value; falls back to bytes32 (old tokens like MKR). */
export function decodeString(hex) {
  const h = strip(hex);
  if (h.length < 64) return null;
  if (h.length === 64) return utf8(h.replace(/(00)+$/, ''));
  const offset = Number(BigInt('0x' + h.slice(0, 64)));
  const lenPos = offset * 2;
  if (lenPos + 64 > h.length) return null;
  const len = Number(BigInt('0x' + h.slice(lenPos, lenPos + 64)));
  const start = lenPos + 64;
  if (len > 4096 || start + len * 2 > h.length) return null;
  return utf8(h.slice(start, start + len * 2));
}

/**
 * Token names and symbols are written by whoever deployed the contract.
 * Treat them as untrusted text: drop control and bidi-override characters
 * and cap the length before showing them anywhere.
 */
export function cleanText(s, max = 64) {
  if (s == null) return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return cleaned.length > max ? cleaned.slice(0, max) + '…' : cleaned;
}
