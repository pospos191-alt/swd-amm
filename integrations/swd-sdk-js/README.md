# swd-sdk

A small TypeScript client for the public **SWD (SAWASDEE COIN)** APIs at
`https://swd-zetaphy.sawasdeecoin.com`. No runtime dependencies, no API key, ESM + CommonJS + types, Node 18+ and
browsers.

ภาษาไทย: [README.th.md](README.th.md)

| Function | Endpoint | What it does |
| --- | --- | --- |
| `audit(chain, address, { lang?, full? })` | `GET /api/audit` | Automated audit of a contract / token on 14 chains: `level`, findings, verdict ID, attestation, permalink, badge |
| `auditTx(chain, hash, { lang?, full? })` | `GET /api/audit/tx` | What a transaction moved and known scam patterns (sol, eth, bsc, base, arbitrum, zetaphy) |
| `supply()` | `GET /api/supply/total`, `/api/supply/circulating` | SWD total and circulating supply (whole SWD, decimal strings) |
| `buySwdTransaction({ account, amountSol, slippageBps?, lang? })` | `POST /api/actions/buy-swd` | An **unsigned** SOL → SWD transaction from the Buy SWD Solana Action, for the buyer's wallet to sign |
| `attestationKeys()` | `GET /api/audit/attest/keys` | The public keys that sign audit attestations |
| `verifyAttestation(att, { keys?, mldsaVerify? })` | (offline) | Checks an attestation's hashes, key ids and Ed25519 signature; ML-DSA-44 only with a verifier you pass in |
| client: `auditInfo()`, `badgeUrl()`, `permalink()`, `buySwdAction()`, `tokenInfo()`, `swapQuote()`, `info()` | | chains/langs, links, the Action card, MCP tools |

Chains for `audit`: `eth bsc base arbitrum zetaphy sol sui aptos osmosis neutron near starknet bitcoin ton`.
Languages: `th en zh ja ko vi es ru`.

## Install

```bash
npm install swd-sdk
```

## Use

```ts
import { audit, auditTx, supply, SWD_MINT } from "swd-sdk";

const a = await audit("sol", SWD_MINT, { lang: "en" });
console.log(a.level, a.title, a.permalink); // "low" | "medium" | "high" | "info"
for (const f of a.lines) console.log(f.severity, f.text);

const t = await auditTx("sol", "<signature>");
console.log(t.found, t.overall);

console.log(await supply()); // { total: "…", circulating: "…" }
```

Another deployment, a custom `fetch`, or a shorter timeout:

```ts
import { createSwdClient } from "swd-sdk";
const swd = createSwdClient({ baseUrl: "http://localhost:3000", timeoutMs: 20_000 });
```

`SWD_API_BASE` (environment variable) also sets the default base URL in Node.

### Buy SWD (Solana Actions)

```ts
import { buySwdTransaction } from "swd-sdk";
import { VersionedTransaction } from "@solana/web3.js";

const { bytes, message } = await buySwdTransaction({ account: wallet.publicKey.toBase58(), amountSol: 0.1 });
const tx = VersionedTransaction.deserialize(bytes);
// show `message` to the user, then let THEIR wallet sign and send:
await wallet.sendTransaction(tx, connection);
```

The SDK never sees a private key and never signs. Limits: 0.001–50 SOL, slippage 10–300 bps (default 50). The
site's fee is included in the transaction (the Action's description states it).

### Verify an attestation

```ts
import { audit, attestationKeys, verifyAttestation } from "swd-sdk";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa"; // optional, for the post-quantum half

const a = await audit("sol", mint);
const r = await verifyAttestation(a.attestation, {
  keys: await attestationKeys(),
  mldsaVerify: (pk, msg, sig) => ml_dsa44.verify(pk, msg, sig),
});
console.log(r.ok, r.trusted, r.problems);
```

Without `mldsaVerify` the result has `complete: false` and `ok: false`: an attestation is valid only when **both**
the ML-DSA-44 and the Ed25519 signatures verify. This function is a port of the site's `verifyAttestation`
(`lib/audit/attest-core.ts`); the site's `scripts/verify-attestation.mjs` remains the reference verifier.

## Errors

Every failure is an `SwdApiError` with `code` (the API's own: `bad_chain`, `bad_address`, `bad_hash`,
`read_failed`, or `http_error`, `bad_input`, `bad_response`, `rpc_error`, `tool_error`) and `status`.
The API rate-limits per IP (HTTP 429).

Results are automated, rule-based checks, not financial advice and not a guarantee. `info` means the rules found
nothing, never "safe".

## Develop / publish (maintainers)

```bash
cd integrations/swd-sdk-js
npm install
npm test            # vitest, offline (mocked fetch)
npm run typecheck
npm run build       # dist/: ESM + CJS + .d.ts
npm publish         # needs an npm account; the name "swd-sdk" was free on 2026-11-07
```
