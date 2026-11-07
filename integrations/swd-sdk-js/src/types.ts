// Response shapes of the public SWD endpoints (the site's lib/audit/run.ts, lib/audit/tx.ts, lib/audit/attest-core.ts,
// lib/actions/spec.ts). Only the fields a caller is likely to read are typed strictly; everything else stays open.

export type SwdLang = "th" | "en" | "zh" | "ja" | "ko" | "vi" | "es" | "ru";

/** Overall risk level from SWD Audit's fixed rules. "info" = the rules found no risk (it never means "safe"). */
export type Level = "high" | "medium" | "low" | "info";
export type Severity = Level | "good";

/** Chains SWD Audit reads (contract audit). */
export const AUDIT_CHAINS = ["eth", "bsc", "base", "arbitrum", "zetaphy", "sol", "sui", "aptos", "osmosis", "neutron", "near", "starknet", "bitcoin", "ton"] as const;
export type AuditChain = (typeof AUDIT_CHAINS)[number];
/** Chains the transaction check reads. */
export const TX_CHAINS = ["sol", "eth", "bsc", "base", "arbitrum", "zetaphy"] as const;
export type TxChain = (typeof TX_CHAINS)[number];

export interface Finding {
  id: string;
  severity: Severity;
  text: string;
}

export interface AuditResult {
  chain: string;
  chainName: string;
  address: string;
  level: Level;
  /** the level in the chosen language */
  title: string;
  /** findings, most serious first, in the chosen language */
  lines: Finding[];
  token: { name?: string; symbol?: string } | null;
  reportHash: string;
  /** Neuro verdict ID: stable while the contract's code and settings stay the same */
  verdict: string;
  command: string;
  explorer: string | null;
  permalink: string;
  badge: string;
  auditedAt: string;
  cached: boolean;
  lang: string;
  disclaimer: string;
  correction: { label: string; url: string };
  engine: { name: string; source: string };
  /** Neuro's full machine-readable report (left out unless `full: true`) */
  report?: Record<string, unknown>;
  attestation?: Attestation | null;
  learned?: unknown;
  [k: string]: unknown;
}

export interface TxCheckResult {
  chain: string;
  chainName: string;
  hash: string;
  reader: "neuro" | "swd-solana";
  found: boolean;
  status: boolean | null;
  block: number | null;
  from: string | null;
  to: string | null;
  /** the level from the rules that made the verdict */
  level: Level;
  /** the level including SWD's own notes */
  overall: Level;
  title: string;
  lines: Finding[];
  steps: unknown[];
  pathNotes: string[];
  notes: Finding[];
  reportHash: string;
  verdict: string | null;
  command: string | null;
  explorer: string | null;
  permalink: string;
  api: string;
  checkedAt: string;
  cached: boolean;
  lang: string;
  testnetNote: string | null;
  disclaimer: string;
  report?: Record<string, unknown>;
  attestation?: Attestation | null;
  [k: string]: unknown;
}

export interface Supply {
  /** whole SWD, as a decimal string (the mint's current supply; SWD has no mint authority) */
  total: string;
  /** whole SWD, as a decimal string */
  circulating: string;
}

// ---- attestations (swd.audit-attestation.v1) ----
export interface AttestPayload {
  kind: "contract" | "tx";
  chain: string;
  subject: string;
  reader: "neuro" | "swd-solana";
  engine: string;
  reportHash: string;
  verdict: string | null;
  level: Level;
  overall?: Level;
  observedAt: string;
  site: string;
  url: string;
}
export interface AttestSig {
  keyId: string;
  /** base64 */
  publicKey: string;
  /** base64 */
  sig: string;
}
export interface Attestation {
  format: "swd.audit-attestation.v1";
  payload: AttestPayload;
  payloadHash: string;
  id: string;
  sigs: { mldsa44: AttestSig; ed25519: AttestSig };
}
export interface PublishedKey {
  alg: "ML-DSA-44" | "Ed25519";
  keyId: string;
  publicKey: string;
  status: "current" | "retired" | "revoked";
  since?: string;
  until?: string;
}
export interface KeyList {
  format: "swd.audit-attest-keys.v1";
  site: string;
  current: { mldsa44: string; ed25519: string } | null;
  keys: PublishedKey[];
  anchor?: unknown;
}

// ---- Solana Actions (spec v2.4) ----
export interface ActionGetResponse {
  type: "action";
  icon: string;
  title: string;
  description: string;
  label: string;
  disabled?: boolean;
  links?: { actions: { type: string; href: string; label: string; parameters?: unknown[] }[] };
  error?: { message: string };
}
export interface BuySwdTransaction {
  /** the unsigned transaction, base64 (a v0 VersionedTransaction; the buyer is the fee payer) */
  transaction: string;
  /** the same bytes, decoded */
  bytes: Uint8Array;
  /** human text from the server: SOL in, SWD out (estimate) and the minimum after slippage */
  message?: string;
}
