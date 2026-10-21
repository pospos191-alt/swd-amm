import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Interface, Wallet, ZeroHash, keccak256, toUtf8Bytes, id as topicId, getBytes, getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import {
  chainArgs, canonicalTarget, decodeAgentURI, NEURO_CHAINS, tonRaw, claimDomain, claimValues, CLAIM_TYPES, consentText, remoteOwners,
  checkClaimBundle, signAttestation, sortedAttestations, verifyEd25519, base58Decode,
} from '../src/identity.js';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { verifyTypedData } from 'ethers';

// Test chain: @ethereumjs Mainnet common, so block.chainid = 1 and "eth"
// (eip155:1) plays the role of "this chain" (on ZETAPHY it is "zetaphy").
const WEB = 'https://neuro.example/web/';
const QUORUM = 2; // runner attestations a remote claim needs in these tests
const MIN_AGREED = 5; // accepted verdicts a runner needs to attest or contest a remote claim
const DELAY = 3 * 86400; // contest window of a remote claim
const MOCK_ADDR = Object.fromEntries(Object.entries({ runners: 'a1', token: 'a2', renounced: 'a3', w1271: 'a4' }).map(([k, v]) => [k, getAddress('0x' + v.padStart(40, '0'))]));

function compileMocks() {
  const input = { language: 'Solidity', sources: { 'M.sol': { content: readFileSync(new URL('./helpers/IdentityMocks.sol', import.meta.url), 'utf8') } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.deployedBytecode.object'] } } } };
  const out = JSON.parse(solc.compile(JSON.stringify(input))).contracts['M.sol'];
  return Object.fromEntries(Object.entries(out).map(([n, c]) => [n, { iface: new Interface(c.abi), code: '0x' + c.evm.deployedBytecode.object }]));
}
const MOCKS = compileMocks();

let c, idr, val, mockIface;
const addr = (n) => getAddress(c.acct[n].toString());
let IDR; // checksummed registry address

beforeEach(async () => {
  c = await createChain(['admin', 'squatter', 'alice', 'bob', 'carol', 'mallory', 'r1', 'r2', 'newbie']);
  idr = await c.deploy('NeuroIdentity', [WEB, '', ...chainArgs(), MOCK_ADDR.runners, QUORUM, MIN_AGREED, DELAY], 'admin');
  IDR = getAddress(idr.address);
  await c.putCode(MOCK_ADDR.runners, MOCKS.MockRunners.code);
  await c.putCode(MOCK_ADDR.token, MOCKS.MockOwned.code);
  await c.putCode(MOCK_ADDR.renounced, MOCKS.MockOwned.code);
  await c.putCode(MOCK_ADDR.w1271, MOCKS.Mock1271.code);
  // errors from the registry bubble up through MockOwned.claimSelf
  mockIface = new Interface([...MOCKS.MockOwned.iface.fragments, ...idr.iface.fragments.filter((f) => f.type === 'error')]);
  await c.sendTo('alice', MOCK_ADDR.token, MOCKS.MockOwned.iface, 'setOwner', [addr('alice')]);
  val = await c.deploy('NeuroValidation', [idr.address, MOCK_ADDR.runners, 1], 'admin');
  for (const [w, active, agreed, rejected] of [['r1', true, 5, 0], ['r2', true, 2, 1], ['newbie', true, 0, 0]]) {
    await c.sendTo('admin', MOCK_ADDR.runners, MOCKS.MockRunners.iface, 'set', [addr(w), active, agreed, rejected]);
  }
});

const ev = (logs, name) => logs.filter((e) => e?.name === name);
async function registerTarget(who, chain, address) {
  const t = canonicalTarget(chain, address);
  const logs = await idr.send(who, 'registerTarget', [t.chain, t.account]);
  return { id: ev(logs, 'Registered')[0].args.agentId, logs, t };
}

// ------------------------------------------------------------------ spec shape

test('implements the ERC-8004 Identity Registry interface (functions, events) on ERC-721', () => {
  const spec = [
    'function register(string agentURI, (string metadataKey, bytes metadataValue)[] metadata) returns (uint256 agentId)',
    'function register(string agentURI) returns (uint256 agentId)',
    'function register() returns (uint256 agentId)',
    'function setAgentURI(uint256 agentId, string newURI)',
    'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
    'function setMetadata(uint256 agentId, string metadataKey, bytes metadataValue)',
    'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
    'function getAgentWallet(uint256 agentId) view returns (address)',
    'function unsetAgentWallet(uint256 agentId)',
    // ERC-721 + metadata + ERC-165
    'function balanceOf(address) view returns (uint256)', 'function ownerOf(uint256) view returns (address)',
    'function safeTransferFrom(address,address,uint256,bytes)', 'function safeTransferFrom(address,address,uint256)',
    'function transferFrom(address,address,uint256)', 'function approve(address,uint256)', 'function setApprovalForAll(address,bool)',
    'function getApproved(uint256) view returns (address)', 'function isApprovedForAll(address,address) view returns (bool)',
    'function name() view returns (string)', 'function symbol() view returns (string)', 'function tokenURI(uint256) view returns (string)',
    'function supportsInterface(bytes4) view returns (bool)',
    'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
    'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
    'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
    'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  ];
  const want = new Interface(spec);
  for (const f of want.fragments) {
    if (f.type === 'function') {
      const got = idr.iface.getFunction(f.selector);
      assert.ok(got, `missing ${f.format()}`);
      assert.equal(got.outputs.map((o) => o.type).join(), f.outputs.map((o) => o.type).join(), `outputs of ${f.format()}`);
    } else {
      const got = idr.iface.getEvent(f.topicHash);
      assert.ok(got, `missing ${f.format()}`);
      assert.deepEqual(got.inputs.map((i) => !!i.indexed), f.inputs.map((i) => !!i.indexed), `indexed args of ${f.format()}`);
    }
  }
});

test('ERC-165: ERC-721, ERC-721 Metadata and ERC-4906, nothing else', async () => {
  const xor = (sigs) => '0x' + sigs.map((s) => BigInt(topicId(s).slice(0, 10))).reduce((a, b) => a ^ b, 0n).toString(16).padStart(8, '0');
  const erc721 = xor(['balanceOf(address)', 'ownerOf(uint256)', 'safeTransferFrom(address,address,uint256,bytes)', 'safeTransferFrom(address,address,uint256)',
    'transferFrom(address,address,uint256)', 'approve(address,uint256)', 'setApprovalForAll(address,bool)', 'getApproved(uint256)', 'isApprovedForAll(address,address)']);
  assert.equal(erc721, '0x80ac58cd');
  for (const iid of ['0x01ffc9a7', erc721, '0x5b5e139f', '0x49064906']) assert.equal(await idr.call('supportsInterface', [iid]), true, iid);
  assert.equal(await idr.call('supportsInterface', ['0xffffffff']), false);
  assert.equal(await idr.call('name'), 'Neuro Agent Identity');
  assert.equal(await idr.call('symbol'), 'NEURO');
});

// ------------------------------------------------------------------ 1 contract = 1 identity

test('one target = one identity: anyone may register it once, held by the registry, registrant recorded', async () => {
  const target = '0x' + 'ab'.repeat(20);
  const { id, logs, t } = await registerTarget('squatter', 'bsc', target.toUpperCase().replace('0X', '0x'));
  assert.equal(id, 1n); // ids start at 1: 0 means "none" / broadcast
  assert.equal(t.caip10, `eip155:56:${target}`);
  assert.equal(await idr.call('ownerOf', [id]), IDR); // custody, not the squatter
  assert.equal(await idr.call('balanceOf', [addr('squatter')]), 0n);
  assert.equal(ev(logs, 'Transfer')[0].args.to, IDR);
  assert.equal(ev(logs, 'TargetRegistered')[0].args.registeredBy, addr('squatter'));
  assert.equal(ev(logs, 'TargetRegistered')[0].args.targetHash, keccak256(toUtf8Bytes(t.caip10)));

  const [chain, caip10, account, registeredBy, , claimed] = await idr.call('getTarget', [id]);
  assert.deepEqual([chain, caip10, account, registeredBy, claimed], ['bsc', t.caip10, target, addr('squatter'), false]);
  assert.equal(await idr.call('agentIdOf', ['bsc', target]), id);
  assert.equal(await idr.call('agentOfTarget', [keccak256(toUtf8Bytes(t.caip10))]), id);
  assert.equal(Buffer.from(getBytes(await idr.call('getMetadata', [id, 'neuro.target']))).toString(), t.caip10);
  assert.equal(await idr.call('getAgentWallet', [id]), '0x' + '00'.repeat(20)); // nobody gets paid as an unclaimed contract

  // the same target again, by anyone: refused with the existing id
  await assert.rejects(idr.send('alice', 'registerTarget', ['bsc', target]), /AlreadyRegistered/);
  // a second spelling of the same EVM address cannot sneak in
  await assert.rejects(idr.send('alice', 'registerTarget', ['bsc', target.toUpperCase().replace('0X', '0x')]), /BadAccount/);
  // the same address on another chain is another contract, so another identity
  const other = await registerTarget('alice', 'base', target);
  assert.equal(other.id, 2n);
});

test('nobody can speak for an unclaimed identity: not the registrant, not the admin', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  for (const who of ['squatter', 'admin']) {
    await assert.rejects(idr.send(who, 'setAgentURI', [id, 'https://evil.example/fake.json']), /NotAuthorized/);
    await assert.rejects(idr.send(who, 'setMetadata', [id, 'k', '0x01']), /NotAuthorized/);
    await assert.rejects(idr.send(who, 'transferFrom', [idr.address, addr(who), id]), /NotAuthorized/);
    await assert.rejects(idr.send(who, 'approve', [addr(who), id]), /NotAuthorized/);
    await assert.rejects(idr.send(who, 'unsetAgentWallet', [id]), /NotAuthorized/);
  }
});

test('bad targets and chains are refused (no JSON or URL injection through the target)', async () => {
  await assert.rejects(idr.send('alice', 'registerTarget', ['nochain', '0x' + '11'.repeat(20)]), /UnknownChain/);
  for (const bad of ['', '0x' + '11'.repeat(19), '0x' + 'g1'.repeat(20)]) await assert.rejects(idr.send('alice', 'registerTarget', ['eth', bad]), /BadAccount/);
  for (const bad of ['abc"},"x":"', 'a b', 'a&chain=eth', 'a?x', 'a#x', 'a%e2', 'a%E', 'x'.repeat(129), 'a/b', 'a‮b']) {
    await assert.rejects(idr.send('alice', 'registerTarget', ['sol', bad]), /BadAccount/, JSON.stringify(bad));
  }
  await assert.rejects(idr.send('alice', 'registerTarget', ['osmosis', 'OSMO1ABC']), /BadAccount/); // bech32 is lowercase here
  await assert.rejects(idr.send('alice', 'addChain', ['mine', 'eip155:9', 2]), /NotAuthorized/);
  await assert.rejects(idr.send('admin', 'addChain', ['eth', 'eip155:9', 2]), /ChainExists/);
  await assert.rejects(idr.send('admin', 'addChain', ['bad"key', 'eip155:9', 2]), /BadValue/);
  await assert.rejects(idr.send('admin', 'addChain', ['ok', 'eip155:"9', 2]), /BadValue/);
  await assert.rejects(idr.send('admin', 'setWeb', ['https://x/"><script>', '']), /BadValue/);
  await idr.send('admin', 'addChain', ['polygon', 'eip155:137', 2]);
  assert.equal(await idr.call('chainCount'), BigInt(Object.keys(NEURO_CHAINS).length + 1));
});

test('canonicalTarget gives the registry one spelling per target on every Neuro chain', async () => {
  assert.equal(canonicalTarget('ETH', '0xABCDEF0000000000000000000000000000000001').account, '0xabcdef0000000000000000000000000000000001');
  assert.equal(canonicalTarget('sui', '0x2::sui::SUI').account, '0x' + '0'.repeat(63) + '2::sui::SUI');
  assert.equal(canonicalTarget('starknet', '0x4718F5').account, '0x' + '0'.repeat(58) + '4718f5');
  assert.equal(canonicalTarget('bitcoin', 'UNCOMMON•GOODS').account, 'UNCOMMONGOODS');
  assert.equal(canonicalTarget('osmosis', 'OSMO1QQ').account, 'osmo1qq');
  assert.throws(() => canonicalTarget('eth', '0x123'), /not an EVM address/);
  assert.throws(() => canonicalTarget('dogechain', '0x' + '11'.repeat(20)), /unknown chain/);
  const samples = { zetaphy: '0x' + '22'.repeat(20), eth: '0x' + '11'.repeat(20), bsc: '0x' + '11'.repeat(20), base: '0x' + '11'.repeat(20), arbitrum: '0x' + '11'.repeat(20),
    sol: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sui: '0x2::sui::SUI', aptos: '0x1::aptos_coin::AptosCoin', osmosis: 'osmo1abc', neutron: 'neutron1abc',
    near: 'usdt.tether-token.near', starknet: '0x4718f5', bitcoin: 'UNCOMMON•GOODS', ton: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs' };
  for (const [chain, a] of Object.entries(samples)) {
    const t = canonicalTarget(chain, a);
    await idr.send('alice', 'registerTarget', [t.chain, t.account]);
    assert.ok(await idr.call('agentIdOf', [t.chain, t.account]) > 0n, chain);
  }
});

// ------------------------------------------------------------------ registration file

test('agentURI is an on-chain ERC-8004 registration file pointing at the Neuro report', async () => {
  const { id, logs, t } = await registerTarget('squatter', 'bsc', '0x' + 'cd'.repeat(20));
  const uri = await idr.call('tokenURI', [id]);
  assert.equal(uri, await idr.call('neuroURI', [id]));
  assert.equal(ev(logs, 'Registered')[0].args.agentURI, uri);
  const reg = decodeAgentURI(uri);
  assert.equal(reg.type, 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1');
  assert.equal(reg.name, `Neuro of ${t.caip10}`);
  assert.match(reg.description, /data, not advice/);
  assert.equal(typeof reg.image, 'string');
  assert.deepEqual(reg.services, [{ name: 'web', endpoint: `${WEB}?chain=bsc&address=${t.account}` }]);
  assert.equal(reg.x402Support, false);
  assert.equal(reg.active, true);
  assert.deepEqual(reg.registrations, [{ agentId: 1, agentRegistry: `eip155:1:${idr.address.toLowerCase()}` }]);
  assert.equal(await idr.call('agentRegistry'), `eip155:1:${idr.address.toLowerCase()}`);
  assert.deepEqual(reg.supportedTrust, ['crypto-economic']);
  assert.deepEqual(reg.neuro, { target: t.caip10, chain: 'bsc', address: t.account, registeredBy: addr('squatter').toLowerCase(), claimed: false });
  // the admin may move the Neuro web; every identity follows
  const l2 = await idr.send('admin', 'setWeb', ['https://neuro2.example/web/', 'https://neuro2.example/icon.png']);
  assert.equal(ev(l2, 'BatchMetadataUpdate').length, 1);
  const reg2 = decodeAgentURI(await idr.call('tokenURI', [id]));
  assert.equal(reg2.services[0].endpoint, `https://neuro2.example/web/?chain=bsc&address=${t.account}`);
  assert.equal(reg2.image, 'https://neuro2.example/icon.png');
  // a rune name with percent-escapes is still valid JSON and a valid link
  const r = await registerTarget('alice', 'bitcoin', 'UNCOMMON•GOODS');
  assert.equal(decodeAgentURI(await idr.call('tokenURI', [r.id])).services[0].endpoint, `https://neuro2.example/web/?chain=bitcoin&address=UNCOMMONGOODS`);
});

// ------------------------------------------------------------------ owner claim

test('the contract\'s owner() takes control with proof; others cannot', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  await assert.rejects(idr.send('squatter', 'claim', [id]), /NotTargetOwner/);
  await assert.rejects(idr.send('mallory', 'claim', [id]), /NotTargetOwner/);
  const logs = await idr.send('alice', 'claim', [id]);
  assert.equal(ev(logs, 'Claimed')[0].args.previousOwner, IDR);
  assert.equal(await idr.call('ownerOf', [id]), addr('alice'));
  assert.equal(await idr.call('getAgentWallet', [id]), addr('alice'));
  assert.equal((await idr.call('getTarget', [id]))[5], true);
  assert.equal(decodeAgentURI(await idr.call('tokenURI', [id])).neuro.claimed, true);
  await assert.rejects(idr.send('alice', 'claim', [id]), /AlreadyHolder/);

  // now a normal ERC-8004 agent: custom URI and metadata; Neuro's file stays readable
  const u = await idr.send('alice', 'setAgentURI', [id, 'ipfs://bafy-alice']);
  assert.equal(ev(u, 'URIUpdated')[0].args.updatedBy, addr('alice'));
  assert.equal(await idr.call('tokenURI', [id]), 'ipfs://bafy-alice');
  assert.equal(decodeAgentURI(await idr.call('neuroURI', [id])).neuro.target, `eip155:1:${MOCK_ADDR.token.toLowerCase()}`);
  await idr.send('alice', 'setMetadata', [id, 'mcp', '0x1234']);
  assert.equal(await idr.call('getMetadata', [id, 'mcp']), '0x1234');
  for (const k of ['agentWallet', 'neuro.target', 'neuro.registeredBy']) await assert.rejects(idr.send('alice', 'setMetadata', [id, k, '0x01']), /ReservedKey/);

  // transfer: agentWallet is cleared (ERC-8004)
  await idr.send('alice', 'transferFrom', [addr('alice'), addr('bob'), id]);
  assert.equal(await idr.call('ownerOf', [id]), addr('bob'));
  assert.equal(await idr.call('getAgentWallet', [id]), '0x' + '00'.repeat(20));

  // control follows the contract: its new owner can claim it back from anyone
  await c.sendTo('alice', MOCK_ADDR.token, MOCKS.MockOwned.iface, 'setOwner', [addr('carol')]);
  await assert.rejects(idr.send('alice', 'claim', [id]), /NotTargetOwner/);
  await idr.send('carol', 'claim', [id]);
  assert.equal(await idr.call('ownerOf', [id]), addr('carol'));
});

test('the contract itself can claim (e.g. owner renounced); other chains and plain agents cannot be claimed', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.renounced); // owner() = 0
  await assert.rejects(idr.send('mallory', 'claim', [id]), /NotTargetOwner/);
  await c.sendTo('bob', MOCK_ADDR.renounced, mockIface, 'claimSelf', [idr.address, id]);
  assert.equal(await idr.call('ownerOf', [id]), MOCK_ADDR.renounced);

  const off = await registerTarget('squatter', 'bsc', MOCK_ADDR.token); // same address, another chain
  await assert.rejects(idr.send('alice', 'claim', [off.id]), /NotLocal/);
  await assert.rejects(c.sendTo('bob', MOCK_ADDR.token, mockIface, 'claimSelf', [idr.address, off.id]), /NotLocal/);

  const logs = await idr.send('bob', 'register()', []);
  await assert.rejects(idr.send('bob', 'claim', [ev(logs, 'Registered')[0].args.agentId]), /NotTarget/);
  await assert.rejects(idr.send('bob', 'claim', [999]), /NotTarget/);
});

// ------------------------------------------------------------------ plain ERC-8004 registration

test('plain register() overloads mint to the caller, set agentWallet, and refuse reserved keys', async () => {
  const l1 = await idr.send('bob', 'register()', []);
  const id1 = ev(l1, 'Registered')[0].args.agentId;
  assert.equal(await idr.call('ownerOf', [id1]), addr('bob'));
  assert.equal(await idr.call('tokenURI', [id1]), '');
  assert.equal(await idr.call('getAgentWallet', [id1]), addr('bob'));
  assert.equal(ev(l1, 'MetadataSet')[0].args.metadataKey, 'agentWallet');

  const l2 = await idr.send('bob', 'register(string)', ['https://bob.example/agent.json']);
  const id2 = ev(l2, 'Registered')[0].args.agentId;
  assert.equal(id2, id1 + 1n);
  assert.equal(await idr.call('tokenURI', [id2]), 'https://bob.example/agent.json');

  const l3 = await idr.send('bob', 'register(string,(string,bytes)[])', ['ipfs://x', [['a2a', '0xaa'], ['mcp', '0xbb']]]);
  const id3 = ev(l3, 'Registered')[0].args.agentId;
  assert.equal(ev(l3, 'MetadataSet').length, 3);
  assert.equal(await idr.call('getMetadata', [id3, 'mcp']), '0xbb');
  await assert.rejects(idr.send('bob', 'register(string,(string,bytes)[])', ['ipfs://x', [['agentWallet', '0x' + '11'.repeat(20)]]]), /ReservedKey/);

  // an operator approved for all may manage it; a stranger may not
  await idr.send('bob', 'setApprovalForAll', [addr('carol'), true]);
  await idr.send('carol', 'setAgentURI', [id2, 'https://new.example/a.json']);
  assert.equal(await idr.call('isAuthorizedOrOwner', [addr('carol'), id2]), true);
  await assert.rejects(idr.send('mallory', 'setAgentURI', [id2, 'x']), /NotAuthorized/);
  await assert.rejects(idr.call('ownerOf', [999]), /Nonexistent/);
  // safe transfer to a contract that is not a receiver is refused
  await assert.rejects(idr.send('bob', 'safeTransferFrom(address,address,uint256)', [addr('bob'), MOCK_ADDR.token, id1]), /UnsafeRecipient/);
});

test('setAgentWallet needs an EIP-712 signature from the new wallet (or ERC-1271), within 5 minutes', async () => {
  const id = ev(await idr.send('bob', 'register()', []), 'Registered')[0].args.agentId;
  const w = Wallet.createRandom();
  const deadline = c.now() + 120n;
  const domain = { name: 'ERC8004IdentityRegistry', version: '1', chainId: 1, verifyingContract: idr.address };
  const types = { AgentWalletSet: [{ name: 'agentId', type: 'uint256' }, { name: 'newWallet', type: 'address' }, { name: 'owner', type: 'address' }, { name: 'deadline', type: 'uint256' }] };
  const sig = await w.signTypedData(domain, types, { agentId: id, newWallet: w.address, owner: addr('bob'), deadline });
  await assert.rejects(idr.send('mallory', 'setAgentWallet', [id, w.address, deadline, sig]), /NotAuthorized/);
  await assert.rejects(idr.send('bob', 'setAgentWallet', [id, Wallet.createRandom().address, deadline, sig]), /InvalidSignature/);
  await assert.rejects(idr.send('bob', 'setAgentWallet', [id, w.address, c.now() + 600n, sig]), /DeadlineTooFar/);
  await idr.send('bob', 'setAgentWallet', [id, w.address, deadline, sig]);
  assert.equal(await idr.call('getAgentWallet', [id]), w.address);
  c.advance(200);
  await assert.rejects(idr.send('bob', 'setAgentWallet', [id, w.address, deadline, sig]), /Expired/);
  // a contract wallet answers through ERC-1271
  await assert.rejects(idr.send('bob', 'setAgentWallet', [id, MOCK_ADDR.w1271, c.now() + 60n, '0x']), /InvalidSignature/);
  await c.sendTo('bob', MOCK_ADDR.w1271, MOCKS.Mock1271.iface, 'setOk', [true]);
  await idr.send('bob', 'setAgentWallet', [id, MOCK_ADDR.w1271, c.now() + 60n, '0x']);
  assert.equal(await idr.call('getAgentWallet', [id]), MOCK_ADDR.w1271);
  await idr.send('bob', 'unsetAgentWallet', [id]);
  assert.equal(await idr.call('getAgentWallet', [id]), '0x' + '00'.repeat(20));
});

// ------------------------------------------------------------------ validation registry

test('implements the ERC-8004 Validation Registry interface', () => {
  const want = new Interface([
    'function getIdentityRegistry() view returns (address)',
    'function validationRequest(address validatorAddress, uint256 agentId, string requestURI, bytes32 requestHash)',
    'function validationResponse(bytes32 requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)',
    'function getValidationStatus(bytes32 requestHash) view returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 responseHash, string tag, uint256 lastUpdate)',
    'function getSummary(uint256 agentId, address[] validatorAddresses, string tag) view returns (uint64 count, uint8 averageResponse)',
    'function getAgentValidations(uint256 agentId) view returns (bytes32[])',
    'function getValidatorRequests(address validatorAddress) view returns (bytes32[])',
    'event ValidationRequest(address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash)',
    'event ValidationResponse(address indexed validatorAddress, uint256 indexed agentId, bytes32 indexed requestHash, uint8 response, string responseURI, bytes32 responseHash, string tag)',
  ]);
  for (const f of want.fragments) {
    const got = f.type === 'function' ? val.iface.getFunction(f.selector) : val.iface.getEvent(f.topicHash);
    assert.ok(got, `missing ${f.format()}`);
    if (f.type === 'function') assert.equal(got.outputs.map((o) => o.type).join(), f.outputs.map((o) => o.type).join());
    else assert.deepEqual(got.inputs.map((i) => !!i.indexed), f.inputs.map((i) => !!i.indexed));
  }
});

test('bonded runners post Neuro verdicts on any identity; outsiders and new runners cannot', async () => {
  const { id, t } = await registerTarget('squatter', 'bsc', '0x' + 'ef'.repeat(20));
  assert.equal(await val.call('getIdentityRegistry'), IDR);
  const V = '0x' + '11'.repeat(32);
  const logs = await val.send('r1', 'postVerdict', [id, V, 20, '', 'neuro-v1']);
  const req = ev(logs, 'ValidationRequest')[0].args;
  assert.equal(req.requestURI, `${WEB}?chain=bsc&address=${t.account}`);
  const res = ev(logs, 'ValidationResponse')[0].args;
  assert.deepEqual([res.validatorAddress, res.agentId, res.response, res.responseHash, res.tag], [addr('r1'), id, 20n, V, 'neuro-v1']);
  const rh = await val.call('verdictRequestHash', [id, addr('r1')]);
  assert.equal(rh.slice(0, 10), '0x4e564431'); // the postVerdict namespace ("NVD1")
  assert.equal(req.requestHash, rh);
  const st = await val.call('getValidationStatus', [rh]);
  assert.deepEqual([st[0], st[1], st[2], st[3], st[4]], [addr('r1'), id, 20n, V, 'neuro-v1']);

  await val.send('r2', 'postVerdict', [id, V, 30, '', 'neuro-v1']);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 25n]);
  assert.deepEqual([...await val.call('getSummary', [id, [addr('r2')], ''])], [1n, 30n]);
  assert.deepEqual([...await val.call('getSummary', [id, [], 'other'])], [0n, 0n]);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2);
  assert.deepEqual([...await val.call('getValidatorRequests', [addr('r1')])], [rh]);
  // the same runner again, same or another verdict: it replaces its one slot, never adds an entry
  await val.send('r1', 'postVerdict', [id, V, 40, '', 'neuro-v1']);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 35n]);
  const V2 = '0x' + '22'.repeat(32);
  const l2 = await val.send('r1', 'postVerdict', [id, V2, 60, '', 'neuro-v1']);
  assert.equal(ev(l2, 'ValidationRequest').length, 0);
  assert.equal(ev(l2, 'ValidationResponse')[0].args.requestHash, rh);
  assert.equal((await val.call('getValidationStatus', [rh]))[3], V2);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 45n]);

  for (const w of ['newbie', 'mallory', 'squatter']) await assert.rejects(val.send(w, 'postVerdict', [id, V, 50, '', '']), /NotRunner/);
  await c.sendTo('admin', MOCK_ADDR.runners, MOCKS.MockRunners.iface, 'set', [addr('r2'), true, 1, 2]); // more rejected than agreed
  await assert.rejects(val.send('r2', 'postVerdict', [id, V, 50, '', '']), /NotRunner/);
  await assert.rejects(val.send('r1', 'postVerdict', [id, V, 101, '', '']), /BadValue/);
  await assert.rejects(val.send('r1', 'postVerdict', [id, ZeroHash, 50, '', '']), /BadValue/);
  await assert.rejects(val.send('r1', 'postVerdict', [999, V, 50, '', ''])); // unknown agent: the registry's ownerOf reverts
});

