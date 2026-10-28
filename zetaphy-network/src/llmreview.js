// Optional LLM review that a runner attaches to its job results
// (`zetaphy node start --llm-review`). Free and local: the runner's own
// Ollama (http://localhost:11434 by default) reads Neuro's report through the
// AI analyst (zetaphy-neuro/ai/) and writes an advisory review.
//
// It never touches the verdict: the commit/reveal carries verdictOf(report)
// exactly as without it, and the review runs after the commit, one at a time,
// so a slow model never delays a reveal. A review that fails is logged and
// dropped.
//
// Each review is a JSON file in ~/.zetaphy/reviews/job-<id>.json, signed with
// the runner key (EIP-191 personal_sign over keccak256 of the canonical JSON
// body), like the runner's on-chain outputs are signed by the same key. Anyone
// can check who wrote it: `zetaphy review verify <file>` (verifyReview below).

import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { keccak256, toUtf8Bytes, getBytes, verifyMessage, getAddress } from 'ethers';
import { runAnalyst } from '../../zetaphy-neuro/ai/analyst.js';
import { OLLAMA_URL, DEFAULT_MODELS, checkEndpoint, checkModel } from '../../zetaphy-neuro/ai/providers.js';

export const REVIEW_KIND = 'neuro-llm-review';
export const REVIEW_VERSION = 1;

/** JSON with sorted keys, so the same body always hashes the same. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const reviewHash = (body) => keccak256(toUtf8Bytes(canonical(body)));

/** Signs a review body with the runner's key: { body, hash, signer, signature }. */
export async function signReview(body, wallet) {
  const hash = reviewHash(body);
  const signature = await wallet.signMessage(getBytes(hash));
  return { body, hash, signer: getAddress(await wallet.getAddress()), signature };
}

/** Checks a signed review: the hash matches the body and the signature is the stated runner's. */
export function verifyReview(rec) {
  try {
    if (rec?.body?.kind !== REVIEW_KIND) return { ok: false, reason: 'not a Neuro LLM review' };
    const hash = reviewHash(rec.body);
    if (hash !== rec.hash) return { ok: false, reason: 'the body does not match its hash (edited after signing)' };
    const by = verifyMessage(getBytes(hash), rec.signature);
    if (getAddress(by) !== getAddress(rec.signer)) return { ok: false, reason: `signed by ${by}, not ${rec.signer}` };
    return { ok: true, signer: by };
  } catch (e) {
    return { ok: false, reason: e.shortMessage ?? e.message };
  }
}

/**
 * @param {object} p
 * @param {import('ethers').Signer} p.wallet  the runner key (signs reviews)
 * @param {string} p.dir                      where signed reviews are written
 * @param {string} [p.model]                  Ollama model (default qwen2.5-coder:7b)
 * @param {string} [p.baseUrl]                OpenAI-compatible endpoint of the local model
 * @param {string} [p.lang]                   review language (Neuro's 9)
 * @returns {{queue: (job:{id:number, chain:string, target:string, report:object, verdict:string}) => void, idle: () => Promise<void>}}
 */
export function createLlmReviewer({ wallet, dir, model = DEFAULT_MODELS.ollama, baseUrl = OLLAMA_URL, lang = 'en', fetchImpl, log = () => {}, now = () => Date.now(), timeoutMs = 600_000 }) {
  const settings = { provider: 'ollama', model: checkModel(model), baseUrl: checkEndpoint(baseUrl) };
  let chain = Promise.resolve();

  async function review(job) {
    const out = await runAnalyst(job.report, settings, { lang, fetchImpl, timeoutMs });
    const body = {
      kind: REVIEW_KIND, v: REVIEW_VERSION, advisory: 'AI opinion; not part of the verdict',
      jobId: Number(job.id), chain: job.chain, target: String(job.target).toLowerCase(),
      reportHash: job.report?.reportHash ?? null, verdict: job.verdict, level: out.level,
      model: out.model, lang, createdAt: new Date(now()).toISOString(),
      contradictsRules: out.contradicts, review: out.result,
    };
    const signed = await signReview(body, wallet);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `job-${Number(job.id)}.json`);
    writeFileSync(file + '.tmp', JSON.stringify(signed, null, 2), { mode: 0o600 });
    renameSync(file + '.tmp', file);
    return file;
  }

  return {
    queue(job) {
      chain = chain.then(() => review(job))
        .then((file) => log(`job ${job.id}: LLM review (AI opinion, ${settings.model}) signed and saved to ${file}`))
        .catch((e) => log(`job ${job.id}: LLM review skipped (${e.message})`));
    },
    idle: () => chain,
  };
}
