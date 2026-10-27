// Runs one area: draws cases from its generator, re-draws any case whose
// inputs hash the same as one already drawn anywhere in the suite, runs the
// check, and records failures with the input needed to reproduce them.

import { createHash } from 'node:crypto';
import { rng } from './rng.mjs';

/** Canonical JSON: sorted keys, BigInt as "123n", bytes as hex. */
export function canon(v) {
  if (typeof v === 'bigint') return JSON.stringify(`${v}n`);
  if (v instanceof Uint8Array) return JSON.stringify(`bytes:${Buffer.from(v).toString('hex')}`);
  if (v === undefined) return '"<undefined>"';
  if (typeof v === 'number' && !Number.isFinite(v)) return JSON.stringify(`num:${v}`);
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

/** The identity of a case: its area plus its canonical inputs. */
export const hashOf = (area, input) => createHash('sha256').update(area).update('\0').update(canon(input)).digest('hex');

/** Short printable form of an input for a failure report. */
export function show(v, max = 700) {
  const s = canon(v);
  return s.length > max ? s.slice(0, max) + `… (${s.length} chars)` : s;
}

/**
 * @param {{name:string, count:number, seed?:string, setup?:Function, gen:(R, i, ctx)=>any, check:(input, ctx)=>any, teardown?:Function}} area
 * @param {Set<string>} globalSeen  hashes of every case in the suite so far
 */
export async function runArea(area, globalSeen) {
  const R = rng(area.seed ?? `tests-10k/${area.name}`);
  const t0 = performance.now();
  const ctx = area.setup ? await area.setup() : {};
  const failures = [];
  let passed = 0, failed = 0, dupes = 0, drawn = 0;
  const local = new Set();
  for (let i = 0; i < area.count; i++) {
    let input, h, tries = 0;
    for (;;) {
      input = area.gen(R, i, ctx);
      drawn++;
      h = hashOf(area.name, input);
      if (!globalSeen.has(h)) break;
      dupes++;
      if (++tries > 1000) throw new Error(`${area.name}: cannot draw a unique case after 1000 tries (case ${i})`);
    }
    globalSeen.add(h);
    local.add(h);
    try {
      await area.check(input, ctx);
      passed++;
    } catch (e) {
      failed++;
      if (failures.length < 25) failures.push({ index: i, hash: h.slice(0, 16), input: show(input), error: String(e?.message ?? e).slice(0, 900) });
    }
  }
  if (area.teardown) await area.teardown(ctx);
  return {
    name: area.name, group: area.group, what: area.what, count: area.count, passed, failed, drawn, dupes,
    unique: local.size, ms: performance.now() - t0, failures,
  };
}

/** Throws with a message when `cond` is false. */
export function ok(cond, msg) { if (!cond) throw new Error(msg); }
export function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${fmt(b)}, got ${fmt(a)}`);
}
const fmt = (x) => (typeof x === 'bigint' ? `${x}n` : JSON.stringify(x));
