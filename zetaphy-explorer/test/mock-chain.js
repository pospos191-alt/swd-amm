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
import { Wallet, Transaction, AbiCoder } from 'ethers';
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
export const TOKEN_NAME = '<img src=x onerror="window.__pwned=1">Sawasdee‮txt.exe';
export const REPORT = '0x' + 'e7'.repeat(32);
export const RESPONSE_TEXT = 'Minting is limited by our DAO vote.';

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

export function buildChain() {
  const vals = [makeValidator('Alpha Node', 7, 60n, true), makeValidator('Beta‮ Node', 9, 40n, false)];
  const evmWallet = new Wallet('0x' + '22'.repeat(32));
  const start = Date.now() - LATEST * 5000;
  const blocks = new Map(); // height -> { header, hash, txs: [bytes], results: [{code,…}] }
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
    ], 'gm ‮from ZETAPHY'), { code: 0, gas_used: '123456', gas_wanted: '400000', events: [{ type: 'message', attributes: [{ key: 'sender', value: ME }] }] }]],
    21: [[cosmosTx([{ typeUrl: '/zetaphy.pq.v1.MsgPQVoteKey', value: concat(lenField(1, utf8(vals[1].operator)), lenField(2, vals[1].keys.publicKey), lenField(3, new Uint8Array(2420).fill(3))) }]),
      { code: 4, log: 'unauthorized: proof does not verify', gas_used: '90000', gas_wanted: '600000', events: [] }]],
    24: [[cosmosTx([{ typeUrl: '/zetaphy.pq.v1.MsgSetPQEvidence', value: concat(lenField(1, utf8(ME)), uintField(2, 1)) }]), { code: 0, gas_used: '50000', gas_wanted: '400000', events: [] }]],
  };
  // block 22: an EVM tx (MetaMask style) that moves three kinds of tokens
  const etx = Transaction.from({ type: 2, chainId: 77390, nonce: 4, maxPriorityFeePerGas: 1000000000n, maxFeePerGas: 2000000000n, gasLimit: 150000n, to: TOKEN, value: 0n, data: '0xa9059cbb' + word(BigInt(ME_HEX)) + word(15n * 10n ** 17n) });
  etx.signature = evmWallet.signingKey.sign(etx.unsignedHash);
  const ethMsg = concat(lenField(5, hexToBytes(evmWallet.address)), lenField(6, hexToBytes(etx.serialized)));
  user[22] = [[encodeTxRaw({ bodyBytes: encodeTxBody({ messages: [{ typeUrl: '/cosmos.evm.vm.v1.MsgEthereumTx', value: ethMsg }] }), authInfoBytes: new Uint8Array(), signatures: [] }),
    { code: 0, gas_used: '61234', gas_wanted: '150000', events: [{ type: 'ethereum_tx', attributes: [{ key: 'ethereumTxHash', value: etx.hash }] }] }]];
  const evmLogs = [
    { address: TOKEN, topics: [topic('Transfer(address,address,uint256)'), addrTopic(evmWallet.address), addrTopic(ME_HEX)], data: '0x' + word(15n * 10n ** 17n) },
    { address: NFT, topics: [topic('Transfer(address,address,uint256)'), addrTopic('0x' + '00'.repeat(20)), addrTopic(ME_HEX), '0x' + word(7)], data: '0x' },
    { address: MULTI, topics: [topic('TransferSingle(address,address,address,uint256,uint256)'), addrTopic(evmWallet.address), addrTopic(evmWallet.address), addrTopic(ME_HEX)], data: '0x' + word(3) + word(10) },
  ].map((l, i) => ({ ...l, blockNumber: hexq(22), transactionHash: etx.hash, logIndex: hexq(i), transactionIndex: '0x1', blockHash: '0x' + 'ab'.repeat(32), removed: false }));
  evm.logs.push(...evmLogs);
  evm.txs.set(etx.hash, { hash: etx.hash, blockNumber: hexq(22), blockHash: '0x' + 'ab'.repeat(32), transactionIndex: '0x1', from: evmWallet.address, to: TOKEN, value: '0x0',
    gas: hexq(150000), gasPrice: hexq(2000000000n), maxFeePerGas: hexq(2000000000n), maxPriorityFeePerGas: hexq(1000000000n), nonce: '0x4', input: etx.data, type: '0x2', chainId: hexq(77390) });
  evm.receipts.set(etx.hash, { transactionHash: etx.hash, status: '0x1', blockNumber: hexq(22), gasUsed: hexq(61234), effectiveGasPrice: hexq(1500000000n), contractAddress: null, from: evmWallet.address, to: TOKEN, logs: evmLogs });

  let prevHash = ''; let prevSigned = null;
  for (let H = 1; H <= LATEST; H++) {
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
  }

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
    const latest = LATEST;
    const blk = (h) => {
      const b = blocks.get(Number(h));
      if (!b) throw Object.assign(new Error(`height ${h} must be less than or equal to the current blockchain height ${latest}`), { rpc: true });
      return { block_id: { hash: b.hash, parts: { total: 1, hash: upper(sha256(utf8('p'))) } }, block: { header: b.header, data: { txs: b.txs.map(b64) }, evidence: { evidence: [] }, last_commit: null } };
    };
    switch (method) {
      case 'status': return { node_info: { network: CHAIN_ID, moniker: 'mock', version: '0.38.17' }, sync_info: { latest_block_height: String(latest), latest_block_time: blocks.get(latest).header.time, catching_up: false } };
      case 'block': return blk(p.height);
      case 'block_by_hash': { const h = [...blocks].find(([, b]) => b.hash === upper(Buffer.from(p.hash, 'base64')))?.[0]; if (!h) return { block_id: { hash: '' }, block: null }; return blk(h); }
      case 'block_results': { const b = blocks.get(Number(p.height)); if (!b) throw new Error('no such block'); return { height: p.height, txs_results: b.results }; }
      case 'blockchain': {
        const metas = [];
        for (let h = Math.min(Number(p.maxHeight), latest); h >= Number(p.minHeight); h--) { const b = blocks.get(h); metas.push({ block_id: { hash: b.hash }, block_size: '1000', header: b.header, num_txs: String(b.txs.length) }); }
        return { last_height: String(latest), block_metas: metas };
      }
      case 'validators': return { block_height: p.height, validators: vals.map((v) => ({ address: v.address, pub_key: { type: 'tendermint/PubKeyEd25519', value: v.edB64 }, voting_power: String(v.power), proposer_priority: '0' })), count: '2', total: '2' };
      case 'abci_query': {
        if (p.path === '/store/zetaphypq/key') { const v = vals.find((x) => '02' + x.address === String(p.data).toUpperCase()); return { response: { code: 0, value: v ? voteKeyValue(v) : null, height: String(p.height) } }; }
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
      case 'tx_search': {
        const [, lo, hi] = /tx\.height>=(\d+) AND tx\.height<=(\d+)/.exec(p.query).map(Number);
        const all = [];
        for (let h = Math.min(hi, latest); h >= lo; h--) { const b = blocks.get(h); if (!b) continue; for (let i = b.txs.length - 1; i >= 0; i--) all.push({ hash: upper(sha256(b.txs[i])), height: String(h), index: i, tx_result: b.results[i], tx: b64(b.txs[i]) }); }
        const page = Number(p.page ?? 1); const per = Number(p.per_page ?? 30);
        return { txs: all.slice((page - 1) * per, page * per), total_count: String(all.length) };
      }
      default: throw new Error(`Method not found: ${method}`);
    }
  }

  function rest(path) {
    const u = new URL(path, 'https://x/');
    const p = u.pathname;
    if (p === '/cosmos/staking/v1beta1/validators') {
      return { validators: vals.map((v) => ({ operator_address: v.operator, consensus_pubkey: { '@type': '/cosmos.crypto.ed25519.PubKey', key: v.edB64 }, jailed: false, status: 'BOND_STATUS_BONDED',
        tokens: String(v.power * 10n ** 24n), description: { moniker: v.name, website: '', details: '' }, commission: { commission_rates: { rate: '0.050000000000000000' } } })), pagination: { total: '2' } };
    }
    if (p === '/cosmos/staking/v1beta1/pool') return { pool: { bonded_tokens: String(100n * 10n ** 24n / 1000n), not_bonded_tokens: '0' } };
    if (p === '/cosmos/bank/v1beta1/supply/by_denom') return { amount: { denom: 'azetaphy', amount: String(SUPPLY) } };
    if (p.startsWith('/cosmos/bank/v1beta1/balances/')) return { balances: [{ denom: 'azetaphy', amount: '1' }, { denom: 'erc20/0x3333‮', amount: '5' }] };
    if (p.startsWith('/cosmos/staking/v1beta1/delegations/')) return { delegation_responses: p.endsWith(ME) ? [{ balance: { denom: 'azetaphy', amount: String(10n ** 21n) } }] : [] };
    return null;
  }

  const codeOf = (a) => ({ [TOKEN.toLowerCase()]: '0x6080604052', [NFT.toLowerCase()]: '0x60806040526001', [MULTI.toLowerCase()]: '0x6080604052600255', [REGISTRY.toLowerCase()]: '0x60806040' }[String(a).toLowerCase()] ?? '0x');
  const tokenAnswers = {
    [TOKEN.toLowerCase()]: { name: coder.encode(['string'], [TOKEN_NAME]), symbol: coder.encode(['string'], ['SWD​']), decimals: '0x' + word(18), totalSupply: '0x' + word(10n ** 24n), balanceOf: '0x' + word(15n * 10n ** 17n) },
    [NFT.toLowerCase()]: { name: coder.encode(['string'], ['Siam Art']), symbol: coder.encode(['string'], ['SART']), totalSupply: '0x' + word(3), supports: true, balanceOf: '0x' + word(1) },
    [MULTI.toLowerCase()]: { supports1155: true, balanceOf: null },
  };

  function evmRpc(method, params) {
    switch (method) {
      case 'eth_chainId': return hexq(77390);
      case 'eth_blockNumber': return hexq(LATEST);
      case 'eth_getBalance': return hexq(String(params[0]).toLowerCase() === ME_HEX.toLowerCase() ? 1234n * 10n ** 18n + 5n * 10n ** 17n : 10n ** 18n);
      case 'eth_getTransactionCount': return String(params[0]).toLowerCase() === evmWallet.address.toLowerCase() ? '0x5' : '0x0';
      case 'eth_getCode': return codeOf(params[0]);
      case 'eth_getStorageAt': return '0x' + word(0);
      case 'eth_getTransactionByHash': return evm.txs.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getTransactionReceipt': return evm.receipts.get(String(params[0]).toLowerCase()) ?? null;
      case 'eth_getBlockByHash': return null;
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
        const ans = tokenAnswers[t];
        if (!ans) throw Object.assign(new Error('execution reverted'), { code: 3 });
        const map = { [sel4('name()')]: ans.name, [sel4('symbol()')]: ans.symbol, [sel4('decimals()')]: ans.decimals, [sel4('totalSupply()')]: ans.totalSupply, [sel4('balanceOf(address)')]: ans.balanceOf };
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

  return { vals, blocks, evmTxHash: etx.hash, evmWallet, comet, rest, evmRpc, cometHashOf: (h, i) => upper(sha256(blocks.get(h).txs[i])) };
}
