// Checks an SWD Audit attestation (format swd.audit-attestation.v1, defined in the site's lib/audit/attest-core.ts).
//
// What this SDK checks with no dependency (WebCrypto only):
//   - the format and the payload fields,
//   - payloadHash = "0x" + sha256(canonical JSON of the payload),
//   - both key ids = "<alg>-" + first 16 hex of sha256(public key),
//   - id = "0x" + sha256(signed message),
//   - the Ed25519 signature (WebCrypto Ed25519: Node 18.4+, current Chrome / Firefox / Safari),
//   - with `keys` (GET /api/audit/attest/keys): whether both keys are SWD's published, non-revoked keys.
// What it does NOT check by itself: the ML-DSA-44 (post-quantum) signature. Pass `mldsaVerify` (for example
// `(pk, msg, sig) => ml_dsa44.verify(pk, msg, sig)` from @noble/post-quantum) to check it too; without it the result
// has `complete: false` and `ok` stays false, because an attestation is only valid when BOTH signatures verify.
import type { Attestation, KeyList, PublishedKey } from "./types";

export const ATTEST_FORMAT = "swd.audit-attestation.v1";
const MLDSA_PUBLIC_KEY_BYTES = 1312;
const MLDSA_SIG_BYTES = 2420;

export type MldsaVerify = (publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array) => boolean | Promise<boolean>;

export interface VerifyOptions {
  /** the list from GET /api/audit/attest/keys (or a copy kept offline) */
  keys?: KeyList | PublishedKey[] | null;
  /** an ML-DSA-44 verifier (FIPS 204, pure mode, empty context) */
  mldsaVerify?: MldsaVerify;
}

export interface VerifyResult {
  /** every check passed, BOTH signatures included */
  ok: boolean;
  /** false when the ML-DSA-44 signature was not checked (no `mldsaVerify` given) */
  complete: boolean;
  /** ok AND both keys are SWD's published keys (current or retired, not revoked) */
  trusted: boolean;
  problems: string[];
  ed25519: boolean;
  /** null = not checked */
  mldsa44: boolean | null;
  signer: "current" | "retired" | "revoked" | "unknown";
  id: string | null;
  payloadHash: string | null;
}

const enc = new TextEncoder();
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function subtle(): Promise<SubtleCrypto> {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.subtle) return c.subtle;
  // Node 18 without the global (it is global from Node 19)
  const m = (await import(/* @vite-ignore */ "node:crypto" as string)) as { webcrypto: Crypto };
  return m.webcrypto.subtle;
}
export async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await (await subtle()).digest("SHA-256", b as BufferSource));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < b.length ? B64[(n >> 6) & 63] : "=") + (i + 2 < b.length ? B64[n & 63] : "=");
  }
  return s;
}
/** strict standard base64 (padding required, canonical) */
export function fromB64(s: string): Uint8Array {
  if (typeof s !== "string" || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("not base64");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((s.length / 4) * 3 - pad);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c = [0, 1, 2, 3].map((j) => (s[i + j] === "=" ? 0 : B64.indexOf(s[i + j])));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    if (o < out.length) out[o++] = (n >> 16) & 255;
    if (o < out.length) out[o++] = (n >> 8) & 255;
    if (o < out.length) out[o++] = n & 255;
  }
  if (toB64(out) !== s) throw new Error("not canonical base64");
  return out;
}

