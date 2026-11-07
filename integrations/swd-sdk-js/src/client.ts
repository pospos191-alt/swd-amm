// HTTP client for the public SWD endpoints. Free, no API key, CORS open. Nothing here holds or asks for a private key:
// buySwdTransaction only RECEIVES an unsigned transaction, which the buyer's own wallet signs and sends.
//   GET  /api/audit?chain=&address=&lang=         contract / token audit (14 chains)
//   GET  /api/audit/tx?chain=&hash=&lang=         transaction check
//   GET  /api/audit/badge?chain=&address=         SVG badge (URL only)
//   GET  /api/audit/attest/keys                   the public keys that sign attestations
//   GET  /api/supply/total, /api/supply/circulating  plain-text numbers (whole SWD)
//   GET  /api/actions/buy-swd                     the "Buy SWD" Solana Action card
//   POST /api/actions/buy-swd?amount=&lang=       { account } → one unsigned SOL → SWD transaction
//   POST /api/mcp                                 MCP tools/call (token info, swap quote, SWD info)
import type { ActionGetResponse, AuditResult, BuySwdTransaction, KeyList, Supply, SwdLang, TxCheckResult } from "./types";
import { fromB64 } from "./attest";

export const DEFAULT_BASE_URL = "https://swd-zetaphy.sawasdeecoin.com";
export const SWD_MINT = "Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL";
export const SWD_DECIMALS = 5;
export const BUY_MIN_SOL = 0.001;
export const BUY_MAX_SOL = 50;
const MCP_VERSION = "2025-11-25";

export interface SwdClientOptions {
  /** another deployment of the site (default: production) */
  baseUrl?: string;
  /** per request, ms (default 60 s: a first audit of a contract reads the chain) */
  timeoutMs?: number;
  /** a fetch implementation (default: globalThis.fetch) */
  fetch?: typeof fetch;
}

