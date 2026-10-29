#!/usr/bin/env node
// Red-vs-blue arena runner (docs/future/markets.md, item 27): judges one round of
// zetaphy-network/contracts/RedBlueArena.sol in a sandbox. Nothing here touches a public chain:
// every red token lives only on a throwaway in-memory devnet (the red team's own lib/chain.js).
//
// Red entry (content = JSON, its keccak256 is the revealed contentHash):
//   { "format": "arena-red/1", "source": "<one Solidity 0.8.26 file>", "token": "<contract name>",
//     "args": ["deployer" | "0x<word>" | "<decimal>", ...],          constructor args (optional)
//     "trap": [{ "call": "setFee(uint256)", "args": ["9900"] }, ... | { "dump": true }] }
//   The token is deployed by the deployer (who must hold >= 10^24 units), listed against the
//   wrapped native coin, and read by Neuro (rules + buy/sell simulation) and the committed model.
//   Then a victim buys for 0.1 coin, the owner runs the trap steps ("victim", "pair", "router",
//   "deployer" stand for those addresses; {"dump": true} = the deployer sells all it holds), and
//   the victim sells everything. VALID: the victim gets back less than half of what the pool quoted
//   right after the buy (or cannot sell). EVADED: valid, and Neuro still showed it below "medium".
// Blue entry: a detector spec (ml/detectors/spec.js, "neuro-detector/1"). Score = valid red tokens
//   it gives p >= 0.5 minus 2 x benign reference tokens it gives p >= 0.5 (same Neuro features).
//
// Several runners judge each round (k-of-n, RedBlueArena): everything that decides the result is pinned in the
// sandbox (ml/redteam/sandbox.js: exact EVM / solc versions, a fixed block, the model, the benign set), the
// round names its hash, and this runner refuses to judge in another sandbox or with other package versions.
//
//   node ml/redteam/arena.js --sandbox                        the sandbox id (and description) to open a round with
//   node ml/redteam/arena.js --round round.json [--out ml/out/arena]
//   round.json (zetaphy-network/scripts/markets.js arena-fetch writes it):
//     { "round": 1, "red": [{ "index": 0, "revealed": true, "contentHash": "0x…", "content": "…" }],
//       "blue": [{ "index": 0, "revealed": true, "contentHash": "0x…", "content": "…" }] }
// Writes result.json (postResult's arguments) and dataset.jsonl (every valid red token as a labelled
// row with its features and whether Neuro missed it, for the next training run).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { Address, hexToBytes, bytesToHex as b2h } from '@ethereumjs/util';
import { readContract } from '../../src/reader.js';
import { CHAINS } from '../../src/chains.js';
import { selectorOf } from '../../scripts/keccak.js';
import { createChain, compileSources, DEPLOYER } from '../lib/chain.js';
import { SIM_SEED, sparse, runSamples } from '../lib/pipeline.js';
import { extractFeatures } from '../features.js';
import { scoreReport, combine, RANK } from '../combine.js';
import { checkSpec, predict } from '../detectors/spec.js';
import { makeSample, BENIGN_FAMILIES } from '../data/solgen.js';
import { loadModel } from './run.js';
import { rng } from '../lib/rng.js';
import { sandboxOf, sandboxHash, checkPinned, BLOCK, BENIGN } from './sandbox.js';

const DEX = CHAINS.bsc.dex;
const POOL_WEI = 10n ** 20n;
const TOKEN_POOL = 10n ** 24n;
const BUY_WEI = 10n ** 17n;
const VICTIM = '0x3333333333333333333333333333333333333333';
const MAX_SOURCE = 60_000;
const MAX_STEPS = 12;

export const keccakHex = (text) => '0x' + bytesToHex(keccak_256(utf8ToBytes(text)));
const w = (x) => (typeof x === 'bigint' ? x.toString(16) : String(x).replace(/^0x/, '').toLowerCase()).padStart(64, '0');

/** ABI-encodes `sig` + args where an argument may be a list of addresses (one level of address[]). */
function calldata(sig, args) {
  const head = []; const tail = [];
  const n = args.length;
  for (const a of args) {
    if (Array.isArray(a)) {
      head.push(w(BigInt(32 * n + tail.length * 32)));
      tail.push(w(BigInt(a.length)), ...a.map(w));
    } else head.push(w(a));
  }
  return '0x' + selectorOf(sig) + head.join('') + tail.join('');
}

const big = (ret) => (ret && ret.length > 2 ? BigInt(ret.slice(0, 66)) : 0n);

async function balance(chain, a) {
  return (await chain.evm.stateManager.getAccount(Address.fromString(a)))?.balance ?? 0n;
}

/** A call from any address. Returns { ok, ret }. */
async function callAs(chain, from, to, sig, args = [], value = 0n) {
  const r = await chain.evm.runCall({ caller: Address.fromString(from), to: Address.fromString(to), data: hexToBytes(calldata(sig, args)), value, gasLimit: 30_000_000n, block: chain.block });
  return { ok: !r.execResult.exceptionError, ret: b2h(r.execResult.returnValue) };
}

