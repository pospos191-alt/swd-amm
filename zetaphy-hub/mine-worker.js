// The faucet proof of work, one Web Worker per thread (mine.js starts and stops them).
// It only counts SHA-256 tries for the job the page gives it, and only while the page says so:
// nothing here runs on its own, and closing or leaving the page ends it.
//   in:  { job: { gen, prefix (60 bytes), bits, hi } }  |  { stop: true }
//   out: { gen, tries }  every chunk;  { gen, tries, found: { hi, lo } }  when a proof is found
import { search } from './mine-core.js';

const CHUNK = 1 << 17; // ~50 ms of work: new messages (stop, a new block) are read between chunks
let job = null, lo = 0, timer = 0;

function step() {
  timer = 0;
  if (!job) return;
  const { gen, prefix, bits } = job;
  const count = Math.min(CHUNK, 2 ** 32 - lo);
  const found = search(prefix, job.hi, bits, lo, count);
  if (found >= 0) {
    postMessage({ gen, tries: found - lo + 1, found: { hi: job.hi, lo: found } });
    job = null;
    return;
  }
  postMessage({ gen, tries: count });
  lo += count;
  if (lo >= 2 ** 32) { job.hi = (job.hi + 1) >>> 0; lo = 0; } // this high word is used up: the next one
  timer = setTimeout(step, 0);
}

onmessage = ({ data }) => {
  if (timer) { clearTimeout(timer); timer = 0; }
  if (data?.stop) { job = null; return; }
  const j = data?.job;
  if (!j || !(j.prefix instanceof Uint8Array) || j.prefix.length !== 60 || !(j.bits >= 1 && j.bits <= 64)) { job = null; return; }
  job = { gen: j.gen, prefix: j.prefix, bits: j.bits, hi: j.hi >>> 0 };
  lo = 0;
  timer = setTimeout(step, 0);
};
