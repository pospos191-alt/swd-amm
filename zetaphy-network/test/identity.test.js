import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import { Interface, Wallet, ZeroHash, keccak256, toUtf8Bytes, id as topicId, getBytes, getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import { chainArgs, canonicalTarget, decodeAgentURI, NEURO_CHAINS } from '../src/identity.js';

// Test chain: @ethereumjs Mainnet common, so block.chainid = 1 and "eth"
// (eip155:1) plays the role of "this chain" (on ZETAPHY it is "zetaphy").
const WEB = 'https://neuro.example/web/';
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
  idr = await c.deploy('NeuroIdentity', [WEB, '', ...chainArgs()], 'admin');
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
  assert.equal(canonicalTarget('bitcoin', 'UNCOMMON•GOODS').account, 'UNCOMMON%E2%80%A2GOODS');
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
  assert.equal(decodeAgentURI(await idr.call('tokenURI', [r.id])).services[0].endpoint, `https://neuro2.example/web/?chain=bitcoin&address=UNCOMMON%E2%80%A2GOODS`);
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
  const rh = await val.call('verdictRequestHash', [id, addr('r1'), V]);
  assert.equal(req.requestHash, rh);
  const st = await val.call('getValidationStatus', [rh]);
  assert.deepEqual([st[0], st[1], st[2], st[3], st[4]], [addr('r1'), id, 20n, V, 'neuro-v1']);

  await val.send('r2', 'postVerdict', [id, V, 30, '', 'neuro-v1']);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 25n]);
  assert.deepEqual([...await val.call('getSummary', [id, [addr('r2')], ''])], [1n, 30n]);
  assert.deepEqual([...await val.call('getSummary', [id, [], 'other'])], [0n, 0n]);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2);
  assert.deepEqual([...await val.call('getValidatorRequests', [addr('r1')])], [rh]);
  // the same runner, same verdict: an update, not a new entry
  await val.send('r1', 'postVerdict', [id, V, 40, '', 'neuro-v1']);
  assert.equal((await val.call('getAgentValidations', [id])).length, 2);
  assert.deepEqual([...await val.call('getSummary', [id, [], ''])], [2n, 35n]);

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
