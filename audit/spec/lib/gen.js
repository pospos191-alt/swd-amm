// Machine-checkable artifacts from an approved spec:
//   test/Spec.t.sol    SpecHandler (the target, its actors and one action per function),
//                      SpecChecks (Halmos `check_*`: every input symbolic, so a pass is a proof
//                      within the stated scope and a failure is a concrete counterexample) and
//                      SpecInvariants (the same invariants for forge's stateful fuzzer)
//   smt/SpecSMT.sol    the target with one `assert` per state invariant, for solc's SMTChecker
//                      (CHC: an unbounded proof over every reachable state, when it finishes)
//   test/SpecReplay.t.sol  (after a Halmos counterexample) the counterexample as a concrete
//                      forge test: it must fail the same assert in a real EVM run
// Every symbolic input is a word of one `uint256[N] w` parameter, cut into typed arguments the
// same way everywhere, so a Halmos model replays exactly in forge.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { sourceClosure } from '../../lib/scope.js';
import { REPO } from './analyze.js';
import { getters } from './analyze.js';

const FORGE_STD = join(REPO, 'audit/lib/forge-std/src/');

/** Words an argument of this ABI type takes. */
const widthOf = (t, bw) => (t === 'bytes' || t === 'string' ? bw : 1);

/** Solidity that turns words a[i..] into argument `name` of type t (returns [code, nextIndex]). */
function decode(t, name, a, i, bw) {
  if (t === 'address') return [`address ${name} = address(uint160(${a}[${i}]));`, i + 1];
  if (/^uint\d*$/.test(t)) return [`${t} ${name} = ${t}(${a}[${i}]);`, i + 1];
  if (/^int\d*$/.test(t)) return [`${t} ${name} = ${t}(int256(${a}[${i}]));`, i + 1];
  if (t === 'bool') return [`bool ${name} = ${a}[${i}] & 1 == 1;`, i + 1];
  if (t === 'bytes32') return [`bytes32 ${name} = bytes32(${a}[${i}]);`, i + 1];
  if (/^bytes\d+$/.test(t)) return [`${t} ${name} = ${t}(bytes32(${a}[${i}]));`, i + 1];
  const words = Array.from({ length: bw }, (_, k) => `${a}[${i + k}]`).join(', ');
  if (t === 'bytes') return [`bytes memory ${name} = abi.encodePacked(${words});`, i + bw];
  if (t === 'string') return [`string memory ${name} = string(abi.encodePacked(${words}));`, i + bw];
  throw new Error(`type ${t} not supported`);
}

/** Replaces old(e) by locals; returns { expr, olds: [e] }. */
function extractOld(expr) {
  const olds = [];
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const m = /\bold\s*\(/y;
    m.lastIndex = i;
    if (m.test(expr) && (i === 0 || !/[A-Za-z0-9_.]/.test(expr[i - 1]))) {
      let j = m.lastIndex; let d = 1;
      while (j < expr.length && d) { if (expr[j] === '(') d++; if (expr[j] === ')') d--; j++; }
      olds.push(expr.slice(m.lastIndex, j - 1));
      out += `__old${olds.length - 1}`;
      i = j;
    } else { out += expr[i++]; }
  }
  return { expr: out, olds };
}

const ident = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

/**
 * Writes the work directory and returns { files: {path: content}, checks: {propertyId: [checkName]},
 * smt: {propertyId: functionName}, nmax, steps }.
 */
