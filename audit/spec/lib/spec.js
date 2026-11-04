// The spec file: schema, validation, canonical form, hashes and the Markdown a human reviews.
//
// A spec is JSON (zetaphy.spec/1). Every property is drafted as "proposed"; only a reviewer's
// `approve` makes it "approved", and only approved properties are turned into proofs. The spec
// hash covers exactly what the prover is asked: the target, the harness, the prover settings and
// the approved properties. Editing any of them after approval changes the hash, and `gen` /
// `prove` refuse a spec whose recorded hash no longer matches.
import { keccak256 } from '../../../zetaphy-neuro/src/keccak.js';

export const SCHEMA = 'zetaphy.spec/1';
export const TOOL = 'zetaphy-spec 1.0.0';
export const KINDS = ['access', 'monotonic', 'conservation', 'invariant', 'post', 'reverts', 'pause-noloss', 'paused-blocks', 'cei'];
export const EXPR_KINDS = ['invariant', 'post', 'reverts']; // the kinds an LLM (or a reviewer) may add

const hex = (b) => Buffer.from(b).toString('hex');
export const keccakHex = (bytes) => '0x' + hex(keccak256(bytes));
export const keccakText = (s) => keccakHex(new TextEncoder().encode(s));

/** JSON with sorted keys and no whitespace: the same object always gives the same bytes. */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}

/** keccak256(abi.encode(bytes32[] xs)), as ProofRegistry computes the artifacts hash. */
export function hashBytes32Array(xs) {
  const words = [32n, BigInt(xs.length), ...xs.map((x) => BigInt(x))];
  const buf = Buffer.concat(words.map((w) => Buffer.from(w.toString(16).padStart(64, '0'), 'hex')));
  return keccakHex(buf);
}

/** What the spec hash covers (the approved properties without their review fields). */
export function hashedPart(spec) {
  const props = spec.properties.filter((p) => p.status === 'approved').map(({ status, review, ...p }) => p);
  return { schema: spec.schema, target: spec.target, harness: spec.harness, prover: spec.prover, properties: props };
}
export const specHash = (spec) => keccakText(canonical(hashedPart(spec)));

// ------------------------------------------------------------------ expressions

const SOL_WORDS = new Set(['t', 'h', 'old', 'address', 'true', 'false', 'type', 'max', 'min', 'balance', 'block', 'timestamp', 'number',
  'wei', 'gwei', 'ether', 'seconds', 'minutes', 'hours', 'days', 'weeks', 'bytes32', 'bool']);
const FORBIDDEN = /\b(vm|svm|assembly|delegatecall|call|staticcall|selfdestruct|new|this|msg|tx|abi|keccak256|sha256|ecrecover|gasleft|unchecked|function|returns?|emit|revert|require|assert|payable|transfer|send)\b/;

/**
 * A property expression: a Solidity boolean over `t.<view>(…)` (the target), `h.<view>(…)` (the
 * harness), `address(t).balance`, literals and operators; `old(e)` (post only) is e before the call.
 * Statements, calls that change state and cheatcodes are refused; the compiler checks the rest.
 */
