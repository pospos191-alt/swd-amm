// The optional AI step: proposes extra properties in the constrained JSON format. It runs only
// when ANTHROPIC_API_KEY is set (never required: without it the draft is the heuristics alone).
// Its proposals are data, not code: each is checked by validateProperty (kinds invariant / post /
// reverts, expressions in the small expression language, functions that exist) and enters the
// spec as "proposed", for a human to approve or reject. Nothing it says is proven until the prover
// proves it.
//
// Raw fetch on purpose: audit/ uses Node's standard library only (audit/package.json).
import { validateProperty, EXPR_KINDS } from './spec.js';
import { getters } from './analyze.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['properties'],
  properties: {
    properties: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'title', 'statement', 'rationale', 'expr', 'functions', 'when'],
        properties: {
          id: { type: 'string' },
          kind: { type: 'string', enum: EXPR_KINDS },
          title: { type: 'string' },
          statement: { type: 'string' },
          rationale: { type: 'string' },
          expr: { type: 'string' },
          functions: { type: 'array', items: { type: 'string' } },
          when: { type: 'string' },
        },
      },
    },
  },
};

function prompt(model, draft, docs) {
  const g = getters(model.abi);
  const fns = model.functions.filter((f) => f.kind === 'function' && !f.view).map((f) => `${f.name}(${f.params.map((p) => `${p.abiType ?? p.type} ${p.name}`).join(', ')})${f.payable ? ' payable' : ''}`);
  return [
    `You write formal properties of the Solidity contract ${model.name} for a symbolic prover (Halmos) and the SMTChecker.`,
    'Propose properties that the deterministic draft below does NOT already state and that a correct version of this contract must satisfy',
    '(conservation of value, limits that can never be exceeded, state machines that cannot go backwards, things only possible after a delay).',
    'Each property is one of three kinds:',
    '- invariant: `expr` holds after setup and after any sequence of calls. `functions` = [], `when` = "".',
    '- post: after any successful call to one of `functions`, `expr` holds; old(e) is the value of the uint expression e just before the call. `when` = "".',
    '- reverts: a call to functions[0] reverts whenever `when` holds just before it. `expr` = "".',
    'Expression language (anything else is refused): a Solidity boolean over t.<view>(args) (t is the contract; only these views exist:',
    Object.keys(g).join(', '),
    '), address(t).balance, block.timestamp, integer literals and units (ether, days), type(uintN).max, comparisons, arithmetic, && || !, and in post only old(e).',
    'No statements, no semicolons, no state-changing calls, no cheatcodes.',
    `State-changing functions: ${fns.join('; ')}.`,
    'Use short ids (letters, digits, -). Prefer few, precise properties over many vague ones; say in `rationale` which line or doc sentence each comes from.',
    '',
    'Already drafted (do not repeat):',
    ...draft.properties.map((p) => `- ${p.id}: ${p.title}`),
    '',
    ...docs.flatMap((d) => [`Documentation (${d.name}):`, d.text.slice(0, 20000), '']),
    'Source:',
    '```solidity',
    model.text.slice(0, 60000),
    '```',
  ].join('\n');
}

/** { properties: [...accepted], rejected: [{id, reason}], model } or null when no key is set. */
export async function propose(model, draft, { docs = [], env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const llmModel = env.ZETAPHY_SPEC_MODEL || DEFAULT_MODEL;
  const r = await fetchImpl(`${env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: JSON.stringify({
      model: llmModel,
      max_tokens: 16000,
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: prompt(model, draft, docs) }],
    }),
  });
  if (!r.ok) throw new Error(`LLM step: HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const body = await r.json();
  if (body.stop_reason === 'refusal') throw new Error('LLM step: the model declined');
  const text = (body.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  let out;
  try { out = JSON.parse(text); } catch { throw new Error('LLM step: the answer is not JSON'); }
  return { ...screen(out.properties, model, draft), model: body.model ?? llmModel };
}

/** Validates raw proposals into spec properties (exported for tests: the screen, not the model, is what is trusted). */
export function screen(raw, model, draft, harnessViews = []) {
  const g = getters(model.abi);
  const fns = model.functions.filter((f) => f.kind === 'function' && !f.view).map((f) => f.name);
  const taken = new Set(draft.properties.map((p) => p.id));
  const properties = [];
  const rejected = [];
  for (const x of Array.isArray(raw) ? raw.slice(0, 30) : []) {
    const id = `llm-${String(x?.id ?? '').replace(/^llm-/, '')}`;
    const check = x?.kind === 'invariant' ? { expr: x.expr } : x?.kind === 'post' ? { expr: x.expr, functions: x.functions } : { function: x?.functions?.[0], when: x?.when };
    const p = { id, kind: x?.kind, origin: 'llm', status: 'proposed', confidence: 'low', title: String(x?.title ?? '').slice(0, 200), statement: String(x?.statement ?? '').slice(0, 2000),
      rationale: String(x?.rationale ?? '').slice(0, 1000), scope: x?.kind === 'invariant' ? 'bounded: sequences of prover.depth calls (Halmos); unbounded where the SMTChecker proves it' : 'any caller and arguments, from any state reachable in prover.depth-1 steps', check };
    const why = !EXPR_KINDS.includes(p.kind) ? `kind ${p.kind} is not one an LLM may add` : taken.has(id) ? 'duplicate id' : validateProperty(p, { functions: fns, views: Object.keys(g), harnessViews });
    if (why) rejected.push({ id, reason: why });
    else { properties.push(p); taken.add(id); }
  }
  return { properties, rejected };
}
