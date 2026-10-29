// zetaphy fl deploy | propose | status | config: FederatedRounds for Neuro's federated learning
// (contracts/FederatedRounds.sol, docs/future/federated.md item 6). cli.js hands these over.
//
//   zetaphy fl deploy --governance 0x<ZetaphyTimelock>|gov [--start <block> | --start-in <blocks, default 14400>]
//                     [--commit-blocks 72000 --reveal-blocks 28800 --max-per-round 1000] [--out <deployment.json>] [--devnet]
//        deploys with this machine's key. The key never holds a role: governance is the timelock (a contract) or the
//        chain's gov module, never this key (a single key only with --devnet, a local RPC). The contract starts CLOSED
//        (paused): no commit until governance opens it. Prints the deployment record the Neuro page and the
//        aggregator read (zetaphy-neuro/ml/fl/deployment.json; --out writes it) and how to open it.
//   zetaphy fl propose open|close|max <n>|governance <0x…> [--rounds 0x…] [--timelock 0x… --salt text --delay 172800]
//                     [--proposal-out proposal.json]
//        no key, sends nothing: the call, and with --timelock the schedule/execute data and the operation id for the
//        proposers; --proposal-out writes a gov proposal (MsgEVMCall from the gov module) for zetaphyd tx gov submit-proposal.
//   zetaphy fl status [--rounds 0x…]      read only: open or closed, the round and phase, commits and reveals.
//   zetaphy fl config --rounds 0x… --block <deploy block> --governance 0x… [--out <deployment.json>]
//        the deployment record for a contract deployed some other way.
// --rounds defaults to zetaphy-neuro/ml/fl/deployment.json. Testnet only.

import { readFileSync, writeFileSync } from 'node:fs';
import { ContractFactory, Interface, getAddress } from 'ethers';
import { checkDeployment, DEPLOYMENT_FORMAT } from '../../zetaphy-neuro/ml/fl/deployment.js';
import { roundsClient } from '../../zetaphy-neuro/ml/fl/rounds.js';
import { timelockOp } from './modelregistry.js';
import { evmCallProposal } from './timelockcli.js';
import { GOV_MODULE, devnetOf } from './bridgegate.js';