export function validateExpr(expr, { views = null, harnessViews = [], allowOld = false } = {}) {
  if (typeof expr !== 'string' || !expr.trim()) return 'empty expression';
  if (expr.length > 400) return 'expression longer than 400 characters';
  if (!/^[A-Za-z0-9_\s.()[\]<>=!&|+\-*/%,?:]+$/.test(expr)) return 'characters outside the expression language';
  if (FORBIDDEN.test(expr)) return `forbidden word: ${expr.match(FORBIDDEN)[0]}`;
  if (!allowOld && /\bold\s*\(/.test(expr)) return 'old(...) is allowed only in post conditions';
  let depth = 0;
  for (const c of expr) { if (c === '(') depth++; if (c === ')') depth--; if (depth < 0) return 'unbalanced parentheses'; }
  if (depth !== 0) return 'unbalanced parentheses';
  // every identifier is a known word, a type, a number, or a member after t. / h.
  const toks = expr.replace(/address\s*\(\s*[th]\s*\)/g, 'address(0)').match(/[A-Za-z_][A-Za-z0-9_]*(\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*/g) ?? [];
  for (const tk of toks) {
    const parts = tk.split('.').map((s) => s.trim());
    const [head, member, ...rest] = parts;
    if (/^(u?int\d*|bytes\d+)$/.test(head) && !member) continue;
    if (head === 't' || head === 'h') {
      if (!member) return `${head} must be followed by .<view function>`;
      if (rest.length) return `${tk}: one member only`;
      if (head === 't' && views && !views.includes(member)) return `t.${member} is not a view function of the target`;
      if (head === 'h' && !harnessViews.includes(member)) return `h.${member} is not a view of the harness`;
      continue;
    }
    if (head === 'type' && member === undefined) continue;
    if (!SOL_WORDS.has(head)) return `unknown name: ${head}`;
    if (member && !['balance', 'timestamp', 'number', 'max', 'min'].includes(member)) return `unknown member: ${tk}`;
  }
  return null;
}

/** The names of the view functions a harness source declares (function x(...) ... view ...). */
export const harnessViewNames = (src = '') => [...String(src).matchAll(/function\s+(\w+)\s*\([^)]*\)[^{;]*\bview\b/g)].map((m) => m[1]);

/** A problem with property p of spec, or null. */
export function validateProperty(p, model = {}) {
  if (!p || typeof p !== 'object') return 'not an object';
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(p.id ?? '')) return 'id: letters, digits, _ and -, at most 64';
  if (!KINDS.includes(p.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (typeof p.title !== 'string' || !p.title || p.title.length > 200) return 'title: 1..200 characters';
  if (typeof p.statement !== 'string' || !p.statement || p.statement.length > 2000) return 'statement: 1..2000 characters';
  const c = p.check ?? {};
  const fns = model.functions ?? null;
  const fnOk = (f) => !fns || fns.includes(f);
  const views = model.views ?? null;
  const harnessViews = model.harnessViews ?? [];
  switch (p.kind) {
    case 'invariant': return validateExpr(c.expr, { views, harnessViews });
    case 'post':
      if (!Array.isArray(c.functions) || !c.functions.length || !c.functions.every(fnOk)) return 'post: functions must name state-changing functions of the target';
      return validateExpr(c.expr, { views, harnessViews, allowOld: true });
    case 'reverts':
      if (!fnOk(c.function)) return 'reverts: function must name a state-changing function of the target';
      return validateExpr(c.when, { views, harnessViews });
    case 'access': return fnOk(c.function) && (c.authorized?.eq?.length || c.authorized?.map?.length) ? null : 'access: function and authorized getters';
    case 'monotonic': return typeof c.var === 'string' && Array.isArray(c.functions) ? null : 'monotonic: var and functions';
    case 'conservation': return typeof c.map === 'string' && typeof c.total === 'string' && Array.isArray(c.functions) ? null : 'conservation: map, total, functions';
    case 'pause-noloss': return typeof c.pause === 'string' && typeof c.by === 'string' ? null : 'pause-noloss: pause and by';
    case 'paused-blocks': return typeof c.function === 'string' && typeof c.pause === 'string' ? null : 'paused-blocks: function, pause, by';
    case 'cei': return typeof c.function === 'string' ? null : 'cei: function';
    default: return null;
  }
}

/** Every problem in a spec (empty: valid). */
export function validateSpec(spec, model) {
  const errs = [];
  if (spec.schema !== SCHEMA) errs.push(`schema must be ${SCHEMA}`);
  if (!spec.target?.contract || !spec.target?.file) errs.push('target.contract and target.file');
  const ids = new Set();
  for (const p of spec.properties ?? []) {
    const e = validateProperty(p, model);
    if (e) errs.push(`${p.id ?? '?'}: ${e}`);
    if (ids.has(p.id)) errs.push(`${p.id}: duplicate id`);
    ids.add(p.id);
    if (!['proposed', 'approved', 'rejected'].includes(p.status)) errs.push(`${p.id}: status must be proposed, approved or rejected`);
  }
  return errs;
}

// ------------------------------------------------------------------ Markdown

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function toMarkdown(spec) {
  const L = [];
  const p = (...xs) => L.push(...xs);
  const t = spec.target;
  p(`# Spec: ${t.contract}`, '',
    `Drafted by ${spec.drafted?.by ?? TOOL}${spec.drafted?.llm ? ` with an LLM step (${spec.drafted.llm.model}: ${spec.drafted.llm.accepted} proposed, ${spec.drafted.llm.rejected?.length ?? 0} refused by the validator)` : ' (deterministic heuristics only, no AI)'}.`,
    `Source: \`${t.root}/${t.file}\`, source hash \`${t.sourceHash}\`.`, '',
    '**Review this file before anything is proven.** A heuristic guess is a draft: approve what the contract must do, reject what it',
    'should not, add what is missing. Proofs are only as good as the properties: a property that is proven but says the wrong thing proves nothing useful.', '');
  if (spec.approval?.specHash) p(`Approved by **${esc(spec.approval.reviewer)}** on ${spec.approval.at}; spec hash \`${spec.approval.specHash}\`.`, '');
  else p('Status: **not approved yet** (`node audit/spec/cli.js approve <spec.json> --reviewer <name> --ids … | --all`).', '');
  p('## Harness', '', `Status: **${spec.harness?.status ?? 'drafted'}**${spec.harness?.notes?.length ? '' : ''}`, '');
  for (const n of spec.harness?.notes ?? []) p(`- ${n}`);
  if (spec.harness?.setup) p('', '```solidity', spec.harness.setup.trim(), '```');
  p('', `Sequences: depth ${spec.prover?.depth}, steps: ${(spec.harness?.steps ?? []).map((s) => `\`${s}\``).join(', ')}.`, '');
  p('## Properties', '', '| Id | Kind | Origin | Status | Confidence | Title |', '|---|---|---|---|---|---|');
  for (const q of spec.properties) p(`| \`${q.id}\` | ${q.kind} | ${q.origin} | **${q.status}** | ${q.confidence ?? ''} | ${esc(q.title)} |`);
  p('');
  for (const q of spec.properties) {
    p(`### \`${q.id}\`: ${q.title}`, '', q.statement, '');
    if (q.rationale) p(`*Why drafted:* ${q.rationale}`, '');
    if (q.scope) p(`*Proof scope:* ${q.scope}`, '');
    const c = q.check ?? {};
    if (c.expr) p('```solidity', c.expr, '```', '');
    if (c.when) p('Reverts when:', '```solidity', c.when, '```', '');
  }
  if (spec.notes?.length) {
    p('## Notes for the reviewer (not properties)', '');
    for (const n of spec.notes) p(`- **${n.kind}** \`${n.function ?? ''}\`: ${n.text}`);
    p('');
  }
  if (spec.drafted?.llm?.rejected?.length) {
    p('## LLM proposals the validator refused', '');
    for (const r of spec.drafted.llm.rejected) p(`- \`${esc(r.id)}\`: ${esc(r.reason)}`);
    p('');
  }
  return L.join('\n') + '\n';
}
