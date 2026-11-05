// Solana Agent Kit v2 actions (name, similes, description, examples, zod schema, handler). Each handler answers
// { status: "success", data } or { status: "error", message } and never throws.
import type { Action, SolanaAgentKit } from "solana-agent-kit";
import { z } from "zod";
import { SWD_MINT, createSwdClient, type SwdClient } from "../client";

const AUDIT_CHAINS = ["eth", "bsc", "base", "arbitrum", "zetaphy", "sol", "sui", "aptos", "osmosis", "neutron", "near", "starknet", "bitcoin", "ton"] as const;
const TX_CHAINS = ["sol", "eth", "bsc", "base", "arbitrum", "zetaphy"] as const;
const LANGS = ["th", "en", "zh", "ja", "ko", "vi", "es", "ru"] as const;
const WSOL = "So11111111111111111111111111111111111111112";

let shared: SwdClient | null = null;
/** the client actions use; swdPlugin.initialize / createSwdPlugin set it */
export function setSwdClient(c: SwdClient) {
  shared = c;
}
const client = () => (shared ??= createSwdClient());

async function run(work: () => Promise<unknown>, done: string) {
  try {
    return { status: "success", data: await work(), message: done };
  } catch (e) {
    return { status: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export const auditContractAction: Action = {
  name: "SWD_AUDIT_CONTRACT",
  similes: ["audit contract", "audit token", "is this token safe", "check smart contract security", "rug check contract", "scan token contract"],
  description:
    "Free automated security audit of a deployed contract or token on 14 chains (Solana, Ethereum, BNB Chain, Base, Arbitrum, Sui, Aptos, TON, ...). " +
    "Returns risk level, findings, a verdict ID, a signed attestation and a permalink. Read-only; an automated check, not a guarantee.",
  examples: [
    [
      {
        input: { chain: "sol", address: SWD_MINT },
        output: { status: "success", data: { level: "low", verdict: "…", permalink: "https://swd-zetaphy.sawasdeecoin.com/audit/sol/…" } },
        explanation: "Audit the SWD token mint on Solana",
      },
    ],
  ],
  schema: z.object({
    chain: z.enum(AUDIT_CHAINS).describe("chain key"),
    address: z.string().min(1).max(200).describe("contract or token address"),
    lang: z.enum(LANGS).optional().describe("language of the texts"),
  }),
  handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => run(() => client().auditContract(input.chain, input.address, input.lang ?? "en"), "audit done"),
};

export const checkTransactionAction: Action = {
  name: "SWD_CHECK_TRANSACTION",
  similes: ["check transaction", "is this transaction a scam", "analyze tx", "explain transaction", "check signature"],
  description:
    "Free read-only check of one transaction (Solana signature or EVM hash on eth, bsc, base, arbitrum, zetaphy): what moved where and known scam patterns " +
    "such as approval drains or address poisoning.",
  examples: [
    [
      {
        input: { chain: "eth", hash: "0x…64 hex…" },
        output: { status: "success", data: { found: true, level: "info", steps: [] } },
        explanation: "Check an Ethereum transaction",
      },
    ],
  ],
  schema: z.object({
    chain: z.enum(TX_CHAINS),
    hash: z.string().min(1).max(120).describe("transaction hash or Solana signature"),
    lang: z.enum(LANGS).optional(),
  }),
  handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => run(() => client().checkTransaction(input.chain, input.hash, input.lang ?? "en"), "transaction checked"),
};

export const tokenInfoAction: Action = {
  name: "SWD_TOKEN_INFO",
  similes: ["token info", "token price and liquidity", "what is this token", "token logo", "market facts"],
  description: "Name, symbol, logo and market facts of a token (Solana: price, volume, liquidity, pools and rule-based market signals). Facts only, not advice.",
  examples: [
    [
      {
        input: { chain: "sol", address: SWD_MINT },
        output: { status: "success", data: { symbol: "SWD", market: { priceUsd: 0.0001 } } },
        explanation: "Market facts of SWD",
      },
    ],
  ],
  schema: z.object({
    chain: z.enum(AUDIT_CHAINS),
    address: z.string().min(1).max(200),
    lang: z.enum(LANGS).optional(),
  }),
  handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => run(() => client().tokenInfo(input.chain, input.address, input.lang ?? "en"), "token info"),
};

export const swapQuoteAction: Action = {
  name: "SWD_SWAP_QUOTE",
  similes: ["swap quote", "how much will I get", "price to swap", "quote sol to swd"],
  description: "Quote for swapping one Solana token for another (Jupiter routing). Quote only: nothing is built or signed. amount is in the input token's smallest units.",
  examples: [
    [
      {
        input: { inputMint: WSOL, outputMint: SWD_MINT, amount: "100000000" },
        output: { status: "success", data: { outAmount: "…", priceImpactPct: "0.01", quoteOnly: true } },
        explanation: "Quote 0.1 SOL to SWD",
      },
    ],
  ],
  schema: z.object({
    inputMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    outputMint: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
    amount: z.string().regex(/^[0-9]{1,20}$/).describe("integer, smallest units"),
    slippageBps: z.number().int().min(1).max(1000).optional(),
  }),
  handler: async (_agent: SolanaAgentKit, input: Record<string, any>) => run(() => client().swapQuote(input.inputMint, input.outputMint, input.amount, input.slippageBps), "quote"),
};

export const swdInfoAction: Action = {
  name: "SWD_INFO",
  similes: ["what is swd", "sawasdee coin", "swd mint address", "swd links"],
  description: "Facts about SWD (SAWASDEE COIN): Solana mint, official links and the SWD tools.",
  examples: [[{ input: {}, output: { status: "success", data: { mint: SWD_MINT } }, explanation: "About SWD" }]],
  schema: z.object({}),
  handler: async () => run(() => client().info(), "SWD facts"),
};

export const SWD_ACTIONS: Action[] = [auditContractAction, checkTransactionAction, tokenInfoAction, swapQuoteAction, swdInfoAction];