const ART = JSON.parse(readFileSync(new URL('../artifacts/FederatedRounds.json', import.meta.url), 'utf8'));
export const ROUNDS_IFACE = new Interface(ART.abi);
export const DEPLOYMENT_FILE = new URL('../../zetaphy-neuro/ml/fl/deployment.json', import.meta.url);
/** One round a week at ~6 s blocks: 5 days to commit, 2 to reveal. */
export const FL_DEFAULTS = Object.freeze({ commitBlocks: 72000, revealBlocks: 28800, maxPerRound: 1000, startIn: 14400 });
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const posInt = (v, what) => { const n = Number(v); if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${what}: a positive integer`); return n; };

/** The committed record (or a given file); null when absent or malformed. */
export function readDeployment(file = DEPLOYMENT_FILE) {
  try { return checkDeployment(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}

/** The deployment record the page and the aggregator read. */
export function deploymentRecord({ rounds, deployBlock, governance, rpc, chainId = 77390, network = 'zetaphy-testnet', threatRegistry = null }) {
  return checkDeployment({ format: DEPLOYMENT_FORMAT, network, chainId, rpc, rounds: getAddress(rounds).toLowerCase(), deployBlock: Number(deployBlock),
    governance: governance === 'gov' ? GOV_MODULE : getAddress(governance), threatRegistry });
}
const recordJson = (r) => JSON.stringify({ format: r.format, network: r.network, chainId: r.chainId, rpc: r.rpc, rounds: r.rounds, deployBlock: r.deployBlock,
  governance: r.governance, threatRegistry: r.threatRegistry }, null, 1) + '\n';

/** A governance call on FederatedRounds: open | close | max <n> | governance <0x…>. */
export function governanceCall(what, arg) {
  if (what === 'open') return { fn: 'setPaused', args: [false] };
  if (what === 'close') return { fn: 'setPaused', args: [true] };
  if (what === 'max') return { fn: 'setMaxPerRound', args: [posInt(arg, 'max')] };
  if (what === 'governance') { if (!ADDR.test(String(arg))) throw new Error('governance <0x…>'); return { fn: 'setGovernance', args: [getAddress(arg)] }; }
  throw new Error('usage: zetaphy fl propose open|close|max <n>|governance <0x…>');
}

/** The call, its timelock operation (with `timelock`) and a gov proposal: what `fl propose` prints. */
export function proposal(rounds, call, { timelock, salt, delay } = {}) {
  const data = ROUNDS_IFACE.encodeFunctionData(call.fn, call.args);
  const out = { call: `${call.fn}(${call.args.map(String).join(', ')})`, to: getAddress(rounds), data };
  if (timelock) {
    if (!ADDR.test(String(timelock))) throw new Error('--timelock must be a 0x address');
    const op = timelockOp(rounds, data, { salt, delay: delay == null ? undefined : Number(delay) });
    Object.assign(out, { timelock: getAddress(timelock), operation: op.id, salt: op.salt, delay: op.delay, schedule: op.schedule, execute: op.execute });
    out.proposal = evmCallProposal({ to: timelock, data: op.schedule, title: `Neuro FL: ${out.call} on FederatedRounds`, summary: `Schedules ${out.call} on FederatedRounds ${out.to} through the ZetaphyTimelock (delay ${op.delay} s); anyone executes it after the delay.` });
  } else {
    out.proposal = evmCallProposal({ to: rounds, data, title: `Neuro FL: ${out.call} on FederatedRounds`, summary: `The gov module calls ${out.call} on FederatedRounds ${out.to} (only when the gov module is its governance).` });
  }
  return out;
}

const statusText = (s, rounds) => [
  `FederatedRounds ${rounds}: ${s.paused ? 'CLOSED (paused: no commits; governance opens it with zetaphy fl propose open)' : 'open'}`,
  `block ${s.block}: ${s.phase === 0 ? `before the first round (starts at block ${s.start})` : `round ${s.round}, ${s.phase === 1 ? 'commit' : 'reveal'} phase, ${s.blocksLeft} blocks left`}`,
  `this round: ${s.commits} commits, ${s.reveals} reveals (at most ${s.maxPerRound}); commit ${s.commitBlocks} + reveal ${s.revealBlocks} blocks per round`,
].join('\n');

/**
 * @param {object} o  cli.js context; `deps` replaces the chain parts in tests:
 *   { request(method, params), getCode(addr), deploy(args) -> {address, block}, me }
 */
export async function flCommand({ cmd, rest, opt, write, s, connect, connectRpc, deps = null }) {
  const roundsOf = () => {
    const r = opt.rounds ?? readDeployment()?.rounds;
    if (!ADDR.test(String(r ?? ''))) throw new Error('--rounds 0x<FederatedRounds> (zetaphy-neuro/ml/fl/deployment.json has none: not deployed yet)');
    return getAddress(r);
  };
  const viaProvider = (p) => ({
    request: async (m, params) => {
      if (m === 'eth_blockNumber') return '0x' + (await p.getBlockNumber()).toString(16);
      if (m === 'eth_call') return p.call(params[0]);
      return p.send(m, params);
    },
    getCode: (a) => p.getCode(a),
  });

  if (cmd === 'propose') {
    const what = rest[0];
    const out = proposal(roundsOf(), governanceCall(what, rest[1]), { timelock: opt.timelock, salt: opt.salt, delay: opt.delay });
    write(`${out.call}\n  to:   ${out.to}\n  data: ${out.data}`);
    if (out.timelock) {
      write(`timelock ${out.timelock}: operation ${out.operation} (salt ${out.salt}, delay ${out.delay} s)`);
      write(`  schedule data (a proposer sends it to the timelock): ${out.schedule}`);
      write(`  execute data (anyone, after the delay):             ${out.execute}`);
    } else write('(governance calls it directly: give --timelock 0x… for the timelock operation)');
    if (opt['proposal-out']) { writeFileSync(String(opt['proposal-out']), JSON.stringify(out.proposal, null, 1) + '\n'); write(`gov proposal written to ${opt['proposal-out']} (zetaphyd tx gov submit-proposal)`); }
    return 0;
  }

  if (cmd === 'config') {
    if (!ADDR.test(String(opt.rounds ?? '')) || !ADDR.test(String(opt.governance ?? '')) || opt.block == null) throw new Error('usage: zetaphy fl config --rounds 0x… --block <deploy block> --governance 0x… [--out file]');
    const rec = deploymentRecord({ rounds: opt.rounds, deployBlock: opt.block, governance: opt.governance, rpc: s.rpc ?? 'https://rpc.sawasdeecoin.com', threatRegistry: readDeployment()?.threatRegistry ?? null });
    if (opt.out) writeFileSync(String(opt.out), recordJson(rec));
    write(recordJson(rec).trimEnd());
    return 0;
  }

  if (cmd === 'status') {
    const rounds = roundsOf();
    const d = deps ?? viaProvider(await connectRpc(s));
    write(statusText(await roundsClient(d.request, rounds).status(), rounds));
    return 0;
  }

  if (cmd === 'deploy') {
    const gov = opt.governance === 'gov' ? GOV_MODULE : opt.governance;
    if (!ADDR.test(String(gov ?? ''))) throw new Error('--governance 0x<ZetaphyTimelock> or gov (the chain\'s gov module) is required: this key never holds a role');
    const devnet = deps ? !!opt.devnet : devnetOf(s.rpc, opt);
    let d = deps;
    let c = null;
    if (!d) {
      c = await connect(s, { needJobs: false });
      d = { ...viaProvider(c.provider), me: c.me,
        deploy: async (args) => {
          const k = await new ContractFactory(ART.abi, ART.bytecode, c.signer).deploy(...args);
          const rc = await k.deploymentTransaction().wait();
          return { address: await k.getAddress(), block: rc.blockNumber };
        } };
    }
    if (same(gov, d.me) && !devnet) throw new Error('--governance: not this deployer key');
    if (!same(gov, GOV_MODULE) && (await d.getCode(gov)) === '0x' && !devnet) throw new Error('--governance is a single key, not a contract: use the ZetaphyTimelock (or gov; a key only with --devnet on a local RPC)');
    const head = BigInt(await d.request('eth_blockNumber', []));
    const start = opt.start != null ? BigInt(posInt(opt.start, '--start')) : head + BigInt(opt['start-in'] != null ? posInt(opt['start-in'], '--start-in') : FL_DEFAULTS.startIn);
    if (start <= head) throw new Error(`--start ${start} is not after the current block ${head}`);
    const commitBlocks = opt['commit-blocks'] != null ? posInt(opt['commit-blocks'], '--commit-blocks') : FL_DEFAULTS.commitBlocks;
    const revealBlocks = opt['reveal-blocks'] != null ? posInt(opt['reveal-blocks'], '--reveal-blocks') : FL_DEFAULTS.revealBlocks;
    const maxPerRound = opt['max-per-round'] != null ? posInt(opt['max-per-round'], '--max-per-round') : FL_DEFAULTS.maxPerRound;
    const { address, block } = await d.deploy([getAddress(gov), start, commitBlocks, revealBlocks, maxPerRound]);
    const st = await roundsClient(d.request, address).status();
    if (!st.paused) throw new Error(`FederatedRounds ${address} is not closed after deploy: do not use it`);
    const rec = deploymentRecord({ rounds: address, deployBlock: block, governance: gov, rpc: s.rpc ?? 'https://rpc.sawasdeecoin.com',
      network: devnet ? 'devnet' : 'zetaphy-testnet', threatRegistry: readDeployment()?.threatRegistry ?? null });
    if (opt.out) writeFileSync(String(opt.out), recordJson(rec));
    write(`FederatedRounds ${getAddress(address)} (governance ${getAddress(gov)}; CLOSED: no commits until governance opens it)`);
    write(`rounds: start block ${start}, commit ${commitBlocks} + reveal ${revealBlocks} blocks, at most ${maxPerRound} commits a round`);
    const timelock = same(gov, GOV_MODULE) ? null : getAddress(gov);
    write(`to open it: zetaphy fl propose open --rounds ${getAddress(address)}${timelock ? ` --timelock ${timelock}` : ' --proposal-out open.json'}`);
    write(`commit the record${opt.out ? ` (${opt.out})` : ''} as zetaphy-neuro/ml/fl/deployment.json: the Neuro page and the weekly aggregator read it.`);
    write(recordJson(rec).trimEnd());
    return 0;
  }
  throw new Error('usage: zetaphy fl deploy | propose | status | config (see the top of src/flcli.js)');
}
