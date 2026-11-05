// SWD plugin for Solana Agent Kit v2:  agent.use(SwdPlugin)  then  agent.methods.swdAuditContract(agent, "sol", mint)
// or let the agent pick the actions (SWD_AUDIT_CONTRACT, SWD_CHECK_TRANSACTION, SWD_TOKEN_INFO, SWD_SWAP_QUOTE, SWD_INFO).
import type { Plugin, SolanaAgentKit } from "solana-agent-kit";
import { SWD_ACTIONS, setSwdClient } from "./actions";
import { createSwdClient, type SwdClientOptions, type SwdLang } from "./client";

export * from "./client";
export * from "./actions";

export function createSwdPlugin(opts: SwdClientOptions = {}) {
  const client = createSwdClient(opts);
  return {
    name: "swd",
    methods: {
      swdAuditContract: (_agent: SolanaAgentKit, chain: string, address: string, lang?: SwdLang) => client.auditContract(chain, address, lang),
      swdCheckTransaction: (_agent: SolanaAgentKit, chain: string, hash: string, lang?: SwdLang) => client.checkTransaction(chain, hash, lang),
      swdTokenInfo: (_agent: SolanaAgentKit, chain: string, address: string, lang?: SwdLang) => client.tokenInfo(chain, address, lang),
      swdSwapQuote: (_agent: SolanaAgentKit, inputMint: string, outputMint: string, amount: string, slippageBps?: number) =>
        client.swapQuote(inputMint, outputMint, amount, slippageBps),
      swdInfo: (_agent: SolanaAgentKit) => client.info(),
    },
    actions: SWD_ACTIONS,
    initialize(_agent: SolanaAgentKit): void {
      setSwdClient(client);
    },
  } satisfies Plugin;
}

const SwdPlugin = createSwdPlugin();
export default SwdPlugin;
