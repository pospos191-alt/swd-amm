// HTTP client for the public SWD endpoints. Read-only: nothing here signs or sends a transaction, and no key is needed.
//   contract audit     GET  /api/audit?chain=&address=&lang=
//   transaction check  GET  /api/audit/tx?chain=&hash=&lang=
//   token info, swap quote, SWD facts: the MCP server, POST /api/mcp (tools/call)

export const DEFAULT_BASE_URL = "https://swd-zetaphy.sawasdeecoin.com";
export const SWD_MINT = "Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL";

export type SwdLang = "th" | "en" | "zh" | "ja" | "ko" | "vi" | "es" | "ru";
export interface SwdClientOptions {
  /** another deployment of the site (default: the production one) */
  baseUrl?: string;
  /** per request, ms (default 60 s: a first audit of a contract reads the chain) */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class SwdApiError extends Error {
  constructor(
    message: string,
    public code: string,
    public status?: number,
  ) {
    super(message);
  }
}

const MCP_VERSION = "2025-11-25";

export function createSwdClient(opts: SwdClientOptions = {}) {
  const base = (opts.baseUrl ?? (typeof process !== "undefined" ? process.env?.SWD_API_BASE : undefined) ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const doFetch = opts.fetch ?? globalThis.fetch;
  let rpcId = 0;

  async function getJson(path: string, params: Record<string, string>) {
    const url = `${base}${path}?${new URLSearchParams(params)}`;
    const r = await doFetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    const body: any = await r.json().catch(() => null);
    if (!r.ok || !body?.ok) throw new SwdApiError(body?.error ?? `HTTP ${r.status}`, body?.code ?? "http_error", r.status);
    return body;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
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

  return {
    baseUrl: base,
    /** audit a deployed contract / token (14 chains). The full rule report is left out; `permalink` shows it. */
    async auditContract(chain: string, address: string, lang: SwdLang = "en") {
      const { audit } = await getJson("/api/audit", { chain, address, lang });
      const { report: _full, ...rest } = audit ?? {};
      return rest;
    },
    /** check one transaction for what moved and known scam patterns (sol, eth, bsc, base, arbitrum, zetaphy) */
    async checkTransaction(chain: string, hash: string, lang: SwdLang = "en") {
      const { tx } = await getJson("/api/audit/tx", { chain, hash, lang });
      const { report: _full, ...rest } = tx ?? {};
      return rest;
    },
    tokenInfo: (chain: string, address: string, lang: SwdLang = "en") => callTool("swd_token_info", { chain, address, lang }),
    /** quote only: `amount` in the input token's smallest units */
    swapQuote: (inputMint: string, outputMint: string, amount: string, slippageBps?: number) =>
      callTool("swd_swap_quote", { inputMint, outputMint, amount, ...(slippageBps ? { slippageBps } : {}) }),
    info: () => callTool("swd_info", {}),
  };
}

export type SwdClient = ReturnType<typeof createSwdClient>;
