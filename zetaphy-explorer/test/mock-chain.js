// A small fake ZETAPHY node for the browser test: CometBFT RPC, Cosmos REST
// and EVM JSON-RPC answers built from real bytes, so the explorer's decoders
// and the ML-DSA-44 certificate check run on the same data a node would give:
//   - 30 blocks with correct CometBFT header hashes and data hashes
//   - from block 3, tx[0] of block H+1 is a MsgPQCertificate for H signed with
//     ML-DSA-44 by validator Alpha (60 power, vote key registered); Beta (40)
//     has no key. The certificate of block 26 (in block 27) carries a broken
//     signature, so that block must show as NOT verified.
//   - user txs: Cosmos (MsgSend + MsgEVMCall as owner + MsgQuantumLock, ML-DSA-44 signer),
//     a failed MsgPQVoteKey, MsgSetPQEvidence, and an EVM tx with ERC-20 / 721 / 1155 transfers
//   - a ThreatRegistry that flags the ERC-20 token's address (reason 2) with evidence and a response
//   - the deep tx view: debug_traceTransaction (callTracer, prestateTracer diff) for a swap through a
//     router verified on Sourcify (answered by sourcify()), a failed swap (custom error), an unlimited
//     approval the node has no traces for; an EIP-1967 proxy in front of the router
import { readFileSync } from 'node:fs';
import { Wallet, Transaction, AbiCoder, Interface, MaxUint256 } from 'ethers';
import {
  ml_dsa44, sha256, keccak_256, bytesToHex, hexToBytes, headerHash, txsHash, voteMessage, varint, toBech32,
  encodeTxRaw, encodeTxBody, encodeAuthInfo, encodeMsgSend, encodeMsgEVMCall, encodeMsgQuantumLock, addressKey, THREAT_SEL, DETAIL_SEL,
} from '../vendor/zetaphy-lib.js';

export const CHAIN_ID = 'zetaphy_77390-1';
export const LATEST = 30;
export const ME_HEX = '0x6DA134EbFcb035273E87954f0641bD920ED073Ba';
export const ME = 'zetaphy1dksnf6lukq6jw058j48svsdajg8dqua6n67l9r';
export const LOCKED_HEX = '0x' + '11'.repeat(20);
export const LOCKED = 'zetaphy1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3huramw';
export const TOKEN = '0x3333333333333333333333333333333333333333';
export const NFT = '0x4444444444444444444444444444444444444444';
export const MULTI = '0x5555555555555555555555555555555555555555';
export const REGISTRY = '0x7777777777777777777777777777777777777777';
/** AuditCertificate: TOKEN holds a valid Gold certificate; every other address none. */
export const AUDIT_CERT = '0xa0d1a0d1a0d1a0d1a0d1a0d1a0d1a0d1a0d1a0d1';
export const TOKEN_NAME = '<img src=x onerror="window.__pwned=1">Sawasdee‮txt.exe';
export const REPORT = '0x' + 'e7'.repeat(32);
// An address with a long history (57 MsgSends to LOCKED) that only the node's tx index
// answers (event queries, at most 25 per page here): for the history, paging and CSV tests.
// (0xb5…: not 0x88…, which is the ROUTER contract of the deep tx view)
export const BUSY_HEX = '0x' + 'b5'.repeat(20);
export const BUSY = toBech32(hexToBytes('b5'.repeat(20)), 'zetaphy');
export const BUSY_TXS = 57;
export const PER_PAGE_CAP = 25;
// A 6-hop chain of native transfers FLOW[0] -> FLOW[1] -> … -> FLOW[6] (100, 90, … 50 ZETAPHY), plus one
// transfer back FLOW[4] -> FLOW[2] (a cycle), in the node's tx index only: for the fund-flow "follow" test.
export const FLOW_HEX = Array.from({ length: 7 }, (_, i) => '0x' + `f${i}`.repeat(20));
export const FLOW = FLOW_HEX.map((x) => toBech32(hexToBytes(x.slice(2)), 'zetaphy'));
export const FLOW_AMOUNTS = [100n, 90n, 80n, 70n, 60n, 50n].map((x) => x * 10n ** 18n);
export const RESPONSE_TEXT = 'Minting is limited by our DAO vote.';
export const ROUTER = '0x8888888888888888888888888888888888888888';
export const PROXY = '0x9999999999999999999999999999999999999999';
export const PAIR = '0x6666666666666666666666666666666666666666';
export const FACTORY = '0xfac7000000000000000000000000000000000001';
export const DEPLOYER = '0xde91000000000000000000000000000000000002';
export const WNATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
export const ROUTER_ABI = JSON.parse(readFileSync(new URL('../../zetaphy-dex/artifacts/ZetaphyRouter.json', import.meta.url), 'utf8')).abi;
const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
// Hyperlane (crosschain.json): ZETAPHY's Mailbox and Sepolia (domain 11155111).
export const MAILBOX = '0x0f1C59C6e98c88E1ddc2Ff98Bee11dadA07fEaCe';
export const SEPOLIA_DOMAIN = 11155111;
export const SEPOLIA_DELIVERY_TX = '0x' + 'd1'.repeat(32);
// validators (deep), governance, holders, NFT gallery, gas, tools
// the SWD token's owner and first minter (holders page); not the router's DEPLOYER above
export const TOKEN_OWNER = '0x' + '5e'.repeat(20);
export const NFT_META_7 = { name: 'Siam <b>Temple</b> #7', description: '<script>window.__pwned=2</script>Sunrise over Wat Arun\u202e', image: 'ipfs://bafyimg7/7.png',
  external_url: 'javascript:alert(1)', attributes: [{ trait_type: 'Colour', value: 'Gold' }, { trait_type: '<i>Rarity</i>', value: 'Rare' }] };
export const NFT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="window.__pwned=3"><script>window.__pwned=4</script><rect width="10" height="10" fill="gold"/></svg>';
export const NFT_META_8 = { name: 'Siam Art #8', description: 'A gold square.', image: 'data:image/svg+xml;base64,' + Buffer.from(NFT_SVG).toString('base64'), external_url: 'https://siam.art/8' };
export const IPFS_FILES = { '/ipfs/QmMeta8/8.json': JSON.stringify(NFT_META_8) }; // served by the test as https://ipfs.io/…

const concat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const lenField = (f, b) => concat(varint((f << 3) | 2), varint(b.length), b);
const uintField = (f, v) => concat(varint(f << 3), varint(v));
const utf8 = (s) => new TextEncoder().encode(s);
const b64 = (b) => Buffer.from(b).toString('base64');
const upper = (b) => bytesToHex(b).toUpperCase();
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const hexq = (n) => '0x' + BigInt(n).toString(16);
const coder = AbiCoder.defaultAbiCoder();
const sel4 = (sig) => bytesToHex(keccak_256(utf8(sig))).slice(0, 8);
const topic = (sig) => '0x' + bytesToHex(keccak_256(utf8(sig)));
const addrTopic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const strTail = (s) => { const h = Buffer.from(s).toString('hex'); return word(h.length / 2) + h.padEnd(64 * Math.ceil(h.length / 64 || 1), '0'); };

function makeValidator(name, seedByte, power, keyed) {
  const ed = new Uint8Array(32).fill(seedByte);
  const keys = ml_dsa44.keygen(new Uint8Array(32).fill(seedByte));
  const cons = sha256(ed).subarray(0, 20);
  const opBytes = new Uint8Array(20).fill(seedByte + 1);
  return { name, power, keyed, edB64: b64(ed), address: upper(cons), consBytes: cons, keys,
    operator: toBech32(opBytes, 'zetaphyvaloper'), account: toBech32(opBytes, 'zetaphy') };
}

