// Reads one Solidity contract through solc's AST (compact JSON) and builds the model the
// heuristics work on: state variables, functions with their (transitive) storage writes,
// caller checks, external calls, reentrancy locks and pause checks.
//
// The AST comes from the pinned native solc (SOLC env, or `solc` on PATH: audit/tools/install.sh
// installs 0.8.26) or, when that is missing, from solc-js in zetaphy-network/node_modules. Nothing
// here is trusted for a proof: a wrong guess drafts a property that the prover then refutes.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { sourceClosure } from '../../lib/scope.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');

/** The solc to use: { kind: 'native', bin, version } | { kind: 'js', solc, version } | null. */
export function findSolc(prefer = process.env.SOLC) {
  for (const bin of [prefer, 'solc'].filter(Boolean)) {
    try {
      const v = execFileSync(bin, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const version = v.match(/Version: (\S+)/)?.[1];
      if (version) return { kind: 'native', bin, version };
    } catch { /* not installed */ }
  }
  const js = join(REPO, 'zetaphy-network/node_modules/solc/index.js');
  if (existsSync(js)) {
    const solc = createRequire(import.meta.url)(js);
    return { kind: 'js', solc, version: solc.version() };
  }
  return null;
}

export function compileStandard(input, solc = findSolc()) {
  if (!solc) throw new Error('solc not installed (set SOLC, put solc on PATH: audit/tools/install.sh, or npm ci in zetaphy-network)');
  const out = solc.kind === 'native'
    ? execFileSync(solc.bin, ['--standard-json'], { input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 1 << 30 })
    : solc.solc.compile(JSON.stringify(input));
  const o = JSON.parse(out);
  const errs = (o.errors ?? []).filter((e) => e.severity === 'error');
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join('\n'));
  return o;
}

/** The project a file belongs to: its root (dir) and remappings (from audit/scope.json, else none). */
export function projectOf(absFile) {
  const scope = JSON.parse(readFileSync(join(REPO, 'audit/scope.json'), 'utf8'));
  for (const p of scope.projects) {
    const root = join(REPO, p.root);
    if (absFile.startsWith(root + '/')) return { root, rel: absFile.slice(root.length + 1), remappings: p.remappings ?? [], name: p.name };
  }
  return { root: dirname(absFile), rel: absFile.slice(dirname(absFile).length + 1), remappings: [], name: null };
}

// ------------------------------------------------------------------ AST walking

function walk(node, fn, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, fn, parent); return; }
  if (node.nodeType && fn(node, parent) === false) return;
  for (const [k, v] of Object.entries(node)) if (k !== 'typeDescriptions' && v && typeof v === 'object') walk(v, fn, node.nodeType ? node : parent);
}

const isMsgSender = (e) => e?.nodeType === 'MemberAccess' && e.memberName === 'sender' && e.expression?.nodeType === 'Identifier' && e.expression.name === 'msg';
const typeStr = (e) => e?.typeDescriptions?.typeString ?? '';
const srcStart = (n) => Number(String(n.src).split(':')[0]);
const lineOf = (text, n) => text.slice(0, srcStart(n)).split('\n').length;

/** ABI type of a parameter (null: not supported by the generators). */
export function abiType(ts) {
  if (/^(uint|int)\d*$/.test(ts) || ts === 'address' || ts === 'address payable' || ts === 'bool' || /^bytes\d+$/.test(ts)) return ts.replace(' payable', '');
  if (ts === 'bytes calldata' || ts === 'bytes memory' || ts === 'bytes') return 'bytes';
  if (ts === 'string calldata' || ts === 'string memory' || ts === 'string') return 'string';
  if (/^contract /.test(ts)) return 'address';
  if (/^enum /.test(ts)) return 'uint8';
  return null;
}

/**
 * The model of contract `name` in `file` (path to the .sol file).
 * @returns {{ name, file, project, sources, solcVersion, ctorParams, stateVars, functions, abi, text }}
 */
