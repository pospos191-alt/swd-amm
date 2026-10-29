// Pure helpers of the Agents page (agents.js): ABI encoding of the few calls it makes, and the
// WebAuthn pieces (public key from SPKI, (r, s) from a DER signature, base64url). No dependencies;
// test/agents.test.mjs checks every encoding against ethers and node:crypto.

// keccak256 selectors (checked in the test)
export const SEL = {
  labelOf: '0xa7477464',
  humanChallenge: '0x132ca941',
  humans: '0x9a98ce27',
  proveHumanP256: '0x8d3266aa',
  agents: '0x513856c8',
  agentOfAccount: '0x0d4eea8b',
  frozen: '0x054f7d9c',
  freezeChallenge: '0x3a1bb7a6',
  freezeWithPasskey: '0x955fcb7e',
  setEmergencyKeys: '0x74c98d9c',
  pqKeyHash: '0xe10e6a89',
  passkeyX: '0x9b1ee9ad',
  remaining: '0xb399b0bc',
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  getAmountsOut: '0xd06ca61f',
  decimals: '0x313ce567',
  // VouchRegistry (the optional uniqueness level)
  vouchStatus: '0x645b8b1b',
  vouch: '0xdd66e16b',
  unvouch: '0xab43cc36',
  refresh: '0x0afb0409',
};

const strip = (h) => String(h).replace(/^0x/, '');
export const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => strip(a).toLowerCase().padStart(64, '0');
/** ABI `bytes` tail: length word + data padded to 32 bytes. */
function bytesTail(hex) {
  const h = strip(hex);
  return word(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64, '0');
}
/** The tuple (bytes authenticatorData, bytes clientDataJSON, uint256 r, uint256 s), ABI-encoded (its own head + tails). */
function assertionTuple({ authenticatorData, clientDataJSON, r, s }) {
  const a = bytesTail(authenticatorData);
  return word(128) + word(128 + a.length / 2) + word(r) + word(s) + a + bytesTail(clientDataJSON);
}

export const callAddr = (sel, a) => `${sel}${addrWord(a)}`;
export const callUint = (sel, n) => `${sel}${word(n)}`;
export const encodeProveHuman = (x, y, assertion) => `${SEL.proveHumanP256}${word(x)}${word(y)}${word(96)}${assertionTuple(assertion)}`;
export const encodeFreezeWithPasskey = (assertion) => `${SEL.freezeWithPasskey}${word(32)}${assertionTuple(assertion)}`;
export const encodeSetEmergencyKeys = (pqKeyHash, x, y, rpIdHash) => `${SEL.setEmergencyKeys}${strip(pqKeyHash).padStart(64, '0')}${word(x)}${word(y)}${strip(rpIdHash).padStart(64, '0')}`;
export const encodeApprove = (spender, amount) => `${SEL.approve}${addrWord(spender)}${word(amount)}`;
export const encodeAllowance = (owner, spender) => `${SEL.allowance}${addrWord(owner)}${addrWord(spender)}`;
export const encodeGetAmountsOut = (amountIn, path) => `${SEL.getAmountsOut}${word(amountIn)}${word(64)}${word(path.length)}${path.map(addrWord).join('')}`;

/** Words of an eth_call answer. */
export const words = (hex) => (strip(hex).match(/.{64}/g) ?? []);
export const uintAt = (hex, i = 0) => BigInt(`0x${words(hex)[i] ?? '0'}`);
export const addrAt = (hex, i = 0) => `0x${(words(hex)[i] ?? '0'.repeat(64)).slice(24)}`;
export const bytes32At = (hex, i = 0) => `0x${words(hex)[i] ?? '0'.repeat(64)}`;
/** The last element of a returned uint256[] (getAmountsOut). */
export function lastOfArray(hex) {
  const w = words(hex);
  const len = Number(BigInt(`0x${w[1] ?? '0'}`));
  return len ? BigInt(`0x${w[1 + len]}`) : 0n;
}

/** AgentRegistry.agents(id) -> the fields the page shows. */
export function decodeAgent(hex) {
  return { operator: addrAt(hex, 0), account: addrAt(hex, 1), pqKeyHash: bytes32At(hex, 2), constitution: bytes32At(hex, 3), checker: addrAt(hex, 4),
    bond: uintAt(hex, 5), unbondAt: uintAt(hex, 6), actions: uintAt(hex, 7), openClaims: uintAt(hex, 8) };
}

/** VouchRegistry.status(a) (uint256[10]) -> the fields the page shows. */
export function decodeVouchStatus(hex) {
  const n = (i) => Number(uintAt(hex, i));
  return { level: n(0), vouches: n(1), needed: n(2), uniqueSince: n(3), flags: n(4), flagsToSuspend: n(5), banned: n(6) === 1, genesis: n(7) === 1, given: n(8), nextVouchAt: n(9) };
}

// ---------------------------------------------------------------- WebAuthn
export const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const toHex = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
export const fromHex = (h) => Uint8Array.from((strip(h).match(/../g) ?? []).map((b) => parseInt(b, 16)));

/** P-256 public key (x, y) from the SPKI DER that AuthenticatorAttestationResponse.getPublicKey() returns. */
export function p256FromSpki(spki) {
  const b = new Uint8Array(spki);
  // SPKI for P-256 ends with the BIT STRING 00 04 ‖ x ‖ y (65 bytes of point)
  if (b.length < 91 || b[b.length - 65] !== 0x04) throw new Error('not an uncompressed P-256 key');
  const p = b.slice(b.length - 64);
  return { x: BigInt(toHex(p.slice(0, 32))), y: BigInt(toHex(p.slice(32))) };
}

/** (r, s) from the ASN.1 DER ECDSA signature a passkey returns. */
export function rsFromDer(der) {
  const b = new Uint8Array(der);
  if (b[0] !== 0x30) throw new Error('signature');
  let i = 2;
  if (b[1] & 0x80) i = 2 + (b[1] & 0x7f);
  const int = () => {
    if (b[i] !== 0x02) throw new Error('signature');
    const len = b[i + 1];
    const v = b.slice(i + 2, i + 2 + len);
    i += 2 + len;
    return BigInt(toHex(v.length ? v : [0]));
  };
  const r = int();
  const s = int();
  return { r, s };
}

/** sha256 of the page's host name: the rpIdHash the contracts compare (WebCrypto). */
export async function rpIdHash(host = globalThis.location?.hostname ?? '') {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(host))));
}
