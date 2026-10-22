// zetaphy deploy-timelock | timelock schedule | execute | cancel | status (cli.js hands these over).
// Every admin role of the important contracts belongs to the ZetaphyTimelock; its proposers are
// the governance multisig(s) or the chain's gov module. When this key cannot act (not a
// proposer / canceller), the command prints what the multisig must send (to, data) and, for
// the gov module, writes a MsgEVMCall proposal file for `zetaphyd tx gov submit-proposal`.

import { Contract, ContractFactory, Interface, getAddress, ZeroAddress, ZeroHash, isHexString } from 'ethers';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { TIMELOCK_ABI, ROLES, STATES, DEFAULT_DELAY, MIN_DELAY, saltOf, operationId, scheduleData, executeData, cancelData, callName, rolesOf } from './timelock.js';
import { devnetOf, multisigInfo, GOV_MODULE } from './bridgegate.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/** The gov module's bech32 address (sha256("gov")[:20]), the Sender of a MsgEVMCall proposal. */
export const GOV_MODULE_BECH32 = 'zetaphy10d07y265gmmuvt4z0w9aw880jnsr700jvr86lj';
const LOG_CHUNK = 2000; // the node's block-range-cap
const when = (t) => new Date(Number(t) * 1000).toISOString();

/** A gov proposal (JSON for `zetaphyd tx gov submit-proposal`): the gov module calls `to` with `data`. */
export function evmCallProposal({ to, data, title, summary, gasLimit = 500000 }) {
  return {
    messages: [{ '@type': '/zetaphy.pq.v1.MsgEVMCall', Sender: GOV_MODULE_BECH32, To: getAddress(to), Value: '0', Data: Buffer.from(String(data).slice(2), 'hex').toString('base64'), GasLimit: String(gasLimit) }],
    metadata: '', deposit: '1000000000000000000000azetaphy', title: String(title).slice(0, 140), summary, expedited: false,
  };
}

/** --to/--data or --to/--sig "fn(type,…)" --args a,b,… → { target, value, data }. */
export function callArgs(opt) {
  if (!ADDR_RE.test(String(opt.to ?? ''))) throw new Error('--to 0x<contract> is required');
  let data;
  if (opt.data != null) {
    data = String(opt.data);
    if (!isHexString(data) || data.length < 10) throw new Error('--data must be 0x calldata (at least a 4-byte selector)');
  } else if (opt.sig != null) {
    const iface = new Interface([`function ${String(opt.sig).replace(/^function\s+/, '')}`]);
    const fn = iface.fragments[0];
    const raw = opt.args == null || opt.args === true ? [] : String(opt.args).split(',').map((s) => s.trim());
    if (raw.length !== fn.inputs.length) throw new Error(`--args: ${fn.format('sighash')} takes ${fn.inputs.length} argument(s), got ${raw.length}`);
    const args = raw.map((v, i) => {
      const t = fn.inputs[i].baseType;
      if (t === 'bool') { if (!/^(true|false)$/.test(v)) throw new Error(`argument ${i + 1}: true or false`); return v === 'true'; }
      if (t === 'array' || t === 'tuple') throw new Error('arrays and tuples: build the calldata yourself and pass --data');
      return v;
    });
    data = iface.encodeFunctionData(fn, args);
  } else throw new Error('--data 0x… or --sig "fn(type,…)" --args a,b,… is required');
  const value = opt.value != null ? BigInt(String(opt.value)) : 0n;
  return { target: getAddress(String(opt.to)), value, data };
}

function timelockAt(s, opt, runner) {
  const a = opt.timelock ?? s.timelock;
  if (!ADDR_RE.test(String(a ?? ''))) throw new Error('no timelock: pass --timelock 0x… (or run zetaphy deploy-timelock; the launch state lists it as "timelock")');
  return new Contract(getAddress(String(a)), TIMELOCK_ABI, runner);
}

