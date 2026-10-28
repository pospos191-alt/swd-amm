// Solana side of wallet-safety.js for this page: what a transaction about to be signed does, read from
// the transaction itself (legacy Transaction or VersionedTransaction, @solana/web3.js shapes), so the
// page can show a summary before the wallet does: the programs it calls, the SOL it sends out of the
// connected account (System transfers), and SPL token approvals (an unlimited one is warned about).
// No dependencies; tests/sol-safety.test.mjs checks it.

export const PROGRAMS = {
  '11111111111111111111111111111111': 'System',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'SPL Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'Associated Token',
  ComputeBudget111111111111111111111111111111: 'Compute Budget',
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: 'Metaplex Metadata',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
};
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
/** A token approval at or above this (2^63 base units) counts as unlimited (u64::MAX is the usual one). */
export const SPL_UNLIMITED_MIN = 1n << 63n;

const b58 = (k) => (typeof k === 'string' ? k : typeof k?.toBase58 === 'function' ? k.toBase58() : String(k ?? ''));
const bytes = (d) => (d instanceof Uint8Array ? d : Array.isArray(d) ? Uint8Array.from(d) : new Uint8Array(0));
const u64 = (d, at) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i] ?? 0); return v; };
const u32 = (d, at) => (d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24)) >>> 0;

/** The instructions of a transaction as { programId, data, accounts } (base58 strings, bytes). */
export function instructionsOf(tx) {
  try {
    if (Array.isArray(tx?.instructions)) {
      return tx.instructions.map((ix) => ({ programId: b58(ix.programId), data: bytes(ix.data), accounts: (ix.keys ?? []).map((k) => b58(k.pubkey)) }));
    }
    const m = tx?.message;
    const keys = (m?.staticAccountKeys ?? m?.accountKeys ?? []).map(b58);
    const list = m?.compiledInstructions ?? m?.instructions ?? [];
    return list.map((ix) => ({
      programId: keys[ix.programIdIndex] ?? '?',
      data: bytes(ix.data),
      accounts: (ix.accountKeyIndexes ?? ix.accounts ?? []).map((i) => keys[i] ?? '?'),
    }));
  } catch { return []; }
}

/**
 * What a list of transactions does for `owner` (base58).
 * @returns {{ txs: number, instructions: number, programs: string[], solOut: bigint, approvals: Array<{delegate:string, amount:bigint, unlimited:boolean}> }}
 */
export function solTxInfo(txs, owner, labels = {}) {
  const list = (Array.isArray(txs) ? txs : [txs]).filter(Boolean);
  const names = { ...PROGRAMS, ...labels };
  const programs = [];
  let instructions = 0;
  let solOut = 0n;
  const approvals = [];
  for (const tx of list) {
    for (const ix of instructionsOf(tx)) {
      instructions++;
      const name = names[ix.programId] ? `${names[ix.programId]} (${ix.programId})` : ix.programId;
      if (!programs.includes(name)) programs.push(name);
      const d = ix.data;
      // System Program Transfer: u32 index 2, u64 lamports; account 0 pays
      if (ix.programId === '11111111111111111111111111111111' && d.length >= 12 && u32(d, 0) === 2 && ix.accounts[0] === owner) solOut += u64(d, 4);
      // SPL Token Approve (4) / ApproveChecked (13): u64 amount at 1; accounts: source, delegate, owner
      if (TOKEN_PROGRAMS.has(ix.programId) && d.length >= 9 && (d[0] === 4 || d[0] === 13)) {
        const amount = u64(d, 1);
        approvals.push({ delegate: ix.accounts[1] ?? '?', amount, unlimited: amount >= SPL_UNLIMITED_MIN });
      }
    }
  }
  return { txs: list.length, instructions, programs, solOut, approvals };
}

/**
 * Shows the summary (wallet-safety.js confirmTx) for transactions about to be signed by `owner`.
 * Resolves true to go on to the wallet, false when the user cancels.
 */
export async function confirmSolana(sf, { network, owner, txs, labels }) {
  const info = solTxInfo(txs, owner, labels);
  const short = (a) => (a.length > 16 ? `${a.slice(0, 6)}…${a.slice(-6)}` : a);
  const warnings = info.approvals.map((a) => (a.unlimited
    ? sf.t('cfSplUnlimited', { delegate: short(a.delegate) })
    : sf.t('cfSplApprove', { delegate: short(a.delegate), amount: a.amount.toString() })));
  const r = await sf.confirmTx({
    network, from: owner, to: '', value: info.solOut, decimals: 9, symbol: 'SOL',
    action: sf.t('cfSolAction', { tx: info.txs, ix: info.instructions }),
    details: [[sf.t('cfPrograms'), info.programs.join(', ')]],
    warnings,
  });
  return r != null;
}
