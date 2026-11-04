// Deterministic property drafting: no AI, the same contract always gives the same draft.
// Patterns (each a guess the prover then checks; a wrong guess comes back as a counterexample):
//   access         a state-changing function whose reverts compare msg.sender with state
//                  (`msg.sender != governance`, `!guardian[msg.sender]`): nobody else gets through
//   monotonic      a uint state variable that is only ever increased (+=, ++): it never decreases
//   conservation   a mapping(address => uint) and a uint total written together (a token's
//                  balanceOf / totalSupply, a vault's deposits / total): every call moves the total
//                  by exactly the sum of the balance changes of the accounts it touches
//   backing        a uint increased in a payable function and decreased where ETH leaves:
//                  the contract always holds at least that much ETH (supply <= backing)
//   pause-noloss   a `paused` flag with a pause function: pausing (and unpausing) changes no
//                  balance and no accounting, it only stops things
//   paused-blocks  functions that check the flag revert while paused
//   cei            a function that calls out (and is not behind a reentrancy lock) writes no
//                  storage after the call (checks-effects-interactions; checked on the AST)
import { relative } from 'node:path';
import { getters, REPO } from './analyze.js';
import { SCHEMA, TOOL, keccakText, canonical, harnessViewNames } from './spec.js';

const uintT = (t) => /^uint\d*$/.test(t);
// public by design in every ERC-20 (the conservation property covers what they move)
const ERC20_PUBLIC = new Set(['transfer', 'transferFrom', 'approve', 'increaseAllowance', 'decreaseAllowance', 'permit']);

/** Default constructor arguments and actors: distinct constant addresses, plausible numbers. */
export function draftHarness(model) {
  const notes = [];
  const args = [];
  const actors = [];
  let addr = 0x1000;
  for (const p of model.ctorParams) {
    const n = p.name.toLowerCase();
    if (p.abiType === 'address') {
      const a = `address(0x${(addr++).toString(16)})`;
      if (/^contract /.test(p.type)) {
        notes.push(`constructor argument \`${p.name}\` is a contract (${p.type.slice(9)}): the draft passes a plain address; give it a mock in harness.helpers / setup if the contract calls it`);
        args.push(a);
      } else { args.push(a); actors.push(a); }
    } else if (/^uint/.test(p.abiType)) {
      if (/decimals/.test(n)) args.push('18');
      else if (/delay|period|window/.test(n)) args.push('1 days');
      else if (/limit|cap|max/.test(n)) args.push('1000 ether');
      else if (/chain/.test(n)) args.push('block.chainid');
      else args.push('1');
    } else if (/^int/.test(p.abiType)) args.push('1');
    else if (p.abiType === 'bool') args.push('false');
    else if (/^bytes\d+$/.test(p.abiType)) args.push(`${p.abiType}(uint${Number(p.abiType.slice(5)) * 8}(1))`);
    else if (p.abiType === 'string') args.push('"T"');
    else if (p.abiType === 'bytes') args.push('""');
    else { args.push('/* REVIEW */ 0'); notes.push(`constructor argument \`${p.name}\` (${p.type}): no default; write it in harness.setup`); }
  }
  actors.push('address(0xA11CE)', 'address(0xB0B)');
  const value = model.ctorPayable ? '{value: 0}' : '';
  const steps = model.functions.filter((f) => !f.view && f.supported && f.kind === 'function').map((f) => f.name);
  const unsupported = model.functions.filter((f) => !f.view && !f.supported && f.kind === 'function').map((f) => f.name);
  if (unsupported.length) notes.push(`not used in sequences (argument types the generator does not decode): ${unsupported.join(', ')}`);
  if (model.functions.some((f) => f.kind === 'receive')) steps.push('receive');
  return {
    status: notes.length ? 'needs-review' : 'drafted',
    notes,
    imports: [],
    helpers: '',
    state: '',
    setup: `t = new ${model.name}${value}(${args.join(', ')});`,
    actors,
    actions: {},
    words: {},
    bytesWords: {},
    views: '',
    steps: [...steps, 'warp'],
  };
}