export function analyze(file, name, { solc = findSolc() } = {}) {
  const abs = resolve(file);
  const proj = projectOf(abs);
  const { sources, missing } = sourceClosure(proj.root, [proj.rel], proj.remappings);
  if (missing?.length) throw new Error(`imports not found: ${missing.join(', ')}`);
  const out = compileStandard({ language: 'Solidity', sources,
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '': ['ast'], '*': ['abi'] } } } }, solc);
  const units = Object.values(out.sources).map((s) => s.ast);
  const byId = new Map();
  for (const u of units) walk(u, (n) => { if (n.id != null) byId.set(n.id, n); });
  const text = sources[proj.rel].content;
  const unit = out.sources[proj.rel].ast;
  const contract = unit.nodes.find((n) => n.nodeType === 'ContractDefinition' && n.name === name);
  if (!contract) throw new Error(`contract ${name} not found in ${proj.rel}`);
  const chain = contract.linearizedBaseContracts.map((id) => byId.get(id)); // most derived first

  // state variables (base contracts' too)
  const stateVars = new Map();
  for (const c of [...chain].reverse()) for (const n of c.nodes) if (n.nodeType === 'VariableDeclaration' && n.stateVariable) {
    const tn = n.typeName;
    stateVars.set(n.id, {
      id: n.id, name: n.name, type: typeStr(n), visibility: n.visibility, constant: !!n.constant, immutable: n.mutability === 'immutable',
      kind: tn.nodeType === 'Mapping' ? 'mapping' : tn.nodeType === 'ElementaryTypeName' ? 'elementary' : tn.nodeType === 'ArrayTypeName' ? 'array' : 'other',
      keyType: tn.nodeType === 'Mapping' ? typeStr(tn.keyType) : null,
      valueType: tn.nodeType === 'Mapping' ? typeStr(tn.valueType) : null,
      contractType: /^contract /.test(typeStr(n)),
    });
  }
  // functions and modifiers visible in the contract (most derived wins for each name+params)
  const fnDefs = new Map(); // id -> FunctionDefinition | ModifierDefinition
  for (const c of chain) for (const n of c.nodes) if (n.nodeType === 'FunctionDefinition' || n.nodeType === 'ModifierDefinition') fnDefs.set(n.id, n);

  // storage-pointer locals -> state var id (Route storage r = routes[id]; or = _use(...))
  const rootOf = (e, alias) => {
    for (;;) {
      if (!e) return null;
      if (e.nodeType === 'Identifier') {
        if (stateVars.has(e.referencedDeclaration)) return e.referencedDeclaration;
        return alias.get(e.referencedDeclaration) ?? null;
      }
      if (e.nodeType === 'IndexAccess') { e = e.baseExpression; continue; }
      if (e.nodeType === 'MemberAccess') { e = e.expression; continue; }
      if (e.nodeType === 'TupleExpression' && e.components?.length === 1) { e = e.components[0]; continue; }
      return null;
    }
  };

  const memo = new Map();
  /** Events of a function body in source order: write / call / lockcheck, expanding internal calls and modifiers. */
  function facts(def, stack = new Set()) {
    if (memo.has(def.id)) return memo.get(def.id);
    if (stack.has(def.id)) return { events: [], guards: [], senderOther: false, conds: [], returnRoots: new Set() };
    stack.add(def.id);
    const alias = new Map();
    const events = [];
    const guards = [];     // { kind: 'eq'|'map', var }
    const conds = [];      // state vars read in a revert condition
    const returnRoots = new Set();
    let senderOther = false;
    const paramIds = new Set((def.parameters?.parameters ?? []).map((p) => p.id));
    const retParams = (def.returnParameters?.parameters ?? []).filter((p) => p.storageLocation === 'storage');

    const condition = (cond) => {
      walk(cond, (n) => {
        if (n.nodeType === 'Identifier' && stateVars.has(n.referencedDeclaration)) conds.push(n.referencedDeclaration);
        if (n.nodeType === 'BinaryOperation' && (n.operator === '==' || n.operator === '!=')) {
          const [a, b] = [n.leftExpression, n.rightExpression];
          const other = isMsgSender(a) ? b : isMsgSender(b) ? a : null;
          if (other) {
            // `x` or `address(x)` with x a state variable
            const id = other.nodeType === 'FunctionCall' && other.kind === 'typeConversion' && other.arguments?.length === 1 ? other.arguments[0] : other;
            const v = id.nodeType === 'Identifier' ? id.referencedDeclaration : null;
            if (v != null && stateVars.has(v)) guards.push({ kind: 'eq', var: v }); else senderOther = true;
          }
        }
        if (n.nodeType === 'IndexAccess' && isMsgSender(n.indexExpression) && n.baseExpression?.nodeType === 'Identifier' && stateVars.has(n.baseExpression.referencedDeclaration)
          && stateVars.get(n.baseExpression.referencedDeclaration).valueType === 'bool') guards.push({ kind: 'map', var: n.baseExpression.referencedDeclaration });
      });
    };
    const reverts = (stmt) => {
      let r = false;
      walk(stmt, (n) => { if (n.nodeType === 'RevertStatement' || (n.nodeType === 'FunctionCall' && n.expression?.nodeType === 'Identifier' && n.expression.name === 'revert')) r = true; });
      return r;
    };
    const write = (lhs, op, node) => {
      const v = rootOf(lhs, alias);
      if (v != null) events.push({ t: 'write', var: v, op, direct: lhs.nodeType === 'Identifier', line: lineOf(text, node) });
    };

    const visit = (node) => {
      walk(node, (n) => {
        switch (n.nodeType) {
          case 'VariableDeclarationStatement': {
            for (const d of n.declarations) if (d && d.storageLocation === 'storage' && n.initialValue) {
              const init = n.initialValue;
              let r = rootOf(init, alias);
              if (r == null && init.nodeType === 'FunctionCall') {
                const callee = fnDefs.get(init.expression?.referencedDeclaration);
                if (callee) { const f = facts(callee, stack); r = [...f.returnRoots][0] ?? null; }
              }
              if (r != null) alias.set(d.id, r);
            }
            if (n.initialValue) visit(n.initialValue);
            return false;
          }
          case 'Assignment':
            visit(n.rightHandSide);
            write(n.leftHandSide, n.operator, n);
            if (retParams.some((p) => p.id === n.leftHandSide.referencedDeclaration)) { const r = rootOf(n.rightHandSide, alias); if (r != null) returnRoots.add(r); }
            walk(n.leftHandSide, (m) => { if (m.nodeType === 'IndexAccess') visit(m.indexExpression); });
            return false;
          case 'UnaryOperation':
            if (['++', '--', 'delete'].includes(n.operator)) { write(n.subExpression, n.operator, n); return false; }
            return undefined;
          case 'Return':
            if (n.expression) { const r = rootOf(n.expression, alias); if (r != null) returnRoots.add(r); }
            return undefined;
          case 'IfStatement':
            if (reverts(n.trueBody)) condition(n.condition);
            return undefined;
          case 'FunctionCall': {
            const callee = n.expression;
            if (callee?.nodeType === 'Identifier' && (callee.name === 'require' || callee.name === 'assert') && n.arguments?.[0]) { condition(n.arguments[0]); return undefined; }
            const target = callee?.nodeType === 'FunctionCallOptions' ? callee.expression : callee;
            const hasValue = callee?.nodeType === 'FunctionCallOptions' && (callee.names ?? []).includes('value');
            // internal call (incl. super.f and library internal functions)
            const ref = target?.referencedDeclaration;
            const def2 = ref != null ? (fnDefs.get(ref) ?? byId.get(ref)) : null;
            const ft = typeStr(target);
            if (def2 && def2.nodeType === 'FunctionDefinition' && (/ internal| private/.test(ft) || target.nodeType === 'Identifier')) {
              for (const a of n.arguments ?? []) visit(a);
              const f = facts(def2, stack);
              events.push(...f.events.map((e) => ({ ...e, via: def2.name })));
              guards.push(...f.guards); conds.push(...f.conds); senderOther ||= f.senderOther;
              return false;
            }
            if (target?.nodeType === 'MemberAccess') {
              const base = typeStr(target.expression);
              const external = / external/.test(ft) || ['call', 'transfer', 'send', 'delegatecall'].includes(target.memberName) && /^address/.test(base);
              const isView = / view | pure |\bview$|\bpure$/.test(ft) || target.memberName === 'staticcall';
              if (external && !isView) {
                const value = hasValue || ['transfer', 'send'].includes(target.memberName);
                for (const a of n.arguments ?? []) visit(a);
                if (target.expression) visit(target.expression);
                if (callee.nodeType === 'FunctionCallOptions') for (const o of callee.options ?? []) visit(o);
                events.push({ t: 'call', value, to: target.memberName, line: lineOf(text, n) });
                return false;
              }
              // array push / pop on a state array
              if ((target.memberName === 'push' || target.memberName === 'pop') && /\[\] storage/.test(base)) write(target.expression, target.memberName, n);
            }
            return undefined;
          }
          default:
            return undefined;
        }
      });
    };

    if (def.nodeType === 'FunctionDefinition') {
      // modifiers wrap the body: [pre-placeholder] body [post-placeholder]
      const mods = (def.modifiers ?? []).map((m) => fnDefs.get(m.modifierName?.referencedDeclaration)).filter((m) => m?.nodeType === 'ModifierDefinition');
      const pre = []; const post = [];
      for (const m of mods) {
        const stmts = m.body?.statements ?? [];
        const ph = stmts.findIndex((s) => s.nodeType === 'PlaceholderStatement');
        const before = ph < 0 ? stmts : stmts.slice(0, ph);
        const after = ph < 0 ? [] : stmts.slice(ph + 1);
        const save = events.length;
        for (const s of before) visit(s);
        pre.push(...events.splice(save));
        for (const s of after) visit(s);
        post.unshift(...events.splice(save));
      }
      events.push(...pre);
      if (def.body) visit(def.body);
      events.push(...post);
    } else if (def.body) visit(def.body);
    void paramIds;
    const r = { events, guards, senderOther, conds, returnRoots };
    stack.delete(def.id);
    memo.set(def.id, r);
    return r;
  }

  // public/external functions of the most derived contract (overrides resolved by solc's baseFunctions)
  const overridden = new Set();
  for (const d of fnDefs.values()) for (const b of d.baseFunctions ?? []) overridden.add(b);
  const functions = [];
  for (const def of fnDefs.values()) {
    if (def.nodeType !== 'FunctionDefinition' || overridden.has(def.id)) continue;
    const isEntry = def.kind === 'constructor' || def.kind === 'receive' || def.kind === 'fallback' || def.visibility === 'public' || def.visibility === 'external';
    if (!isEntry) continue;
    const f = facts(def);
    const params = (def.parameters?.parameters ?? []).map((p, i) => ({ name: p.name || `arg${i}`, type: typeStr(p), abiType: abiType(typeStr(p).replace(/ (calldata|memory|storage)$/, '')) }));
    const writes = {};
    for (const e of f.events) if (e.t === 'write') {
      const v = stateVars.get(e.var).name;
      writes[v] ??= { inc: false, dec: false, set: false, direct: false, lines: [] };
      const w = writes[v];
      if (e.op === '+=' || e.op === '++' || e.op === 'push') w.inc = true; else if (e.op === '-=' || e.op === '--') w.dec = true; else w.set = true;
      if (e.direct) w.direct = true;
      w.lines.push(e.line);
    }
    // the reentrancy lock: a state var read in a revert condition and written by the function
    // (only ever assigned, at least twice: set on entry, reset on exit; `locked -= amount` is accounting, not a lock)
    const lockVars = new Set(f.conds.filter((id) => {
      const ws = f.events.filter((e) => e.t === 'write' && e.var === id);
      return /lock|entered|reentr|status/i.test(stateVars.get(id).name) && ws.length >= 2 && ws.every((e) => e.op === '=');
    }).map((id) => stateVars.get(id).name));
    const nonReentrantMod = (def.modifiers ?? []).some((m) => /nonReentrant|noReentr|lock/i.test(m.modifierName?.name ?? ''));
    const firstCall = f.events.findIndex((e) => e.t === 'call');
    const writeAfterCall = firstCall < 0 ? [] : f.events.slice(firstCall).filter((e) => e.t === 'write' && !lockVars.has(stateVars.get(e.var).name))
      .map((e) => ({ var: stateVars.get(e.var).name, line: e.line, via: e.via ?? null }));
    const pausedVars = [...stateVars.values()].filter((v) => /^_?paused$/i.test(v.name) && v.type === 'bool').map((v) => v.id);
    const guardVars = (k) => [...new Set(f.guards.filter((g) => g.kind === k).map((g) => stateVars.get(g.var).name))];
    functions.push({
      name: def.kind === 'function' ? def.name : def.kind, kind: def.kind, visibility: def.visibility, mutability: def.stateMutability,
      payable: def.stateMutability === 'payable', view: ['view', 'pure'].includes(def.stateMutability),
      params, supported: params.every((p) => p.abiType), line: lineOf(text, def),
      modifiers: (def.modifiers ?? []).map((m) => m.modifierName?.name),
      writes,
      sender: { eq: guardVars('eq'), map: guardVars('map'), other: f.senderOther },
      calls: f.events.filter((e) => e.t === 'call').map((e) => ({ to: e.to, value: e.value, line: e.line })),
      writeAfterCall, lockVars: [...lockVars], nonReentrantMod,
      checksPaused: f.conds.some((id) => pausedVars.includes(id)),
      setsPaused: Object.entries(writes).filter(([v]) => /^_?paused$/i.test(v)).length > 0,
    });
  }
  const ctor = functions.find((f) => f.kind === 'constructor');
  const abi = out.contracts[proj.rel][name].abi;
  return {
    name, file: proj.rel, project: proj.name, projectRoot: proj.root, sources, solcVersion: solc.version, text,
    ctorParams: ctor?.params ?? [], ctorPayable: !!ctor?.payable,
    stateVars: [...stateVars.values()],
    functions: functions.filter((f) => f.kind !== 'constructor').sort((a, b) => a.line - b.line),
    abi,
  };
}

/** The no-argument view getters of the ABI: name -> output types. */
export function getters(abi) {
  const g = {};
  for (const e of abi) if (e.type === 'function' && ['view', 'pure'].includes(e.stateMutability)) g[e.name] = { inputs: e.inputs.map((i) => i.type), outputs: e.outputs.map((o) => o.type) };
  return g;
}