export function generate(spec, model, work) {
  const H = spec.harness;
  const depth = Math.max(1, Number(spec.prover?.depth ?? 2));
  const fnByName = new Map();
  for (const f of model.functions) if (f.kind === 'function' && !f.view && !fnByName.has(f.name)) fnByName.set(f.name, f);
  const bwOf = (fn, p) => Number(H.bytesWords?.[`${fn}.${p}`] ?? H.bytesWords?.[fn] ?? 2);
  const genericWords = (f) => (f.payable ? 1 : 0) + f.params.reduce((s, p) => s + widthOf(p.abiType, bwOf(f.name, p.name)), 0);
  const wordsOf = (name) => {
    if (name === 'warp') return 1;
    if (name === 'receive') return 1;
    if (H.actions?.[name]) return Number(H.words?.[name] ?? 4);
    const f = fnByName.get(name);
    if (!f) throw new Error(`harness step ${name}: no such state-changing function in ${model.name}`);
    return genericWords(f);
  };
  const steps = H.steps ?? [];
  const approved = spec.properties.filter((p) => p.status === 'approved');
  const callFns = new Set();
  for (const p of approved) {
    const c = p.check;
    for (const f of [c.function, ...(c.functions ?? [])].filter(Boolean)) callFns.add(f);
  }
  for (const s of steps) if (s !== 'warp' && s !== 'receive' && (!H.actions?.[s] || fnByName.get(s))) callFns.add(s);
  for (const f of callFns) if (!fnByName.get(f)) throw new Error(`${f}: no such state-changing function in ${model.name}`);
  const K = Math.max(1, ...steps.map(wordsOf));
  const SW = 2 + K;                // a step: selector, actor, K argument words
  const prefixOf = (p) => (p.kind === 'access' ? Number(p.check.prefix ?? 0) : Number(p.check.prefix ?? depth - 1));

  // ---------------------------------------------------------------- handler
  const H_ = [];
  const h = (...xs) => H_.push(...xs);
  for (const f of callFns) {
    const fi = fnByName.get(f);
    let i = 0;
    const lines = [];
    const args = [];
    let v = '0';
    if (fi.payable) { lines.push(`uint256 v = uint256(uint96(a[0]));`, 'vm.deal(caller, v);'); v = 'v'; i = 1; }
    for (const [k, p] of fi.params.entries()) {
      const [code, next] = decode(p.abiType, `p${k}`, 'a', i, bwOf(f, p.name));
      // contract and enum parameters: decoded as address / uint8, passed as their own type
      const m = p.type.replace(/ (calldata|memory|storage)$/, '').match(/^(?:contract|enum) (\S+)$/);
      lines.push(code); args.push(m ? `${m[1]}(p${k})` : `p${k}`); i = next;
    }
    h(`    /// ${f}(${fi.params.map((p) => p.abiType).join(', ')}) as \`caller\`, the arguments cut from a (${i} words). Never reverts: returns whether the call succeeded.`,
      `    function call_${f}(address caller, uint256[] memory a) public returns (bool ok) {`,
      ...lines.map((l) => '        ' + l),
      '        vm.prank(caller);',
      `        try t.${f}${fi.payable ? '{value: v}' : ''}(${args.join(', ')}) { ok = true; } catch { ok = false; }`,
      '    }', '');
  }
  for (const s of steps) {
    const K_ = wordsOf(s);
    if (s === 'warp') h('    function act_warp(address, uint256[] memory a) public returns (bool ok) { vm.warp(block.timestamp + (a[0] % 3 days)); ok = true; }', '');
    else if (s === 'receive') h('    function act_receive(address caller, uint256[] memory a) public returns (bool ok) {', '        uint256 v = uint256(uint96(a[0]));', '        vm.deal(caller, v);', '        vm.prank(caller);', '        (ok, ) = address(t).call{value: v}("");', '    }', '');
    else if (H.actions?.[s]) h(`    /// ${s}: the reviewed harness action (${K_} words).`, `    function act_${s}(address caller, uint256[] memory a) public returns (bool ok) {`, ...String(H.actions[s]).trim().split('\n').map((l) => '        ' + l), '    }', '');
    else h(`    function act_${s}(address caller, uint256[] memory a) public returns (bool ok) { return call_${s}(caller, a); }`, '');
    const conv = Array.from({ length: K_ }, (_, j) => `a[${j}] = w[${j}];`).join(' ');
    h(`    function fz_${s}(uint256 who, uint256[${Math.max(K_, 1)}] memory w) public { uint256[] memory a = new uint256[](${K_}); ${conv} act_${s}(actor(who), a); }`, '');
  }
  const actors = H.actors?.length ? H.actors : ['address(0xA11CE)'];
  const handler = [
    'contract SpecHandler is Test {',
    `    ${model.name} public t;`,
    '    address[] internal actors;',
    ...String(H.state ?? '').trim().split('\n').filter(Boolean).map((l) => '    ' + l),
    '',
    '    constructor() payable {',
    ...String(H.setup).trim().split('\n').map((l) => '        ' + l),
    ...actors.map((a) => `        actors.push(${a});`),
    '    }',
    '',
    '    function actor(uint256 x) public view returns (address) { return actors[x % actors.length]; }',
    '',
    ...H_,
    ...String(H.views ?? '').trim().split('\n').filter(Boolean).map((l) => '    ' + l),
    '}',
  ];

  // ---------------------------------------------------------------- checks
  const checks = {};
  const layout = {};
  const C = [];
  const c = (...xs) => C.push(...xs);
  let nmax = SW * depth + 1;
  const need = (n) => { nmax = Math.max(nmax, n); };
  const slice = (name, n, base) => `uint256[] memory ${name} = new uint256[](${Math.max(n, 1)});${Array.from({ length: n }, (_, j) => ` ${name}[${j}] = w[${base + j}];`).join('')}`;
  const prefix = (n) => Array.from({ length: n }, (_, i) => `        _step(w, ${i * SW});`);
  const fnCall = (f) => (H.actions?.[f] && steps.includes(f) ? `act_${f}` : `call_${f}`);
  const fnWords = (f) => (H.actions?.[f] && steps.includes(f) ? wordsOf(f) : genericWords(fnByName.get(f)));
  const g = getters(model.abi);

  for (const p of approved) {
    const ck = p.check;
    const id = ident(p.id);
    const pre = prefixOf(p);
    const P = pre * SW;
    const names = [];
    const header = (name, call = null, custom = false) => { names.push(name); layout[name] = { steps: p.kind === 'invariant' ? depth : pre, call, custom, at: P }; c(`    /// ${p.id}: ${p.title}`, `    function ${name}(uint256[NMAX] memory w) public {`); };
    switch (p.kind) {
      case 'access': {
        const f = ck.function; const n = genericWords(fnByName.get(f));
        need(P + 1 + n);
        header(`check_${id}`, f);
        c(...prefix(pre), `        address caller = address(uint160(w[${P}]));`, '        _outsider(caller);',
          ...ck.authorized.eq.map((v) => `        vm.assume(caller != address(t.${v}()));`),
          ...ck.authorized.map.map((v) => `        vm.assume(!t.${v}(caller));`),
          `        ${slice('a', n, P + 1)}`, `        assert(!h.call_${f}(caller, a));`, '    }', '');
        break;
      }
      case 'monotonic':
        for (const f of ck.functions) {
          const n = genericWords(fnByName.get(f)); need(P + 1 + n);
          header(`check_${id}__${ident(f)}`, f);
          c(...prefix(pre), `        address caller = address(uint160(w[${P}]));`, '        _outsider(caller);', `        ${slice('a', n, P + 1)}`,
            `        uint256 before = uint256(t.${ck.var}());`, `        h.call_${f}(caller, a);`, `        assert(uint256(t.${ck.var}()) >= before);`, '    }', '');
        }
        break;
      case 'conservation':
        for (const f of ck.functions) {
          const fi = fnByName.get(f); const n = genericWords(fi); need(P + 1 + n);
          // the words of the address arguments, as call_ cuts them
          const addrWords = []; let i = fi.payable ? 1 : 0;
          for (const q of fi.params) { if (q.abiType === 'address') addrWords.push(i); i += widthOf(q.abiType, bwOf(f, q.name)); }
          const acc = ['caller', ...addrWords.map((wi) => `address(uint160(a[${wi}]))`)];
          header(`check_${id}__${ident(f)}`, f);
          c(...prefix(pre), `        address caller = address(uint160(w[${P}]));`, '        _outsider(caller);', `        ${slice('a', n, P + 1)}`,
            `        address[] memory who = new address[](${acc.length});`, ...acc.map((x, k) => `        who[${k}] = ${x};`),
            `        uint256 sumBefore = _sum${ident(ck.map)}(who);`, `        uint256 totalBefore = uint256(t.${ck.total}());`,
            `        h.call_${f}(caller, a);`,
            `        uint256 sumAfter = _sum${ident(ck.map)}(who);`, `        uint256 totalAfter = uint256(t.${ck.total}());`,
            '        unchecked { assert(sumAfter - sumBefore == totalAfter - totalBefore); }', '    }', '');
          checks.__sums ??= new Set(); checks.__sums.add(ck.map); checks.__sumN = Math.max(checks.__sumN ?? 0, acc.length);
        }
        break;
      case 'invariant': {
        need(SW * depth + 1);
        header(`check_${id}`);
        c(`        unchecked { assert(${ck.expr}); }`);
        for (let s = 0; s < depth; s++) c(`        _step(w, ${s * SW});`, `        unchecked { assert(${ck.expr}); }`);
        c('    }', '');
        break;
      }
      case 'post':
      case 'reverts':
        for (const f of p.kind === 'post' ? ck.functions : [ck.function]) {
          const n = fnWords(f); need(P + 1 + n);
          const { expr, olds } = extractOld(ck.expr ?? 'true');
          header(`check_${id}__${ident(f)}`, f, fnCall(f) === `act_${f}`);
          c(...prefix(pre), `        address caller = address(uint160(w[${P}]));`, '        _outsider(caller);', `        ${slice('a', n, P + 1)}`);
          if (p.kind === 'post') {
            c(...olds.map((e, k) => `        uint256 __old${k} = uint256(${e});`), `        bool ok = h.${fnCall(f)}(caller, a);`, `        unchecked { if (ok) assert(${expr}); }`);
          } else {
            c(`        bool cond; unchecked { cond = ${ck.when}; }`, `        bool ok = h.${fnCall(f)}(caller, a);`, '        if (cond) assert(!ok);');
          }
          c('    }', '');
        }
        break;
      case 'pause-noloss': {
        need(P + 1);
        const snap = Object.entries(g).filter(([n, s]) => s.inputs.length === 0 && s.outputs.length === 1 && /^(u?int\d*|address|bool|bytes32)$/.test(s.outputs[0]) && n !== ck.flag);
        checks.__snap = snap;
        header(`check_${id}`);
        c(...prefix(pre), '        bytes32[] memory s0 = _snap();',
          `        vm.prank(address(t.${ck.by}()));`, `        try t.${ck.pause}() {} catch { assert(false); } // pausing must always work`,
          `        assert(t.${ck.flag}());`, '        _same(s0, _snap());');
        if (ck.unpause) c(`        vm.prank(address(t.${ck.unpauseBy ?? ck.by}()));`, `        try t.${ck.unpause}() {} catch { assert(false); }`, `        assert(!t.${ck.flag}());`, '        _same(s0, _snap());');
        c('    }', '');
        break;
      }
      case 'paused-blocks': {
        const f = ck.function; const n = genericWords(fnByName.get(f)); need(P + 1 + n);
        header(`check_${id}`, f);
        c(...prefix(pre), `        vm.prank(address(t.${ck.by}()));`, `        try t.${ck.pause}() {} catch { vm.assume(false); }`,
          `        address caller = address(uint160(w[${P}]));`, '        _outsider(caller);', `        ${slice('a', n, P + 1)}`,
          `        assert(!h.call_${f}(caller, a));`, '    }', '');
        break;
      }
      case 'cei':
        break; // static (prove.js)
      default:
        throw new Error(`${p.id}: kind ${p.kind}`);
    }
    if (names.length) checks[p.id] = names;
  }

  // helpers of the check contract
  const helpers = [];
  const stepBody = steps.map((s, i) => `        ${i ? 'else ' : ''}if (sel == ${i}) { ${slice('a', wordsOf(s), 0).replace(/w\[(\d+)\]/g, (_, j) => `w[o + ${2 + Number(j)}]`)} h.act_${s}(who, a); }`);
  helpers.push('    /// One step of a sequence: w[o] picks the function, w[o+1] the actor, the rest are its arguments.',
    '    function _step(uint256[NMAX] memory w, uint256 o) internal {',
    '        uint256 sel = w[o];', `        vm.assume(sel < ${steps.length});`, '        address who = h.actor(w[o + 1]);', ...stepBody, '    }', '',
    '    function _outsider(address x) internal view {',
    '        vm.assume(x != address(h) && x != address(t) && x != address(this) && uint160(x) > 0xffff);', '    }', '');
  for (const m of checks.__sums ?? []) {
    const n = checks.__sumN;
    helpers.push(`    /// The sum of ${m} over the distinct accounts in who (unrolled: no loop for the prover to bound).`,
      `    function _sum${ident(m)}(address[] memory who) internal view returns (uint256 s) {`, '        unchecked {');
    for (let k = 0; k < n; k++) {
      const dup = Array.from({ length: k }, (_, j) => `who[${k}] == who[${j}]`).join(' || ');
      helpers.push(`            if (who.length > ${k}${dup ? ` && !(${dup})` : ''}) s += uint256(t.${m}(who[${k}]));`);
    }
    helpers.push('        }', '    }', '');
  }
  if (checks.__snap) {
    const toWord = (n, t) => (t === 'bool' ? `t.${n}() ? bytes32(uint256(1)) : bytes32(0)` : t === 'address' ? `bytes32(uint256(uint160(address(t.${n}()))))` : t === 'bytes32' ? `t.${n}()` : /^int/.test(t) ? `bytes32(uint256(int256(t.${n}())))` : `bytes32(uint256(t.${n}()))`);
    helpers.push('    /// Every public no-argument number, address and flag of the target, and its ETH.',
      '    function _snap() internal view returns (bytes32[] memory s) {', `        s = new bytes32[](${checks.__snap.length + 1});`,
      '        s[0] = bytes32(address(t).balance);', ...checks.__snap.map(([n, s], k) => `        s[${k + 1}] = ${toWord(n, s.outputs[0])};`), '    }', '',
      '    function _same(bytes32[] memory a, bytes32[] memory b) internal pure {',
      ...Array.from({ length: checks.__snap.length + 1 }, (_, k) => `        assert(a[${k}] == b[${k}]);`), '    }', '');
  }
  delete checks.__sums; delete checks.__sumN; delete checks.__snap;

  const invariants = approved.filter((p) => p.kind === 'invariant');
  const fzSelectors = steps.map((s) => `SpecHandler.fz_${s}.selector`);
  const body = [
    '// SPDX-License-Identifier: MIT',
    `// GENERATED by audit/spec from the approved spec of ${model.name} (spec hash ${spec.approval?.specHash ?? 'unapproved'}).`,
    '// Do not edit: change the spec, approve it, generate again.',
    'pragma solidity 0.8.26;',
    '',
    'import {Test} from "forge-std/Test.sol";',
    'import {StdInvariant} from "forge-std/StdInvariant.sol";',
    `import "../src/${model.file}";`,
    ...(H.imports ?? []).map((imp) => `import "../src/${imp}";`),
    '',
    String(H.helpers ?? '').trim(),
    '',
    ...handler,
    '',
    'contract SpecChecks is Test {',
    '    SpecHandler internal h;',
    `    ${model.name} internal t;`,
    '',
    '    function setUp() public virtual {',
    '        h = new SpecHandler();',
    '        t = h.t();',
    '    }',
    '',
    ...helpers,
    ...C,
    '}',
    '',
    '/// The state invariants under forge\'s stateful fuzzer (sampling, not proof).',
    'contract SpecInvariants is SpecChecks {',
    '    function setUp() public override {',
    '        super.setUp();',
    '        targetContract(address(h));',
    `        bytes4[] memory s = new bytes4[](${fzSelectors.length});`,
    ...fzSelectors.map((x, i) => `        s[${i}] = ${x};`),
    '        targetSelector(StdInvariant.FuzzSelector({addr: address(h), selectors: s}));',
    '    }',
    '',
    ...invariants.map((p) => `    function invariant_${ident(p.id)}() public view { unchecked { assert(${p.check.expr}); } }`),
    '}',
    '',
  ].join('\n').replace(/NMAX/g, String(nmax));

  // ---------------------------------------------------------------- SMTChecker wrapper
  const sv = new Map(model.stateVars.map((v) => [v.name, v]));
  const smt = {};
  const smtFns = [];
  for (const p of invariants) {
    let e = p.check.expr;
    if (/\bh\s*\./.test(e)) continue;
    let ok = true;
    e = e.replace(/address\s*\(\s*t\s*\)/g, 'address(this)').replace(/\bt\s*\.\s*(\w+)\s*\(([^()]*)\)/g, (_, n, args) => {
      const v = sv.get(n);
      if (v && v.kind === 'elementary' && !args.trim()) return n;
      if (v && v.kind === 'mapping' && args.trim()) return `${n}[${args}]`;
      const f = model.functions.find((x) => x.name === n);
      if (f && f.visibility === 'public') return `${n}(${args})`;
      ok = false; return _;
    });
    if (!ok || /\bt\s*\./.test(e)) continue;
    smt[p.id] = `__spec_${ident(p.id)}`;
    smtFns.push(`    function __spec_${ident(p.id)}() external view { assert(${e}); }`);
  }
  const ctorTypes = model.ctorParams.map((q) => {
    const t = q.type.replace(/^contract /, '').replace(/^enum /, '').replace(/^struct /, '');
    return /^(string|bytes)$/.test(t) || /\[\]$/.test(t) ? `${t} memory` : t;
  });
  const smtSrc = [
    '// SPDX-License-Identifier: MIT',
    `// GENERATED by audit/spec: ${model.name} with one assert per approved state invariant, for solc's SMTChecker (CHC).`,
    'pragma solidity 0.8.26;',
    '',
    `import "${model.file}";`,
    '',
    `contract __Spec_${model.name} is ${model.name} {`,
    `    constructor(${model.ctorParams.map((q, i) => `${ctorTypes[i]} a${i}`).join(', ')}) ${model.ctorPayable ? 'payable ' : ''}${model.name}(${model.ctorParams.map((_, i) => `a${i}`).join(', ')}) {}`,
    ...smtFns,
    '}',
    '',
  ].join('\n');

  // ---------------------------------------------------------------- the work directory
  const files = {};
  const proj = join(REPO, model.project ?? '');
  const extra = (H.imports ?? []).length ? sourceClosure(model.projectRoot, H.imports, []).sources : {};
  for (const [k, v] of Object.entries({ ...model.sources, ...extra })) files[`src/${k}`] = v.content;
  files['test/Spec.t.sol'] = body;
  files['smt/SpecSMT.sol'] = smtSrc;
  const atRemaps = [...new Set(Object.keys(files).filter((k) => k.startsWith('src/@')).map((k) => k.split('/')[1]))];
  files['foundry.toml'] = [
    '# GENERATED by audit/spec. The pinned tools: audit/tools/install.sh (solc 0.8.26 at ~/.svm, forge 1.2.3, halmos 0.3.3).',
    '[profile.default]', 'src = "src"', 'test = "test"', 'out = "out"', 'cache_path = "cache"', 'libs = []',
    `remappings = [${[`"forge-std/=${FORGE_STD}"`, ...atRemaps.map((a) => `"${a}/=src/${a}/"`)].join(', ')}]`,
    `allow_paths = ["${FORGE_STD}"]`,
    'solc_version = "0.8.26"', 'evm_version = "cancun"', 'optimizer = true', 'optimizer_runs = 200', 'offline = true', 'auto_detect_remappings = false',
    '', '[profile.default.invariant]', `runs = ${Number(spec.prover?.forge?.runs ?? 256)}`, `depth = ${Number(spec.prover?.forge?.depth ?? 20)}`, 'fail_on_revert = false', '',
  ].join('\n');
  void proj;
  for (const [k, v] of Object.entries(files)) { mkdirSync(dirname(join(work, k)), { recursive: true }); writeFileSync(join(work, k), v); }
  /** A counterexample as calls: the sequence steps, then the checked call (words: {index: value}). */
  const explain = (check, words) => {
    const L = layout[check];
    if (!L) return null;
    const W = (i) => BigInt(words[i] ?? 0);
    const fmt = (t, v) => (t === 'address' ? '0x' + (v & ((1n << 160n) - 1n)).toString(16).padStart(40, '0') : t === 'bool' ? String((v & 1n) === 1n) : /^uint(\d*)$/.test(t) ? String(v & ((1n << BigInt(Number(t.slice(4) || 256))) - 1n)) : '0x' + v.toString(16));
    const argsOf = (f, base, custom) => {
      if (custom || f === 'warp' || f === 'receive' || !fnByName.get(f)) return Array.from({ length: f === 'warp' || f === 'receive' ? 1 : wordsOf(f) }, (_, j) => (f === 'warp' ? `+${W(base + j) % 259200n}s` : f === 'receive' ? `value ${W(base + j) & ((1n << 96n) - 1n)}` : `w${j}=${W(base + j)}`)).join(', ');
      const fi = fnByName.get(f); let i = base; const out = [];
      if (fi.payable) { out.push(`value ${W(i) & ((1n << 96n) - 1n)}`); i++; }
      for (const q of fi.params) { const n = widthOf(q.abiType, bwOf(f, q.name)); out.push(`${q.name}=${n === 1 ? fmt(q.abiType, W(i)) : '0x' + Array.from({ length: n }, (_, j) => W(i + j).toString(16).padStart(64, '0')).join('')}`); i += n; }
      return out.join(', ');
    };
    const out = [];
    for (let s = 0; s < L.steps; s++) {
      const o = s * SW; const sel = Number(W(o)); const f = steps[sel];
      out.push(`${f}(${argsOf(f, o + 2, !!H.actions?.[f])}) by ${actors[Number(W(o + 1) % BigInt(actors.length))]}`);
    }
    if (L.call) out.push(`${L.call}(${argsOf(L.call, L.at + 1, L.custom)}) by ${fmt('address', W(L.at))}`);
    return out;
  };
  return { files, checks, smt, nmax, steps, layout, explain };
}

/** test/SpecReplay.t.sol: each Halmos counterexample as a concrete forge test (w: {check: {index: value}}). */
export function replaySource(model, models, nmax) {
  const L = ['// SPDX-License-Identifier: MIT', '// GENERATED by audit/spec: Halmos counterexamples replayed concretely (each must hit the same failed assert).',
    'pragma solidity 0.8.26;', '', 'import {SpecChecks} from "./Spec.t.sol";', '', 'contract SpecReplay is SpecChecks {'];
  for (const [check, words] of Object.entries(models)) {
    L.push(`    function test_replay_${check}() public {`, `        uint256[${nmax}] memory w;`);
    for (const [i, v] of Object.entries(words)) L.push(`        w[${i}] = ${BigInt(v).toString()};`);
    L.push(`        try this.${check}(w) { revert("counterexample not reproduced"); } catch (bytes memory e) {`,
      '            // Panic(0x01): the property\'s assert failed in a real EVM run',
      '            assertEq(keccak256(e), keccak256(abi.encodeWithSignature("Panic(uint256)", uint256(1))), "not the property assert");',
      '        }', '    }', '');
  }
  L.push('}', '');
  return L.join('\n');
}

export const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
