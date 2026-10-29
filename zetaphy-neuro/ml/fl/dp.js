// Neuro federated learning: clipping, Gaussian noise and the privacy budget.
//
// Threat model: LOCAL differential privacy. Each browser clips its update to
// L2 norm C and adds N(0, (z*C)^2) noise to every coordinate BEFORE it leaves
// the device, so neither the aggregator, the runners nor anyone reading the
// chain needs to be trusted for the guarantee.
//
// Neighbouring inputs = anything one user could have labelled (user level):
// two clipped updates differ by at most 2C in L2 (sensitivity 2C). The
// Gaussian mechanism with std z*C is then rho-zCDP with
//   rho = (2C)^2 / (2 (zC)^2) = 2 / z^2           per submitted round,
// rounds compose additively (rho_total = k * 2 / z^2), and zCDP converts to
//   epsilon = rho + 2 sqrt(rho ln(1/delta))         (Bun & Steinke 2016, Prop. 1.3).
// No amplification by sampling or shuffling is claimed.

/** Per-round zCDP rho of the local Gaussian mechanism with noise multiplier z. */
export const rhoPerRound = (z) => {
  if (!(z > 0)) return Infinity;
  return 2 / (z * z);
};

/** (epsilon, delta)-DP implied by rho-zCDP. */
export function epsilonOf(rho, delta = 1e-5) {
  if (!Number.isFinite(rho)) return Infinity;
  return rho + 2 * Math.sqrt(rho * Math.log(1 / delta));
}

/** Largest rho with epsilonOf(rho, delta) <= eps. */
export function rhoFor(eps, delta = 1e-5) {
  const L = Math.log(1 / delta);
  const s = -Math.sqrt(L) + Math.sqrt(L + eps); // sqrt(rho): s^2 + 2 sqrt(L) s - eps = 0
  return s * s;
}

/** How many rounds a user may join with noise multiplier z before the total exceeds eps. */
export const roundsAllowed = (z, eps, delta = 1e-5) => Math.floor(rhoFor(eps, delta) / rhoPerRound(z) + 1e-12);

/** Default privacy settings; documented in docs/future/federated.md. */
export const DEFAULT_PRIVACY = Object.freeze({ clip: 1, z: 2, delta: 1e-5, epsBudget: 16 });

export function l2(v) { let s = 0; for (const x of v) s += x * x; return Math.sqrt(s); }

/** Scales v so its L2 norm is at most C. */
export function clipL2(v, C) {
  const n = l2(v);
  if (n <= C || n === 0) return Float64Array.from(v);
  const k = C / n;
  return Float64Array.from(v, (x) => x * k);
}

/**
 * Uniform (0,1) numbers from the platform's cryptographic generator. Noise
 * MUST come from here in production: a seeded generator makes it predictable
 * and the privacy guarantee void.
 */
export function cryptoUniform() {
  const buf = new Uint32Array(2);
  return () => {
    globalThis.crypto.getRandomValues(buf);
    // 53 random bits, never exactly 0
    return ((buf[0] >>> 5) * 67108864 + (buf[1] >>> 6) + 1) / 9007199254740993;
  };
}

/** Standard normal samples from a uniform source (Box-Muller). */
export function gaussian(uniform) {
  let spare = null;
  return () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0;
    while (u <= 0) u = uniform();
    const v = uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

/** Clip to C, then add N(0, (zC)^2) per coordinate. */
export function privatize(delta, { clip, z }, uniform = cryptoUniform()) {
  const out = clipL2(delta, clip);
  if (z > 0) {
    const g = gaussian(uniform);
    for (let i = 0; i < out.length; i++) out[i] += z * clip * g();
  }
  return out;
}

/**
 * The privacy budget a browser keeps (in localStorage or similar): how much
 * rho it has spent and on which rounds. refuse() says why it must not submit.
 */
export class PrivacyLedger {
  constructor({ epsBudget = DEFAULT_PRIVACY.epsBudget, delta = DEFAULT_PRIVACY.delta, spent = [] } = {}) {
    this.epsBudget = epsBudget;
    this.delta = delta;
    this.spent = spent.slice(); // [{round, rho}]
  }
  get rho() { return this.spent.reduce((s, e) => s + e.rho, 0); }
  get epsilon() { return epsilonOf(this.rho, this.delta); }
  /** null when a round with noise multiplier z may be submitted, else the reason. */
  refuse(round, z) {
    if (this.spent.some((e) => e.round === round)) return 'already submitted for this round';
    if (epsilonOf(this.rho + rhoPerRound(z), this.delta) > this.epsBudget) return 'privacy budget used up';
    return null;
  }
  record(round, z) {
    const why = this.refuse(round, z);
    if (why) throw new Error(why);
    this.spent.push({ round, rho: rhoPerRound(z) });
  }
  toJSON() { return { epsBudget: this.epsBudget, delta: this.delta, spent: this.spent }; }
}