/** CallScheduled (+ CallSalt) logs of the timelock, newest last: [{ id, index, target, value, data, predecessor, delay, salt, block }]. */
export async function scheduledCalls(provider, timelock, { fromBlock = 0, toBlock = null, id = null } = {}) {
  const head = toBlock ?? await provider.getBlockNumber();
  const iface = new Interface(TIMELOCK_ABI);
  const sched = iface.getEvent('CallScheduled').topicHash;
  const saltT = iface.getEvent('CallSalt').topicHash;
  const out = [];
  const salts = new Map();
  for (let a = Math.max(0, fromBlock); a <= head; a += LOG_CHUNK) {
    const b = Math.min(head, a + LOG_CHUNK - 1);
    const logs = await provider.getLogs({ address: timelock.target, fromBlock: a, toBlock: b, topics: [[sched, saltT], id ? [id] : null] });
    for (const l of logs) {
      const p = iface.parseLog(l);
      if (p.name === 'CallSalt') { salts.set(p.args.id, p.args.salt); continue; }
      out.push({ id: p.args.id, index: Number(p.args.index), target: getAddress(p.args.target), value: p.args.value, data: p.args.data,
        predecessor: p.args.predecessor, delay: p.args.delay, block: l.blockNumber, tx: l.transactionHash });
    }
  }
  for (const o of out) o.salt = salts.get(o.id) ?? ZeroHash;
  return out;
}

/** One operation (all its calls) from the logs, or null. */
async function operation(provider, timelock, id, fromBlock) {
  const calls = (await scheduledCalls(provider, timelock, { fromBlock, id })).filter((c) => same(c.id, id));
  if (!calls.length) return null;
  const latest = Math.max(...calls.map((c) => c.block));
  return calls.filter((c) => c.block === latest).sort((a, b) => a.index - b.index);
}

async function hasRole(timelock, role, who) { return timelock.hasRole(role, who); }

function multisigHelp(write, timelock, data, what) {
  write(`${what}: this key cannot. Have a proposer send it:\n  to    ${timelock.target}\n  value 0\n  data  ${data}`);
  write('  SimpleMultisig: an owner calls propose(to, 0, data), others confirm, then execute. Safe: Transaction Builder, each owner signs on a hardware wallet.');
}

