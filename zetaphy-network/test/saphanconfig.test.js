// The Saphan v2 chain table (zetaphy-chain/hyperlane/saphan-chains.json) and what is derived from it:
// the relayer's whitelist and settings, its "anything to do?" gate, the hub's route list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, getAddress, Wallet } from 'ethers';
import { loadChains, chainProblems, chainOf, relayerWhitelist, hubRoutes, sortAddresses, CHAINS_FILE, messageIdMetadata,
  tokenProblems, tokenOf, tokenRouteList, hubTokenRoutes, NATIVE_ERC20 } from '../src/saphan.js';
import { relayerEnv, relayGate } from '../scripts/saphan.js';

const table = () => JSON.parse(readFileSync(CHAINS_FILE, 'utf8'));
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const routes = {
  basesepolia: { origin: { lockbox: A(0xb1), fromBlock: 500 }, zetaphy: { hyperlaneLane: A(0xb2), hyperlaneOutbox: A(0xb3), bridgedToken: A(0xb4), fromBlock: 20000 }, state: 'CLOSED' },
  arbitrumsepolia: { origin: { lockbox: A(0xa1), fromBlock: 900 }, zetaphy: { hyperlaneLane: A(0xa2), bridgedToken: A(0xa4), fromBlock: 19000 }, state: 'OPEN' },
};

test('the committed chain table is valid: Sepolia, Base Sepolia, Arbitrum Sepolia from the Hyperlane registry', () => {
  const t = loadChains();
  assert.deepEqual(Object.keys(t.chains), ['sepolia', 'basesepolia', 'arbitrumsepolia']);
  assert.deepEqual(Object.values(t.chains).map((c) => [c.chainId, c.domain]), [[11155111, 11155111], [84532, 84532], [421614, 421614]]);
  // the registry's Mailboxes (hyperlane-registry chains/<name>/addresses.yaml at the commit in `sources`)
  assert.equal(t.chains.basesepolia.mailbox, '0x6966b0E55883d49BFB24539356a2f8A673E02039');
  assert.equal(t.chains.arbitrumsepolia.mailbox, '0x598facE78a4302f11E3de0bee1894Da0b2Cb71F8');
  assert.equal(t.chains.sepolia.mailbox, '0xfFAEF09B3cd11D9b20d1a19bECca54EEC2884766');
  for (const c of Object.values(t.chains)) assert.deepEqual([c.validators, c.threshold], [['0x3c659e0fe8d01b80d7828b421630085777346e7c'], 1]);
  assert.match(t.sources.registry, /hyperlane-registry\/tree\/[0-9a-f]{40}/);
  assert.match(t.sources.validators, /hyperlane-monorepo\/blob\/[0-9a-f]{40}/);
  assert.equal(t.zetaphy.mailbox, '0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe');
  // the same ZETAPHY addresses as the core deploy (registry/chains/zetaphy/addresses.yaml)
  const core = readFileSync(new URL('../../zetaphy-chain/hyperlane/registry/chains/zetaphy/addresses.yaml', import.meta.url), 'utf8');
  for (const k of ['mailbox', 'merkleTreeHook', 'validatorAnnounce', 'staticMessageIdMultisigIsmFactory']) assert.ok(core.includes(`${k}: "${t.zetaphy[k]}"`), k);
  // and the relayer's agent config knows every source chain, with the same Mailbox
  const agent = JSON.parse(readFileSync(new URL('../../zetaphy-chain/hyperlane/agent-config.json', import.meta.url), 'utf8')).chains;
  for (const [n, c] of Object.entries(t.chains)) assert.deepEqual([agent[n]?.mailbox, agent[n]?.domainId, agent[n]?.merkleTreeHook], [c.mailbox, c.domain, c.merkleTreeHook], n);
  assert.throws(() => chainOf(t, 'mainnet'), /unknown source chain mainnet: one of sepolia, basesepolia, arbitrumsepolia/);
});

