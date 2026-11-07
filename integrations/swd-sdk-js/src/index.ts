// swd-sdk: the public SWD (SAWASDEE COIN) APIs. Use the functions below (they share one default client), or
// createSwdClient({ baseUrl, timeoutMs, fetch }) for another deployment, a custom fetch or a test.
import { createSwdClient, type SwdClient } from "./client";
import type { SwdLang } from "./types";

export * from "./types";
export { createSwdClient, SwdApiError, DEFAULT_BASE_URL, SWD_MINT, SWD_DECIMALS, BUY_MIN_SOL, BUY_MAX_SOL, solAmountString, type SwdClient, type SwdClientOptions } from "./client";
export { verifyAttestation, canonical, keyIdOf, signedMessage, ATTEST_FORMAT, type VerifyOptions, type VerifyResult, type MldsaVerify } from "./attest";

let shared: SwdClient | null = null;
const c = () => (shared ??= createSwdClient());

/** Audit a contract / token (chain: eth, bsc, base, arbitrum, zetaphy, sol, sui, aptos, osmosis, neutron, near, starknet, bitcoin, ton). */
export const audit = (chain: string, address: string, o?: { lang?: SwdLang; full?: boolean }) => c().audit(chain, address, o);
/** Check a transaction (chain: sol, eth, bsc, base, arbitrum, zetaphy). */
export const auditTx = (chain: string, hash: string, o?: { lang?: SwdLang; full?: boolean }) => c().auditTx(chain, hash, o);
/** SWD total and circulating supply (whole SWD, decimal strings). */
export const supply = () => c().supply();
/** An unsigned SOL → SWD transaction from the Buy SWD Solana Action; the buyer's wallet signs it. */
export const buySwdTransaction = (o: Parameters<SwdClient["buySwdTransaction"]>[0]) => c().buySwdTransaction(o);
/** The public attestation keys. */
export const attestationKeys = () => c().attestationKeys();
