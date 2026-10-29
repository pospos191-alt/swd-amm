// Neuro federated learning: the browser's side of FederatedRounds
// (zetaphy-network/contracts/FederatedRounds.sol), without ethers.
//
// Every call goes through one EIP-1193 style function `request(method, params)`:
// the user's wallet (eth_sendTransaction, eth_call) or a read-only JSON-RPC
// endpoint (eth_call, eth_blockNumber). ABI encoding is done here by hand for
// the few functions used; zetaphy-network/test/federated.test.js and
// ml/test/flrounds.test.js check it against ethers and the compiled contract.

import { keccak256, selectorOf } from '../../src/keccak.js';

const SEL = Object.fromEntries([
  ['commit', 'commit(uint256,bytes32)'],
  ['reveal', 'reveal(uint256,bytes32,bytes)'],
  ['phaseAt', 'phaseAt(uint256)'],
  ['roundStart', 'roundStart(uint256)'],
  ['paused', 'paused()'],
  ['start', 'start()'],
  ['commitBlocks', 'commitBlocks()'],
  ['revealBlocks', 'revealBlocks()'],
  ['maxPerRound', 'maxPerRound()'],
  ['commits', 'commits(uint256)'],
  ['reveals', 'reveals(uint256)'],
  ['commitmentOf', 'commitmentOf(uint256,address)'],
  ['revealed', 'revealed(uint256,address)'],
  ['governance', 'governance()'],
].map(([k, sig]) => [k, selectorOf(sig)]));
export const SELECTORS = Object.freeze({ ...SEL });

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function fromHex(hex) {
  const h = String(hex).replace(/^0x/, '');
  if (h.length % 2 || /[^0-9a-fA-F]/.test(h)) throw new Error('bad hex');
  return Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
}
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (a) => {
  if (!ADDR.test(String(a))) throw new Error('bad address');
  return a.slice(2).toLowerCase().padStart(64, '0');
};
const b32 = (h) => {
  const x = String(h).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(x)) throw new Error('bad bytes32');
  return x.toLowerCase();
};

/** keccak256 of bytes, 0x hex. */
export const keccakHex = (bytes) => '0x' + toHex(keccak256(bytes));

/** FederatedRounds.commitmentFor: keccak256(abi.encode(keccak256(payload), salt, sender)). */
export function commitmentFor(payload, salt, sender) {
  return keccakHex(fromHex(b32(keccakHex(payload)) + b32(salt) + addrWord(sender)));
}

/** A fresh 32-byte salt from the platform's cryptographic generator. */
export function newSalt() {
  return '0x' + toHex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export const commitData = (round, commitment) => '0x' + SEL.commit + word(round) + b32(commitment);

/** reveal(uint256 round, bytes32 salt, bytes payload) */
export function revealData(round, salt, payload) {
  const p = toHex(payload);
  return '0x' + SEL.reveal + word(round) + b32(salt) + word(96) + word(payload.length) + p.padEnd(Math.ceil(p.length / 64) * 64, '0');
}

const uintAt = (hex, i) => BigInt('0x' + (String(hex).replace(/^0x/, '').slice(i * 64, i * 64 + 64) || '0'));

/**
 * Reader / writer for one FederatedRounds address.
 * @param {(method:string, params:any[]) => Promise<any>} request
 * @param {string} address
 */
export function roundsClient(request, address) {
  if (!ADDR.test(String(address))) throw new Error('FederatedRounds address');
  const call = (data) => request('eth_call', [{ to: address, data }, 'latest']);
  const view = async (name, ...words) => call('0x' + SEL[name] + words.join(''));
  const num = async (name, ...w) => uintAt(await view(name, ...w), 0);

  /** Everything the panel shows about the round at the chain head (and `me`'s part in it). */
  async function status(me = null) {
    const block = BigInt(await request('eth_blockNumber', []));
    const [ph, paused, start, commitBlocks, revealBlocks, maxPerRound] = await Promise.all([
      view('phaseAt', word(block)), num('paused'), num('start'), num('commitBlocks'), num('revealBlocks'), num('maxPerRound'),
    ]);
    const round = uintAt(ph, 0);
    const phase = Number(uintAt(ph, 1)); // 0 before the first round, 1 commit, 2 reveal
    const period = commitBlocks + revealBlocks;
    const roundStart = start + round * period;
    const phaseEnd = phase === 0 ? start : phase === 1 ? roundStart + commitBlocks : roundStart + period;
    const [commits, reveals] = await Promise.all([num('commits', word(round)), num('reveals', word(round))]);
    const out = { block, round, phase, paused: paused === 1n, start, commitBlocks, revealBlocks, maxPerRound, commits, reveals, blocksLeft: phaseEnd - block };
    if (me) {
      const [c, r] = await Promise.all([view('commitmentOf', word(round), addrWord(me)), num('revealed', word(round), addrWord(me))]);
      out.myCommitment = '0x' + String(c).replace(/^0x/, '').slice(0, 64).padStart(64, '0');
      out.committed = BigInt(out.myCommitment) !== 0n;
      out.revealed = r === 1n;
    }
    return out;
  }

  /** Sends a transaction from `from` and waits for its receipt; throws if it reverted. */
  async function send(from, data, { poll = 1500, timeoutMs = 180_000 } = {}) {
    const hash = await request('eth_sendTransaction', [{ from, to: address, data, value: '0x0' }]);
    const until = Date.now() + timeoutMs;
    for (;;) {
      const rc = await request('eth_getTransactionReceipt', [hash]);
      if (rc) {
        if (rc.status != null && BigInt(rc.status) !== 1n) throw new Error(`transaction ${hash} reverted`);
        return { hash, block: rc.blockNumber != null ? BigInt(rc.blockNumber) : null };
      }
      if (Date.now() > until) throw new Error(`transaction ${hash}: no receipt yet`);
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  return {
    address,
    status,
    commitmentOf: async (round, who) => '0x' + String(await view('commitmentOf', word(round), addrWord(who))).replace(/^0x/, '').slice(0, 64),
    commit: (from, round, commitment, o) => send(from, commitData(round, commitment), o),
    reveal: (from, round, salt, payload, o) => send(from, revealData(round, salt, payload), o),
  };
}