test('chain table problems are named; a broken table is refused', () => {
  const t = table();
  assert.deepEqual(chainProblems(t), []);
  t.chains.basesepolia.domain = 11155111;           // a domain twice
  t.chains.basesepolia.validators = [];
  t.chains.arbitrumsepolia.rpc = ['http://insecure'];
  t.chains.sepolia.token.symbol = 'way too long symbol';
  t.zetaphyValidators = { validators: [A(1), A(1)], threshold: 3 };
  t.chains['Bad Name'] = { ...t.chains.sepolia, chainId: 5, domain: 5 };
  const p = chainProblems(t).join('\n');
  for (const re of [/basesepolia\.domain 11155111: used twice/, /basesepolia\.validators/, /arbitrumsepolia\.rpc: https/, /sepolia\.token/, /zetaphyValidators: a validator twice/,
    /zetaphyValidators\.threshold/, /Bad Name: a name/]) assert.match(p, re);
});

test('the relayer relays only our routes: each lockbox to ZETAPHY, each outbox back to its own chain', () => {
  const t = loadChains();
  const w = relayerWhitelist(t, routes, [{ originDomain: 11155111, senderAddress: '0x' + '00'.repeat(12) + 'c0'.repeat(20), destinationDomain: 77390 }]);
  assert.deepEqual(w.slice(1), [
    { originDomain: 84532, senderAddress: '0x' + '00'.repeat(12) + A(0xb1).slice(2), destinationDomain: 77390 },
    { originDomain: 77390, senderAddress: '0x' + '00'.repeat(12) + A(0xb3).slice(2), destinationDomain: 84532 },
    { originDomain: 421614, senderAddress: '0x' + '00'.repeat(12) + A(0xa1).slice(2), destinationDomain: 77390 },
  ]);
  const env = relayerEnv(t, routes, A(0xc0), { sepoliaV1From: 4600000, zetaphyV1From: 17117 });
  assert.equal(env[0], 'HYP_RELAYCHAINS=sepolia,basesepolia,arbitrumsepolia,zetaphy');
  assert.ok(env.includes('HYP_CHAINS_BASESEPOLIA_INDEX_FROM=500') && env.includes('HYP_CHAINS_ARBITRUMSEPOLIA_INDEX_FROM=900') && env.includes('HYP_CHAINS_SEPOLIA_INDEX_FROM=4600000'));
  assert.ok(env.includes('HYP_CHAINS_ZETAPHY_INDEX_FROM=17117'));
  // with our validator running, ZETAPHY is read from the Mailbox's start (agent-config.json), not the bridge's block
  assert.ok(!relayerEnv(t, routes, A(0xc0), { sepoliaV1From: 1, zetaphyV1From: 17117, validator: true }).some((l) => l.startsWith('HYP_CHAINS_ZETAPHY_INDEX_FROM')));
  assert.throws(() => relayerEnv(t, { basesepolia: { origin: { lockbox: A(1) }, zetaphy: {} } }, null), /no start block for basesepolia/);
  assert.ok(!env.join('\n').match(/KEY|SIGNER/), 'no signer settings here');
});

/** A stand-in RPC: nonce() / received() per contract address. */
function fakeRpc(values, { down = false } = {}) {
  const iface = new Interface(['function nonce() view returns (uint256)', 'function received() view returns (uint256)',
    'function transferIds(uint256) view returns (bytes32)', 'function delivered(bytes32) view returns (bool)']);
  return {
    provider: null,
    async call(tx) {
      if (down) throw new Error('connection refused');
      const fn = iface.getFunction(tx.data.slice(0, 10)).name;
      const v = values[`${getAddress(tx.to)}:${fn}`];
      if (v == null) throw new Error(`no ${fn} at ${tx.to}`);
      return AbiCoder.defaultAbiCoder().encode([fn === 'transferIds' ? 'bytes32' : fn === 'delivered' ? 'bool' : 'uint256'], [v]);
    },
  };
}

