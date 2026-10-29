// Optional extension points of the investigator (agent/pipeline.js). Empty by
// default: the pipeline runs fully without them. Other modules register an
// implementation; the pipeline calls it with a timeout, checks what comes
// back, and never lets it lower a result or decide one on its own.
//
//   ml.score(features)  -> { score: 0..1, model?: string, version?: string } | number
//       features: the plain numbers of agent/pipeline.js featuresOf() (no text)
//   llm.review(context) -> { summary: string, model?: string }
//       context: facts only (finding ids, levels, signal ids, numbers,
//       addresses); never raw token names or other text written by strangers.
//       The summary is shown as advisory text; it never changes the level.
//
// A hook may also be passed per call: investigate(target, { hooks: { ml, llm } }).

const registry = { ml: null, llm: null };

export function registerMl(impl) {
  if (impl != null && typeof impl.score !== 'function') throw new TypeError('ml hook needs a score(features) function');
  registry.ml = impl ?? null;
}

export function registerLlm(impl) {
  if (impl != null && typeof impl.review !== 'function') throw new TypeError('llm hook needs a review(context) function');
  registry.llm = impl ?? null;
}

/** The hooks registered now ({ ml, llm }, either may be null). */
export const getHooks = () => ({ ...registry });

export function clearHooks() { registry.ml = null; registry.llm = null; }
