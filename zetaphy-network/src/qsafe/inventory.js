// The quantum-exposure inventory of the ZETAPHY stack (docs/future/quantum-safe-settlement.md, section 2):
// every place the stack still relies on classical public-key crypto, what happens to it on Q-day (the day a
// quantum computer can derive secp256k1 / Ed25519 / P-256 / BN254 secrets from public data), what protects it
// today, and the migration step. Machine-checkable: test/qsafe-inventory.test.js validates every row, checks that
// each `refs` path exists in the repo, and that the doc's table is exactly toMarkdownTable().
// Pure data + pure functions: no Node-only imports (the hub's build reads it, zetaphy-hub/build.mjs).

/** status: how far the component is from needing classical crypto. */
export const STATUS = {
  pq: 'post-quantum (hash-based or ML-DSA / ML-KEM only)',
  hybrid: 'classical and post-quantum together: safe if either holds',
  partial: 'a post-quantum path exists, but classical keys still guard part of it',
  classical: 'classical only',
};
/** impact: what an attacker gains on Q-day if the row stays as it is (the weight of the row in the score). */
export const IMPACT = { critical: 5, high: 3, medium: 2, low: 1 };
const CREDIT = { pq: 1, hybrid: 0.8, partial: 0.4, classical: 0 };
export const LAYERS = ['consensus', 'accounts', 'contracts', 'governance', 'bridge', 'interop', 'wallets', 'transport', 'infra'];

/**
 * One row per component. Fields:
 *   id, component, layer, crypto (the classical primitive, or the PQ one), status, impact,
 *   hndl (true when harvest-now-decrypt-later applies: recorded traffic or data could be read later),
 *   risk (what Q-day breaks), mitigation (what exists today), migration (the next step),
 *   refs (repo paths that exist; checked), related (other agents' planned work; not checked)
 */