test('relay gate: runs while a lockbox locked in the last 2 days, starts the validator only while a release waits', async () => {
  const t = loadChains();
  const now = 1_900_000_000;
  const vals = { [`${getAddress(A(0xb1))}:nonce`]: 3, [`${getAddress(A(0xb1))}:received`]: 2, [`${getAddress(A(0xa1))}:nonce`]: 0, [`${getAddress(A(0xc0))}:nonce`]: 0,
    [`${getAddress(A(0xb3))}:nonce`]: 2, [`${getAddress(A(0xb1))}:transferIds`]: '0x' + '11'.repeat(32), [`${getAddress(A(0xb2))}:delivered`]: false,
    [`${getAddress(A(0xa1))}:transferIds`]: '0x' + '22'.repeat(32), [`${getAddress(A(0xa2))}:delivered`]: false };
  const origin = fakeRpc(vals), zeta = fakeRpc(vals);
  const gate = (state, n = now, z = zeta) => relayGate({ t, routes, v1: A(0xc0), originProvider: async () => origin, zetaphyProvider: async () => z, state, now: n });
  let g = await gate(null);                                    // first run: Base's lockbox has locks, the latest not delivered: relay
  assert.deepEqual([g.run, g.validator], [true, false]);
  vals[`${getAddress(A(0xb2))}:delivered`] = true;              // it arrived: nothing to relay, though inside the window
  g = await gate(g.state, now + 600);
  assert.deepEqual([g.run, g.validator], [false, false]);
  assert.match(g.reasons.join(), /lock 2 delivered/);
  g = await gate(g.state, now + 3 * 86400);                    // nothing new for 3 days: idle
  assert.deepEqual([g.run, g.validator], [false, false]);
  vals[`${getAddress(A(0xb3))}:nonce`] = 3;                    // a send on ZETAPHY not yet recorded on Base
  g = await gate(g.state, now + 3 * 86400);
  assert.deepEqual([g.run, g.validator], [true, true]);
  assert.match(g.reasons.join(), /basesepolia: 1 release/);
  vals[`${getAddress(A(0xb1))}:received`] = 3;
  vals[`${getAddress(A(0xa1))}:nonce`] = 1;                    // a new lock on Arbitrum
  g = await gate(g.state, now + 4 * 86400);
  assert.deepEqual([g.run, g.validator], [true, false]);
  g = await gate(g.state, now + 6 * 86400 + 1);
  assert.equal(g.run, false);
  // ZETAPHY down: no validator; a source chain down: relay anyway
  vals[`${getAddress(A(0xb3))}:nonce`] = 9;
  g = await gate(g.state, now + 7 * 86400, fakeRpc({}, { down: true }));
  assert.deepEqual([g.run, g.validator], [false, false]);
  assert.match(g.reasons.join(), /outbound check failed/);
  g = await relayGate({ t, routes, v1: null, originProvider: async () => fakeRpc({}, { down: true }), zetaphyProvider: async () => zeta, state: g.state, now });
  assert.equal(g.run, true);
});

test('the hub lists every chain of the table: planned, closed or open, and which ones go both ways', () => {
  const t = loadChains();
  const h = hubRoutes(t, routes);
  assert.deepEqual(h.map((r) => [r.name, r.state, r.twoWay]), [['sepolia', 'planned', false], ['basesepolia', 'closed', true], ['arbitrumsepolia', 'open', false]]);
  assert.equal(h[1].symbol, 'baseETH');
  assert.equal(h[1].lockbox, A(0xb1));
});

test('multisig ISM validators are sorted; the metadata carries hook, root, index and one signature per signer', () => {
  assert.deepEqual(sortAddresses([A(3), A(1), A(2)]), [A(1), A(2), A(3)].map(getAddress));
  const w = Wallet.createRandom();
  const msg = '0x03' + '00000000' + '00012e4e' + '11'.repeat(32) + '00014a34' + '22'.repeat(32) + 'abcd';
  const m = messageIdMetadata(msg, [w, w], { merkleTreeHook: A(7), index: 5 });
  assert.equal((m.length - 2) / 2, 32 + 32 + 4 + 65 * 2);
  assert.equal(m.slice(2 + 128, 2 + 136), '00000005');
});

// ---------------------------------------------------------------- token routes (tokens born on ZETAPHY)

const tokenRoutes = {
  zetaphy: {
    basesepolia: { state: 'CLOSED', zetaphy: { vault: A(0xd1), fromBlock: 21000 }, destination: { synthetic: A(0xd2), fromBlock: 600 } },
    arbitrumsepolia: { state: 'OPEN', zetaphy: { vault: A(0xe1), fromBlock: 22000 }, destination: { synthetic: A(0xe2), fromBlock: 950 } },
  },
  ghost: { mainnet: { zetaphy: { vault: A(0xf1) }, destination: { synthetic: A(0xf2) } } },   // not a chain of the table: ignored
};