/** The spec drafted from the model (properties all "proposed"). */
export function draft(model, { docs = [] } = {}) {
  const g = getters(model.abi);
  const has = (name, ins = [], outs = null) => g[name] && g[name].inputs.join() === ins.join() && (!outs || g[name].outputs.join() === outs.join());
  const props = [];
  const notes = [];
  const fns = model.functions.filter((f) => f.kind === 'function' && !f.view);
  const sv = Object.fromEntries(model.stateVars.map((v) => [v.name, v]));
  const add = (p) => props.push({ origin: 'heuristic', status: 'proposed', ...p });

  // access control
  for (const f of fns) {
    const eq = f.sender.eq.filter((v) => has(v, [], ['address']));
    const map = f.sender.map.filter((v) => has(v, ['address'], ['bool']));
    const missing = [...f.sender.eq, ...f.sender.map].filter((v) => !eq.includes(v) && !map.includes(v));
    if (eq.length || map.length) {
      if (!f.supported) { notes.push({ kind: 'access', function: f.name, text: 'caller check found, but its argument types are not decoded by the generator: check by hand' }); continue; }
      const who = [...eq, ...map.map((m) => `a ${m}`)].join(' or ');
      add({
        id: `access-${f.name}`, kind: 'access', confidence: f.sender.other || missing.length ? 'medium' : 'high',
        title: `only ${who} can call ${f.name}`,
        statement: `For every caller that is not ${eq.map((v) => `\`${v}()\``).concat(map.map((m) => `in \`${m}\``)).join(' and not ')}, and for all arguments (and any ETH sent), \`${f.name}\` reverts.`,
        rationale: `${f.name} (line ${f.line}) reverts on a comparison of msg.sender with ${[...f.sender.eq, ...f.sender.map].join(', ')}.`,
        scope: 'all callers outside the set, all arguments, from the setup state',
        check: { function: f.name, authorized: { eq, map } },
      });
    } else if (missing.length) {
      notes.push({ kind: 'access', function: f.name, text: `caller check on ${missing.join(', ')}, which has no public getter: the generator cannot name the authorized set` });
    } else if (Object.keys(f.writes).length && !f.sender.other && !ERC20_PUBLIC.has(f.name)) {
      notes.push({ kind: 'unguarded', function: f.name, text: `changes ${Object.keys(f.writes).join(', ')} and anyone can call it: intended?` });
    }
  }

  // monotonic counters
  for (const v of model.stateVars.filter((x) => x.kind === 'elementary' && uintT(x.type) && !x.constant && !x.immutable)) {
    const writers = fns.filter((f) => f.writes[v.name]);
    if (!writers.length || !has(v.name, [], [v.type])) continue;
    if (writers.every((f) => f.writes[v.name].inc && !f.writes[v.name].dec && !f.writes[v.name].set)) {
      add({
        id: `monotonic-${v.name}`, kind: 'monotonic', confidence: /nonce|count|received|next|id|total|seq/i.test(v.name) ? 'high' : 'medium',
        title: `${v.name} never decreases`,
        statement: `No call, by anyone, with any arguments, makes \`${v.name}\` smaller (it is only ever increased: ${writers.map((f) => f.name).join(', ')}).`,
        rationale: `every write of ${v.name} is += or ++.`,
        scope: `every function that writes ${v.name}, any caller and arguments, from any state reachable in prover.depth-1 steps`,
        check: { var: v.name, functions: writers.filter((f) => f.supported).map((f) => f.name) },
      });
    }
  }

  // conservation: mapping(address => uint) + a uint total written in the same functions
  for (const m of model.stateVars.filter((x) => x.kind === 'mapping' && x.keyType === 'address' && uintT(x.valueType ?? ''))) {
    if (!has(m.name, ['address'], [m.valueType])) continue;
    const mw = fns.filter((f) => f.writes[m.name]);
    if (!mw.length) continue;
    for (const tot of model.stateVars.filter((x) => x.kind === 'elementary' && uintT(x.type) && !x.constant && !x.immutable)) {
      if (!has(tot.name, [], [tot.type])) continue;
      const tw = fns.filter((f) => f.writes[tot.name]);
      const both = mw.filter((f) => f.writes[tot.name]);
      const nameHit = /supply|total|deposit|staked|shares/i.test(tot.name);
      if (!tw.length || !both.length || !nameHit) continue;
      const fnsOf = [...new Set([...mw, ...tw])].filter((f) => f.supported);
      add({
        id: `conservation-${m.name}-${tot.name}`, kind: 'conservation', confidence: /supply/i.test(tot.name) && /balance/i.test(m.name) ? 'high' : 'medium',
        title: `${tot.name} moves exactly with the ${m.name} it sums`,
        statement: `Every call changes \`${tot.name}\` by exactly the total change of \`${m.name}\` over the accounts it touches (the caller and every address argument): nothing is created or lost in between. Transfers leave \`${tot.name}\` unchanged.`,
        rationale: `${m.name} and ${tot.name} are written together in ${both.map((f) => f.name).join(', ')}.`,
        scope: 'every function that writes either, any caller and arguments, from any state reachable in prover.depth-1 steps',
        check: { map: m.name, total: tot.name, functions: fnsOf.map((f) => f.name) },
      });
    }
  }

  // backing: a uint increased by a payable function and decreased where ETH leaves
  const payIn = fns.filter((f) => f.payable);
  const payOut = fns.filter((f) => f.calls.some((c) => c.value));
  for (const v of model.stateVars.filter((x) => x.kind === 'elementary' && uintT(x.type) && !x.constant && !x.immutable)) {
    if (!has(v.name, [], [v.type])) continue;
    const up = payIn.filter((f) => f.writes[v.name]?.inc);
    const down = payOut.filter((f) => f.writes[v.name]?.dec);
    if (!up.length || !down.length) continue;
    add({
      id: `backing-${v.name}`, kind: 'invariant', pattern: 'backing', confidence: 'high',
      title: `the contract always holds at least ${v.name} in ETH`,
      statement: `After any sequence of calls (by anyone, with any arguments), the contract's ETH balance is at least \`${v.name}\`: what it owes is always backed (${up.map((f) => f.name).join(', ')} add, ${down.map((f) => f.name).join(', ')} pay out).`,
      rationale: `${v.name} grows in payable ${up.map((f) => f.name).join(', ')} and shrinks where ETH is sent (${down.map((f) => f.name).join(', ')}).`,
      scope: 'bounded: every sequence of prover.depth calls over harness.steps from the setup state (Halmos); unbounded where the SMTChecker proves it; fuzzed by forge',
      check: { expr: `address(t).balance >= t.${v.name}()` },
    });
  }

  // pause: no loss, and the paused functions stop
  const pausedVar = model.stateVars.find((v) => /^_?paused$/i.test(v.name) && v.type === 'bool');
  if (pausedVar && has(pausedVar.name, [], ['bool'])) {
    const pauseFn = fns.find((f) => f.setsPaused && f.params.length === 0 && /^pause$/i.test(f.name)) ?? fns.find((f) => f.setsPaused && f.params.length === 0 && /pause/i.test(f.name) && !/unpause/i.test(f.name));
    const unpauseFn = fns.find((f) => f.setsPaused && f.params.length === 0 && /unpause/i.test(f.name));
    const byOf = (f) => f?.sender.eq.find((v) => has(v, [], ['address']));
    if (pauseFn && byOf(pauseFn)) {
      const others = Object.keys(pauseFn.writes).filter((w) => w !== pausedVar.name);
      add({
        id: 'pause-noloss', kind: 'pause-noloss', confidence: others.length ? 'low' : 'high',
        title: 'pausing loses nothing',
        statement: `\`${pauseFn.name}\`${unpauseFn ? ` and \`${unpauseFn.name}\`` : ''} change no balance and no public state except \`${pausedVar.name}\`: the contract's ETH and every public number, address and flag are the same before and after.`,
        rationale: `${pauseFn.name} writes ${Object.keys(pauseFn.writes).join(', ')}.`,
        scope: 'from any state reachable in prover.depth-1 steps; public no-argument getters and the ETH balance (mappings are covered by the AST fact that pause writes only the flag)',
        check: { pause: pauseFn.name, unpause: unpauseFn?.name ?? null, by: byOf(pauseFn), unpauseBy: byOf(unpauseFn) ?? byOf(pauseFn), flag: pausedVar.name },
      });
      for (const f of fns.filter((x) => x.checksPaused && x.supported && x !== pauseFn && x !== unpauseFn)) {
        add({
          id: `paused-blocks-${f.name}`, kind: 'paused-blocks', confidence: 'high',
          title: `${f.name} is stopped while paused`,
          statement: `Once \`${pauseFn.name}\` ran, \`${f.name}\` reverts for every caller and argument.`,
          rationale: `${f.name} reverts on ${pausedVar.name}.`,
          scope: 'any caller and arguments, after a pause from any state reachable in prover.depth-1 steps',
          check: { function: f.name, pause: pauseFn.name, by: byOf(pauseFn) },
        });
      }
    }
  }

  // checks-effects-interactions / reentrancy guard
  for (const f of fns.filter((x) => x.calls.length)) {
    const guarded = f.lockVars.length > 0 || f.nonReentrantMod;
    add({
      id: `cei-${f.name}`, kind: 'cei', confidence: 'high',
      title: `${f.name}: no storage write after an external call${guarded ? ' (or behind its reentrancy lock)' : ''}`,
      statement: `\`${f.name}\` makes external calls (${f.calls.map((c) => `${c.to}${c.value ? ' with ETH' : ''} line ${c.line}`).join(', ')}); ${guarded ? `it is behind a reentrancy lock (${[...f.lockVars, ...(f.nonReentrantMod ? ['modifier'] : [])].join(', ')}), so` : 'every'} storage write happens before the first call.`,
      rationale: 'a write after an external call lets the callee re-enter while the state is stale (the classic reentrancy pattern).',
      scope: 'static: the solc AST of the function, its modifiers and the internal functions it calls',
      check: { function: f.name },
    });
  }

  const harness = draftHarness(model);
  return {
    schema: SCHEMA,
    target: { contract: model.name, root: relative(REPO, model.projectRoot), file: model.file, project: model.project, sourceHash: sourceHash(model.sources), solc: model.solcVersion },
    drafted: { by: TOOL, heuristics: true, llm: null, docs: docs.map((d) => d.name) },
    harness,
    prover: { depth: 2, halmos: { loop: 3, solverTimeoutMs: 60000, wallSec: 1800 }, forge: { runs: 256, depth: 20 }, smtchecker: { engine: 'chc', timeoutMs: 60000, wallSec: 600 } },
    properties: props,
    notes,
    approval: null,
  };
}

/** keccak256 of the canonical {path: content} of the target's source closure. */
export const sourceHash = (sources) => keccakText(canonical(Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, v.content]))));

export { harnessViewNames };