/** Canonical JSON: sorted keys, no whitespace, non-ASCII escaped as \uXXXX, safe integers only. */
const asciiString = (s: string) => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export function canonical(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("canonical: only safe integers");
    return String(v);
  }
  if (typeof v === "string") return asciiString(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${asciiString(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  throw new Error(`canonical: cannot encode a ${typeof v}`);
}

export const keyIdOf = async (alg: "mldsa44" | "ed25519", publicKey: Uint8Array) => `${alg}-${toHex(await sha256(publicKey)).slice(0, 16)}`;
export const signedMessage = (payloadHash: string, mldsaKeyId: string, edKeyId: string) =>
  enc.encode(`${ATTEST_FORMAT}\n${payloadHash}\nml-dsa-44:${mldsaKeyId}\ned25519:${edKeyId}`);

const LEVELS = ["high", "medium", "low", "info"];
function checkPayload(p: unknown): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "payload_shape";
  const o = p as Record<string, unknown>;
  const allowed = new Set(["kind", "chain", "subject", "reader", "engine", "reportHash", "verdict", "level", "overall", "observedAt", "site", "url"]);
  if (Object.keys(o).some((k) => !allowed.has(k))) return "payload_extra_field";
  const str = (k: string, max = 300) => typeof o[k] === "string" && (o[k] as string).length > 0 && (o[k] as string).length <= max;
  if (!["contract", "tx"].includes(o.kind as string)) return "payload_kind";
  if (!str("chain", 40) || !str("subject", 200) || !str("engine", 120) || !str("site", 200) || !str("url", 600)) return "payload_field";
  if (!["neuro", "swd-solana"].includes(o.reader as string)) return "payload_reader";
  if (typeof o.reportHash !== "string" || !/^(0x)?[0-9a-fA-F]{16,128}$/.test(o.reportHash)) return "payload_report_hash";
  if (o.verdict !== null && (typeof o.verdict !== "string" || !/^0x[0-9a-f]{64}$/.test(o.verdict))) return "payload_verdict";
  if (!LEVELS.includes(o.level as string)) return "payload_level";
  if (o.overall !== undefined && !LEVELS.includes(o.overall as string)) return "payload_level";
  if (typeof o.observedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(o.observedAt)) return "payload_time";
  return null;
}

async function ed25519Verify(pub: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  try {
    const s = await subtle();
    const key = await s.importKey("raw", pub as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await s.verify({ name: "Ed25519" }, key, sig as BufferSource, msg as BufferSource);
  } catch {
    return false;
  }
}

function decode(s: unknown, len: number): Uint8Array | null {
  try {
    const b = fromB64(s as string);
    return b.length === len ? b : null;
  } catch {
    return null;
  }
}

/** Checks an attestation from its JSON (object or string). Never throws. */
export async function verifyAttestation(input: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const problems: string[] = [];
  const out: VerifyResult = { ok: false, complete: false, trusted: false, problems, ed25519: false, mldsa44: null, signer: "unknown", id: null, payloadHash: null };
  let a: unknown = input;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      problems.push("not_json");
      return out;
    }
  }
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    problems.push("not_json");
    return out;
  }
  const att = a as Partial<Attestation> & Record<string, unknown>;
  if (att.format !== ATTEST_FORMAT) problems.push("format");
  if (Object.keys(att).some((k) => !["format", "payload", "payloadHash", "id", "sigs"].includes(k))) problems.push("extra_field");
  const bad = checkPayload(att.payload);
  if (bad) problems.push(bad);
  try {
    out.payloadHash = "0x" + toHex(await sha256(enc.encode(canonical(att.payload))));
  } catch {
    if (!bad) problems.push("payload_shape");
  }
  if (!out.payloadHash || att.payloadHash !== out.payloadHash) problems.push("payload_hash");

  const ml = att.sigs?.mldsa44;
  const ed = att.sigs?.ed25519;
  const mlPub = decode(ml?.publicKey, MLDSA_PUBLIC_KEY_BYTES);
  const mlSig = decode(ml?.sig, MLDSA_SIG_BYTES);
  const edPub = decode(ed?.publicKey, 32);
  const edSig = decode(ed?.sig, 64);
  if (!mlPub) problems.push("mldsa_key");
  if (!mlSig) problems.push("mldsa_sig_format");
  if (!edPub) problems.push("ed25519_key");
  if (!edSig) problems.push("ed25519_sig_format");
  const mlId = mlPub ? await keyIdOf("mldsa44", mlPub) : null;
  const edId = edPub ? await keyIdOf("ed25519", edPub) : null;
  if (mlId && ml?.keyId !== mlId) problems.push("mldsa_key_id");
  if (edId && ed?.keyId !== edId) problems.push("ed25519_key_id");

  if (typeof att.payloadHash === "string" && mlId && edId) {
    // rebuilt from the DERIVED key ids, so a swapped keyId field cannot change what was signed
    const msg = signedMessage(att.payloadHash, mlId, edId);
    out.id = "0x" + toHex(await sha256(msg));
    if (att.id !== out.id) problems.push("id");
    if (edSig) out.ed25519 = await ed25519Verify(edPub!, msg, edSig);
    if (mlSig && opts.mldsaVerify) {
      try {
        out.mldsa44 = (await opts.mldsaVerify(mlPub!, msg, mlSig)) === true;
      } catch {
        out.mldsa44 = false;
      }
    }
  }
  if (edPub && edSig && !out.ed25519) problems.push("ed25519_sig");
  if (out.mldsa44 === false) problems.push("mldsa_sig");
  out.complete = out.mldsa44 !== null;
  out.ok = problems.length === 0 && out.ed25519 && out.mldsa44 === true;

  const list = Array.isArray(opts.keys) ? opts.keys : opts.keys?.keys;
  if (list && mlPub && edPub) {
    const mlB = toB64(mlPub);
    const edB = toB64(edPub);
    const kMl = list.find((k) => k.alg === "ML-DSA-44" && k.publicKey === mlB);
    const kEd = list.find((k) => k.alg === "Ed25519" && k.publicKey === edB);
    if (!kMl || !kEd) out.signer = "unknown";
    else if (kMl.status === "revoked" || kEd.status === "revoked") out.signer = "revoked";
    else if (kMl.status === "current" && kEd.status === "current") out.signer = "current";
    else out.signer = "retired";
    if (out.signer === "unknown") problems.push("key_unknown");
    if (out.signer === "revoked") problems.push("key_revoked");
    out.trusted = out.ok && (out.signer === "current" || out.signer === "retired");
  }
  return out;
}