test('the committed token table: the native coin (its ERC-20 precompile) to all three chains; BZTPHY listed but not movable', () => {
  const t = loadChains();
  const z = tokenOf(t, 'zetaphy');
  assert.deepEqual([z.address, z.decimals, z.native, z.synthetic.symbol], [NATIVE_ERC20, 18, true, 'zZETAPHY']);
  assert.deepEqual(z.destinations, ['sepolia', 'basesepolia', 'arbitrumsepolia']);
  // the same precompile address as the genesis (setup-node.sh: erc20 native_precompiles)
  assert.ok(readFileSync(new URL('../../zetaphy-chain/setup-node.sh', import.meta.url), 'utf8').includes(`native_precompiles=[\\"${NATIVE_ERC20}\\"]`));
  const b = tokenOf(t, 'bztphy');
  // BZTPHY's address (the rewards deployment) and why it stays home (ZetaphyPoints is NonTransferable)
  assert.equal(b.address, JSON.parse(readFileSync(new URL('../../zetaphy-chain/rewards/points-testnet.json', import.meta.url), 'utf8')).points);
  assert.deepEqual([b.transferable, b.destinations], [false, []]);
  assert.ok(readFileSync(new URL('../contracts/ZetaphyPoints.sol', import.meta.url), 'utf8').includes('error NonTransferable()'));
  assert.throws(() => tokenOf(t, 'usdc'), /unknown token usdc: one of zetaphy, bztphy/);
  assert.throws(() => tokenOf(t, 'about'), /unknown token/);
});

test('token table problems are named: keys, addresses, decimals, symbols, destinations, limits, a token that cannot move', () => {
  const t = table();
  assert.deepEqual(tokenProblems(t), []);
  t.tokens.bztphy.destinations = ['basesepolia'];                             // not transferable: no destinations
  t.tokens.zetaphy.destinations = ['basesepolia', 'mainnet', 'basesepolia'];
  t.tokens.zetaphy.limits.lockCap = '1.0000000000000000001';                  // 19 decimals of an 18-decimal token
  t.tokens.zetaphy.limits.mintDelay = 31 * 86400;
  t.tokens['Bad Key'] = { ...t.tokens.zetaphy, address: 'nope', native: false, decimals: 40, synthetic: { name: '', symbol: 'baseETH' } };
  t.tokens.dup = { ...t.tokens.zetaphy, native: false, synthetic: { name: 'x', symbol: 'zZETAPHY' } };
  t.tokens.fake = { ...t.tokens.zetaphy, address: A(5), synthetic: { name: 'y', symbol: 'zFAKE' } };   // "native" but not the precompile
  const p = tokenProblems(t).join('\n');
  for (const re of [/tokens\.bztphy: not transferable, so no destinations/, /tokens\.zetaphy\.destinations: mainnet is not a chain/, /tokens\.zetaphy\.destinations: a chain twice/,
    /tokens\.zetaphy\.limits\.lockCap/, /tokens\.zetaphy\.limits\.mintDelay/, /tokens\.Bad Key: a key/, /tokens\.Bad Key\.address/, /tokens\.Bad Key\.decimals/,
    /tokens\.Bad Key\.synthetic\.symbol baseETH: used twice/, /tokens\.Bad Key\.synthetic\.name/, /tokens\.dup\.address: listed twice/, /tokens\.dup\.synthetic\.symbol zZETAPHY: used twice/,
    /tokens\.fake: native means/]) assert.match(p, re);
  assert.match(chainProblems(t).join('\n'), /tokens\.dup/);                    // part of the table check (loadChains refuses it)
  assert.deepEqual(tokenProblems({ chains: {} }), []);                         // no tokens section: fine
});

test('token routes: the relayer whitelist and settings include each vault -> its chain and each synthetic -> ZETAPHY', () => {
  const t = loadChains();
  assert.deepEqual(tokenRouteList(t, tokenRoutes).map(([k, c]) => `${k}:${c}`), ['zetaphy:basesepolia', 'zetaphy:arbitrumsepolia']);
  const w = relayerWhitelist(t, {}, [], tokenRoutes);
  const pad = (x) => '0x' + '00'.repeat(12) + x.slice(2);
  assert.deepEqual(w, [
    { originDomain: 77390, senderAddress: pad(A(0xd1)), destinationDomain: 84532 },
    { originDomain: 84532, senderAddress: pad(A(0xd2)), destinationDomain: 77390 },
    { originDomain: 77390, senderAddress: pad(A(0xe1)), destinationDomain: 421614 },
    { originDomain: 421614, senderAddress: pad(A(0xe2)), destinationDomain: 77390 },
  ]);
  const env = relayerEnv(t, routes, null, { tokenRoutes });
  assert.equal(env[0], 'HYP_RELAYCHAINS=basesepolia,arbitrumsepolia,zetaphy');
  assert.ok(env.includes('HYP_CHAINS_BASESEPOLIA_INDEX_FROM=500') && env.includes('HYP_CHAINS_ARBITRUMSEPOLIA_INDEX_FROM=900'));  // the earlier of lockbox and synthetic
  assert.ok(env.includes('HYP_CHAINS_ZETAPHY_INDEX_FROM=19000'));
  assert.equal(JSON.parse(env[1].slice('HYP_WHITELIST='.length)).length, 3 + 4);
  assert.deepEqual(relayerEnv(t, {}, null, { tokenRoutes: { zetaphy: { sepolia: tokenRoutes.zetaphy.basesepolia } } })[0], 'HYP_RELAYCHAINS=sepolia,zetaphy');
});

