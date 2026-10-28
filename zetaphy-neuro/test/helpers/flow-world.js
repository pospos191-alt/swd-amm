// A small made-up chain for the money-flow tests (unit and browser): one
// token on "Base" whose deployer is funded through a flagged address, whose
// first holders share a funder, whose liquidity is pulled, and whose deployer
// made an earlier token whose liquidity was pulled too. Answers JSON-RPC
// (Base and the ZETAPHY ThreatRegistry) and Blockscout's GET API.
import { TOPIC, selector, word, addrWord, lc } from '../../graph/util.js';
import { CHAINS } from '../../src/chains.js';
import { ZETAPHY } from '../../graph/sources.js';

const a = (tag) => '0x' + tag.padStart(40, '0');
const h = (tag) => '0x' + tag.padStart(64, '0');
export const W = {
  token: a('70c0'), pair: a('9a17'), deployer: a('de9'), f1: a('f1'), f2: a('f2'), exchange: a('e0c4a9e'), sybil: a('5b1'),
  r: [1, 2, 3, 4, 5, 6, 7].map((i) => a(`ec0${i}`)), lpTo: a('de92'), old: a('01d'), oldPair: a('01d9a1'), router: a('7047e7'),
  txCreate: h('c7ea7e'), txAdd: h('add'), txRemove: h('7e30e'), txOldCreate: h('01dc7'), txOldAdd: h('01dadd'), txOldRemove: h('01d7e3'),
};
const BASE = CHAINS.base;
const WETH = lc(BASE.dex.weth);

const tx = (hash, from, to, value, block, extra = {}) => ({ hash, from, to, value: String(value), blockNumber: String(block), isError: '0', contractAddress: '', ...extra });
// Native transfers (first funding of each address), and contract creations.
const TXS = [
  tx(h('f0'), W.exchange, W.f2, 10n ** 18n, 10),
  tx(h('f1'), W.f2, W.f1, 10n ** 18n, 11),
  tx(h('f2'), W.f1, W.deployer, 10n ** 18n, 12),
  tx(h('5b'), W.exchange, W.sybil, 10n ** 18n, 13),
  ...W.r.slice(0, 4).map((r, i) => tx(h(`5b${i}`), W.sybil, r, 10n ** 16n, 20 + i)),
  tx(h('e5'), W.exchange, W.r[4], 10n ** 16n, 24),
  tx(h('d6'), W.deployer, W.r[5], 10n ** 16n, 25),
  tx(h('d7'), W.deployer, W.r[6], 10n ** 16n, 26),
  tx(W.txOldCreate, W.deployer, '', 0, 50, { contractAddress: W.old }),
  tx(W.txCreate, W.deployer, '', 0, 100, { contractAddress: W.token }),
];
const log = (address, topics, data, block, txHash, i = 0) => ({ address, topics, data, blockNumber: '0x' + block.toString(16), transactionHash: txHash, logIndex: '0x' + i.toString(16) });
const t = (addr) => '0x' + addrWord(addr);
const amount = (v) => '0x' + word(v);
const ZERO = a('0');
const LOGS = [
  // token: mint to the deployer, then the deployer sends to 7 wallets and the pool
  log(W.token, [TOPIC.transfer, t(ZERO), t(W.deployer)], amount(10n ** 24n), 100, W.txCreate),
  log(W.token, [TOPIC.transfer, t(W.deployer), t(W.pair)], amount(10n ** 23n), 105, W.txAdd),
  ...W.r.map((r, i) => log(W.token, [TOPIC.transfer, t(W.deployer), t(r)], amount(10n ** 21n), 106 + i, h(`7e${i}`))),
  // pool LP token: minimum liquidity, the deployer adds, later removes 90% to another wallet
  log(W.pair, [TOPIC.transfer, t(ZERO), t(ZERO)], amount(1000n), 105, W.txAdd, 0),
  log(W.pair, [TOPIC.transfer, t(ZERO), t(W.deployer)], amount(1000n * 10n ** 18n), 105, W.txAdd, 1),
  log(W.pair, [TOPIC.transfer, t(W.deployer), t(W.pair)], amount(900n * 10n ** 18n), 140, W.txRemove, 0),
  log(W.pair, [TOPIC.transfer, t(W.pair), t(ZERO)], amount(900n * 10n ** 18n), 140, W.txRemove, 1),
  log(W.pair, [TOPIC.burn, t(W.router), t(W.lpTo)], amount(1n) + word(2n), 140, W.txRemove, 2),
  // the earlier token's pool: added and fully removed by the deployer
  log(W.oldPair, [TOPIC.transfer, t(ZERO), t(W.deployer)], amount(500n), 55, W.txOldAdd),
  log(W.oldPair, [TOPIC.transfer, t(W.deployer), t(W.oldPair)], amount(500n), 60, W.txOldRemove, 0),
  log(W.oldPair, [TOPIC.burn, t(W.router), t(W.deployer)], amount(1n) + word(1n), 60, W.txOldRemove, 1),
];
const CODE = new Set([W.token, W.pair, W.old, W.oldPair]);
const NONCE = { [W.exchange]: 1_000_000, [W.deployer]: 3 };
const SEL = { getPair: selector('getPair(address,address)'), balanceOf: selector('balanceOf(address)'), totalSupply: selector('totalSupply()'), flagged: selector('isAddressFlagged(uint256,address)') };
const FLAGGED = new Set([W.f2]);

