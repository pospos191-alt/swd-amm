// Minimal stand-in for @solana/spl-token, used ONLY by test-ui/tests/smoke.mjs
// (see stubs/web3.js). Imports PublicKey from the SAME URL the page uses for
// web3.js so both share one PublicKey class.
import { PublicKey } from "https://esm.sh/@solana/web3.js@1.95.4";
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MINT_SIZE = 82;
export async function getAssociatedTokenAddress(m,o){return PublicKey.findProgramAddressSync([o.toBytes(),m.toBytes()],ASSOCIATED_TOKEN_PROGRAM_ID)[0];}
export function createAssociatedTokenAccountIdempotentInstruction(){return {};} export function createInitializeMint2Instruction(){return {};} export function createMintToInstruction(){return {};}
export async function getMint(){return {decimals:6,supply:0n};} export async function getAccount(){throw new Error("TokenAccountNotFoundError");} export function unpackMint(){return {decimals:6};}
export function createTransferCheckedInstruction(){return {};} export function createCloseAccountInstruction(){return {};}
