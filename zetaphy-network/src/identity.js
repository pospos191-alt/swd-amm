// Neuro identities (ERC-8004): which chain key maps to which CAIP-2 chain id,
// and the one canonical spelling of a target, so "1 contract = 1 identity"
// holds even when people type an address differently.
//
// The registry enforces the one spelling on chain for EVM (0x + 40 lowercase
// hex), Sui/Aptos (0x + 64 lowercase hex [::module::Name]) and Solana (base58),
// and lowercase for bech32/NEAR/Starknet. It also converts the spellings that
// mean the same target: a TON friendly address (EQ…/UQ…, base64 or base64url,
// testnet flag) becomes raw `0:hex` after its CRC16 check, and a rune loses its
// spacers (• or .) and must then be A-Z. The CLI makes the same spelling here
// first, so it can show it before sending anything.

// rule: 0 = text ([A-Za-z0-9._:-] and %XX), 1 = lowercase, 2 = EVM address,
// 3 = Move (0x + 64 hex [::module::Name]), 4 = base58 (Solana),
// 5 = TON (stored raw), 6 = rune name (stored A-Z, no spacers)
export const RULE = { TEXT: 0, LOWER: 1, EVM: 2, MOVE: 3, BASE58: 4, TON: 5, RUNE: 6 };

export const NEURO_CHAINS = {
  zetaphy: { caip2: 'eip155:77390', rule: RULE.EVM },
  eth: { caip2: 'eip155:1', rule: RULE.EVM },
  bsc: { caip2: 'eip155:56', rule: RULE.EVM },
  base: { caip2: 'eip155:8453', rule: RULE.EVM },
  arbitrum: { caip2: 'eip155:42161', rule: RULE.EVM },
  sol: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', rule: RULE.BASE58 },
  sui: { caip2: 'sui:mainnet', rule: RULE.MOVE },
  aptos: { caip2: 'aptos:1', rule: RULE.MOVE },
  osmosis: { caip2: 'cosmos:osmosis-1', rule: RULE.LOWER },
  neutron: { caip2: 'cosmos:neutron-1', rule: RULE.LOWER },
  near: { caip2: 'near:mainnet', rule: RULE.LOWER },
  starknet: { caip2: 'starknet:SN_MAIN', rule: RULE.LOWER },
  bitcoin: { caip2: 'bip122:000000000019d6689c085ae165831e93', rule: RULE.RUNE },
  ton: { caip2: 'tvm:-239', rule: RULE.TON },
};

/** The chain id of ZETAPHY's EVM, which remote-claim signatures name (EIP-712 domain). */
export const ZETAPHY_EVM_CHAIN_ID = 77390n;

/** Constructor arguments for NeuroIdentity's chain list. */
export function chainArgs(chains = NEURO_CHAINS) {
  const keys = Object.keys(chains);
  return [keys, keys.map((k) => chains[k].caip2), keys.map((k) => chains[k].rule)];
}

