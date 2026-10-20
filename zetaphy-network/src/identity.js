// Neuro identities (ERC-8004): which chain key maps to which CAIP-2 chain id,
// and the one canonical spelling of a target, so "1 contract = 1 identity"
// holds even when people type an address differently.
//
// The registry enforces the strict form for EVM chains (0x + 40 lowercase hex)
// and lowercase for bech32/NEAR/Starknet; for the other chains it takes the
// spelling the CLI makes here.

// rule: 0 = text ([A-Za-z0-9._:-] and %XX), 1 = lowercase, 2 = EVM address
export const RULE = { TEXT: 0, LOWER: 1, EVM: 2 };

export const NEURO_CHAINS = {
  zetaphy: { caip2: 'eip155:77390', rule: RULE.EVM },
  eth: { caip2: 'eip155:1', rule: RULE.EVM },
  bsc: { caip2: 'eip155:56', rule: RULE.EVM },
  base: { caip2: 'eip155:8453', rule: RULE.EVM },
  arbitrum: { caip2: 'eip155:42161', rule: RULE.EVM },
  sol: { caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', rule: RULE.TEXT },
  sui: { caip2: 'sui:mainnet', rule: RULE.TEXT },
  aptos: { caip2: 'aptos:1', rule: RULE.TEXT },
  osmosis: { caip2: 'cosmos:osmosis-1', rule: RULE.LOWER },
  neutron: { caip2: 'cosmos:neutron-1', rule: RULE.LOWER },
  near: { caip2: 'near:mainnet', rule: RULE.LOWER },
  starknet: { caip2: 'starknet:SN_MAIN', rule: RULE.LOWER },
  bitcoin: { caip2: 'bip122:000000000019d6689c085ae165831e93', rule: RULE.TEXT },
  ton: { caip2: 'tvm:-239', rule: RULE.TEXT },
};

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
  } else if (key === 'sui' || key === 'aptos') {
    // 0x2::sui::SUI and 0x0000…0002::sui::SUI are the same coin type: pad the address part.
    const m = /^(0x[0-9a-fA-F]{1,64})(::.*)?$/.exec(a);
    if (m) a = pad64(m[1]) + (m[2] ?? '');
  } else if (c.rule === RULE.LOWER) {
    a = a.toLowerCase();
  }
  a = c.rule === RULE.TEXT ? pctEncode(a) : a;
  if (c.rule === RULE.LOWER && !/^[a-z0-9._:-]+$/.test(a)) throw new Error(`bad characters in ${key} address: ${address}`);
  if (a.length > 128) throw new Error('address too long (max 128 characters once encoded)');
  return { chain: key, account: a, caip2: c.caip2, caip10: `${c.caip2}:${a}` };
}

/** Decodes a `data:application/json;base64,` agentURI; returns null for other URIs. */
export function decodeAgentURI(uri) {
  const p = 'data:application/json;base64,';
  if (typeof uri !== 'string' || !uri.startsWith(p)) return null;
  return JSON.parse(Buffer.from(uri.slice(p.length), 'base64').toString('utf8'));
}