test('relay gate, token routes: validator while a lock waits on ZETAPHY; relayer while a send-back waits; ZETAPHY asked sparingly', async () => {
  const t = loadChains();
  const vals = {};
  const set = (addr, fn, v) => { vals[`${getAddress(addr)}:${fn}`] = v; };
  for (const [v, s] of [[0xd1, 0xd2], [0xe1, 0xe2]]) { set(A(v), 'nonce', 0); set(A(v), 'received', 0); set(A(s), 'nonce', 0); set(A(s), 'received', 0); }
  let zCalls = 0;
  const z = fakeRpc(vals);
  const zeta = { call: (tx) => { zCalls++; return z.call(tx); } };
  const gate = (state, zp = zeta) => relayGate({ t, routes: {}, tokenRoutes, v1: null, originProvider: async () => fakeRpc(vals), zetaphyProvider: async () => zp, state, now: 1_900_000_000 });
  let g = await gate(null);
  assert.deepEqual([g.run, g.validator], [false, false]);
  assert.equal(zCalls, 2);                                       // one nonce() per vault; received() not asked (nothing sent back)
  set(A(0xd1), 'nonce', 2); set(A(0xd2), 'received', 1);         // a lock on ZETAPHY not yet on Base: our validator must sign
  g = await gate(g.state);
  assert.deepEqual([g.run, g.validator], [true, true]);
  assert.match(g.reasons.join(), /zetaphy:basesepolia: 1 lock\(s\) on ZETAPHY not delivered yet/);
  set(A(0xd2), 'received', 2);
  set(A(0xe2), 'nonce', 1);                                      // a send-back on Arbitrum: Hyperlane's validator signs, the relayer delivers
  g = await gate(g.state);
  assert.deepEqual([g.run, g.validator], [true, false]);
  assert.match(g.reasons.join(), /zetaphy:arbitrumsepolia: 1 send-back\(s\) to ZETAPHY not delivered yet/);
  set(A(0xe1), 'received', 1);
  g = await gate(g.state);
  assert.deepEqual([g.run, g.validator], [false, false]);
  zCalls = 0;
  g = await gate(g.state);                                       // seen delivered: the vault's received() is not asked again
  assert.equal(zCalls, 2);
  // ZETAPHY down: no validator, nothing to do on its word; a destination down: relay anyway
  g = await gate(g.state, fakeRpc({}, { down: true }));
  assert.deepEqual([g.run, g.validator], [false, false]);
  assert.match(g.reasons.join(), /ZETAPHY check failed/);
  g = await relayGate({ t, routes: {}, tokenRoutes, v1: null, originProvider: async () => fakeRpc({}, { down: true }), zetaphyProvider: async () => zeta, state: g.state, now: 1 });
  assert.equal(g.run, true);
});

test('the hub lists every token of the table with its destinations (planned, closed, open); BZTPHY with none', () => {
  const h = hubTokenRoutes(loadChains(), tokenRoutes);
  assert.deepEqual(h.map((x) => [x.key, x.symbol, x.synthetic, x.transferable]), [['zetaphy', 'ZETAPHY', 'zZETAPHY', true], ['bztphy', 'BZTPHY', 'zBZTPHY', false]]);
  assert.deepEqual(h[0].destinations.map((d) => [d.name, d.state]), [['sepolia', 'planned'], ['basesepolia', 'closed'], ['arbitrumsepolia', 'open']]);
  assert.equal(h[0].destinations[2].token, A(0xe2));
  assert.deepEqual(h[1].destinations, []);
});