export const INVENTORY = [
  {
    id: 'consensus-votes', component: 'CometBFT block votes', layer: 'consensus', crypto: 'Ed25519 + ML-DSA-44 vote extensions',
    status: 'hybrid', impact: 'critical', hndl: false,
    risk: 'Forged Ed25519 precommits could commit a fork that a classical-only verifier accepts.',
    mitigation: 'Every vote carries an ML-DSA-44 signature; block H+1 carries the ML-DSA certificate of H (MsgPQCertificate), checked by every node and by `zetaphy pq verify-block`.',
    migration: 'Keep >2/3 of voting power registered (gov.sh vote-key); refuse to run Q-day while it is lower.',
    refs: ['zetaphy-chain/README.md', 'zetaphy-network/src/pqcert.js', 'zetaphy-chain/test-vote-keys.sh'],
  },
  {
    id: 'double-sign-evidence', component: 'Double-sign evidence and slashing', layer: 'consensus', crypto: 'Ed25519',
    status: 'partial', impact: 'high', hndl: false,
    risk: 'Forged Ed25519 "double signs" could slash honest validators.',
    mitigation: 'gov.sh pq-evidence on: no slashing on Ed25519 evidence alone for validators with an ML-DSA key (off by default).',
    migration: 'Vote pq-evidence on with the Q-day proposal; ML-DSA evidence needs the round in CometBFT\'s PQ signing (upstream).',
    refs: ['zetaphy-chain/README.md', 'zetaphy-chain/gov.sh'],
  },
  {
    id: 'validator-remote-signer', component: 'Validator key and remote signer (horcrux)', layer: 'consensus', crypto: 'Ed25519 (threshold)',
    status: 'partial', impact: 'medium', hndl: false,
    risk: 'The consensus key can be derived from its public key; threshold signing does not help against that.',
    mitigation: 'The PQ certificate rule needs the separate ML-DSA vote key (config/pq_vote_key.seed).',
    migration: 'Back up and rotate pq_vote_key.seed with the validator key; native ML-DSA consensus keys when CometBFT supports them.',
    refs: ['zetaphy-chain/horcrux/README.md'],
  },
  {
    id: 'p2p-transport', component: 'CometBFT peer-to-peer links', layer: 'transport', crypto: 'X25519 + Ed25519 node keys (SecretConnection)',
    status: 'classical', impact: 'medium', hndl: true,
    risk: 'Node identities can be impersonated (eclipse a node); recorded traffic can be decrypted later (mostly public blocks, but also tx propagation timing).',
    mitigation: 'Sentry topology; blocks are PQ-certified, so a fake peer cannot feed a forged chain to a node.',
    migration: 'Hybrid X25519+ML-KEM-768 handshake upstream, or validator links over WireGuard with a post-quantum pre-shared key until then.',
    refs: ['zetaphy-chain/join-validator.sh'],
  },
  {
    id: 'evm-accounts', component: 'secp256k1 accounts (MetaMask, Cosmos eth_secp256k1)', layer: 'accounts', crypto: 'secp256k1 ECDSA',
    status: 'partial', impact: 'critical', hndl: false,
    risk: 'Any account whose public key is on chain (it signed once) can be drained by deriving its key.',
    mitigation: 'Q-day rule refuses ECDSA from a voted height; quantum lock to an ML-DSA-44 account; commit–reveal for never-used keys; QuantumRescue pre-commitments for used keys; explorer exposure page.',
    migration: 'Lock or pre-commit now (hub "Quantum safety" tab); governance schedules Q-day months ahead; MsgQDayRescue (designed) turns rescues into locks.',
    refs: ['docs/SECURITY-CORE.md', 'zetaphy-network/src/pqtx.js', 'zetaphy-network/contracts/QuantumRescue.sol', 'zetaphy-explorer/src/quantum.js'],
  },
  {
    id: 'native-pq-accounts', component: 'Native ML-DSA-44 accounts', layer: 'accounts', crypto: 'ML-DSA-44 (FIPS 204)',
    status: 'pq', impact: 'critical', hndl: false,
    risk: 'None known from quantum computers.',
    mitigation: 'Cosmos txs signed with ML-DSA-44 only; MsgEVMCall gives them the whole EVM.',
    migration: 'Done. Consider ML-DSA-65 for long-lived treasuries.',
    refs: ['zetaphy-network/src/pqtx.js', 'zetaphy-network/src/pq.js'],
  },
  {
    id: 'validator-operators', component: 'Validator operator accounts', layer: 'accounts', crypto: 'secp256k1 ECDSA',
    status: 'partial', impact: 'high', hndl: false,
    risk: 'After Q-day an unlocked operator cannot sign staking or governance messages.',
    mitigation: 'gov.sh quantum-lock; the controller manages the validator through MsgEVMCall as_owner and MsgPQVoteKey validator_owner.',
    migration: 'All operators locked before the Q-day vote.',
    refs: ['zetaphy-chain/gov.sh', 'docs/SECURITY-CORE.md'],
  },
  {
    id: 'contract-ecrecover', component: 'Signatures checked inside contracts (permit, cheques, offline orders, EIP-712)', layer: 'contracts', crypto: 'secp256k1 ecrecover',
    status: 'partial', impact: 'high', hndl: false,
    risk: 'Forged permits and off-chain orders.',
    mitigation: 'From Q-day the chain makes ecrecover return no address (fails safe: the feature stops).',
    migration: 'PQ variants: PQSettlement for payments, QuantumWallet for actions; ML-DSA-signed cheques/orders next.',
    refs: ['zetaphy-network/contracts/ZetaphyCheques.sol', 'zetaphy-network/contracts/ZetaphyOfflineOrders.sol', 'zetaphy-network/contracts/PQSettlement.sol'],
  },
  {
    id: 'passkeys-p256', component: 'Passkeys (WebAuthn, P-256 precompile 0x…0100)', layer: 'contracts', crypto: 'P-256 ECDSA',
    status: 'classical', impact: 'medium', hndl: false,
    risk: 'Forged passkey assertions.',
    mitigation: 'The chain disables P-256 verification at Q-day (fails safe); passkeys are second factors next to ML-DSA in AgentPolicyWallet.',
    migration: 'Wait for PQ WebAuthn (FIDO ML-DSA); keep ML-DSA as the primary key.',
    refs: ['zetaphy-network/contracts/WebAuthnVerifier.sol'],
  },
  {
    id: 'frost-cosign', component: 'FROST threshold Schnorr (agent co-signing)', layer: 'contracts', crypto: 'secp256k1 Schnorr',
    status: 'classical', impact: 'medium', hndl: false,
    risk: 'The group key can be derived; the co-signing committee can be impersonated.',
    mitigation: 'Used as an extra check next to the owner\'s key, not alone.',
    migration: 'ML-DSA threshold (or t-of-n ML-DSA multisig like PQMultisigIsm).',
    refs: ['zetaphy-network/src/frost.js', 'zetaphy-network/src/cosign.js'],
  },
  {
    id: 'zk-groth16', component: 'Groth16 proofs (NeuroScore zk, trusted-setup ceremony)', layer: 'contracts', crypto: 'BN254 pairings',
    status: 'classical', impact: 'medium', hndl: false,
    risk: 'Discrete logs on BN254 let anyone forge proofs (soundness, not privacy, is lost).',
    mitigation: 'Proofs gate scores and optional features, not custody.',
    migration: 'Hash-based STARK proofs (the STARK light-client work), FRI verifiers on ZETAPHY.',
    refs: ['zetaphy-network/contracts/NeuroScoreVerifier.sol', 'zetaphy-hub/ceremony-core.js'],
    related: ['zetaphy-network/src/starklc', 'zetaphy-lightclient'],
  },
  {
    id: 'governance-signers', component: 'Timelock and multisig signers', layer: 'governance', crypto: 'secp256k1 ECDSA (EOA owners)',
    status: 'partial', impact: 'critical', hndl: false,
    risk: 'Admin keys of the timelock / SimpleMultisig can be derived: upgrades, parameter changes, treasury.',
    mitigation: 'Owners can be QuantumWallets or native PQ accounts (msg.sender = their 0x address); locked EOAs act through their controller.',
    migration: 'Replace every EOA owner with a PQ account before Q-day; the inventory test keeps this row partial until then.',
    refs: ['zetaphy-network/contracts/ZetaphyTimelock.sol', 'zetaphy-network/contracts/SimpleMultisig.sol', 'zetaphy-network/contracts/QuantumWallet.sol'],
  },
  {
    id: 'ibc-light-clients', component: 'IBC light clients (both directions)', layer: 'interop', crypto: 'Ed25519 (07-tendermint)',
    status: 'classical', impact: 'high', hndl: false,
    risk: 'A counterparty light client of ZETAPHY checks only Ed25519: forged headers could mint IBC vouchers there; and the reverse here.',
    mitigation: 'IBC rate limits and the IBC hold (large inbound transfers wait, guardian can refund).',
    migration: 'A client that checks ZETAPHY\'s ML-DSA certificates (08-wasm) or a STARK proof of them (STARK light client).',
    refs: ['zetaphy-chain/ibc/README.md', 'docs/SECURITY-CORE.md'],
    related: ['zetaphy-network/src/starklc', 'zetaphy-lightclient'],
  },
  {
    id: 'ibc-relayer', component: 'IBC relayer (Hermes) key', layer: 'interop', crypto: 'secp256k1 ECDSA',
    status: 'classical', impact: 'medium', hndl: false,
    risk: 'After Q-day it cannot submit; IBC stops (liveness, not funds).',
    mitigation: 'Q-day should not be scheduled while IBC depends on it (docs/SECURITY-CORE.md).',
    migration: 'A relayer that signs with ML-DSA-44 (pqtx.js buildTx).',
    refs: ['zetaphy-chain/ibc/setup-relayer.sh'],
  },
  {
    id: 'hyperlane-ism', component: 'Hyperlane ISM validators (Saphan bridge)', layer: 'bridge', crypto: 'secp256k1 ECDSA multisig',
    status: 'partial', impact: 'critical', hndl: false,
    risk: 'Forged validator checkpoints release or mint bridged assets.',
    mitigation: 'BridgeAirlock quarantine, BridgeGuard caps, the chain\'s bridge breaker; PQMultisigIsm (ML-DSA validators) is ready for ZETAPHY-side delivery.',
    migration: 'Aggregation ISM (ECDSA AND ML-DSA) inbound now, ML-DSA only at Q-day; outbound to chains without ML-DSA via a STARK-wrapped attestation.',
    refs: ['zetaphy-network/contracts/PQMultisigIsm.sol', 'zetaphy-network/contracts/HyperlaneLane.sol', 'zetaphy-network/contracts/BridgeAirlock.sol', 'zetaphy-chain/hyperlane/README.md'],
  },
  {
    id: 'hyperlane-relayer', component: 'Hyperlane relayer and agents\' submit keys', layer: 'bridge', crypto: 'secp256k1 ECDSA',
    status: 'classical', impact: 'low', hndl: false,
    risk: 'A derived relayer key can spend its gas balance; messages still need the ISM.',
    mitigation: 'Relayers are untrusted for safety; small gas balances.',
    migration: 'Submit through a native PQ account (MsgEVMCall) on ZETAPHY.',
    refs: ['zetaphy-chain/hyperlane/setup-agents.sh'],
  },
  {
    id: 'remote-chain-custody', component: 'Assets locked on Ethereum / BNB (lockboxes)', layer: 'bridge', crypto: 'the remote chain\'s ECDSA',
    status: 'classical', impact: 'high', hndl: false,
    risk: 'Locked collateral is only as safe as the remote chain and its admin keys.',
    mitigation: 'Caps per route; inbound migration moves value to PQ accounts on ZETAPHY.',
    migration: 'The "move to a PQ account on ZETAPHY" flow; remote admins behind PQ-signed (STARK-verified) governance.',
    refs: ['zetaphy-network/contracts/HyperlaneLockBoxV2.sol', 'docs/SAPHAN-MULTICHAIN.md'],
  },
  {
    id: 'oracles', component: 'Price oracles (Pyth relay, ZetaphyOracle reporters)', layer: 'interop', crypto: 'secp256k1 (Wormhole guardians, reporter EOAs)',
    status: 'classical', impact: 'high', hndl: false,
    risk: 'Forged prices drain markets that read them.',
    mitigation: 'TWAP and bounds where used.',
    migration: 'Reporters as PQ accounts; guardian-signed feeds only through a PQ attestation (pqattest.js style).',
    refs: ['zetaphy-network/contracts/ZetaphyPythRelay.sol', 'zetaphy-network/contracts/ZetaphyOracle.sol'],
  },
  {
    id: 'pq-web-wallet', component: 'ZETAPHY web wallet (ML-DSA-44 in the browser)', layer: 'wallets', crypto: 'ML-DSA-44',
    status: 'pq', impact: 'high', hndl: false,
    risk: 'None from quantum computers (browser compromise is the classical risk).',
    mitigation: 'Seeds sealed with scrypt + AES-256-GCM.',
    migration: 'Done.',
    refs: ['zetaphy-wallet/README.md', 'zetaphy-wallet/src'],
  },
  {
    id: 'snap', component: 'ZETAPHY Snap (ML-DSA keys inside MetaMask)', layer: 'wallets', crypto: 'ML-DSA-44 from SIP-6 entropy',
    status: 'pq', impact: 'high', hndl: false,
    risk: 'None from quantum computers: the key comes from hashing the recovery phrase, not from a curve.',
    mitigation: 'Recoverable from the MetaMask recovery phrase.',
    migration: 'Publish after MetaMask review.',
    refs: ['zetaphy-snap/src/account.js'],
  },
  {
    id: 'injected-wallets', component: 'MetaMask / injected EIP-1193 wallets in the dapps', layer: 'wallets', crypto: 'secp256k1 ECDSA',
    status: 'classical', impact: 'high', hndl: false,
    risk: 'Everything signed with them is forgeable once the key is exposed.',
    mitigation: 'The hub warns per address (exposure), and offers lock / rescue.',
    migration: 'Route signing through the Snap or the PQ web wallet; QuantumWallet for contract accounts.',
    refs: ['zetaphy-hub/walletbar.js'],
  },
  {
    id: 'tls', component: 'HTTPS for RPC, explorer, hub (TLS)', layer: 'transport', crypto: 'ECDHE (X25519) + ECDSA/RSA certificates',
    status: 'partial', impact: 'medium', hndl: true,
    risk: 'Recorded RPC traffic (who queried which address) can be decrypted later; certificates can be forged after Q-day.',
    mitigation: 'Modern browsers and hosts already negotiate hybrid X25519MLKEM768 key exchange where both sides support it.',
    migration: 'Require hybrid ML-KEM at our reverse proxies; PQ certificates when the Web PKI has them; wallets verify data, not TLS.',
    refs: ['zetaphy-hub/vercel.json', 'zetaphy-chain/setup-node.sh'],
  },
  {
    id: 'mempool-privacy', component: 'Pending transactions (mempool)', layer: 'transport', crypto: 'none (public)',
    status: 'classical', impact: 'low', hndl: true,
    risk: 'Front-running; with an encrypted mempool, harvest-now-decrypt-later if its KEM is classical.',
    mitigation: 'Threat gate and wallet checks.',
    migration: 'The ML-KEM encrypted mempool (another workstream).',
    refs: ['docs/SECURITY-CORE.md'],
    related: ['zetaphy-network/src/encmempool'],
  },
  {
    id: 'keys-at-rest', component: 'Keys at rest (CLI seeds, wallet vaults)', layer: 'infra', crypto: 'scrypt + AES-256-GCM',
    status: 'pq', impact: 'medium', hndl: true,
    risk: 'Grover halves symmetric strength: AES-256 keeps ~128-bit security.',
    mitigation: 'AES-256 (not AES-128) everywhere.',
    migration: 'Done; keep passphrases long.',
    refs: ['zetaphy-network/src/keys.js'],
  },
  {
    id: 'release-integrity', component: 'Node install and release integrity', layer: 'infra', crypto: 'SHA-256 pins (+ GitHub SSH/TLS)',
    status: 'hybrid', impact: 'high', hndl: false,
    risk: 'Forged TLS/SSH could serve a different script, but the pinned SHA-256 refuses it.',
    mitigation: 'cloud-init.sh runs setup-node.sh only when its SHA-256 matches; content-addressed files.',
    migration: 'Hash-based (SLH-DSA) release signatures when tooling supports them.',
    refs: ['zetaphy-chain/cloud-init.sh'],
  },
  {
    id: 'pq-attestations', component: 'Reports and AI attestations', layer: 'infra', crypto: 'ML-DSA-44',
    status: 'pq', impact: 'low', hndl: false,
    risk: 'None from quantum computers.',
    mitigation: 'pqattest archives signed with ML-DSA.',
    migration: 'Done.',
    refs: ['zetaphy-network/src/pqattest.js'],
  },
  {
    id: 'pq-settlement', component: 'Settlement of payments (PQSettlement)', layer: 'contracts', crypto: 'ML-DSA-44',
    status: 'pq', impact: 'critical', hndl: false,
    risk: 'None from quantum computers; finality relies on the PQ block certificate rule.',
    mitigation: 'Only ML-DSA signatures move balances; batch digests settle once.',
    migration: 'Deploy on testnet; stablecoins route through it.',
    refs: ['zetaphy-network/contracts/PQSettlement.sol', 'zetaphy-network/src/qsafe/settlement.js'],
  },
];