/** JSON-RPC answer for Base (and ZETAPHY for the registry), or throws. */
export function rpcAnswer(url, method, params, stats) {
  stats.calls.push(method);
  const zetaphy = url.startsWith(ZETAPHY.rpc);
  if (method === 'eth_chainId') return '0x' + (zetaphy ? ZETAPHY.chainId : BASE.id).toString(16);
  if (zetaphy) {
    if (method === 'eth_call' && params[0].to === ZETAPHY.threatRegistry && params[0].data.startsWith('0x' + SEL.flagged)) {
      const who = '0x' + params[0].data.slice(-40);
      return FLAGGED.has(who) ? '0x' + word(1) + word(2) : '0x' + word(0) + word(0);
    }
    throw new Error('unexpected zetaphy call');
  }
  switch (method) {
    case 'eth_blockNumber': return '0x1000';
    case 'eth_getCode': return CODE.has(lc(params[0])) ? '0x6080604052' : '0x';
    case 'eth_getTransactionCount': return '0x' + (NONCE[lc(params[0])] ?? 1).toString(16);
    case 'eth_getTransactionByHash': { const x = TXS.find((y) => y.hash === params[0]); return x ? { hash: x.hash, from: x.from, to: x.to || null, blockNumber: '0x' + Number(x.blockNumber).toString(16) } : null; }
    case 'eth_call': {
      const { to, data } = params[0];
      if (data.startsWith('0x' + SEL.getPair)) {
        const tok = '0x' + data.slice(10 + 24, 10 + 64);
        if (lc(to) !== lc(BASE.dex.factory) || '0x' + data.slice(-40) !== WETH) return '0x' + word(0);
        return '0x' + addrWord(tok === W.token ? W.pair : tok === W.old ? W.oldPair : ZERO);
      }
      if (lc(to) === W.pair && data.startsWith('0x' + SEL.balanceOf)) return '0x' + word('0x' + data.slice(-40) === W.deployer ? 100n * 10n ** 18n : 0n);
      if (lc(to) === W.pair && data === '0x' + SEL.totalSupply) return '0x' + word(100n * 10n ** 18n + 1000n);
      throw new Error('execution reverted');
    }
    case 'eth_getLogs': {
      const f = params[0];
      return LOGS.filter((l) => l.address === lc(f.address) && (!f.topics?.[0] || l.topics[0] === f.topics[0])
        && parseInt(l.blockNumber, 16) >= parseInt(f.fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(f.toBlock, 16));
    }
    case 'eth_gasPrice': return '0x1';
    case 'eth_getStorageAt': return '0x' + word(0);
    default: throw Object.assign(new Error('method not found'), { code: -32601 });
  }
}

/** Blockscout GET /api answer. */
export function blockscoutAnswer(q, stats) {
  stats.calls.push(`bs:${q.get('module')}.${q.get('action')}`);
  const key = `${q.get('module')}.${q.get('action')}`;
  const ok = (result) => ({ status: '1', message: 'OK', result });
  const none = { status: '0', message: 'No transactions found', result: [] };
  if (key === 'contract.getcontractcreation') {
    const c = TXS.find((x) => x.contractAddress === lc(q.get('contractaddresses')));
    return c ? ok([{ contractAddress: c.contractAddress, contractCreator: c.from, txHash: c.hash }]) : none;
  }
  if (key === 'account.txlist') {
    const addr = lc(q.get('address'));
    const rows = TXS.filter((x) => x.from === addr || x.to === addr).sort((x, y) => Number(x.blockNumber) - Number(y.blockNumber));
    if (q.get('sort') === 'desc') rows.reverse();
    return rows.length ? ok(rows) : none;
  }
  if (key === 'account.txlistinternal') return none;
  if (key === 'logs.getLogs') {
    const rows = LOGS.filter((l) => l.address === lc(q.get('address')) && l.topics[0] === q.get('topic0') && parseInt(l.blockNumber, 16) >= Number(q.get('fromBlock')));
    return rows.length ? ok(rows) : { status: '0', message: 'No records found', result: [] };
  }
  return { status: '0', message: 'NOTOK', result: 'unknown action' };
}

/** fetch() for the world: JSON-RPC POSTs and Blockscout GETs. stats.calls lists what was asked. */
export function worldFetch(stats = { calls: [] }, { failRegistry = false } = {}) {
  const res = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api' && u.hostname.endsWith('blockscout.com')) return res(blockscoutAnswer(u.searchParams, stats));
    if (failRegistry && url.startsWith(ZETAPHY.rpc)) return res({}, 503);
    const { id, method, params } = JSON.parse(init.body);
    try { return res({ jsonrpc: '2.0', id, result: rpcAnswer(url, method, params, stats) }); } catch (e) { return res({ jsonrpc: '2.0', id, error: { code: e.code ?? 3, message: e.message } }); }
  };
}
