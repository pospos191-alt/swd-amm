# solana-agent-kit-plugin-swd

SWD (SAWASDEE COIN) tools for [Solana Agent Kit](https://github.com/sendaifun/solana-agent-kit) v2. Free, read-only, no API key:

| Action | Method | What it does |
| --- | --- | --- |
| `SWD_AUDIT_CONTRACT` | `swdAuditContract(agent, chain, address, lang?)` | Automated security audit of a deployed contract / token on 14 chains: level, findings, verdict ID, signed attestation, permalink |
| `SWD_CHECK_TRANSACTION` | `swdCheckTransaction(agent, chain, hash, lang?)` | What a transaction moved and known scam patterns (sol, eth, bsc, base, arbitrum, zetaphy) |
| `SWD_TOKEN_INFO` | `swdTokenInfo(agent, chain, address, lang?)` | Name, symbol, logo, market facts (Solana: price, volume, liquidity, pools, rule-based signals) |
| `SWD_SWAP_QUOTE` | `swdSwapQuote(agent, inputMint, outputMint, amount, slippageBps?)` | Solana swap quote (Jupiter). Quote only, nothing is signed |
| `SWD_INFO` | `swdInfo(agent)` | SWD mint, official links, tool list |

Nothing in this plugin uses the agent's wallet: it never builds, signs or sends a transaction.

## Install

```bash
npm install solana-agent-kit-plugin-swd solana-agent-kit zod
```

## Use

```ts
import { SolanaAgentKit, KeypairWallet, createVercelAITools } from "solana-agent-kit";
import SwdPlugin from "solana-agent-kit-plugin-swd";

const agent = new SolanaAgentKit(wallet, process.env.RPC_URL!, {}).use(SwdPlugin);

// call a method directly
const audit = await agent.methods.swdAuditContract(agent, "sol", "Cmh2tu6bt5z2a8NKsx6G5WfVmaeQ9f2fcX5VnQbVaGLL");
console.log(audit.level, audit.verdict, audit.permalink);

// or hand the actions to your AI framework
const tools = createVercelAITools(agent, agent.actions);
```

Another deployment of the site (or a local one):

```ts
import { createSwdPlugin } from "solana-agent-kit-plugin-swd";
agent.use(createSwdPlugin({ baseUrl: "http://localhost:3000", timeoutMs: 30_000 }));
```

`SWD_API_BASE` (environment variable) sets the default base URL as well.

## Endpoints it calls

- `GET https://swd-zetaphy.sawasdeecoin.com/api/audit?chain=&address=&lang=`
- `GET https://swd-zetaphy.sawasdeecoin.com/api/audit/tx?chain=&hash=&lang=`
- `POST https://swd-zetaphy.sawasdeecoin.com/api/mcp` (MCP `tools/call`: token info, swap quote, SWD info)

All are rate-limited per IP. Results are automated checks and public market facts, not financial advice.

## MCP instead of the plugin

Any MCP client (Claude, Cursor, ...) can use the same tools directly:

```json
{ "mcpServers": { "swd": { "type": "http", "url": "https://swd-zetaphy.sawasdeecoin.com/api/mcp" } } }
```

## Build and publish (maintainers)

```bash
cd integrations/solana-agent-kit-plugin-swd
npm install
npm run typecheck
npm run build          # dist/ (ESM + CJS + types)
npm publish --access public
```

This folder is not part of the website build (it is excluded in the site's `tsconfig.json`).