const REQUIRED = ['id', 'component', 'layer', 'crypto', 'status', 'impact', 'risk', 'mitigation', 'migration'];

/** Problems with the inventory (empty = valid). `exists(path)` checks refs (omit to skip that check). */
export function checkInventory(items = INVENTORY, exists = null) {
  const out = [];
  const ids = new Set();
  for (const [i, it] of items.entries()) {
    const at = `row ${i} (${it?.id ?? '?'})`;
    for (const k of REQUIRED) if (typeof it?.[k] !== 'string' || !it[k].trim()) out.push(`${at}: ${k} missing`);
    if (it?.id && !/^[a-z0-9-]+$/.test(it.id)) out.push(`${at}: id must be kebab-case`);
    if (ids.has(it?.id)) out.push(`${at}: duplicate id`);
    ids.add(it?.id);
    if (!(it?.status in STATUS)) out.push(`${at}: status ${it?.status}`);
    if (!(it?.impact in IMPACT)) out.push(`${at}: impact ${it?.impact}`);
    if (!LAYERS.includes(it?.layer)) out.push(`${at}: layer ${it?.layer}`);
    if (typeof it?.hndl !== 'boolean') out.push(`${at}: hndl must be true/false`);
    if (!Array.isArray(it?.refs) || it.refs.length === 0) out.push(`${at}: refs missing`);
    else if (exists) for (const r of it.refs) if (!exists(r)) out.push(`${at}: ref ${r} does not exist`);
    if (it?.status !== 'pq' && /^done\b/i.test(String(it?.migration ?? ''))) out.push(`${at}: not pq, but the migration says done`);
  }
  return out;
}