export class SwdApiError extends Error {
  constructor(
    message: string,
    /** the API's error code (bad_chain, bad_address, bad_hash, read_failed, ...) or http_error / bad_input / bad_response */
    public code: string,
    public status?: number,
  ) {
    super(message);
    this.name = "SwdApiError";
  }
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** "0.05" or 0.05 → "0.05"; refuses anything outside 0.001–50 SOL or with more than 9 decimals */
export function solAmountString(amount: number | string): string {
  const s = typeof amount === "number" ? (Number.isFinite(amount) ? amount.toFixed(9).replace(/\.?0+$/, "") : "") : amount.trim();
  if (!/^\d{1,3}(\.\d{1,9})?$/.test(s)) throw new SwdApiError("amount must be a SOL amount with at most 9 decimals", "bad_input");
  const n = Number(s);
  if (n < BUY_MIN_SOL || n > BUY_MAX_SOL) throw new SwdApiError(`amount must be between ${BUY_MIN_SOL} and ${BUY_MAX_SOL} SOL`, "bad_input");
  return s;
}

function strip<T extends { report?: unknown }>(r: T, full: boolean | undefined): T {
  if (full || !r) return r;
  const { report: _r, ...rest } = r;
  return rest as T;
}

export function createSwdClient(opts: SwdClientOptions = {}) {
  const env = typeof process !== "undefined" ? (process as { env?: Record<string, string | undefined> }).env?.SWD_API_BASE : undefined;
  const base = (opts.baseUrl ?? env ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new Error("swd-sdk: no fetch available; pass options.fetch");
  let rpcId = 0;

  const url = (path: string, params?: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) q.set(k, v);
    const s = q.toString();
    return `${base}${path}${s ? `?${s}` : ""}`;
  };

  async function getJson(path: string, params?: Record<string, string | undefined>): Promise<any> {
    const r = await doFetch(url(path, params), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new SwdApiError(body?.error ?? `HTTP ${r.status}`, body?.code ?? "http_error", r.status);
    return body;
  }

  async function getNumber(path: string): Promise<string> {
    const r = await doFetch(url(path), { headers: { accept: "text/plain" }, signal: AbortSignal.timeout(timeoutMs) });
    const t = (await r.text()).trim();
    if (!r.ok) throw new SwdApiError(`HTTP ${r.status}`, "http_error", r.status);
    if (!/^\d+(\.\d+)?$/.test(t)) throw new SwdApiError("not a number", "bad_response", r.status);
    return t;
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
    const r = await doFetch(`${base}/api/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": MCP_VERSION },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body: any = await r.json().catch(() => null);
    if (!body) throw new SwdApiError(`HTTP ${r.status}`, "http_error", r.status);
    if (body.error) throw new SwdApiError(String(body.error.message), "rpc_error", r.status);
    const res = body.result;
    if (res?.isError) throw new SwdApiError(String(res.content?.[0]?.text ?? "tool error"), "tool_error", r.status);
    return res?.structuredContent ?? JSON.parse(res?.content?.[0]?.text ?? "null");
  }

  const client = {
    baseUrl: base,

    /** Audit a deployed contract / token. `full: true` keeps Neuro's full machine-readable report. */
    async audit(chain: string, address: string, o: { lang?: SwdLang; full?: boolean } = {}): Promise<AuditResult> {
      if (!chain || !address) throw new SwdApiError("chain and address are required", "bad_input");
      const { audit } = await getJson("/api/audit", { chain, address, lang: o.lang ?? "en" });
      return strip(audit as AuditResult, o.full);
    },

    /** Check one transaction: what moved where, and known scam patterns. */
    async auditTx(chain: string, hash: string, o: { lang?: SwdLang; full?: boolean } = {}): Promise<TxCheckResult> {
      if (!chain || !hash) throw new SwdApiError("chain and hash are required", "bad_input");
      const { tx } = await getJson("/api/audit/tx", { chain, hash, lang: o.lang ?? "en" });
      return strip(tx as TxCheckResult, o.full);
    },

    /** What the audit API accepts: { chains: [{ key, name, kind, example }], langs } */
    auditInfo: async () => {
      const { chains, langs } = await getJson("/api/audit");
      return { chains, langs } as { chains: { key: string; name: string; kind: string; example: string }[]; langs: { code: string; name: string }[] };
    },

    /** The SVG badge URL for a contract (always shows the current result). */
    badgeUrl: (chain: string, address: string) => url("/api/audit/badge", { chain, address }),
    /** The human-readable audit page. */
    permalink: (chain: string, address: string) => `${base}/audit/${encodeURIComponent(chain)}/${address.split("/").map(encodeURIComponent).join("/")}`,

    /** The public keys that sign attestations (keep a copy: attestations verify offline against it). */
    attestationKeys: async (): Promise<KeyList> => (await getJson("/api/audit/attest/keys")).keys,

    /** SWD total and circulating supply, whole SWD as decimal strings. */
    async supply(): Promise<Supply> {
      const [total, circulating] = await Promise.all([getNumber("/api/supply/total"), getNumber("/api/supply/circulating")]);
      return { total, circulating };
    },

    /** The "Buy SWD" Solana Action card (title, presets, limits). */
    async buySwdAction(lang: SwdLang = "en"): Promise<ActionGetResponse> {
      const r = await doFetch(url("/api/actions/buy-swd", { lang }), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      const body: any = await r.json().catch(() => null);
      if (!r.ok || !body) throw new SwdApiError(body?.message ?? `HTTP ${r.status}`, "http_error", r.status);
      return body as ActionGetResponse;
    },

    /**
     * An UNSIGNED SOL → SWD transaction for `account` (the buyer's wallet address, also the fee payer), built by the
     * site's Buy SWD Action (Jupiter route + the site's fee). Hand `bytes` to the buyer's wallet to sign and send; the
     * SDK never signs anything. Simulate it in your app before asking the user to sign, as any wallet does.
     */
    async buySwdTransaction(o: { account: string; amountSol: number | string; slippageBps?: number; lang?: SwdLang }): Promise<BuySwdTransaction> {
      if (typeof o.account !== "string" || !BASE58_ADDRESS.test(o.account)) throw new SwdApiError("account must be a Solana address", "bad_input");
      const amount = solAmountString(o.amountSol);
      if (o.slippageBps !== undefined && !(Number.isInteger(o.slippageBps) && o.slippageBps >= 10 && o.slippageBps <= 300))
        throw new SwdApiError("slippageBps must be an integer from 10 to 300", "bad_input");
      const r = await doFetch(url("/api/actions/buy-swd", { amount, lang: o.lang ?? "en", slippageBps: o.slippageBps?.toString() }), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ account: o.account }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body: any = await r.json().catch(() => null);
      if (!r.ok || !body) throw new SwdApiError(body?.message ?? `HTTP ${r.status}`, "http_error", r.status);
      if (body.type !== "transaction" || typeof body.transaction !== "string") throw new SwdApiError("no transaction in the answer", "bad_response", r.status);
      let bytes: Uint8Array;
      try {
        bytes = fromB64(body.transaction);
      } catch {
        throw new SwdApiError("transaction is not base64", "bad_response", r.status);
      }
      return { transaction: body.transaction, bytes, message: body.message };
    },

    /** MCP tools (same server Claude / Cursor use) */
    tokenInfo: (chain: string, address: string, lang: SwdLang = "en") => callTool("swd_token_info", { chain, address, lang }),
    /** quote only; `amount` in the input token's smallest units */
    swapQuote: (inputMint: string, outputMint: string, amount: string, slippageBps?: number) =>
      callTool("swd_swap_quote", { inputMint, outputMint, amount, ...(slippageBps ? { slippageBps } : {}) }),
    info: () => callTool("swd_info", {}),
  };
  return client;
}

export type SwdClient = ReturnType<typeof createSwdClient>;
