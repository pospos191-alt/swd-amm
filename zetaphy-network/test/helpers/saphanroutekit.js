// One full Saphan EVM route in the in-memory EVM (as test/saphan.test.js and saphansafety.test.js build it): the
// source chain's HyperlaneLockBoxV2 behind OUR validators' ISM, and on ZETAPHY the HyperlaneLane, the airlock (two
// lanes), the guard and its token, the outbox. One EVM plays both chains; each has its own Mailbox (HyperlaneKit).
// Used by the Saphan PR 6 tests (offline transfers, the route property test).
import { readFileSync } from 'node:fs';
import { AbiCoder, encodeBytes32String, zeroPadValue, getCreateAddress, keccak256 } from 'ethers';
import { createChain } from './evm.js';
import { kitArtifacts, messageIdMetadata, validator } from './hyperlanekit.js';

export const ZETAPHY = 77390;
export const SEPOLIA = 11155111;
export const CHAIN = 1n;          // block.chainid of the test EVM (the source chain's id in bodies)
export const Q = 600;
export const DELAY = 3600;
export const E = 10n ** 18n;
export const ZERO = '0x' + '00'.repeat(20);
export const ROUTE_IN = encodeBytes32String('airlock');
export const ROUTE_OUT = encodeBytes32String('out');
export const HYP = validator(1);
export const OURS = [validator(2), validator(3), validator(4)].sort((x, y) => (BigInt(x.address) < BigInt(y.address) ? -1 : 1));
const AUDIT = ['https://audits.example/saphan.pdf', '0x' + 'a1'.repeat(32)];
export const b32 = (x) => zeroPadValue(x, 32);
const artifact = (n) => JSON.parse(readFileSync(new URL(`../../artifacts/${n}.json`, import.meta.url), 'utf8'));
const errorsOf = (...names) => names.flatMap((n) => artifact(n).abi.filter((f) => f.type === 'error'));
export const withErrors = (name, ...more) => { const x = artifact(name); return { abi: [...x.abi, ...errorsOf(...more)], bytecode: x.bytecode }; };

/**
 * A chain with these accounts (plus the route's own: gov, guardian, relayer, lane2, odeploy) and one route.
 * o: { lockboxLimit (wei/day, default 50), guardLimit (tokens/day, default 100), fund: { name: '0x…' } (accounts whose keys the test holds) }
 */
export async function routeWorld(names = [], o = {}) {
  const c = await createChain([...new Set(['gov', 'guardian', 'relayer', 'lane2', 'odeploy', ...names])], o.fund ?? {});
  const a = (n) => c.acct[n].toString();
  const kit = kitArtifacts();
  const mailboxArt = () => ({ abi: [...kit.KitMailbox.abi, ...errorsOf('HyperlaneLockBoxV2', 'HyperlaneLane', 'BridgeAirlock')], bytecode: kit.KitMailbox.bytecode });
  const zMailbox = await c.deployRaw(mailboxArt(), [ZETAPHY], 'gov');
  const r = { c, a, zMailbox };
  r.mailbox = await c.deployRaw(mailboxArt(), [SEPOLIA], 'gov');
  r.guard = await c.deploy('BridgeGuard', [a('gov')], 'gov');
  await r.guard.send('gov', 'createToken', ['ETH from Sepolia (bridged, testnet)', 'sepETH', 18]);
  r.token = await r.guard.call('token');
  r.airlock = await c.deploy('BridgeAirlock', [r.guard.address, ROUTE_IN, a('gov'), 2, Q], 'gov');
  r.hypIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [[HYP.address], 1], 'gov');
  r.lane = await c.deploy('HyperlaneLane', [r.airlock.address, a('gov'), zMailbox.address, SEPOLIA, '0x' + '00'.repeat(32), 0, ZERO, r.hypIsm.address], 'gov');
  r.ourIsm = await c.deployRaw(kit.KitMessageIdMultisigIsm, [OURS.map((w) => w.address), 2], 'odeploy');
  const lbAt = getCreateAddress({ from: a('odeploy'), nonce: await c.nonce('odeploy') });
  r.outbox = await c.deployRaw(withErrors('HyperlaneOutbox', 'BridgeGuard'), [r.guard.address, ROUTE_OUT, zMailbox.address, SEPOLIA, CHAIN, b32(lbAt), ZERO], 'gov');
  r.lockbox = await c.deploy('HyperlaneLockBoxV2', [r.mailbox.address, ZETAPHY, CHAIN, b32(r.lane.address), b32(r.outbox.address), ZERO,
    r.ourIsm.address, a('gov'), a('guardian'), o.lockboxLimit ?? 50n * E, DELAY], 'odeploy');
  await r.lane.send('gov', 'setConfig', [zMailbox.address, SEPOLIA, b32(r.lockbox.address), CHAIN, r.lockbox.address]);
  await r.airlock.send('gov', 'setLane', [r.lane.address, true]);
  await r.airlock.send('gov', 'setLane', [a('lane2'), true]);
  await r.guard.send('gov', 'setAudit', AUDIT);
  await r.guard.send('gov', 'setRoute', [ROUTE_IN, r.airlock.address, o.guardLimit ?? 100n * E, true]);
  await r.guard.send('gov', 'setOutboundRoute', [ROUTE_OUT, r.outbox.address, o.guardLimit ?? 100n * E, true]);
  r.tokenAbi = ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
  return r;
}

const lastMessage = (mb) => mb.call('lastMessage');
/** The relayer carries the source chain's last message to ZETAPHY (Hyperlane's validator signs it). */
export async function relayIn(r) { const m = await lastMessage(r.mailbox); return r.zMailbox.send('relayer', 'process', [messageIdMetadata(m, [HYP]), m]); }
/** ... and ZETAPHY's last message to the source chain (our validators sign it). */
export async function relayOut(r, signers = OURS.slice(0, 2)) { const m = await lastMessage(r.zMailbox); return r.mailbox.send('relayer', 'process', [messageIdMetadata(m, signers), m]); }
/** The release id (keccak256 of the body) of ZETAPHY's last message. */
export async function lastReleaseId(r) { const m = await lastMessage(r.zMailbox); return keccak256('0x' + m.slice(2 + 77 * 2)); }

/** `who` locks `amount` on the source; both lanes attest; after the quarantine the airlock mints token(X) to `to`. */
export async function bridgeIn(r, who, amount, to = who) {
  const { c, a } = r;
  const fee = await r.lockbox.call('quoteLock', [a(to), amount]);
  const ev = await r.lockbox.send(who, 'lock', [a(to), amount], amount + fee);
  const n = ev.find((e) => e?.name === 'Locked').args.nonce;
  await relayIn(r);
  const t = [CHAIN, r.lockbox.address, n, a(who), a(to), amount];
  await r.airlock.send('lane2', 'attest', t);
  c.advance(Q);
  await r.airlock.send('relayer', 'release', t);
  return t;
}

export const abi = AbiCoder.defaultAbiCoder();