test('spec request/response: only the agent\'s owner asks, only the named runner answers', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  const RH = '0x' + '77'.repeat(32);
  // unclaimed: nobody owns it, so nobody can open a spec request
  await assert.rejects(val.send('squatter', 'validationRequest', [addr('r1'), id, 'ipfs://req', RH]), /NotAuthorized/);
  await idr.send('alice', 'claim', [id]);
  await assert.rejects(val.send('alice', 'validationRequest', ['0x' + '00'.repeat(20), id, 'ipfs://req', RH]), /BadValue/);
  await val.send('alice', 'validationRequest', [addr('r1'), id, 'ipfs://req', RH]);
  await assert.rejects(val.send('alice', 'validationRequest', [addr('r1'), id, 'ipfs://req', RH]), /Exists/);
  await assert.rejects(val.send('r2', 'validationResponse', [RH, 100, '', ZeroHash, '']), /NotValidator/);
  await assert.rejects(val.send('r1', 'validationResponse', ['0x' + '78'.repeat(32), 100, '', ZeroHash, '']), /Unknown/);
  await val.send('r1', 'validationResponse', [RH, 100, 'ipfs://resp', '0x' + '99'.repeat(32), 'hard']);
  await val.send('r1', 'validationResponse', [RH, 90, '', ZeroHash, 'soft']); // may answer again
  const st = await val.call('getValidationStatus', [RH]);
  assert.deepEqual([st[2], st[4]], [90n, 'soft']);
  // a named validator who is not a runner cannot answer
  const RH2 = '0x' + '79'.repeat(32);
  await val.send('alice', 'validationRequest', [addr('mallory'), id, 'ipfs://req', RH2]);
  await assert.rejects(val.send('mallory', 'validationResponse', [RH2, 100, '', ZeroHash, '']), /NotRunner/);
});