export const GOV_ADDR = toBech32(new Uint8Array(20).fill(0x0d), 'zetaphy');

export function buildChain() {
  const vals = [makeValidator('Alpha Node', 7, 60n, true), makeValidator('Beta‮ Node', 9, 40n, false)];
  const evmWallet = new Wallet('0x' + '22'.repeat(32));
  const start = Date.now() - LATEST * 5000;
  const blocks = new Map(); // height -> { header, hash, txs: [bytes], results: [{code,…}] }
  const state = { noEventIndex: false }; // tests flip this to act as a node that refuses event queries
  const txIndex = new Map(); // comet hash (upper) -> { height, index }
  const evm = { txs: new Map(), receipts: new Map(), logs: [] };

  // user txs by height
  const signer = { publicKey: ml_dsa44.keygen(new Uint8Array(32).fill(1)).publicKey, sequence: 3n };
  const cosmosTx = (messages, memo = '') => encodeTxRaw({
    bodyBytes: encodeTxBody({ messages, memo }),
    authInfoBytes: encodeAuthInfo({ signerInfos: [signer], fee: { amount: [{ denom: 'azetaphy', amount: '400000000000000' }], gasLimit: 400000n } }),
    signatures: [new Uint8Array(2420)],
  });
  const user = {
    20: [[cosmosTx([
      { typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: encodeMsgSend({ fromAddress: ME, toAddress: LOCKED, amount: [{ denom: 'azetaphy', amount: '2500000000000000000' }] }) },
      { typeUrl: '/zetaphy.pq.v1.MsgEVMCall', value: encodeMsgEVMCall({ sender: ME, to: TOKEN, value: 0n, data: hexToBytes('a9059cbb' + word(1) + word(2)), gasLimit: 200000n, asOwner: LOCKED }) },
      { typeUrl: '/zetaphy.pq.v1.MsgQuantumLock', value: encodeMsgQuantumLock({ signer: ME, owner: LOCKED, controller: ME }) },
    ], 'gm ‮from ZETAPHY'), { code: 0, gas_used: '123456', gas_wanted: '400000', events: [{ type: 'message', attributes: [{ key: 'sender', value: ME }] },
      { type: 'transfer', attributes: [{ key: 'recipient', value: LOCKED }, { key: 'sender', value: ME }, { key: 'amount', value: '2500000000000000000azetaphy' }] }] }]],
    21: [[cosmosTx([{ typeUrl: '/zetaphy.pq.v1.MsgPQVoteKey', value: concat(lenField(1, utf8(vals[1].operator)), lenField(2, vals[1].keys.publicKey), lenField(3, new Uint8Array(2420).fill(3))) }]),
      { code: 4, log: 'unauthorized: proof does not verify', gas_used: '90000', gas_wanted: '600000', events: [] }]],
    24: [[cosmosTx([{ typeUrl: '/zetaphy.pq.v1.MsgSetPQEvidence', value: concat(lenField(1, utf8(ME)), uintField(2, 1)) }]), { code: 0, gas_used: '50000', gas_wanted: '400000', events: [{ type: 'message', attributes: [{ key: 'sender', value: ME }] }] }]],
  };
  // block 22: an EVM tx (MetaMask style) that moves three kinds of tokens
  const etx = Transaction.from({ type: 2, chainId: 77390, nonce: 4, maxPriorityFeePerGas: 1000000000n, maxFeePerGas: 2000000000n, gasLimit: 150000n, to: TOKEN, value: 0n, data: '0xa9059cbb' + word(BigInt(ME_HEX)) + word(15n * 10n ** 17n) });
  etx.signature = evmWallet.signingKey.sign(etx.unsignedHash);
  const ethMsg = concat(lenField(5, hexToBytes(evmWallet.address)), lenField(6, hexToBytes(etx.serialized)));
  user[22] = [[encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: '/cosmos.evm.vm.v1.MsgEthereumTx', value: ethMsg }] }), authInfoBytes: new Uint8Array(), signatures: [] }),
    { code: 0, gas_used: '61234', gas_wanted: '150000', events: [{ type: 'ethereum_tx', attributes: [{ key: 'ethereumTxHash', value: etx.hash }, { key: 'recipient', value: TOKEN }] },
      { type: 'message', attributes: [{ key: 'sender', value: evmWallet.address }, { key: 'module', value: 'evm' }] }] }]];
  const evmLogs = [
    { address: TOKEN, topics: [topic('Transfer(address,address,uint256)'), addrTopic(evmWallet.address), addrTopic(ME_HEX)], data: '0x' + word(15n * 10n ** 17n) },
    { address: NFT, topics: [topic('Transfer(address,address,uint256)'), addrTopic('0x' + '00'.repeat(20)), addrTopic(ME_HEX), '0x' + word(7)], data: '0x' },
    { address: MULTI, topics: [topic('TransferSingle(address,address,address,uint256,uint256)'), addrTopic(evmWallet.address), addrTopic(evmWallet.address), addrTopic(ME_HEX)], data: '0x' + word(3) + word(10) },
  ].map((l, i) => ({ ...l, blockNumber: hexq(22), transactionHash: etx.hash, logIndex: hexq(i), transactionIndex: '0x1', blockHash: '0x' + 'ab'.repeat(32), removed: false }));
  evm.logs.push(...evmLogs);
  // holders: block 5 mints 900,000 SWD to TOKEN_OWNER (also the owner), block 6 sends 100 to the EVM wallet; block 23 mints NFT #8
  const extraLog = (n, l, i) => ({ ...l, blockNumber: hexq(n), transactionHash: '0x' + String(n).padStart(2, '0').repeat(32), logIndex: hexq(i), transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32), removed: false });
  evm.logs.push(
    extraLog(5, { address: TOKEN, topics: [topic('Transfer(address,address,uint256)'), addrTopic('0x' + '00'.repeat(20)), addrTopic(TOKEN_OWNER)], data: '0x' + word(900000n * 10n ** 18n) }, 0),
    extraLog(6, { address: TOKEN, topics: [topic('Transfer(address,address,uint256)'), addrTopic(TOKEN_OWNER), addrTopic(evmWallet.address)], data: '0x' + word(100n * 10n ** 18n) }, 0),
    extraLog(23, { address: NFT, topics: [topic('Transfer(address,address,uint256)'), addrTopic('0x' + '00'.repeat(20)), addrTopic(evmWallet.address), '0x' + word(8)], data: '0x' }, 0),
  );
  evm.txs.set(etx.hash, { hash: etx.hash, blockNumber: hexq(22), blockHash: '0x' + 'ab'.repeat(32), transactionIndex: '0x1', from: evmWallet.address, to: TOKEN, value: '0x0',
    gas: hexq(150000), gasPrice: hexq(2000000000n), maxFeePerGas: hexq(2000000000n), maxPriorityFeePerGas: hexq(1000000000n), nonce: '0x4', input: etx.data, type: '0x2', chainId: hexq(77390) });
  evm.receipts.set(etx.hash, { transactionHash: etx.hash, status: '0x1', blockNumber: hexq(22), gasUsed: hexq(61234), effectiveGasPrice: hexq(1500000000n), contractAddress: null, from: evmWallet.address, to: TOKEN, logs: evmLogs });

  // ---- the deep tx view (EVM txs only known to the EVM RPC, in block 23) ----
  const traces = new Map(); // hash -> { call (callTracer), prestate (prestateTracer, diffMode) }
  const W = evmWallet.address;
  const tokenIface = new Interface(['function transfer(address to,uint256 value)', 'function approve(address spender,uint256 value)', 'function balanceOf(address)']);
  const router = new Interface(ROUTER_ABI);
  const deepHash = (n) => '0x' + bytesToHex(keccak_256(utf8(`zetaphy-deep-tx-${n}`)));
  const GAS_PRICE = 1500000000n;
  const addEvmTx = (hash, { to, value = 0n, input, status = '0x1', gasUsed, logs = [] }) => {
    const L = logs.map((l, i) => ({ ...l, blockNumber: hexq(23), transactionHash: hash, logIndex: hexq(i), transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32), removed: false }));
    evm.txs.set(hash, { hash, blockNumber: hexq(23), blockHash: '0x' + 'cd'.repeat(32), transactionIndex: '0x0', from: W, to, value: hexq(value), gas: hexq(300000), gasPrice: hexq(2000000000n),
      maxFeePerGas: hexq(2000000000n), maxPriorityFeePerGas: hexq(1000000000n), nonce: '0x5', input, type: '0x2', chainId: hexq(77390) });
    evm.receipts.set(hash, { transactionHash: hash, status, blockNumber: hexq(23), gasUsed: hexq(gasUsed), effectiveGasPrice: hexq(GAS_PRICE), contractAddress: null, from: W, to, logs: L });
  };
  const TEN = 10n * 10n ** 18n; const OUT = 1234n * 10n ** 18n; const START = 100n * 10n ** 18n;
  // 1. 10 ZETAPHY -> 1,234 SWD through the verified router, traced
  const swapHash = deepHash('swap');
  const swapInput = router.encodeFunctionData('swapExactETHForTokens', [1000n, [WNATIVE, TOKEN], W, 1900000000n]);
  addEvmTx(swapHash, { to: ROUTER, value: TEN, input: swapInput, gasUsed: 120000n,
    logs: [{ address: TOKEN, topics: [topic('Transfer(address,address,uint256)'), addrTopic(PAIR), addrTopic(W)], data: '0x' + word(OUT) }] });
  traces.set(swapHash, {
    call: { type: 'CALL', from: W, to: ROUTER, value: hexq(TEN), gas: hexq(300000), gasUsed: hexq(120000), input: swapInput, output: coder.encode(['uint256[]'], [[TEN, OUT]]), calls: [
      { type: 'CALL', from: ROUTER, to: WNATIVE, value: hexq(TEN), gas: hexq(250000), gasUsed: hexq(20000), input: '0xd0e30db0', output: '0x' },
      { type: 'CALL', from: ROUTER, to: WNATIVE, value: '0x0', gas: hexq(230000), gasUsed: hexq(9000), input: tokenIface.encodeFunctionData('transfer', [PAIR, TEN]), output: '0x' + word(1) },
      { type: 'CALL', from: ROUTER, to: PAIR, value: '0x0', gas: hexq(200000), gasUsed: hexq(60000), input: '0x022c0d9f' + word(0) + word(OUT) + word(BigInt(W)) + word(128) + word(0), output: '0x', calls: [
        { type: 'CALL', from: PAIR, to: TOKEN, value: '0x0', gas: hexq(150000), gasUsed: hexq(30000), input: tokenIface.encodeFunctionData('transfer', [W, OUT]), output: '0x' + word(1) },
        { type: 'STATICCALL', from: PAIR, to: TOKEN, gas: hexq(100000), gasUsed: hexq(2000), input: tokenIface.encodeFunctionData('balanceOf', [PAIR]), output: '0x' + word(5) },
      ] },
      { type: 'CALL', from: ROUTER, to: REGISTRY, value: '0x0', gas: hexq(50000), gasUsed: hexq(1000), input: '0x12345678', output: '0x', error: 'execution reverted' },
    ] },
    prestate: { pre: { [W.toLowerCase()]: { balance: hexq(START), nonce: 5 }, [WNATIVE.toLowerCase()]: { balance: '0x0' } },
      post: { [W.toLowerCase()]: { balance: hexq(START - TEN - 120000n * GAS_PRICE), nonce: 6 }, [WNATIVE.toLowerCase()]: { balance: hexq(TEN) } } },
  });
  // 2. the same swap after its deadline: reverts with the router's custom error Expired()
  const failHash = deepHash('fail');
  const failInput = router.encodeFunctionData('swapExactETHForTokens', [1000n, [WNATIVE, TOKEN], W, 1n]);
  addEvmTx(failHash, { to: ROUTER, value: 10n ** 18n, input: failInput, status: '0x0', gasUsed: 30000n });
  traces.set(failHash, {
    call: { type: 'CALL', from: W, to: ROUTER, value: hexq(10n ** 18n), gas: hexq(300000), gasUsed: hexq(30000), input: failInput, output: router.encodeErrorResult('Expired', []), error: 'execution reverted' },
    prestate: { pre: { [W.toLowerCase()]: { balance: hexq(START) } }, post: { [W.toLowerCase()]: { balance: hexq(START - 30000n * GAS_PRICE) } } },
  });
  // 3. an unlimited approval of SWD to the router; this node has no trace for it
  const approveHash = deepHash('approve');
  addEvmTx(approveHash, { to: TOKEN, input: tokenIface.encodeFunctionData('approve', [ROUTER, MaxUint256]), gasUsed: 46000n,
    logs: [{ address: TOKEN, topics: [topic('Approval(address,address,uint256)'), addrTopic(W), addrTopic(ROUTER)], data: '0x' + MaxUint256.toString(16) }] });
  // the block 22 tx: a plain call, traced
  traces.set(etx.hash, {
    call: { type: 'CALL', from: W, to: TOKEN, value: '0x0', gas: hexq(150000), gasUsed: hexq(61234), input: etx.data, output: '0x' + word(1) },
    prestate: { pre: { [W.toLowerCase()]: { balance: hexq(START) } }, post: { [W.toLowerCase()]: { balance: hexq(START - 61234n * GAS_PRICE) } } },
  });

  /** Sourcify's v2 answer for an address (the router is verified; anything else is not). */
  function sourcify(address) {
    if (String(address).toLowerCase() !== ROUTER.toLowerCase()) return null;
    return { match: 'exact_match', creationMatch: 'exact_match', runtimeMatch: 'exact_match', chainId: '77390', address: ROUTER, abi: ROUTER_ABI,
      compilation: { language: 'Solidity', compiler: 'solc', compilerVersion: '0.8.28+commit.7893614a', name: 'ZetaphyRouter', fullyQualifiedName: 'contracts/ZetaphyRouter.sol:ZetaphyRouter' },
      sources: { 'contracts/ZetaphyRouter.sol': { content: '// SPDX-License-Identifier: BUSL-1.1\npragma solidity 0.8.28;\n\ncontract ZetaphyRouter { /* <script>window.__pwned=2</script> */ }\n' },
        'contracts/interfaces/IZetaphyPair.sol': { content: 'interface IZetaphyPair {}\n' } },
      deployment: { transactionHash: '0x' + 'de'.repeat(32), blockNumber: '3', transactionIndex: '0', deployer: DEPLOYER } };
  }
  // block 23: an EVM tx to ZETAPHY's Hyperlane Mailbox (2 ZETAPHY) that dispatches a message to Sepolia
  const hlMessage = concat(new Uint8Array([3]), hexToBytes(word(7).slice(56)), hexToBytes(word(77390).slice(56)), hexToBytes(word(BigInt(evmWallet.address))),
    hexToBytes(word(SEPOLIA_DOMAIN).slice(56)), hexToBytes(word(BigInt(ME_HEX))), utf8('hello sepolia'));
  const hlId = '0x' + bytesToHex(keccak_256(hlMessage));
  const dtx = Transaction.from({ type: 2, chainId: 77390, nonce: 5, maxPriorityFeePerGas: 1000000000n, maxFeePerGas: 2000000000n, gasLimit: 300000n, to: MAILBOX, value: 2n * 10n ** 18n,
    data: '0x' + sel4('dispatch(uint32,bytes32,bytes)') + word(SEPOLIA_DOMAIN) + word(BigInt(ME_HEX)) + word(96) + strTail('hello sepolia') });
  dtx.signature = evmWallet.signingKey.sign(dtx.unsignedHash);
  user[23] = [[encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: '/cosmos.evm.vm.v1.MsgEthereumTx', value: concat(lenField(5, hexToBytes(evmWallet.address)), lenField(6, hexToBytes(dtx.serialized))) }] }), authInfoBytes: new Uint8Array(), signatures: [] }),
    { code: 0, gas_used: '120000', gas_wanted: '300000', events: [{ type: 'ethereum_tx', attributes: [{ key: 'ethereumTxHash', value: dtx.hash }] }] }]];
  const hlLogs = [
    { address: MAILBOX, topics: [topic('Dispatch(address,uint32,bytes32,bytes)'), addrTopic(evmWallet.address), '0x' + word(SEPOLIA_DOMAIN), addrTopic(ME_HEX)],
      data: '0x' + word(32) + word(hlMessage.length) + bytesToHex(hlMessage).padEnd(64 * Math.ceil(hlMessage.length / 32), '0') },
    { address: MAILBOX, topics: [topic('DispatchId(bytes32)'), hlId], data: '0x' },
  ].map((l, i) => ({ ...l, blockNumber: hexq(23), transactionHash: dtx.hash, logIndex: hexq(i), transactionIndex: '0x0', blockHash: '0x' + 'cd'.repeat(32), removed: false }));
  evm.logs.push(...hlLogs);
  evm.txs.set(dtx.hash, { hash: dtx.hash, blockNumber: hexq(23), blockHash: '0x' + 'cd'.repeat(32), transactionIndex: '0x0', from: evmWallet.address, to: MAILBOX, value: hexq(2n * 10n ** 18n),
    gas: hexq(300000), gasPrice: hexq(2000000000n), maxFeePerGas: hexq(2000000000n), maxPriorityFeePerGas: hexq(1000000000n), nonce: '0x5', input: dtx.data, type: '0x2', chainId: hexq(77390) });
  evm.receipts.set(dtx.hash, { transactionHash: dtx.hash, status: '0x1', blockNumber: hexq(23), gasUsed: hexq(120000), effectiveGasPrice: hexq(1500000000n), contractAddress: null, from: evmWallet.address, to: MAILBOX, logs: hlLogs });

  let prevHash = ''; let prevSigned = null; let latest = 0;
  function makeBlock(H) {
    const txs = []; const results = [];
    // tx[0]: the certificate of block H-1 (keys valid from block 2)
    if (H >= 3 && prevSigned) {
      const att = concat(...prevSigned.map((s) => concat(s.cons, s.sig)));
      txs.push(encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: '/zetaphy.pq.v1.MsgPQCertificate', value: concat(lenField(1, utf8(vals[0].account)), uintField(2, H - 1), lenField(3, att)) }] }), authInfoBytes: new Uint8Array(), signatures: [] }));
      results.push({ code: 0, gas_used: '0', gas_wanted: '0', events: [] });
    }
    for (const [bytes, res] of user[H] ?? []) { txs.push(bytes); results.push(res); }
    const header = {
      version: { block: '11', app: '0' }, chain_id: CHAIN_ID, height: String(H), time: new Date(start + H * 5000).toISOString(),
      last_block_id: { hash: prevHash, parts: { total: prevHash ? 1 : 0, hash: prevHash ? upper(sha256(utf8(`parts${H}`))) : '' } },
      last_commit_hash: upper(sha256(utf8(`commit${H}`))), data_hash: upper(txsHash(txs)),
      validators_hash: upper(sha256(utf8('vals'))), next_validators_hash: upper(sha256(utf8('vals'))), consensus_hash: upper(sha256(utf8('cons'))),
      app_hash: upper(sha256(utf8(`app${H}`))), last_results_hash: upper(sha256(utf8(`res${H}`))), evidence_hash: upper(sha256(new Uint8Array())),
      proposer_address: vals[H % 2].address,
    };
    const hash = upper(headerHash(header));
    blocks.set(H, { header, hash, txs, results });
    txs.forEach((t, i) => txIndex.set(upper(sha256(t)), { height: H, index: i }));
    // Alpha signs block H (its key is valid for votes on H >= 2); block 26's signature is broken
    prevSigned = H >= 2 ? vals.filter((v) => v.keyed).map((v) => {
      const sig = ml_dsa44.sign(voteMessage(CHAIN_ID, H, hexToBytes(hash)), v.keys.secretKey);
      if (H === 26) sig[10] ^= 0xff;
      return { cons: v.consBytes, sig };
    }) : null;
    prevHash = hash;
    latest = H;
  }
  for (let H = 1; H <= LATEST; H++) makeBlock(H);

  // BUSY's history: in the node's tx index only (not in blocks), heights 1..19, three per block.
  const busyTxs = [];
  for (let k = 0; k < BUSY_TXS; k++) {
    const height = 19 - Math.floor(k / 3); const index = 1 + (k % 3);
    const bytes = cosmosTx([{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: encodeMsgSend({ fromAddress: BUSY, toAddress: LOCKED, amount: [{ denom: 'azetaphy', amount: String(1000 + k) }] }) }], `busy ${k}`);
    busyTxs.push({ hash: upper(sha256(bytes)), height: String(height), index, tx: b64(bytes),
      tx_result: { code: 0, gas_used: '50000', gas_wanted: '200000', events: [{ type: 'message', attributes: [{ key: 'sender', value: BUSY }] },
        { type: 'transfer', attributes: [{ key: 'recipient', value: LOCKED }, { key: 'sender', value: BUSY }, { key: 'amount', value: `${1000 + k}azetaphy` }] }] } });
  }
  const sendTx = (from, to, amount, memo, height, index) => {
    const bytes = cosmosTx([{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: encodeMsgSend({ fromAddress: from, toAddress: to, amount: [{ denom: 'azetaphy', amount: String(amount) }] }) }], memo);
    return { hash: upper(sha256(bytes)), height: String(height), index, tx: b64(bytes),
      tx_result: { code: 0, gas_used: '50000', gas_wanted: '200000', events: [{ type: 'message', attributes: [{ key: 'sender', value: from }] },
        { type: 'transfer', attributes: [{ key: 'recipient', value: to }, { key: 'sender', value: from }, { key: 'amount', value: `${amount}azetaphy` }] }] } };
  };
  FLOW_AMOUNTS.forEach((amt, i) => busyTxs.push(sendTx(FLOW[i], FLOW[i + 1], amt, `flow hop ${i + 1}`, 3 + 2 * i, 5)));
  busyTxs.push(sendTx(FLOW[4], FLOW[2], 10n ** 18n, 'flow back', 16, 6));
  // Pending txs in the "mempool" (unconfirmed_txs), and new blocks made by the tests.
  const mempool = [];
  const pendingTx = (k) => cosmosTx([{ typeUrl: '/cosmos.bank.v1beta1.MsgSend', value: encodeMsgSend({ fromAddress: ME, toAddress: BUSY, amount: [{ denom: 'azetaphy', amount: String(7n * 10n ** 17n + BigInt(k)) }] }) }], `pending ${k}`);
  /** Puts a new pending tx in the mempool; returns its CometBFT hash. */
  function addPending() { const b = pendingTx(mempool.length + 100); mempool.push(b); return upper(sha256(b)); }
  /** Makes the next block with the mempool's txs in it; returns its height. */
  function addBlock() {
    const H = latest + 1;
    user[H] = mempool.splice(0).map((b) => [b, { code: 0, gas_used: '60000', gas_wanted: '200000', events: [{ type: 'message', attributes: [{ key: 'sender', value: ME }] },
      { type: 'transfer', attributes: [{ key: 'recipient', value: BUSY }, { key: 'sender', value: ME }] }] }]);
    makeBlock(H);
    return H;
  }
  /** The CometBFT websocket NewBlock event of height H, as the node sends it. */
  function newBlockEvent(H, id = 1) {
    const b = blocks.get(H);
    return { jsonrpc: '2.0', id, result: { query: "tm.event='NewBlock'", data: { type: 'tendermint/event/NewBlock', value: { block: { header: b.header, data: { txs: b.txs.map(b64) } }, block_id: { hash: b.hash } } } } };
  }
  // tx_search: "key='value'" conditions joined by AND, matched against the tx events.
  const eventMatch = (res, query) => query.split(' AND ').every((c) => {
    const m = /^([a-z_]+)\.([A-Za-z_]+)='([^']*)'$/.exec(c.trim());
    if (!m) throw Object.assign(new Error(`invalid query: ${c}`), { rpc: true });
    return (res.events ?? []).some((e) => e.type === m[1] && e.attributes.some((a) => a.key === m[2] && a.value === m[3]));
  });

  // ---- ThreatRegistry answers ----
  const flagged = { [addressKey(77390, TOKEN.toLowerCase())]: 2 };
  const evidence = { [addressKey(77390, TOKEN.toLowerCase())]: '0x' + REPORT.slice(2) + word(128) + word(BigInt('0x' + '99'.repeat(20))) + word(Math.floor(start / 1000)) + strTail('ipfs://neuro-report-1') };
  const responses = { [addressKey(77390, TOKEN.toLowerCase())]: ['0x' + word(160) + word(BigInt('0x' + 'ab'.repeat(20))) + word(Math.floor(start / 1000)) + word(77390) + word(BigInt(TOKEN)) + strTail(RESPONSE_TEXT)] };
  const regSel = Object.fromEntries(Object.entries(THREAT_SEL).flatMap(([what, [w, e]]) => [[w, what], [e, what]]));

  const coinBytes = (amount) => concat(lenField(1, utf8('azetaphy')), lenField(2, utf8(String(amount))));
  const SUPPLY = 1000000n * 10n ** 18n; const SUPPLY_1H_AGO = SUPPLY + 12n * 10n ** 17n;
  const voteKeyValue = (v) => (v.keyed ? b64(concat(hexToBytes(word(1).slice(48)), v.keys.publicKey)) : null);

  // ---- the three APIs ----
  function comet(method, p) {
    const blk = (h) => {
      const b = blocks.get(Number(h));
      if (!b) throw Object.assign(new Error(`height ${h} must be less than or equal to the current blockchain height ${latest}`), { rpc: true });
      // last_commit: the signatures for block h-1; Beta misses every block whose height is a multiple of 5
      const miss = (v) => v === vals[1] && (Number(h) - 1) % 5 === 0;
      const lc = Number(h) >= 2 ? { height: String(Number(h) - 1), round: 0, block_id: { hash: blocks.get(Number(h) - 1).hash },
        signatures: vals.map((v) => ({ block_id_flag: miss(v) ? 1 : 2, validator_address: v.address, timestamp: b.header.time, signature: miss(v) ? null : b64(new Uint8Array(64).fill(1)) })) } : null;
      return { block_id: { hash: b.hash, parts: { total: 1, hash: upper(sha256(utf8('p'))) } }, block: { header: b.header, data: { txs: b.txs.map(b64) }, evidence: { evidence: [] }, last_commit: lc } };
    };
    switch (method) {
      case 'status': return { node_info: { network: CHAIN_ID, moniker: 'mock', version: '0.38.17' }, sync_info: { latest_block_height: String(latest), latest_block_time: blocks.get(latest).header.time, catching_up: false } };
      case 'block': return blk(p.height);
      case 'block_by_hash': { const h = [...blocks].find(([, b]) => b.hash === upper(Buffer.from(p.hash, 'base64')))?.[0]; if (!h) return { block_id: { hash: '' }, block: null }; return blk(h); }
      case 'block_results': {
        const b = blocks.get(Number(p.height)); if (!b) throw new Error('no such block');
        const fin = Number(p.height) === 12 ? [{ type: 'slash', attributes: [{ key: 'address', value: valconsOf(vals[1]) }, { key: 'power', value: '40' }, { key: 'reason', value: 'missing_signature' }, { key: 'jailed', value: valconsOf(vals[1]) }] }] : [];
        return { height: p.height, txs_results: b.results, finalize_block_events: fin };
      }
      case 'block_search': {
        const hit = String(p.query) === `slash.address='${valconsOf(vals[1])}'`;
        return { blocks: hit ? [{ block_id: { hash: blocks.get(12).hash }, block: { header: blocks.get(12).header } }] : [], total_count: hit ? '1' : '0' };
      }
      case 'blockchain': {
        const metas = [];
        for (let h = Math.min(Number(p.maxHeight), latest); h >= Number(p.minHeight); h--) { const b = blocks.get(h); metas.push({ block_id: { hash: b.hash }, block_size: '1000', header: b.header, num_txs: String(b.txs.length) }); }
        return { last_height: String(latest), block_metas: metas };
      }
      case 'validators': return { block_height: p.height, validators: vals.map((v) => ({ address: v.address, pub_key: { type: 'tendermint/PubKeyEd25519', value: v.edB64 }, voting_power: String(v.power), proposer_priority: '0' })), count: '2', total: '2' };
      case 'abci_query': {
        if (p.path === '/store/zetaphypq/key') { const v = vals.find((x) => '02' + x.address === String(p.data).toUpperCase()); return { response: { code: 0, value: v ? voteKeyValue(v) : null, height: String(p.height) } }; }
        if (p.path === '/cosmos.gov.v1.Query/Proposal' && String(p.data) === '0802') {
          const msg = concat(lenField(1, utf8('/cosmos.bank.v1beta1.MsgSend')), lenField(2, encodeMsgSend({ fromAddress: GOV_ADDR, toAddress: ME, amount: [{ denom: 'azetaphy', amount: '5000000000000000000000' }] })));
          return { response: { code: 0, value: b64(lenField(1, concat(uintField(1, 2), lenField(2, msg), uintField(3, 2)))), height: '30' } };
        }
        if (p.path === '/cosmos.bank.v1beta1.Query/SupplyOf') return { response: { code: 0, value: b64(lenField(1, coinBytes(Number(p.height) < 0 ? SUPPLY : SUPPLY_1H_AGO))), height: String(p.height) } };
        return { response: { code: 1, log: 'unknown path' } };
      }
      case 'tx': {
        const hash = upper(Buffer.from(p.hash, 'base64'));
        const at = txIndex.get(hash);
        if (!at) throw Object.assign(new Error(`tx (${hash}) not found`), { rpc: true });
        const b = blocks.get(at.height);
        return { hash, height: String(at.height), index: at.index, tx_result: b.results[at.index], tx: b64(b.txs[at.index]) };
      }
      case 'num_unconfirmed_txs': return { n_txs: String(mempool.length), total: String(mempool.length), total_bytes: String(mempool.reduce((n, b) => n + b.length, 0)), txs: null };
      case 'unconfirmed_txs': return { n_txs: String(mempool.length), total: String(mempool.length), total_bytes: String(mempool.reduce((n, b) => n + b.length, 0)), txs: mempool.slice(0, Number(p.limit ?? 30)).map(b64) };
      case 'tx_search': {
        if (/MsgEditValidator/.test(p.query)) {
          const mine = String(p.query).includes(`message.sender='${vals[1].account}'`);
          return { txs: mine ? [{ hash: 'E'.repeat(64), height: '15', index: 0, tx: '', tx_result: { code: 0, events: [{ type: 'edit_validator', attributes: [{ key: 'commission_rate', value: '0.050000000000000000' }, { key: 'min_self_delegation', value: '1' }] }] } }] : [], total_count: mine ? '1' : '0' };
        }
        if (!/^tx\.height>=/.test(p.query)) {
          if (state.noEventIndex) throw Object.assign(new Error('tx_search: event queries are not indexed on this node'), { rpc: true });
          const all = [];
          for (let h = latest; h >= 1; h--) { const b = blocks.get(h); for (let i = b.txs.length - 1; i >= 0; i--) if (eventMatch(b.results[i], p.query)) all.push({ hash: upper(sha256(b.txs[i])), height: String(h), index: i, tx_result: b.results[i], tx: b64(b.txs[i]) }); }
          for (const x of busyTxs) if (eventMatch(x.tx_result, p.query)) all.push(x);
          all.sort((a, b) => (Number(b.height) - Number(a.height)) || (b.index - a.index));
          if (p.order_by !== 'desc') all.reverse();
          const per = Math.min(Number(p.per_page ?? 30), PER_PAGE_CAP); const page = Number(p.page ?? 1);
          if (all.length && (page - 1) * per >= all.length) throw Object.assign(new Error(`page should be within [1, ${Math.ceil(all.length / per)}] range, given ${page}`), { rpc: true });
          return { txs: all.slice((page - 1) * per, page * per), total_count: String(all.length) };
        }
        const [, lo, hi] = /tx\.height>=(\d+) AND tx\.height<=(\d+)/.exec(p.query).map(Number);
        const all = [];
        for (let h = Math.min(hi, latest); h >= lo; h--) { const b = blocks.get(h); if (!b) continue; for (let i = b.txs.length - 1; i >= 0; i--) all.push({ hash: upper(sha256(b.txs[i])), height: String(h), index: i, tx_result: b.results[i], tx: b64(b.txs[i]) }); }
        const page = Number(p.page ?? 1); const per = Number(p.per_page ?? 30);
        return { txs: all.slice((page - 1) * per, page * per), total_count: String(all.length) };
      }
      default: throw new Error(`Method not found: ${method}`);
    }
  }

  function valconsOf(v) { return toBech32(v.consBytes, 'zetaphyvalcons'); }
  const now = Date.now();
  const PROPOSALS = [
    { id: '2', title: 'Send 5,000 ZETAPHY from the community pool', summary: 'Fund the explorer\u202e work.\n<script>window.__pwned=5</script>', status: 'PROPOSAL_STATUS_VOTING_PERIOD', proposer: ME, expedited: false, metadata: 'ipfs://QmProp2',
      messages: [{ '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: GOV_ADDR, to_address: ME, amount: [{ denom: 'azetaphy', amount: '5000000000000000000000' }] }],
      final_tally_result: { yes_count: '0', abstain_count: '0', no_count: '0', no_with_veto_count: '0' },
      submit_time: new Date(now - 86400_000).toISOString(), deposit_end_time: new Date(now + 86400_000).toISOString(), total_deposit: [{ denom: 'azetaphy', amount: String(10000n * 10n ** 18n) }],
      voting_start_time: new Date(now - 3600_000).toISOString(), voting_end_time: new Date(now + 2 * 86400_000 + 3 * 3600_000).toISOString() },
    { id: '1', title: '<b>Turn on</b> PQ evidence', summary: 'MsgSetPQEvidence', status: 'PROPOSAL_STATUS_PASSED', proposer: ME, expedited: false, metadata: '',
      messages: [{ '@type': '/zetaphy.pq.v1.MsgSetPQEvidence', authority: GOV_ADDR, enabled: true }],
      final_tally_result: { yes_count: String(6n * 10n ** 22n), abstain_count: '0', no_count: String(10n ** 21n), no_with_veto_count: '0' },
      submit_time: new Date(now - 9 * 86400_000).toISOString(), deposit_end_time: new Date(now - 8 * 86400_000).toISOString(), total_deposit: [{ denom: 'azetaphy', amount: String(10000n * 10n ** 18n) }],
      voting_start_time: new Date(now - 8 * 86400_000).toISOString(), voting_end_time: new Date(now - 6 * 86400_000).toISOString() },
  ];
  const VOTES = [
    { voter: ME, options: [{ option: 'VOTE_OPTION_YES', weight: '1.000000000000000000' }] },
    { voter: vals[0].account, options: [{ option: 'VOTE_OPTION_NO', weight: '1.000000000000000000' }] },
    { voter: LOCKED, options: [{ option: 'VOTE_OPTION_YES', weight: '0.700000000000000000' }, { option: 'VOTE_OPTION_ABSTAIN', weight: '0.300000000000000000' }] },
  ];
  function govRest(p, q) {
    if (p === '/cosmos/gov/v1/proposals') return { proposals: PROPOSALS, pagination: { next_key: null, total: '2' } };
    if (p === '/cosmos/gov/v1/params/tallying') return { params: { quorum: '0.334000000000000000', threshold: '0.500000000000000000', veto_threshold: '0.334000000000000000', expedited_threshold: '0.667000000000000000' } };
    if (p === '/cosmos/gov/v1/params/deposit') return { params: { min_deposit: [{ denom: 'azetaphy', amount: String(10000n * 10n ** 18n) }] } };
    const m = /^\/cosmos\/gov\/v1\/proposals\/(\d+)(\/\w+)?$/.exec(p);
    const prop = m && PROPOSALS.find((x) => x.id === m[1]);
    if (!prop) return null;
    if (!m[2]) return { proposal: prop };
    if (m[2] === '/tally') return { tally: prop.id === '2' ? { yes_count: String(3n * 10n ** 22n), abstain_count: String(5n * 10n ** 21n), no_count: String(10n ** 22n), no_with_veto_count: '0' } : prop.final_tally_result };
    if (m[2] === '/votes') {
      if (prop.id !== '2') return { votes: [], pagination: { next_key: null, total: '0' } };
      const first = !q.get('pagination.key');
      return { votes: first ? VOTES.slice(0, 2) : VOTES.slice(2), pagination: { next_key: first ? 'bmV4dA==' : null, total: first ? '3' : '0' } };
    }
    if (m[2] === '/deposits') return { deposits: [{ proposal_id: prop.id, depositor: ME, amount: prop.total_deposit }], pagination: { total: '1' } };
    return null;
  }

  function rest(path) {
    const u = new URL(path, 'https://x/');
    const p = u.pathname;
    if (p === '/cosmos/staking/v1beta1/validators') {
      return { validators: vals.map((v) => ({ operator_address: v.operator, consensus_pubkey: { '@type': '/cosmos.crypto.ed25519.PubKey', key: v.edB64 }, jailed: false, status: 'BOND_STATUS_BONDED',
        tokens: String(v.power * 10n ** 24n), description: { moniker: v.name, website: '', details: '' }, commission: { commission_rates: { rate: '0.050000000000000000' } } })), pagination: { total: '2' } };
    }
    const val = vals.find((v) => p.startsWith(`/cosmos/staking/v1beta1/validators/${v.operator}`));
    if (val) {
      const base = `/cosmos/staking/v1beta1/validators/${val.operator}`;
      if (p === base) {
        return { validator: { operator_address: val.operator, jailed: false, status: 'BOND_STATUS_BONDED', tokens: String(val.power * 10n ** 24n), delegator_shares: String(val.power * 10n ** 24n) + '.000000000000000000',
          description: { moniker: val.name, website: val === vals[0] ? 'https://alpha.example' : 'javascript:alert(1)', details: 'Runs two sentries' }, min_self_delegation: '1',
          commission: { commission_rates: { rate: '0.050000000000000000', max_rate: '0.200000000000000000', max_change_rate: '0.010000000000000000' }, update_time: new Date(start).toISOString() } } };
      }
      if (p === `${base}/delegations`) return { delegation_responses: [], pagination: { next_key: null, total: val === vals[0] ? '42' : '7' } };
      if (p === `${base}/delegations/${val.account}`) return { delegation_response: { delegation: {}, balance: { denom: 'azetaphy', amount: String(1000n * 10n ** 18n) } } };
    }
    if (p.startsWith('/cosmos/slashing/v1beta1/signing_infos/')) {
      const v = vals.find((x) => p.endsWith(valconsOf(x)));
      return v ? { val_signing_info: { address: valconsOf(v), start_height: '1', index_offset: '29', jailed_until: '1970-01-01T00:00:00Z', tombstoned: false, missed_blocks_counter: v === vals[1] ? '5' : '0' } } : null;
    }
    if (p === '/cosmos/slashing/v1beta1/params') return { params: { signed_blocks_window: '100', min_signed_per_window: '0.500000000000000000', downtime_jail_duration: '600s', slash_fraction_double_sign: '0.050000000000000000', slash_fraction_downtime: '0.000100000000000000' } };
    if (p.startsWith('/cosmos/gov/v1/')) return govRest(p, u.searchParams);
    if (p === '/cosmos/staking/v1beta1/pool') return { pool: { bonded_tokens: String(100n * 10n ** 24n / 1000n), not_bonded_tokens: '0' } };
    if (p === '/cosmos/bank/v1beta1/supply/by_denom') return { amount: { denom: 'azetaphy', amount: String(SUPPLY) } };
    if (p.startsWith('/cosmos/bank/v1beta1/balances/')) return { balances: [{ denom: 'azetaphy', amount: '1' }, { denom: 'erc20/0x3333‮', amount: '5' }] };
    if (p.startsWith('/cosmos/staking/v1beta1/delegations/')) return { delegation_responses: p.endsWith(ME) ? [{ balance: { denom: 'azetaphy', amount: String(10n ** 21n) } }] : [] };
    return null;
  }

  const codeOf = (a) => ({ [ROUTER.toLowerCase()]: '0x608060405260043610', [PROXY.toLowerCase()]: '0x60806040526003', [PAIR.toLowerCase()]: '0x6080604052600436', [TOKEN.toLowerCase()]: '0x6080604052', [NFT.toLowerCase()]: '0x60806040526001', [MULTI.toLowerCase()]: '0x6080604052600255', [REGISTRY.toLowerCase()]: '0x60806040' }[String(a).toLowerCase()] ?? '0x');
  const tokenAnswers = {
    [TOKEN.toLowerCase()]: { name: coder.encode(['string'], [TOKEN_NAME]), symbol: coder.encode(['string'], ['SWD​']), decimals: '0x' + word(18), totalSupply: '0x' + word(10n ** 24n), owner: '0x' + word(BigInt(TOKEN_OWNER)),
      balances: { [ME_HEX.toLowerCase()]: 15n * 10n ** 17n, [evmWallet.address.toLowerCase()]: 985n * 10n ** 17n, [TOKEN_OWNER]: 899900n * 10n ** 18n } },
    [NFT.toLowerCase()]: { name: coder.encode(['string'], ['Siam Art']), symbol: coder.encode(['string'], ['SART']), totalSupply: '0x' + word(3), supports: true, balanceOf: '0x' + word(1),
      tokenURI: { 7: coder.encode(['string'], ['data:application/json;base64,' + Buffer.from(JSON.stringify(NFT_META_7)).toString('base64')]), 8: coder.encode(['string'], ['ipfs://QmMeta8/8.json']) },
      ownerOf: { 7: '0x' + word(BigInt(ME_HEX)), 8: '0x' + word(BigInt(evmWallet.address)) } },
    [MULTI.toLowerCase()]: { supports1155: true, balanceOf: null },
  };

  const baseFeeAt = (n) => 10n ** 9n + BigInt(n) * 10n ** 7n;
  const sent = [];
  function evmRpc(method, params) {
    switch (method) {
      case 'eth_chainId': return hexq(77390);
      case 'eth_blockNumber': return hexq(latest);
      case 'eth_getBalance': return hexq(String(params[0]).toLowerCase() === ME_HEX.toLowerCase() ? 1234n * 10n ** 18n + 5n * 10n ** 17n : 10n ** 18n);
      case 'eth_getTransactionCount': return String(params[0]).toLowerCase() === evmWallet.address.toLowerCase() ? '0x5' : '0x0';
      case 'eth_getCode': return codeOf(params[0]);
      case 'eth_getStorageAt': return '0x' + word(String(params[0]).toLowerCase() === PROXY.toLowerCase() && String(params[1]).toLowerCase() === IMPL_SLOT ? BigInt(ROUTER) : 0);
      case 'eth_getBlockByNumber': // a tag ('latest'): the gas page's view of the head; a number: the tx and cross-chain views' block
        if (!/^0x[0-9a-f]+$/i.test(String(params[0]))) return { number: hexq(LATEST), gasLimit: hexq(30000000), gasUsed: hexq(7500000), baseFeePerGas: hexq(baseFeeAt(LATEST + 1)) };
        return { number: params[0], hash: '0x' + 'cd'.repeat(32), baseFeePerGas: hexq(500000000n), gasLimit: hexq(30000000), timestamp: hexq(Math.floor(start / 1000) + Number(BigInt(params[0])) * 5) };
      case 'debug_traceTransaction': {
        const tr = traces.get(String(params[0]).toLowerCase());
        if (!tr) throw Object.assign(new Error('the method debug_traceTransaction does not exist/is not available'), { code: -32601 });
        return params[1]?.tracer === 'prestateTracer' ? tr.prestate : tr.call;
      }
      case 'eth_getTransactionByHash': return evm.txs.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getTransactionReceipt': return evm.receipts.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getBlockByHash': return null;
      case 'eth_gasPrice': return hexq(baseFeeAt(LATEST + 1) + 10n ** 9n);
      case 'eth_maxPriorityFeePerGas': return hexq(10n ** 9n);
      case 'eth_feeHistory': { // newest: 'latest' or a block number (the home charts); at most 100 blocks
        const newest = params[1] === 'latest' ? latest : Number(BigInt(params[1]));
        const n = Math.min(Number(BigInt(params[0])), newest, 100); const oldest = newest - n + 1;
        const hs = Array.from({ length: n }, (_, i) => oldest + i);
        return { oldestBlock: hexq(oldest), baseFeePerGas: [...hs, newest + 1].map((x) => hexq(baseFeeAt(x))),
          gasUsedRatio: hs.map((x) => (x % 3 === 0 ? 0 : 0.25)),
          reward: hs.map((x) => (x % 3 === 0 ? ['0x0', '0x0', '0x0'] : [hexq(10n ** 8n * BigInt(x % 4 + 1)), hexq(10n ** 9n * BigInt(x % 4 + 1)), hexq(2n * 10n ** 9n * BigInt(x % 4 + 1))])) };
      }
      case 'eth_sendRawTransaction': { sent.push(params[0]); return '0x' + bytesToHex(keccak_256(hexToBytes(params[0]))); }
      case 'zetaphy_pqAccount': {
        const a = String(params[0]);
        const isMe = a === ME || a.toLowerCase() === ME_HEX.toLowerCase();
        const isLocked = a === LOCKED || a.toLowerCase() === LOCKED_HEX;
        return { address: a, chainId: CHAIN_ID, denom: 'azetaphy', exists: isMe || isLocked, accountNumber: isMe ? '5' : isLocked ? '9' : null, sequence: isMe ? '3' : isLocked ? '12' : null,
          pubKeyType: isMe ? 'mldsa44' : isLocked ? 'eth_secp256k1' : null, quantumLockedTo: isLocked ? ME : null };
      }
      case 'eth_getLogs': {
        const f = params[0];
        const from = Number(BigInt(f.fromBlock)); const to = Number(BigInt(f.toBlock));
        if (to - from > 2000) throw Object.assign(new Error('block range too large'), { code: -32000 });
        return evm.logs.filter((l) => {
          const n = Number(BigInt(l.blockNumber));
          if (n < from || n > to) return false;
          if (f.address && String(f.address).toLowerCase() !== l.address.toLowerCase()) return false;
          return (f.topics ?? []).every((t, i) => t == null || (Array.isArray(t) ? t.map((x) => x.toLowerCase()) : [t.toLowerCase()]).includes(String(l.topics[i] ?? '').toLowerCase()));
        });
      }
      case 'eth_call': {
        const { to, data } = params[0];
        const t = String(to).toLowerCase(); const s = data.slice(2, 10); const arg = data.slice(10);
        if (t === REGISTRY.toLowerCase()) {
          if (regSel[s]) {
            const what = regSel[s];
            const key = what === 'address' ? addressKey(Number(BigInt('0x' + arg.slice(0, 64))), '0x' + arg.slice(88, 128)) : '0x' + arg;
            const reason = what === 'address' ? flagged[key] : undefined;
            const isEnforced = THREAT_SEL[what][1] === s;
            const on = reason != null && !isEnforced;
            return '0x' + word(on ? 1 : 0) + word(on ? reason : 0);
          }
          if (s === DETAIL_SEL.evidence) return evidence['0x' + arg] ?? '0x' + word(0) + word(128) + word(0) + word(0) + word(0);
          if (s === DETAIL_SEL.responseAt) { const r = responses['0x' + arg.slice(0, 64)]?.[Number(BigInt('0x' + arg.slice(64)))]; return r ?? '0x' + word(160) + word(0) + word(0) + word(0) + word(0) + word(0); }
          throw Object.assign(new Error('execution reverted'), { code: 3 });
        }
        if (t === AUDIT_CERT.toLowerCase()) {
          // certificate(uint64,address) -> (requestId, chainId, target, codeHash, reportHash, sourceHash, level, auditors, mutationBps, issuedAt, expiresAt, revokedAt, revokedBy), valid
          if (s !== sel4('certificate(uint64,address)')) throw Object.assign(new Error('execution reverted'), { code: 3 });
          const target = '0x' + arg.slice(88, 128);
          if (target !== TOKEN.toLowerCase()) return '0x' + word(0).repeat(14);
          const issued = 1_780_000_000n;
          return '0x' + [4n, 77390n, BigInt(TOKEN), 0x11n, 0x22n, 0x33n, 3n, 6n, 9000n, issued, issued + 3650n * 86400n, 0n, 0n, 1n].map(word).join('');
        }
        if (t === ROUTER.toLowerCase() || t === PROXY.toLowerCase()) {
          const r = { [sel4('factory()')]: '0x' + word(BigInt(FACTORY)), [sel4('WETH()')]: '0x' + word(BigInt(WNATIVE)), [sel4('REGISTRY_GAS()')]: '0x' + word(50000), [sel4('SCORE_GAS()')]: '0x' + word(60000),
            [sel4('getAmountOut(uint256,uint256,uint256)')]: '0x' + word(997), [sel4('sweep(address)')]: '0x' }[s];
          if (r != null) return r;
          throw Object.assign(new Error('execution reverted'), { code: 3, data: router.encodeErrorResult('InsufficientLiquidity', []) });
        }
        const ans = tokenAnswers[t];
        if (!ans && codeOf(t) === '0x') return '0x'; // a call to an account without code succeeds with no output
        if (!ans) throw Object.assign(new Error('execution reverted'), { code: 3 });
        const map = { [sel4('name()')]: ans.name, [sel4('symbol()')]: ans.symbol, [sel4('decimals()')]: ans.decimals, [sel4('totalSupply()')]: ans.totalSupply, [sel4('balanceOf(address)')]: ans.balanceOf, [sel4('owner()')]: ans.owner };
        if (ans.balances && s === sel4('balanceOf(address)')) return '0x' + word(ans.balances['0x' + arg.slice(24, 64)] ?? 0n);
        const idArg = arg ? BigInt('0x' + arg.slice(0, 64)) : 0n;
        if (ans.tokenURI && s === sel4('tokenURI(uint256)')) { const r = ans.tokenURI[String(idArg)]; if (!r) throw Object.assign(new Error('execution reverted'), { code: 3 }); return r; }
        if (ans.ownerOf && s === sel4('ownerOf(uint256)')) { const r = ans.ownerOf[String(idArg)]; if (!r) throw Object.assign(new Error('execution reverted'), { code: 3 }); return r; }
        if (s === sel4('supportsInterface(bytes4)')) {
          const id = arg.slice(0, 8);
          if ((id === '80ac58cd' && ans.supports) || (id === 'd9b67a26' && ans.supports1155)) return '0x' + word(1);
          return '0x' + word(0);
        }
        if (map[s] == null) throw Object.assign(new Error('execution reverted'), { code: 3 });
        return map[s];
      }
      default: throw Object.assign(new Error(`the method ${method} does not exist/is not available`), { code: -32601 });
    }
  }

  return { sent, baseFeeAt, valconsOf, vals, blocks, evmTxHash: etx.hash, hlTxHash: dtx.hash, hlMessageId: hlId, evmWallet, comet, rest, evmRpc, sourcify, deep: { swapHash, failHash, approveHash },
    cometHashOf: (h, i) => upper(sha256(blocks.get(h).txs[i])), busyTxs, state, addPending, addBlock, newBlockEvent, latest: () => latest };
}