/** zetaphy deploy-timelock / timelock <cmd>. Returns an exit code, or null if not ours. */
export async function timelockCommand({ group, cmd, rest, opt, write, s, connect, saveSettings }) {
  if (group === 'deploy-timelock') {
    const c = await connect(s, { needJobs: false });
    const devnet = devnetOf(s.rpc, opt);
    const delay = Number(opt.delay ?? DEFAULT_DELAY);
    if (!Number.isInteger(delay) || delay < 0) throw new Error('--delay: seconds');
    if (delay < MIN_DELAY && !devnet) throw new Error(`--delay ${delay}: less than ${MIN_DELAY} s (24 h) only on a devnet (--devnet, local RPC)`);
    const proposers = String(opt.proposer ?? '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (x === 'gov' ? GOV_MODULE : x));
    if (!proposers.length || proposers.some((p) => !ADDR_RE.test(p))) throw new Error('--proposer 0x<multisig>[,0x…] or gov (the chain\'s gov module): who schedules and cancels');
    for (const p of proposers) {
      const info = await multisigInfo(c.provider, p);
      if (info.kind === 'eoa' && !devnet && !opt['allow-eoa-for-testing']) throw new Error(`--proposer ${p} is a single key (EOA): a multisig or the gov module (an EOA only with --devnet or --allow-eoa-for-testing)`);
      if (same(p, c.me) && !devnet) throw new Error('--proposer: not this deployer key');
    }
    const exec = String(opt.executor ?? 'open');
    const executors = exec === 'open' ? [ZeroAddress] : exec === 'proposers' ? proposers : null;
    if (!executors) throw new Error('--executor open (anyone executes a call whose delay passed; the default) or proposers');
    const a = art('ZetaphyTimelock');
    const k = await new ContractFactory(a.abi, a.bytecode, c.signer).deploy(delay, proposers, executors, ZeroAddress);
    const rc = await k.deploymentTransaction().wait();
    const addr = await k.getAddress();
    saveSettings({ timelock: addr, timelockBlock: rc.blockNumber });
    write(`ZetaphyTimelock ${addr} (delay ${delay} s; proposers/cancellers ${proposers.join(', ')}; executor ${exec === 'open' ? 'anyone' : 'the proposers'}; admin: itself)`);
    write('Hand each contract to it: its governance calls setGovernance / setOwner / setAdmin(timelock) (the DEX factory: then schedule acceptGovernance()).');
    return 0;
  }
  if (group !== 'timelock') return null;
  const fromBlock = Number(opt['from-block'] ?? s.timelockBlock ?? 0);

  if (cmd === 'status') {
    const c = await connect(s, { needJobs: false });
    const tl = timelockAt(s, opt, c.provider);
    const [delay, roles] = await Promise.all([tl.getMinDelay(), rolesOf(tl)]);
    write(`ZetaphyTimelock ${tl.target}: delay ${delay} s (${Number(delay) / 3600} h)`);
    const label = async (a) => (same(a, ZeroAddress) ? 'anyone' : same(a, tl.target) ? 'the timelock itself' : `${a} (${(await multisigInfo(c.provider, a)).kind})`);
    for (const [k, list] of Object.entries(roles)) write(`  ${k.padEnd(9)} ${(await Promise.all(list.map(label))).join(', ') || '(nobody)'}`);
    const now = BigInt((await c.provider.getBlock('latest')).timestamp);
    const show = async (id, calls) => {
      const state = STATES[Number(await tl.getOperationState(id))];
      const ts = await tl.getTimestamp(id);
      const eta = ts > 1n ? ` ETA ${when(ts)}${ts > now ? ` (in ${ts - now} s)` : ''}` : '';
      write(`${id}  ${state}${eta}`);
      for (const k of calls ?? []) write(`    → ${k.target} ${callName(k.data)}${k.value ? ` value ${k.value}` : ''}  data ${k.data}${k.salt !== ZeroHash ? `  salt ${k.salt}` : ''}`);
    };
    if (rest[0]) { await show(rest[0], await operation(c.provider, tl, rest[0], fromBlock)); return 0; }
    const all = await scheduledCalls(c.provider, tl, { fromBlock });
    const ids = [...new Set(all.map((x) => x.id))].slice(-Number(opt.last ?? 20));
    if (!ids.length) write(`no scheduled calls since block ${fromBlock}`);
    for (const id of ids) await show(id, all.filter((x) => x.id === id));
    return 0;
  }

  if (cmd === 'schedule') {
    const c = await connect(s, { needJobs: false });
    const tl = timelockAt(s, opt, c.signer);
    const call = callArgs(opt);
    const minDelay = await tl.getMinDelay();
    const delay = opt.delay != null ? BigInt(String(opt.delay)) : minDelay;
    if (delay < minDelay) throw new Error(`--delay ${delay}: the timelock's minimum is ${minDelay} s`);
    const salt = saltOf(opt.salt);
    const predecessor = opt.predecessor ? String(opt.predecessor) : ZeroHash;
    const op = { ...call, predecessor, salt };
    const id = operationId(op);
    const data = scheduleData({ ...op, delay });
    const now = BigInt((await c.provider.getBlock('latest')).timestamp);
    write(`operation ${id}: ${call.target} ${callName(call.data)}, executable after ${when(now + delay)} (delay ${delay} s)`);
    // A call the gov module schedules leaves no log eth_getLogs returns: keep the full command to run it later.
    const execCmd = `zetaphy timelock execute ${id} --timelock ${tl.target} --to ${call.target} --data ${call.data}${call.value ? ` --value ${call.value}` : ''}${salt !== ZeroHash ? ` --salt ${salt}` : ''}${predecessor !== ZeroHash ? ` --predecessor ${predecessor}` : ''}`;
    write(`after the delay, anyone runs:\n  ${execCmd}`);
    if (await hasRole(tl, ROLES.proposer, c.me)) {
      await (await tl.schedule(op.target, op.value, op.data, predecessor, salt, delay)).wait();
      write(`scheduled (by ${c.me}). After the delay anyone runs: zetaphy timelock execute ${id}`);
      return 0;
    }
    multisigHelp(write, tl, data, 'schedule');
    if (await hasRole(tl, ROLES.proposer, GOV_MODULE)) {
      const proposal = evmCallProposal({ to: tl.target, data, title: `Timelock: ${callName(call.data).split('(')[0]} on ${call.target.slice(0, 10)}…`,
        summary: `Schedules ${callName(call.data)} on ${call.target} through the ZetaphyTimelock ${tl.target} (operation ${id}; runs no earlier than ${delay} s after this vote passes; cancellable until then). Calldata ${call.data}` });
      if (opt['proposal-out']) {
        mkdirSync(dirname(String(opt['proposal-out'])), { recursive: true });
        writeFileSync(String(opt['proposal-out']), JSON.stringify(proposal, null, 2) + '\n');
        write(`  the gov module is a proposer: a vote can schedule it. Proposal written to ${opt['proposal-out']}:\n    zetaphyd tx gov submit-proposal ${opt['proposal-out']} --from <key> … then gov.sh vote <id> yes`);
      } else write(`  the gov module is a proposer: a vote can schedule it (pass --proposal-out file.json for zetaphyd tx gov submit-proposal):\n${JSON.stringify(proposal, null, 2)}`);
    }
    return 0;
  }

  if (cmd === 'execute') {
    const c = await connect(s, { needJobs: false });
    const tl = timelockAt(s, opt, c.signer);
    let calls;
    const explicit = () => { const call = callArgs(opt); return [{ ...call, predecessor: opt.predecessor ? String(opt.predecessor) : ZeroHash, salt: saltOf(opt.salt) }]; };
    if (opt.to) {
      // the call given in full (needed for one the gov module scheduled: its logs are not in eth_getLogs)
      calls = explicit();
      if (rest[0] && !same(operationId(calls[0]), rest[0])) throw new Error(`--to/--data/--salt/--predecessor give operation ${operationId(calls[0])}, not ${rest[0]}`);
    } else if (rest[0]) {
      calls = await operation(c.provider, tl, rest[0], fromBlock);
      if (!calls) throw new Error(`operation ${rest[0]}: no CallScheduled log since block ${fromBlock}; a call a gov vote scheduled has none: pass it in full (--to, --data or --sig/--args, --salt), as \`timelock schedule\` printed`);
    } else throw new Error('usage: zetaphy timelock execute <id> [--to 0x… --data 0x… | --sig … --args … --salt …]');
    const id = rest[0] ?? operationId(calls[0]);
    const state = STATES[Number(await tl.getOperationState(id))];
    const ts = await tl.getTimestamp(id);
    if (state !== 'Ready') throw new Error(`operation ${id} is ${state}${state === 'Waiting' ? ` until ${when(ts)}` : ''}: it cannot run now`);
    const batch = calls.length > 1;
    const k0 = calls[0];
    const data = batch
      ? tl.interface.encodeFunctionData('executeBatch', [calls.map((x) => x.target), calls.map((x) => x.value), calls.map((x) => x.data), k0.predecessor, k0.salt])
      : executeData(k0);
    const open = await hasRole(tl, ROLES.executor, ZeroAddress);
    if (!open && !(await hasRole(tl, ROLES.executor, c.me))) { multisigHelp(write, tl, data, 'execute'); return 0; }
    const value = calls.reduce((a, x) => a + BigInt(x.value), 0n);
    const rc = await (await c.signer.sendTransaction({ to: tl.target, data, value })).wait();
    write(`executed ${id} (${calls.map((x) => `${x.target} ${callName(x.data)}`).join('; ')}) in tx ${rc.hash}`);
    return 0;
  }

  if (cmd === 'cancel') {
    const id = rest[0];
    if (!isHexString(id ?? '', 32)) throw new Error('usage: zetaphy timelock cancel 0x<operation id>');
    const c = await connect(s, { needJobs: false });
    const tl = timelockAt(s, opt, c.signer);
    const state = STATES[Number(await tl.getOperationState(id))];
    if (state !== 'Waiting' && state !== 'Ready') throw new Error(`operation ${id} is ${state}: nothing to cancel`);
    if (await hasRole(tl, ROLES.canceller, c.me)) {
      await (await tl.cancel(id)).wait();
      write(`cancelled ${id}`);
      return 0;
    }
    multisigHelp(write, tl, cancelData(id), 'cancel');
    if (await hasRole(tl, ROLES.canceller, GOV_MODULE)) write(`  the gov module is a canceller: a vote can cancel it (MsgEVMCall to ${tl.target} with that data)`);
    return 0;
  }
  throw new Error('usage: zetaphy timelock status [<id>] | schedule --to 0x… (--data 0x… | --sig "fn(…)" --args …) [--salt s --delay s --proposal-out f] | execute <id> | cancel <id>');
}

/**
 * When `gov` (a contract's governance) is a ZetaphyTimelock: the lines to print for a governance call
 * (`zetaphy timelock schedule …`), else null. Used by bridge/threat/neuro commands.
 */
export async function timelockHint(provider, gov, target, data) {
  try {
    const tl = new Contract(gov, TIMELOCK_ABI, provider);
    const d = await tl.getMinDelay();
    return [`governance is the ZetaphyTimelock ${gov} (delay ${d} s): schedule it, then execute after the delay:`,
      `  zetaphy timelock schedule --timelock ${gov} --to ${target} --data ${data}`,
      '  (a proposer runs it; otherwise it prints what the governance multisig or a gov vote sends)'];
  } catch { return null; }
}