// ------------------------------------------------------------------ security review fixes

test('verdict squatting: verdict slots cannot be pre-created through validationRequest', async () => {
  const scam = await registerTarget('squatter', 'bsc', '0x' + '5c'.repeat(20));
  // the attacker's own free agent A, which it may open spec requests for
  const A = ev(await idr.send('mallory', 'register()', []), 'Registered')[0].args.agentId;
  const slot = await val.call('verdictRequestHash', [scam.id, addr('r1')]);
  await assert.rejects(val.send('mallory', 'validationRequest', [addr('r1'), A, 'ipfs://x', slot]), /ReservedHash/);
  // the whole tagged namespace is closed to spec requests, whatever follows the tag
  await assert.rejects(val.send('mallory', 'validationRequest', [addr('r1'), A, 'ipfs://x', '0x4e564431' + '00'.repeat(28)]), /ReservedHash/);
  assert.equal(await val.call('isVerdictHash', [slot]), true);
  assert.equal(await val.call('isVerdictHash', ['0x' + '77'.repeat(32)]), false);
  await assert.rejects(val.send('mallory', 'validationRequest', [addr('r1'), A, 'ipfs://x', ZeroHash]), /BadValue/);

  // the runner's verdict lands on the scam target, and only there
  await val.send('r1', 'postVerdict', [scam.id, '0x' + '11'.repeat(32), 5, '', 'neuro-v1']);
  assert.equal((await val.call('getValidationStatus', [slot]))[1], scam.id);
  assert.deepEqual([...await val.call('getSummary', [scam.id, [], ''])], [1n, 5n]);
  assert.deepEqual([...await val.call('getSummary', [A, [], ''])], [0n, 0n]);
  // slots are per (agent, runner): another agent or runner gets another slot
  assert.notEqual(await val.call('verdictRequestHash', [A, addr('r1')]), slot);
  assert.notEqual(await val.call('verdictRequestHash', [scam.id, addr('r2')]), slot);
});