const SAFE = /[A-Za-z0-9._:-]/;
/** Percent-encodes every byte outside [A-Za-z0-9._:-] with uppercase hex (e.g. a rune's "•"). */
function pctEncode(s) {
  let out = '';
  for (const ch of s) {
    if (SAFE.test(ch)) { out += ch; continue; }
    for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

const pad64 = (hex) => '0x' + hex.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** The canonical target for a Neuro chain key and an address as typed. Throws on bad input. */
export function canonicalTarget(chain, address) {
  const key = String(chain ?? '').trim().toLowerCase();
  const c = NEURO_CHAINS[key];
  if (!c) throw new Error(`unknown chain "${chain}" (one of: ${Object.keys(NEURO_CHAINS).join(', ')})`);
  let a = String(address ?? '').trim();
  if (!a) throw new Error('missing address');
  if (c.rule === RULE.EVM) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an EVM address: ${a}`);
    a = a.toLowerCase();
  } else if (key === 'starknet') {
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(a)) throw new Error(`not a Starknet address: ${a}`);
    a = pad64(a);
  } else if (c.rule === RULE.MOVE) {
    // 0x2::sui::SUI and 0x0000…0002::sui::SUI are the same coin type: pad the address part.
    const m = /^(0x[0-9a-fA-F]{1,64})(::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*)?$/.exec(a);
    if (!m) throw new Error(`not a ${key} address or coin type (0x…[::module::Name]): ${a}`);
    a = pad64(m[1]) + (m[2] ?? '');
  } else if (c.rule === RULE.BASE58) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) throw new Error(`not a ${key} address (base58): ${a}`);
  } else if (c.rule === RULE.LOWER) {
    a = a.toLowerCase();
  } else if (c.rule === RULE.TON) {
    a = tonRaw(a);
  } else if (c.rule === RULE.RUNE) {
    if (/^\d{1,7}:\d{1,5}$/.test(a)) throw new Error(`a rune id (${a}) is another spelling of a rune name: give the name (e.g. UNCOMMON•GOODS)`);
    const name = a.replace(/[•.]/g, '').toUpperCase();
    if (!/^[A-Z]{1,28}$/.test(name)) throw new Error(`not a rune name (letters A-Z, spacers • or . allowed): ${a}`);
    a = name;
  }
  a = c.rule === RULE.TEXT ? pctEncode(a) : a;
  if (c.rule === RULE.LOWER && !/^[a-z0-9._:-]+$/.test(a)) throw new Error(`bad characters in ${key} address: ${address}`);
  if (a.length > 128) throw new Error('address too long (max 128 characters once encoded)');
  return { chain: key, account: a, caip2: c.caip2, caip10: `${c.caip2}:${a}` };
}

function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** TON raw form `0:hex` / `-1:hex` (lowercase) of a raw or friendly address, as the registry computes it. */
export function tonRaw(s) {
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(s);
  if (raw) return `${raw[1]}:${raw[2].toLowerCase()}`;
  if (!/^[A-Za-z0-9_+/-]{48}$/.test(s)) throw new Error(`not a TON address (raw 0:hex or friendly EQ…/UQ…): ${s}`);
  const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const tag = b[0] & 0x7f;
  if (b.length !== 36 || (tag !== 0x11 && tag !== 0x51)) throw new Error(`not a TON address: ${s}`);
  if (crc16(b.subarray(0, 34)) !== b.readUInt16BE(34)) throw new Error(`TON address checksum is wrong: ${s}`);
  if (b[1] !== 0 && b[1] !== 0xff) throw new Error(`unknown TON workchain in ${s}`);
  return `${b[1] === 0xff ? '-1' : '0'}:${b.subarray(2, 34).toString('hex')}`;
}

// ------------------------------------------------------------ remote claims
// A target on another chain is claimed with NeuroIdentity.claimRemote: its
// owner there consents, and a quorum of runners attests that the consenting
// key IS the owner. Both sign the same fields.

const CLAIM_FIELDS = [
  { name: 'agentId', type: 'uint256' }, { name: 'newOwner', type: 'address' }, { name: 'target', type: 'string' },
  { name: 'ownerKey', type: 'bytes' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
];
export const CLAIM_TYPES = {
  consent: { RemoteClaimConsent: CLAIM_FIELDS },
  attestation: { RemoteClaimAttestation: CLAIM_FIELDS },
};

/** EIP-712 domain of a NeuroIdentity registry (the ERC-8004 one, shared with setAgentWallet). */
export function claimDomain(chainId, registry) {
  return { name: 'ERC8004IdentityRegistry', version: '1', chainId: BigInt(chainId), verifyingContract: registry };
}

/**
 * The text a non-EVM owner signs (e.g. with a Solana wallet's signMessage).
 * It names the same fields as the EIP-712 consent; runners check it off-chain.
 */
export function consentText({ chainId, registry, agentId, newOwner, target, ownerKey, nonce, deadline }) {
  return [
    'ZETAPHY Neuro identity claim',
    `registry: eip155:${chainId}:${String(registry).toLowerCase()}`,
    `agent: ${agentId}`,
    `target: ${target}`,
    `new owner: ${String(newOwner).toLowerCase()}`,
    `owner key: ${String(ownerKey).toLowerCase()}`,
    `nonce: ${nonce}`,
    `deadline: ${deadline}`,
  ].join('\n');
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 (Solana) -> bytes. */
export function base58Decode(s) {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error(`not base58: ${s}`);
    n = n * 58n + BigInt(v);
  }
  let hex = n === 0n ? '' : n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const lead = s.match(/^1*/)[0].length;
  return Buffer.concat([Buffer.alloc(lead), Buffer.from(hex, 'hex')]);
}

/**
 * Who controls a target on its chain, from a Neuro report (zetaphy-neuro
 * readContract): [{key: 0x-hex bytes, scheme: 'secp256k1'|'ed25519'|null, role}].
 * scheme null = Neuro reads the owner but no consent check exists for it yet.
 */
export function remoteOwners(report) {
  const out = [];
  const add = (key, scheme, role) => { if (key && !out.some((o) => o.key === key)) out.push({ key, scheme, role }); };
  const evm = (a) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a) && !/^0x0{40}$/.test(a) ? a.toLowerCase() : null);
  if (report.owner !== undefined && /^0x[0-9a-fA-F]{40}$/.test(String(report.owner ?? ''))) add(evm(report.owner), 'secp256k1', 'owner() / getOwner()');
  if (report.proxy?.admin) add(evm(report.proxy.admin), 'secp256k1', 'EIP-1967 admin');
  const sol = report.solana ?? {};
  for (const [field, role] of [['mintAuthority', 'mint authority'], ['upgradeAuthority', 'upgrade authority'], ['freezeAuthority', 'freeze authority']]) {
    if (sol[field]) add('0x' + base58Decode(sol[field]).toString('hex'), 'ed25519', role);
  }
  if (report.ton?.admin) add(report.ton.admin, null, 'jetton admin');
  if (report.cosmwasm?.admin) add(report.cosmwasm.admin, null, 'admin');
  if (report.move?.owner) add(report.move.owner, null, 'owner');
  return out;
}

/** Verifies an ed25519 signature (Solana keys) with Node's crypto. */
export async function verifyEd25519(publicKeyHex, message, signatureHex) {
  const { createPublicKey, verify } = await import('node:crypto');
  const raw = Buffer.from(publicKeyHex.replace(/^0x/, ''), 'hex');
  if (raw.length !== 32) return false;
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  try { return verify(null, Buffer.from(message), key, Buffer.from(signatureHex.replace(/^0x/, ''), 'hex')); } catch { return false; }
}

// A claim bundle (JSON file) travels owner -> runners -> submitter:
// {v, chainId, registry, agentId, target, newOwner, ownerKey, nonce, deadline, ownerSig, attestations: [{runner, sig}]}

/** The fields both signatures cover, as EIP-712 values. */
export function claimValues(b) {
  return { agentId: BigInt(b.agentId), newOwner: b.newOwner, target: b.target, ownerKey: b.ownerKey, nonce: BigInt(b.nonce), deadline: BigInt(b.deadline) };
}

/**
 * Checks a bundle against what a runner read on the target's chain.
 * @param {object} b  the bundle
 * @param {Array} owners  remoteOwners(report)
 * @param {{verifyTypedData: Function}} ethers  (injected so this file stays dependency-free)
 * @returns {Promise<{ok:true, owner:object}|{ok:false, reason:string}>}
 */
export async function checkClaimBundle(b, owners, { verifyTypedData }) {
  const key = String(b.ownerKey ?? '').toLowerCase();
  const owner = owners.find((o) => o.key.toLowerCase() === key);
  if (!owner) return { ok: false, reason: `${b.ownerKey} is not the target's owner on its chain (found: ${owners.map((o) => `${o.role} ${o.key}`).join(', ') || 'none'})` };
  if (!owner.scheme) return { ok: false, reason: `no consent check for a ${owner.role} of this chain yet` };
  if (!b.ownerSig) return { ok: false, reason: 'the owner has not signed the consent (ownerSig)' };
  if (BigInt(b.deadline) * 1000n < BigInt(Date.now())) return { ok: false, reason: 'deadline passed' };
  if (owner.scheme === 'secp256k1') {
    let who;
    try { who = verifyTypedData(claimDomain(b.chainId, b.registry), CLAIM_TYPES.consent, claimValues(b), b.ownerSig); } catch { who = null; }
    if (String(who).toLowerCase() !== key) return { ok: false, reason: 'the consent signature is not from the owner' };
  } else if (!(await verifyEd25519(key, consentText(b), b.ownerSig))) {
    return { ok: false, reason: 'the consent signature is not from the owner' };
  }
  return { ok: true, owner };
}

/** A runner's EIP-712 attestation for a bundle (ethers Wallet). */
export async function signAttestation(wallet, b) {
  return { runner: wallet.address, sig: await wallet.signTypedData(claimDomain(b.chainId, b.registry), CLAIM_TYPES.attestation, claimValues(b)) };
}

/** Attestation signatures in the order claimRemote wants: by signer address, ascending, one each. */
export function sortedAttestations(list) {
  const one = new Map();
  for (const a of list) one.set(a.runner.toLowerCase(), a.sig);
  return [...one.entries()].sort(([x], [y]) => (BigInt(x) < BigInt(y) ? -1 : 1)).map(([, sig]) => sig);
}

/** Decodes a `data:application/json;base64,` agentURI; returns null for other URIs. */
export function decodeAgentURI(uri) {
  const p = 'data:application/json;base64,';
  if (typeof uri !== 'string' || !uri.startsWith(p)) return null;
  return JSON.parse(Buffer.from(uri.slice(p.length), 'base64').toString('utf8'));
}
