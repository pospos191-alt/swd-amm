// The step runner: runs launch steps in order, records each finished one in a
// state file (addresses only, never keys), and on --resume skips what is done.
//
// A step: { name, describe, run(ctx, state) -> out?, when?(ctx, state) -> true | 'reason to skip',
//           always?: true (re-run every time: cheap, idempotent checks and config writes) }
// state.steps[name] = { doneAt, out } once a step finished; `out` is what run returned
// (addresses and other public values).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATE_VERSION = 1;

/** A new, empty state for this chain. */
export function newState({ chainId, genesisHash = null, deployer = null } = {}) {
  return { version: STATE_VERSION, chainId, genesisHash, deployer, steps: {} };
}

export function loadState(file) {
  if (!existsSync(file)) return null;
  const s = JSON.parse(readFileSync(file, 'utf8'));
  if (s.version !== STATE_VERSION || typeof s.steps !== 'object') throw new Error(`${file}: not a launch state file (version ${s.version})`);
  return s;
}

/** Hex strings of 64+ digits are refused: the state holds addresses (40) and hashes (64) only, so a 64-hex value
 *  under a key that sounds like a secret, or anything that looks like a private key field, is a bug. */
const SECRETISH = /(key|secret|mnemonic|seed|passphrase|password)$/i;
export function assertNoSecrets(value, path = 'state') {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (SECRETISH.test(k) && !/codeKeys?$|CodeKeys?$/.test(k) && v != null && v !== '') throw new Error(`${path}.${k}: refusing to store a field named like a secret`);
      assertNoSecrets(v, `${path}.${k}`);
    }
  }
}

/** Writes the state atomically (temp file, then rename). */
export function saveState(file, state) {
  assertNoSecrets(state);
  mkdirSync(dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Every address and value the finished steps returned, merged (later steps win). */
export function outputs(state) {
  return Object.assign({}, ...Object.values(state.steps).map((s) => s.out ?? {}));
}

/**
 * Runs `steps` in order.
 *   only:   names to run (others are left alone); null = all
 *   redo:   re-run steps that are already done
 *   dryRun: run nothing, only say what would run
 * save(state) is called after each finished step, so a failure keeps what was done.
 * Returns { ran, skipped, wouldRun }.
 */
/** A node that answers a stale pending nonce right after a receipt makes the next transaction fail like this. */
export const STALE_NONCE = /nonce (has already been used|too low)|NONCE_EXPIRED/i;

export async function runSteps({ steps, state, ctx, only = null, redo = false, dryRun = false, log = console.log, save = () => {},
  settle = async () => {}, attempts = 3 }) {
  const names = new Set(steps.map((s) => s.name));
  for (const n of only ?? []) if (!names.has(n)) throw new Error(`--only ${n}: no such step (steps: ${[...names].join(', ')})`);
  const ran = [], skipped = [], wouldRun = [];
  for (const step of steps) {
    if (only && !only.includes(step.name)) continue;
    const ok = step.when ? step.when(ctx, state) : true;
    if (ok !== true) { log(`- ${step.name}: skipped (${ok || 'not needed'})`); skipped.push(step.name); continue; }
    const done = state.steps[step.name]?.doneAt;
    if (done && !step.always && !redo) { log(`✓ ${step.name}: done ${done}`); skipped.push(step.name); continue; }
    if (dryRun) { log(`· ${step.name}: would run: ${step.describe}`); wouldRun.push(step.name); continue; }
    log(`→ ${step.name}: ${step.describe}`);
    let out;
    try {
      // Not every tool counts nonces itself (zetaphy-dex asks the node each time): when the node answered a stale
      // nonce, wait until it catches up and run the step again. A half-done try leaves only unused contracts
      // (testnet); the state records just the try that finished.
      for (let attempt = 1; ; attempt++) {
        await settle();
        try { out = await step.run(ctx, state); break; } catch (e) {
          if (attempt >= attempts || !STALE_NONCE.test(`${e.code ?? ''} ${e.message}`)) throw e;
          log(`  ${step.name}: the node answered a stale nonce; running the step again (try ${attempt + 1} of ${attempts})`);
        }
      }
    } catch (e) {
      const err = new Error(`step ${step.name} failed: ${e.shortMessage ?? e.message}\n  fix the cause, then run again with --resume (finished steps are kept in the state file)`);
      err.step = step.name;
      err.cause = e;
      throw err;
    }
    state.steps[step.name] = { doneAt: new Date().toISOString(), ...(out && Object.keys(out).length ? { out } : {}) };
    save(state);
    ran.push(step.name);
  }
  return { ran, skipped, wouldRun };
}