test('getSummary counts each runner once per agent: its latest answer', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  for (let i = 1; i <= 10; i++) await val.send('r1', 'postVerdict', [id, '0x' + i.toString(16).padStart(64, '0'), 100, '', 'neuro-v1']);
  await val.send('r2', 'postVerdict', [id, '0x' + 'aa'.repeat(32), 0, '', 'neuro-v1']);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2); // bounded: one slot per runner
  assert.equal((await val.call('getValidatorRequests', [addr('r1')])).length, 1);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 50n]);

  // spec requests answered by the same runner do not stack up either: its latest answer wins
  await idr.send('alice', 'claim', [id]);
  for (const [i, score] of [[1, 100], [2, 100], [3, 90]]) {
    const RH = '0x' + String(i).repeat(64);
    await val.send('alice', 'validationRequest', [addr('r2'), id, 'ipfs://req', RH]);
    await val.send('r2', 'validationResponse', [RH, score, '', ZeroHash, 'neuro-v1']);
  }
  assert.equal((await val.call('getAgentValidations', [id])).length, 5);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 95n]); // r1: 100, r2: 90
  assert.deepEqual([...await val.call('getSummary', [id, [addr('r2')], ''])], [1n, 90n]);
  // a runner's newer verdict replaces its spec answer in the summary too
  await val.send('r2', 'postVerdict', [id, '0x' + 'bb'.repeat(32), 10, '', 'neuro-v1']);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 55n]);
});