/** The network's Q-day readiness, 0-100: impact-weighted credit per status (pq 1, hybrid 0.8, partial 0.4, classical 0). */
export function readinessScore(items = INVENTORY) {
  let w = 0, got = 0;
  for (const it of items) {
    const k = IMPACT[it.impact] ?? 0;
    w += k;
    got += k * (CREDIT[it.status] ?? 0);
  }
  return w ? Math.round((100 * got) / w) : 0;
}

/** Counts per status and per layer, the score, and the open (non-pq) rows by impact, for the CLI and the hub. */
export function summary(items = INVENTORY) {
  const byStatus = Object.fromEntries(Object.keys(STATUS).map((s) => [s, 0]));
  const byLayer = {};
  for (const it of items) {
    byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
    byLayer[it.layer] ??= { total: 0, pq: 0 };
    byLayer[it.layer].total += 1;
    if (it.status === 'pq' || it.status === 'hybrid') byLayer[it.layer].pq += 1;
  }
  const open = items.filter((it) => it.status !== 'pq')
    .sort((a, b) => IMPACT[b.impact] - IMPACT[a.impact] || CREDIT[a.status] - CREDIT[b.status] || a.id.localeCompare(b.id))
    .map((it) => ({ id: it.id, component: it.component, layer: it.layer, status: it.status, impact: it.impact, migration: it.migration }));
  return { score: readinessScore(items), total: items.length, byStatus, byLayer, open };
}

const cell = (s) => String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');
/** The doc's table (docs/future/quantum-safe-settlement.md keeps exactly this between its inventory markers). */
export function toMarkdownTable(items = INVENTORY) {
  const head = '| id | Component | Crypto | Status | Q-day impact | HNDL | Today | Migration |\n|---|---|---|---|---|---|---|---|';
  const rows = items.map((it) => `| \`${it.id}\` | ${cell(it.component)} | ${cell(it.crypto)} | ${it.status} | ${it.impact} | ${it.hndl ? 'yes' : 'no'} | ${cell(it.mitigation)} | ${cell(it.migration)} |`);
  return [head, ...rows].join('\n');
}

export const TABLE_BEGIN = '<!-- qsafe-inventory:begin (generated from zetaphy-network/src/qsafe/inventory.js; do not edit by hand) -->';
export const TABLE_END = '<!-- qsafe-inventory:end -->';
