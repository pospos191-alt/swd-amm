// A Saphan EVM route with its Gateways, as in test/saphangateway.test.js (one EVM plays every chain; each chain has
// its own Mailbox), shared by the Saphan PR 5 tests. Accounts the chain must have: gov, guardian, relayer, lane2,
// odeploy, gdeploy, executor.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256 } from 'ethers';
import { kitArtifacts, tokenKitArtifacts, messageIdMetadata, validator } from './hyperlanekit.js';
import { compileHelper } from './starkbridge.js';

export const ZETAPHY = 77390;
export const SEPOLIA = 11155111;
export const BASE = 84532;
export const CHAIN = 1n;          // block.chainid of the test EVM: every source chain's id here
export const Q = 600;
export const DELAY = 3600;
export const E = 10n ** 18n;
export const ZERO = '0x' + '00'.repeat(20);
const ROUTE_IN = encodeBytes32String('airlock');
const ROUTE_OUT = encodeBytes32String('out');
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
export const b32 = (x) => zeroPadValue(x, 32);
export const artifact = (n) => JSON.parse(readFileSync(new URL(`../../artifacts/${n}.json`, import.meta.url), 'utf8'));
export const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
/** An artifact whose ABI also knows other contracts' errors and events (to decode what they emit inside a call). */
export const withAbi = (name, ...more) => {
  const x = artifact(name);
  const extra = more.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error' || f.type === 'event'));
  const seen = new Set();
  const abi = [...x.abi, ...extra].filter((f) => { const k = `${f.type}:${f.name}:${JSON.stringify(f.inputs ?? [])}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { abi, bytecode: x.bytecode };
};
export const TOKEN = new Interface(artifact('BridgedToken').abi);
export const HYP = validator(1);
export const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
export const pr5Kit = () => compileHelper('SaphanPr5Kit.sol');
export { kitArtifacts, tokenKitArtifacts, messageIdMetadata };

/** The ZETAPHY Mailbox and a route builder for chain `c`. */
export async function saphanWorld(c) {
  const kit = kitArtifacts();
  const a = (n) => c.acct[n].toString();
  const mailboxArt = { abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock', 'SaphanReads', 'SaphanIntents')], bytecode: kit.KitMailbox.bytecode };
  const zMailbox = await c.deployRaw(mailboxArt, [ZETAPHY], 'gov');
  const w = { kit, zMailbox, a };
  /** Another chain's Mailbox (a chain with no route, e.g. where intents are filled). */
  w.newMailbox = (domain) => c.deployRaw(mailboxArt, [domain], 'gov');

  /** A route from source chain `domain` (its Mailbox, lockbox, guard, airlock, lane, outbox) and both Gateways. */
  w.route = async (domain, { symbol = 'sepETH', zetaphyChainId = CHAIN } = {}) => {
    const r = { domain };
    r.mailbox = await c.deployRaw(mailboxArt, [domain], 'gov');
    r.guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
    await r.guard.send('gov', 'createToken', [`ETH from ${domain} (bridged, testnet)`, symbol, 18]);
    r.token = await r.guard.call('token');
    r.airlock = await c.deploy('BridgeAirlock', [r.guard.address, ROUTE_IN, a('gov'), 2, Q], 'gov');
    r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
    r.lane = await c.deploy('HyperlaneLane', [r.airlock.address, a('gov'), zMailbox.address, domain, '0x' + '00'.repeat(32), 0, ZERO, r.hypIsm.address], 'gov');
    r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [OURS.map((v) => v.address), 2], 'odeploy');
    const lbAt = getCreateAddress({ from: a('odeploy'), nonce: await c.nonce('odeploy') });
    r.outbox = await c.deployRaw(withAbi('HyperlaneOutbox', 'BridgeGuard'), [r.guard.address, ROUTE_OUT, zMailbox.address, domain, CHAIN, b32(lbAt), ZERO], 'gov');
    r.lockbox = await c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
      r.ourIsm.address, a('gov'), a('guardian'), 5n * E, DELAY], 'odeploy');
    assert.equal(r.lockbox.address.toLowerCase(), lbAt.toLowerCase());
    await r.lane.send('gov', 'setConfig', [zMailbox.address, domain, b32(r.lockbox.address), CHAIN, r.lockbox.address]);
    await r.airlock.send('gov', 'setLane', [r.lane.address, true]);
    await r.airlock.send('gov', 'setLane', [a('lane2'), true]);
    await r.guard.send('gov', 'setAudit', AUDIT);
    await r.guard.send('gov', 'setGuardian', [a('guardian'), true]);
    await r.guard.send('gov', 'setRoute', [ROUTE_IN, r.airlock.address, 100n * E, true]);
    await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, 100n * E, true]);
    r.zgw = await c.deployRaw(withAbi('ZetaphyGateway', 'BridgeAirlock', 'BridgeGuard'), [r.token, r.outbox.address, r.airlock.address, r.lockbox.address, CHAIN], 'gdeploy');
    r.sgw = await c.deployRaw(withAbi('SaphanSourceGateway', 'HyperlaneLockBoxV2'), [r.lockbox.address, r.zgw.address, r.token, zetaphyChainId], 'gdeploy');
    await r.zgw.send('gdeploy', 'setRemote', [r.sgw.address]);
    r.bal = (who) => c.callAt(r.token, TOKEN, 'balanceOf', [who.startsWith('0x') ? who : a(who)]);
    r.tok = (from, fn, args) => c.rawTx(from, r.token, TOKEN.encodeFunctionData(fn, args));
    return r;
  };

  /** Relays the last message of a source chain's Mailbox to ZETAPHY (signed by Hyperlane's validator). */
  w.relayIn = async (mailbox) => { const m = await mailbox.call('lastMessage'); return zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP]), m]); };
  w.lastMessage = (mailbox) => mailbox.call('lastMessage');
  w.process = (m, signers = [HYP]) => zMailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]);
  /** Relays ZETAPHY's last message to the route's lockbox (signed by our validators). */
  w.relayOut = async (r) => { const m = await zMailbox.call('lastMessage'); return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, OURS.slice(0, 2)), m]); };
  w.lastRelease = async () => { const m = await zMailbox.call('lastMessage'); return keccak256('0x' + m.slice(2 + 77 * 2)); };

  /** `who` calls depositAndCall on X; the lock is relayed, the other lane attests, the quarantine passes. */
  w.depositAndCall = async (r, target, { amount = E, fee = 0n, gas = 500_000n, revertTo = ZERO, abortTo = ZERO, data = '0x', who = 'alice' } = {}) => {
    const quote = await r.sgw.call('quoteDeposit', [amount]);
    const ev = await r.sgw.send(who, 'depositAndCall', [target, data, amount, fee, gas, revertTo, false, abortTo, '0x'], amount + quote);
    const d = ev.find((e) => e?.name === 'DepositAndCall').args;
    const n = (await r.lockbox.call('nonce')) - 1n;
    await w.relayIn(r.mailbox);
    await r.airlock.send('lane2', 'attest', [CHAIN, r.lockbox.address, n, r.sgw.address, d.depositAddress, amount]);
    c.advance(Q);
    return { p: d.call.toArray(true), n, at: d.depositAddress, hash: d.callHash };
  };

  /** Bridges `amount` of the route's ETH to `who` on ZETAPHY (a plain lock, both lanes, quarantine). */
  w.bridgeIn = async (r, who, amount) => {
    const fee = await r.lockbox.call('quoteLock', [a(who), amount]);
    await r.lockbox.send(who, 'lock', [a(who), amount], amount + fee);
    const n = (await r.lockbox.call('nonce')) - 1n;
    await w.relayIn(r.mailbox);
    const t = [CHAIN, r.lockbox.address, n, a(who), a(who), amount];
    await r.airlock.send('lane2', 'attest', t);
    c.advance(Q);
    await r.airlock.send('relayer', 'release', t);
  };
  return w;
}