test('a claimed identity cannot be handed back to the registry to look unclaimed', async () => {
  const { id } = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  await idr.send('alice', 'claim', [id]);
  await idr.send('alice', 'setAgentURI', [id, 'https://evil.example/fake-neuro.json']);
  await assert.rejects(idr.send('alice', 'transferFrom', [addr('alice'), idr.address, id]), /RegistryCustody/);
  await assert.rejects(idr.send('alice', 'safeTransferFrom(address,address,uint256)', [addr('alice'), idr.address, id]), /RegistryCustody/);
  await assert.rejects(idr.send('alice', 'safeTransferFrom(address,address,uint256,bytes)', [addr('alice'), idr.address, id, '0x']), /RegistryCustody/);
  // also through an approved operator
  await idr.send('alice', 'setApprovalForAll', [addr('bob'), true]);
  await assert.rejects(idr.send('bob', 'transferFrom', [addr('alice'), idr.address, id]), /RegistryCustody/);
  assert.equal(await idr.call('ownerOf', [id]), addr('alice'));
  assert.equal((await idr.call('getTarget', [id]))[5], true);
  // plain agents cannot be parked there either
  const p = ev(await idr.send('bob', 'register()', []), 'Registered')[0].args.agentId;
  await assert.rejects(idr.send('bob', 'transferFrom', [addr('bob'), idr.address, p]), /RegistryCustody/);
});

test('one spelling on chain for Sui/Aptos (padded lowercase hex), Solana (base58) and escaped text', async () => {
  const ONE = '0x' + '0'.repeat(63) + '2';
  await idr.send('alice', 'registerTarget', ['sui', ONE + '::sui::SUI']);
  await idr.send('alice', 'registerTarget', ['aptos', '0x' + 'ab'.repeat(32)]);
  for (const bad of ['0x2::sui::SUI', '0x' + '0'.repeat(63) + 'A::sui::SUI', '0x' + 'AB'.repeat(32), ONE + '::sui', ONE + '::sui::', ONE + ':sui::SUI',
    ONE + '::sui::SUI::x', ONE + '::1sui::SUI', ONE + '::sui::S-UI', ONE + '::sui::SUI%3C', '0X' + '0'.repeat(63) + '2', ONE + '0']) {
    await assert.rejects(idr.send('alice', 'registerTarget', ['sui', bad]), /BadAccount/, bad);
  }
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  await idr.send('alice', 'registerTarget', ['sol', mint]);
  for (const bad of [mint.replace('E', '%45'), mint.slice(0, 31), mint + 'abc', mint.replace('E', '0'), mint.replace('E', 'O'), mint.replace('E', 'l'), mint.replace('E', '_')]) {
    await assert.rejects(idr.send('alice', 'registerTarget', ['sol', bad]), /BadAccount/, bad);
  }
  // text chains (a chain added with rule 0): an escape is only for a byte that needs one
  await idr.send('admin', 'addChain', ['textchain', 'text:1', 0]);
  await idr.send('alice', 'registerTarget', ['textchain', 'UNCOMMON%E2%80%A2GOODS']);
  for (const bad of ['UNCOMMON%E2%80%A2GOOD%53', '%41BC', 'a%2Db', 'a%3Ab']) await assert.rejects(idr.send('alice', 'registerTarget', ['textchain', bad]), /BadAccount/, bad);
  // runes: only A-Z (spacers dropped)
  for (const bad of ['UNCOMMON%E2%80%A2GOOD%53', '%41BC', 'uncommongoods', 'A-B', '840000:3', 'A'.repeat(29), '•', '']) {
    await assert.rejects(idr.send('alice', 'registerTarget', ['bitcoin', bad]), /BadAccount/, bad);
  }
  // the CLI refuses what the registry would, with a readable error
  assert.throws(() => canonicalTarget('sui', '0x2::coin::Coin<0x2::sui::SUI>'), /not a sui address or coin type/);
  assert.throws(() => canonicalTarget('aptos', 'hello'), /not a aptos address/);
  assert.throws(() => canonicalTarget('sol', mint + '%'), /base58/);
  assert.equal(canonicalTarget('aptos', '0xAB::Coin::Name').account, '0x' + '0'.repeat(62) + 'ab::Coin::Name');
});