/** Checks a red manifest's shape (before anything is compiled). */
export function checkRed(m) {
  if (!m || m.format !== 'arena-red/1') throw new Error('format must be arena-red/1');
  if (typeof m.source !== 'string' || m.source.length > MAX_SOURCE || !/pragma solidity/.test(m.source)) throw new Error('source: one Solidity file');
  if (typeof m.token !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(m.token)) throw new Error('token: a contract name');
  if (!Array.isArray(m.trap ?? []) || (m.trap ?? []).length > MAX_STEPS) throw new Error(`trap: at most ${MAX_STEPS} steps`);
  for (const s of m.trap ?? []) {
    if (s.dump === true) continue;
    if (typeof s.call !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*\((?:(?:address|uint256|bool|bytes32)(?:,(?:address|uint256|bool|bytes32))*)?\)$/.test(s.call)) throw new Error(`trap: bad call ${s.call}`);
  }
  return m;
}

/** Deploys, lists, reads with Neuro, then runs the victim flow. */
export async function judgeRed(chain, manifest, model) {
  const m = checkRed(manifest);
  const bins = compileSources({ 'red.sol': m.source });
  if (!bins[m.token]) throw new Error(`no contract ${m.token}`);
  const ctor = (m.args ?? []).map((a) => (a === 'deployer' ? w(DEPLOYER) : /^0x[0-9a-fA-F]{1,64}$/.test(a) ? w(a) : w(BigInt(a)))).join('');
  const token = (await chain.deployCode(bins[m.token], ctor)).toLowerCase();
  const pair = await chain.addPool(token, TOKEN_POOL, POOL_WEI);
  const report = await readContract('bsc', token, { rpc: chain.rpc, simulate: true, sourcify: false, simSeed: SIM_SEED });
  const code = await chain.getCode(token);
  const impl = report.proxy?.implementation;
  const logicCode = impl ? await chain.getCode(impl) : null;
  const ml = model ? scoreReport(model, report, { code, logicCode }) : null;
  const shown = combine(report.analysis, ml).level;
  const f = sparse(extractFeatures({ report, code, logicCode }));
  // victim flow
  await chain.fund(VICTIM, 10n ** 18n);
  const path = (a, b) => [a, b];
  const buy = await callAs(chain, VICTIM, DEX.router, 'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256,address[],address,uint256)', [0n, path(DEX.weth, token), VICTIM, 2n ** 64n], BUY_WEI);
  const held = buy.ok ? big((await callAs(chain, VICTIM, token, 'balanceOf(address)', [VICTIM])).ret) : 0n;
  let valid = false; let reason;
  if (!buy.ok || held === 0n) reason = 'victim could not buy';
  else {
    const q = await callAs(chain, VICTIM, DEX.router, 'getAmountsOut(uint256,address[])', [held, path(token, DEX.weth)]);
    const quote = q.ok ? BigInt('0x' + q.ret.slice(2).slice(64 * 3, 64 * 4)) : 0n; // amounts[1]
    const names = { victim: VICTIM, pair, router: DEX.router, deployer: DEPLOYER };
    for (const s of m.trap ?? []) {
      if (s.dump) {
        const mine = big((await callAs(chain, DEPLOYER, token, 'balanceOf(address)', [DEPLOYER])).ret);
        await callAs(chain, DEPLOYER, token, 'approve(address,uint256)', [DEX.router, mine]);
        await callAs(chain, DEPLOYER, DEX.router, 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', [mine, 0n, path(token, DEX.weth), DEPLOYER, 2n ** 64n]);
        continue;
      }
      const args = (s.args ?? []).map((a) => (names[a] ?? (/^0x/.test(a) ? a : BigInt(a))));
      await callAs(chain, DEPLOYER, token, s.call, args);
    }
    const now = big((await callAs(chain, VICTIM, token, 'balanceOf(address)', [VICTIM])).ret);
    const before = await balance(chain, VICTIM);
    await callAs(chain, VICTIM, token, 'approve(address,uint256)', [DEX.router, now]);
    const sell = now > 0n ? await callAs(chain, VICTIM, DEX.router, 'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256,uint256,address[],address,uint256)', [now, 0n, path(token, DEX.weth), VICTIM, 2n ** 64n]) : { ok: false };
    const got = (await balance(chain, VICTIM)) - before;
    valid = !sell.ok || got * 2n < quote;
    reason = !sell.ok ? 'victim could not sell' : `victim got ${got} of ${quote} quoted`;
  }
  return { token, valid, evaded: valid && RANK[shown] < RANK.medium, level: shown, rulesLevel: report.analysis.level, sim: report.sim?.stage ?? null, p: ml?.p ?? null, reason, f };
}

/** A sandbox chain: the pinned block environment and the mock DEX. */
export async function sandboxChain() {
  const chain = await createChain({ block: BLOCK });
  chain.addPool = await chain.installDex(DEX);
  return chain;
}

/** Benign reference rows (Neuro features of benign generated tokens), fixed seed, in the sandbox. */
export async function benignRows(perFamily = BENIGN.perFamily, families = BENIGN_FAMILIES) {
  const R = rng(BENIGN.seed);
  const samples = families.flatMap((fam) => Array.from({ length: perFamily }, (_, i) => makeSample(R, { id: `arena-benign-${fam}-${i}`, family: fam, label: 0 })));
  const { rows } = await runSamples(samples, { optimize: true, chain: await sandboxChain() });
  return rows;
}

/**
 * Judges a whole round in the pinned sandbox. `round.sandbox` (from arena-fetch: the id the round was opened
 * with) must be this runner's sandbox id; `benignPerFamily` is part of the id (tests use a smaller set).
 */
export async function judgeRound(round, { model = loadModel(), benign = null, benignPerFamily = BENIGN.perFamily } = {}) {
  checkPinned();
  const desc = sandboxOf(model, { benign: { ...BENIGN, perFamily: benignPerFamily } });
  const sandbox = sandboxHash(desc);
  if (round.sandbox && String(round.sandbox).toLowerCase() !== sandbox) throw new Error(`round ${round.round} was opened for sandbox ${round.sandbox}; this runner's is ${sandbox} (other package versions, model or settings): not judged`);
  const chain = await sandboxChain();
  const red = [];
  for (const e of round.red ?? []) {
    const base = { index: e.index, valid: false, evaded: false };
    if (!e.revealed) { red.push({ ...base, reason: 'not revealed' }); continue; }
    if (keccakHex(e.content ?? '') !== String(e.contentHash).toLowerCase()) { red.push({ ...base, reason: 'content does not match its hash' }); continue; }
    try {
      red.push({ index: e.index, ...(await judgeRed(chain, JSON.parse(e.content), model)) });
    } catch (err) {
      red.push({ ...base, reason: `rejected: ${String(err.message).split('\n')[0].slice(0, 200)}` });
    }
  }
  const ref = benign ?? await benignRows(benignPerFamily);
  const validReds = red.filter((r) => r.valid);
  const blue = [];
  for (const e of round.blue ?? []) {
    let spec = null;
    if (e.revealed && keccakHex(e.content ?? '') === String(e.contentHash).toLowerCase()) { try { spec = checkSpec(JSON.parse(e.content)); } catch { spec = null; } }
    if (!spec) { blue.push({ index: e.index, score: 0, caught: 0, falsePositives: 0, reason: e.revealed ? 'bad spec or hash' : 'not revealed' }); continue; }
    const caught = validReds.filter((r) => predict(spec, r.f) >= 0.5).length;
    const fp = ref.filter((r) => predict(spec, r.f) >= 0.5).length;
    blue.push({ index: e.index, score: caught - 2 * fp, caught, falsePositives: fp });
  }
  const bits = (xs) => '0x' + xs.reduce((m, r) => m | (1n << BigInt(r.index)), 0n).toString(16);
  return {
    round: round.round, sandbox, sandboxDesc: desc, modelId: model?.id ?? null, benignRows: ref.length,
    red: red.map(({ f, ...rest }) => rest),
    blue: blue.sort((a, b) => a.index - b.index),
    args: { redValid: bits(red.filter((r) => r.valid)), redEvaded: bits(red.filter((r) => r.evaded)), blueScore: blue.sort((a, b) => a.index - b.index).map((b) => b.score) },
    dataset: validReds.map((r) => ({ id: `arena-${round.round}-red-${r.index}`, label: 1, src: 'arena', family: 'arena', evaded: r.evaded, rulesLevel: r.rulesLevel, level: r.level, sim: r.sim, f: r.f })),
  };
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes('--sandbox')) {
  checkPinned();
  const desc = sandboxOf(loadModel());
  console.log(JSON.stringify({ sandbox: sandboxHash(desc), description: desc }, null, 1));
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const round = JSON.parse(readFileSync(arg('round'), 'utf8'));
  const out = arg('out', new URL('../out/arena', import.meta.url).pathname);
  const res = await judgeRound(round);
  mkdirSync(out, { recursive: true });
  const { dataset, ...result } = res;
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1) + '\n');
  writeFileSync(`${out}/dataset.jsonl`, dataset.map((r) => JSON.stringify(r)).join('\n') + (dataset.length ? '\n' : ''));
  console.log(`round ${res.round}: ${res.red.filter((r) => r.valid).length}/${res.red.length} red valid, ${res.red.filter((r) => r.evaded).length} evaded Neuro; blue scores ${result.args.blueScore.join(', ')} -> ${out}`);
}