// ------------------------------------------------------------------ one target, one identity, any spelling

/** A TON friendly address for a raw one (what wallets show). */
function tonFriendly(raw, { bounceable = true, testnet = false, url = true } = {}) {
  const [wc, h] = raw.split(':');
  const b = Buffer.alloc(36);
  b[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0);
  b[1] = wc === '-1' ? 0xff : 0;
  Buffer.from(h, 'hex').copy(b, 2);
  let crc = 0;
  for (const x of b.subarray(0, 34)) { crc ^= x << 8; for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  b.writeUInt16BE(crc, 34);
  const s = b.toString('base64');
  return url ? s.replace(/\+/g, '-').replace(/\//g, '_') : s;
}

test('TON: every spelling of one address (raw, EQ…, UQ…, testnet, base64/base64url) is ONE identity, converted on chain', async () => {
  const raw = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
  const eq = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
  assert.equal(tonFriendly(raw), eq);
  // the registry converts the friendly form itself (not only the CLI)
  const logs = await idr.send('alice', 'registerTarget', ['ton', eq]);
  const id = ev(logs, 'Registered')[0].args.agentId;
  assert.equal((await idr.call('getTarget', [id]))[2], raw);
  assert.equal(ev(logs, 'TargetRegistered')[0].args.target, `tvm:-239:${raw}`);
  const spellings = [raw, raw.toUpperCase().replace('0:', '0:'), tonFriendly(raw, { bounceable: false }), tonFriendly(raw, { testnet: true }),
    tonFriendly(raw, { bounceable: false, testnet: true }), tonFriendly(raw, { url: false })];
  for (const sp of spellings) {
    assert.equal(await idr.call('agentIdOf', ['ton', sp]), id, sp);
    assert.equal(await idr.call('canonicalAccount', ['ton', sp]), raw, sp);
    assert.equal(canonicalTarget('ton', sp).account, raw, `CLI agrees: ${sp}`);
    await assert.rejects(idr.send('bob', 'registerTarget', ['ton', sp]), /AlreadyRegistered/, sp);
  }
  // masterchain is another account
  const master = '-1:' + 'ab'.repeat(32);
  await idr.send('alice', 'registerTarget', ['ton', tonFriendly(master)]);
  assert.equal(await idr.call('agentIdOf', ['ton', master]), id + 1n);
  // a broken checksum, a bad tag, a bad workchain or a wrong length is refused (and unknown to agentIdOf)
  const flip = eq.slice(0, 47) + (eq[47] === 's' ? 't' : 's');
  const badTag = Buffer.from(tonFriendly(raw, { url: false }), 'base64'); badTag[0] = 0x22;
  for (const bad of [flip, badTag.toString('base64'), '1:' + 'ab'.repeat(32), '0:' + 'ab'.repeat(31), eq.slice(1), '0:' + 'gg'.repeat(32)]) {
    await assert.rejects(idr.send('alice', 'registerTarget', ['ton', bad]), /BadAccount/, bad);
    assert.equal(await idr.call('agentIdOf', ['ton', bad]), 0n);
  }
  assert.throws(() => tonRaw(flip), /checksum/);
});

test('runes: with or without spacers (•, %E2%80%A2 or .) is ONE identity, stored A-Z', async () => {
  const id = (await registerTarget('alice', 'bitcoin', 'UNCOMMON•GOODS')).id;
  assert.equal((await idr.call('getTarget', [id]))[2], 'UNCOMMONGOODS');
  for (const sp of ['UNCOMMON•GOODS', 'UNCOMMON%E2%80%A2GOODS', 'UNCOMMON.GOODS', 'UNCOMMONGOODS', 'U•N•C•O•M•M•O•N•G•O•O•D•S']) {
    assert.equal(await idr.call('agentIdOf', ['bitcoin', sp]), id, sp);
    await assert.rejects(idr.send('bob', 'registerTarget', ['bitcoin', sp]), /AlreadyRegistered/, sp);
  }
  assert.equal(await idr.call('agentIdOf', ['bitcoin', 'uncommon•goods']), 0n, 'lowercase is refused on chain');
  assert.equal(canonicalTarget('bitcoin', 'uncommon.goods').account, 'UNCOMMONGOODS', 'the CLI upper-cases first');
  assert.throws(() => canonicalTarget('bitcoin', '840000:3'), /rune id/);
});

// ------------------------------------------------------------------ remote claims (targets on other chains)

const RUNNER_KEYS = [Wallet.createRandom(), Wallet.createRandom(), Wallet.createRandom()];
async function setRunner(w, active, agreed, rejected) {
  await c.sendTo('admin', MOCK_ADDR.runners, MOCKS.MockRunners.iface, 'set', [w.address, active, agreed, rejected]);
}

/** A claim bundle for agent `id`, signed by `owner` (EVM consent) and the given runners. */
async function bundleFor(id, { owner, ownerKey, newOwner, runners = RUNNER_KEYS.slice(0, QUORUM), ttl = 3600n, consentBy = owner }) {
  const [, caip10] = await idr.call('getTarget', [id]);
  const b = { chainId: '1', registry: IDR, agentId: String(id), target: caip10, newOwner, ownerKey: ownerKey ?? owner.address.toLowerCase(),
    nonce: String(await idr.call('claimNonce', [id])), deadline: String(c.now() + ttl), ownerSig: null, attestations: [] };
  if (consentBy) b.ownerSig = await consentBy.signTypedData(claimDomain(1, IDR), CLAIM_TYPES.consent, claimValues(b));
  for (const r of runners) b.attestations.push(await signAttestation(r, b));
  return b;
}
const submit = (who, b, sigs = sortedAttestations(b.attestations)) =>
  idr.send(who, 'claimRemote', [b.agentId, b.newOwner, b.ownerKey, b.deadline, b.ownerSig ?? '0x', sigs]);
/** Proposes a claim, waits out the contest window and runs it. */
async function submitAndFinalize(who, b) {
  const logs = await submit(who, b);
  c.advance(DELAY);
  return [...logs, ...await idr.send(who, 'finalizeClaim', [b.agentId])];
}

test('claimRemote (EVM owner): the owner\'s EIP-712 consent is checked on chain, plus a quorum of runner attestations', async () => {
  for (const w of RUNNER_KEYS) await setRunner(w, true, MIN_AGREED, 0);
  const owner = Wallet.createRandom();
  const { id } = await registerTarget('squatter', 'bsc', '0x' + 'ee'.repeat(20));
  assert.equal(await idr.call('claimQuorum'), BigInt(QUORUM));
  const b = await bundleFor(id, { owner, newOwner: addr('alice') });

  // too few runners
  await assert.rejects(submit('bob', b, sortedAttestations(b.attestations).slice(0, 1)), /Quorum/);
  // the same runner twice, or out of order
  const s = sortedAttestations(b.attestations);
  await assert.rejects(submit('bob', b, [s[0], s[0]]), /InvalidSignature/);
  await assert.rejects(submit('bob', b, [s[1], s[0]]), /InvalidSignature/);
  // the runners alone cannot fake the owner's consent: a consent by another key is refused
  const forged = await bundleFor(id, { owner, newOwner: addr('alice'), consentBy: Wallet.createRandom() });
  await assert.rejects(submit('bob', forged), /InvalidSignature/);
  // ... and the owner's consent cannot be redirected to another new owner
  await assert.rejects(submit('bob', { ...b, newOwner: addr('mallory') }), /InvalidSignature/);
  // runners must be in good standing (active, agreed >= claimMinAgreed, rejected <= agreed)
  assert.equal(await idr.call('claimMinAgreed'), BigInt(MIN_AGREED));
  const newbie = Wallet.createRandom();
  await setRunner(newbie, true, 0, 0);
  await assert.rejects(submit('bob', await bundleFor(id, { owner, newOwner: addr('alice'), runners: [RUNNER_KEYS[0], newbie] })), /NotRunner/);
  await setRunner(newbie, true, MIN_AGREED - 1, 0); // a few accepted verdicts are not enough to take identities
  await assert.rejects(submit('bob', await bundleFor(id, { owner, newOwner: addr('alice'), runners: [RUNNER_KEYS[0], newbie] })), /NotRunner/);
  await setRunner(newbie, true, MIN_AGREED, MIN_AGREED + 1);
  await assert.rejects(submit('bob', await bundleFor(id, { owner, newOwner: addr('alice'), runners: [RUNNER_KEYS[0], newbie] })), /NotRunner/);
  await setRunner(newbie, false, 9, 0);
  await assert.rejects(submit('bob', await bundleFor(id, { owner, newOwner: addr('alice'), runners: [RUNNER_KEYS[0], newbie] })), /NotRunner/);
  // deadlines
  await assert.rejects(submit('bob', await bundleFor(id, { owner, newOwner: addr('alice'), ttl: 2n * 86400n })), /DeadlineTooFar/);

  // anyone may submit a good bundle; the signatures decide who gets it, after the contest window
  const logs = await submitAndFinalize('bob', b);
  assert.equal(await idr.call('ownerOf', [id]), addr('alice'));
  assert.equal(await idr.call('getAgentWallet', [id]), addr('alice'));
  assert.equal(await idr.call('claimNonce', [id]), 2n); // spent by the proposal, and again by the takeover
  const rc = ev(logs, 'RemoteClaimProposed')[0].args;
  assert.equal(rc.ownerKey, owner.address.toLowerCase());
  assert.deepEqual([...rc.runners], b.attestations.map((a) => a.runner).sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1)));
  assert.equal(ev(logs, 'RemoteClaimFinalized')[0].args.newOwner, addr('alice'));
  assert.equal(ev(logs, 'Claimed')[0].args.previousOwner, IDR);

  // replay: the nonce moved, so the same signatures no longer verify (within their deadline: see the contest test)
  await assert.rejects(submit('carol', b), /InvalidSignature|NotRunner|Expired/);
  // control follows the owner on the other chain: a new owner there claims again with a fresh bundle
  const owner2 = Wallet.createRandom();
  await submitAndFinalize('carol', await bundleFor(id, { owner: owner2, newOwner: addr('carol') }));
  assert.equal(await idr.call('ownerOf', [id]), addr('carol'));
  // expiry
  const late = await bundleFor(id, { owner: owner2, newOwner: addr('bob') });
  c.advance(3601);
  await assert.rejects(submit('bob', late), /Expired/);
});

test('claimRemote (non-EVM owner, e.g. Solana ed25519): the runners\' quorum is the proof; local targets use claim()', async () => {
  for (const w of RUNNER_KEYS) await setRunner(w, true, MIN_AGREED, 0);
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const { id } = await registerTarget('squatter', 'sol', mint);
  const authority = '0x' + 'ab'.repeat(32); // the mint authority's ed25519 key
  const b = await bundleFor(id, { ownerKey: authority, newOwner: addr('alice'), consentBy: null });
  await submitAndFinalize('bob', b); // no ownerSig on chain: runners checked it off-chain
  assert.equal(await idr.call('ownerOf', [id]), addr('alice'));
  // still needs the quorum
  const one = await bundleFor(id, { ownerKey: authority, newOwner: addr('bob'), consentBy: null, runners: [RUNNER_KEYS[2]] });
  await assert.rejects(submit('bob', one), /Quorum/);
  // a ZETAPHY target is claimed with claim(), never with runner signatures
  const local = await registerTarget('squatter', 'eth', MOCK_ADDR.token);
  await assert.rejects(submit('bob', await bundleFor(local.id, { ownerKey: authority, newOwner: addr('mallory'), consentBy: null })), /NotRemote/);
  // and a local claim also moves the nonce (pending remote signatures die)
  await idr.send('alice', 'claim', [local.id]);
  assert.equal(await idr.call('claimNonce', [local.id]), 1n);
  // a registry deployed without runners has remote claims off
  const off = await c.deploy('NeuroIdentity', [WEB, '', ...chainArgs(), '0x' + '00'.repeat(20), 0, 0, 0], 'admin');
  const offId = ev(await off.send('alice', 'registerTarget', ['sol', mint]), 'Registered')[0].args.agentId;
  await assert.rejects(off.send('bob', 'claimRemote', [offId, addr('alice'), authority, c.now() + 60n, '0x', []]), /RemoteClaimsOff/);
  await assert.rejects(off.send('bob', 'contestClaim', [offId]), /NoPendingClaim/);
  // remote claims on need a quorum, a runner bar and a contest window of 1 hour to 30 days
  for (const [q, m, d] of [[0, MIN_AGREED, DELAY], [QUORUM, 0, DELAY], [QUORUM, MIN_AGREED, 3599], [QUORUM, MIN_AGREED, 30 * 86400 + 1]]) {
    await assert.rejects(c.deploy('NeuroIdentity', [WEB, '', ...chainArgs(), MOCK_ADDR.runners, q, m, d], 'admin'), /deploy failed/, `${q} ${m} ${d}`);
  }
});

test('claimRemote only proposes: it waits claimDelay, and one honest runner or the holder can contest it', async () => {
  for (const w of RUNNER_KEYS) await setRunner(w, true, MIN_AGREED, 0);
  // r1: a runner meeting the bar (not in the quorum); r2: active but below it
  await setRunner({ address: addr('r1') }, true, MIN_AGREED, 0);
  await setRunner({ address: addr('r2') }, true, MIN_AGREED - 1, 0);
  assert.equal(await idr.call('claimDelay'), BigInt(DELAY));

  // a colluding quorum "attests" that its own key owns an unclaimed Solana mint
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const { id } = await registerTarget('squatter', 'sol', mint);
  const fake = await bundleFor(id, { ownerKey: '0x' + 'ba'.repeat(32), newOwner: addr('mallory'), consentBy: null });
  const pl = await submit('mallory', fake);
  const prop = ev(pl, 'RemoteClaimProposed')[0].args;
  assert.equal(prop.newOwner, addr('mallory'));
  assert.equal(prop.readyAt, c.now() + BigInt(DELAY));
  assert.equal(ev(pl, 'Claimed').length, 0);
  assert.equal(await idr.call('ownerOf', [id]), IDR, 'nothing moves at proposal time');
  assert.deepEqual([...await idr.call('pendingClaim', [id])], [addr('mallory'), prop.readyAt]);
  assert.equal(await idr.call('claimNonce', [id]), 1n, 'the attestations are spent at once');
  // too early to run; one pending claim at a time
  await assert.rejects(idr.send('mallory', 'finalizeClaim', [id]), /ClaimNotReady/);
  await assert.rejects(submit('mallory', await bundleFor(id, { ownerKey: '0x' + 'ba'.repeat(32), newOwner: addr('bob'), consentBy: null })), /ClaimPending/);
  // outsiders, the registrant and runners below the bar cannot contest
  for (const who of ['bob', 'squatter', 'r2']) await assert.rejects(idr.send(who, 'contestClaim', [id]), /NotAuthorized/, who);
  // ONE honest runner in good standing cancels it
  const cl = await idr.send('r1', 'contestClaim', [id]);
  assert.deepEqual([ev(cl, 'RemoteClaimContested')[0].args.by, ev(cl, 'RemoteClaimContested')[0].args.newOwner], [addr('r1'), addr('mallory')]);
  assert.deepEqual([...await idr.call('pendingClaim', [id])], ['0x' + '00'.repeat(20), 0n]);
  // the same signatures cannot be resubmitted (nonce moved; still before their deadline)
  await assert.rejects(submit('mallory', fake), /InvalidSignature|NotRunner/); // stale digests recover to non-runners
  c.advance(DELAY);
  await assert.rejects(idr.send('mallory', 'finalizeClaim', [id]), /NoPendingClaim/);
  await assert.rejects(idr.send('r1', 'contestClaim', [id]), /NoPendingClaim/);
  assert.equal(await idr.call('ownerOf', [id]), IDR);

  // an EVM identity already claimed by alice: a takeover proposal can be contested by alice herself
  const owner = Wallet.createRandom();
  const t = await registerTarget('squatter', 'bsc', '0x' + 'e1'.repeat(20));
  await submitAndFinalize('bob', await bundleFor(t.id, { owner, newOwner: addr('alice') }));
  assert.equal(await idr.call('ownerOf', [t.id]), addr('alice'));
  const attacker = Wallet.createRandom(); // the quorum attests that the attacker's key owns the target
  await submit('mallory', await bundleFor(t.id, { owner: attacker, newOwner: addr('mallory') }));
  await assert.rejects(idr.send('mallory', 'contestClaim', [t.id]), /NotAuthorized/);
  await idr.send('alice', 'contestClaim', [t.id]);
  c.advance(DELAY);
  await assert.rejects(idr.send('mallory', 'finalizeClaim', [t.id]), /NoPendingClaim/);
  assert.equal(await idr.call('ownerOf', [t.id]), addr('alice'));
  // the holder's approved operator may contest too
  await submit('mallory', await bundleFor(t.id, { owner: attacker, newOwner: addr('mallory') }));
  await idr.send('alice', 'setApprovalForAll', [addr('carol'), true]);
  await idr.send('carol', 'contestClaim', [t.id]);

  // the window closes: no contest after readyAt, and anyone may run the claim then
  const good = await bundleFor(t.id, { owner, newOwner: addr('bob') });
  await submit('bob', good);
  c.advance(DELAY - 1);
  await assert.rejects(idr.send('mallory', 'finalizeClaim', [t.id]), /ClaimNotReady/);
  c.advance(1);
  await assert.rejects(idr.send('alice', 'contestClaim', [t.id]), /ContestClosed/);
  const fl = await idr.send('mallory', 'finalizeClaim', [t.id]);
  assert.equal(ev(fl, 'Claimed')[0].args.previousOwner, addr('alice'));
  assert.equal(await idr.call('ownerOf', [t.id]), addr('bob'));
  await assert.rejects(idr.send('mallory', 'finalizeClaim', [t.id]), /NoPendingClaim/);
  // proposing the current holder again is refused up front
  await assert.rejects(submit('bob', await bundleFor(t.id, { owner, newOwner: addr('bob') })), /AlreadyHolder/);
});

test('runner tool: the owner is read from the Neuro report and the consent checked before signing', async () => {
  // EVM: owner() / getOwner() and the EIP-1967 admin count
  const owner = Wallet.createRandom();
  const evmReport = { owner: owner.address, proxy: { kind: 'eip1967', admin: '0x' + '0a'.repeat(20) } };
  assert.deepEqual(remoteOwners(evmReport).map((o) => [o.role, o.scheme]), [['owner() / getOwner()', 'secp256k1'], ['EIP-1967 admin', 'secp256k1']]);
  assert.deepEqual(remoteOwners({ owner: '0x' + '00'.repeat(20) }), [], 'renounced: nobody');
  const { id } = await registerTarget('squatter', 'bsc', '0x' + 'ef'.repeat(20));
  const b = await bundleFor(id, { owner, newOwner: addr('alice'), runners: [] });
  b.deadline = String(Math.floor(Date.now() / 1000) + 600); // checked against the wall clock off-chain
  b.ownerSig = await owner.signTypedData(claimDomain(1, IDR), CLAIM_TYPES.consent, claimValues(b));
  assert.equal((await checkClaimBundle(b, remoteOwners(evmReport), { verifyTypedData })).ok, true);
  assert.match((await checkClaimBundle({ ...b, ownerKey: '0x' + '0b'.repeat(20) }, remoteOwners(evmReport), { verifyTypedData })).reason, /not the target's owner/);
  assert.match((await checkClaimBundle({ ...b, newOwner: addr('mallory') }, remoteOwners(evmReport), { verifyTypedData })).reason, /not from the owner/);
  assert.match((await checkClaimBundle({ ...b, ownerSig: null }, remoteOwners(evmReport), { verifyTypedData })).reason, /not signed/);

  // Solana: the mint/upgrade authority, an ed25519 key; the consent is a text message
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = '0x' + publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt(pub); let b58 = ''; while (n > 0n) { b58 = B58[Number(n % 58n)] + b58; n /= 58n; }
  b58 = '1'.repeat(pub.slice(2).match(/^(00)*/)[0].length / 2) + b58; // base58 keeps each leading zero byte as '1'
  assert.equal('0x' + base58Decode(b58).toString('hex'), pub);
  const solReport = { solana: { program: 'SPL Token', mintAuthority: b58, freezeAuthority: null } };
  assert.deepEqual(remoteOwners(solReport), [{ key: pub, scheme: 'ed25519', role: 'mint authority' }]);
  const sb = { ...b, ownerKey: pub };
  const text = consentText(sb);
  assert.match(text, /^ZETAPHY Neuro identity claim\nregistry: eip155:1:0x[0-9a-f]{40}\nagent: \d+\ntarget: eip155:56:0x(ef){20}\nnew owner: 0x/);
  sb.ownerSig = '0x' + edSign(null, Buffer.from(text), privateKey).toString('hex');
  assert.equal(await verifyEd25519(pub, text, sb.ownerSig), true);
  assert.equal((await checkClaimBundle(sb, remoteOwners(solReport), { verifyTypedData })).ok, true);
  assert.equal((await checkClaimBundle({ ...sb, nonce: '7' }, remoteOwners(solReport), { verifyTypedData })).ok, false, 'bound to the nonce');
  // owners Neuro reads but cannot check a consent for yet are refused, not guessed
  assert.match((await checkClaimBundle({ ...b, ownerKey: '0:' + 'ad'.repeat(32) }, remoteOwners({ ton: { admin: '0:' + 'ad'.repeat(32) } }), { verifyTypedData })).reason, /no consent check/);

  // the attestation a runner signs is exactly what the registry checks
  const att = await signAttestation(RUNNER_KEYS[0], b);
  assert.equal(verifyTypedData(claimDomain(1, IDR), CLAIM_TYPES.attestation, claimValues(b), att.sig), RUNNER_KEYS[0].address);
  assert.equal(sortedAttestations([att, att]).length, 1, 'one per runner');
});
