// Devnet-only SOL faucet, backed by a project-owned reserve wallet.
//
// This does NOT mint new SOL — Solana's devnet SOL can only be issued by the
// cluster's own faucet (the `requestAirdrop` RPC method, i.e. `solana airdrop`).
// This endpoint simply redistributes SOL that was airdropped into a reserve
// wallet ahead of time, so visitors don't have to fight the public faucet's
// rate limits themselves.
//
// Required environment variables (set in the Vercel project, "Secret" type
// for the key — never commit real values, never paste them into chat):
//   DEVNET_FAUCET_SECRET_KEY  JSON array of the reserve wallet's secret key
//                             (the same format solana-keygen writes to a
//                             keypair file, e.g. "[12,34,...]")
//   DEVNET_RPC_URL            Devnet RPC endpoint (defaults to the public
//                             cluster if unset, which is rate-limited)
//
// Requires a connected Vercel KV store on this project for rate limiting.

const {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const { kv } = require("@vercel/kv");

const DEVNET_RPC_URL = process.env.DEVNET_RPC_URL || "https://api.devnet.solana.com";
// Kept deliberately small: the reserve wallet starts with well under 1 SOL
// (public/CLI devnet faucets are rate-limited, so it's funded a little at a
// time). Bump these up later once the reserve has more in it — just send
// more devnet SOL to the reserve pubkey, no redeploy needed for that part.
const FAUCET_AMOUNT_SOL = 0.15;
const WALLET_COOLDOWN_SECONDS = 24 * 60 * 60; // 1 request per wallet per day
const IP_COOLDOWN_SECONDS = 60 * 60; // 1 request per IP per hour
const MIN_RESERVE_BALANCE_SOL = 0.05; // stop dispensing before the reserve hits zero

function getReserveKeypair() {
  const raw = process.env.DEVNET_FAUCET_SECRET_KEY;
  if (!raw) throw new Error("DEVNET_FAUCET_SECRET_KEY is not configured");
  const parsed = JSON.parse(raw);
  return Keypair.fromSecretKey(Uint8Array.from(parsed));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (req.method === "GET" && req.query?.diag === "1") {
    try {
      const connection = new Connection(DEVNET_RPC_URL, "confirmed");
      const genesisHash = await connection.getGenesisHash();
      const reserve = getReserveKeypair();
      const balance = await connection.getBalance(reserve.publicKey);
      res.status(200).json({
        genesisHash,
        reservePubkey: reserve.publicKey.toBase58(),
        balanceSol: balance / 1e9,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const address = body?.address;
  if (!address || typeof address !== "string") {
    res.status(400).json({ error: "Missing address" });
    return;
  }

  let recipient;
  try {
    recipient = new PublicKey(address);
  } catch {
    res.status(400).json({ error: "Invalid Solana address" });
    return;
  }

  const ip = clientIp(req);
  const walletKey = `devnet-faucet:wallet:${recipient.toBase58()}`;
  const ipKey = `devnet-faucet:ip:${ip}`;

  // Reserve both locks up front so two concurrent requests can't both pass
  // the check-then-act race; release them again on any failure path below
  // so a transient error doesn't lock a legitimate user out for a full day.
  const walletLocked = await kv.set(walletKey, "1", { nx: true, ex: WALLET_COOLDOWN_SECONDS });
  if (!walletLocked) {
    res.status(429).json({ error: "This wallet already requested devnet SOL recently. Please try again later." });
    return;
  }

  const ipLocked = await kv.set(ipKey, "1", { nx: true, ex: IP_COOLDOWN_SECONDS });
  if (!ipLocked) {
    await kv.del(walletKey);
    res.status(429).json({ error: "Too many requests from this network. Please try again later." });
    return;
  }

  try {
    const connection = new Connection(DEVNET_RPC_URL, "confirmed");
    const reserve = getReserveKeypair();
    const amountLamports = Math.round(FAUCET_AMOUNT_SOL * LAMPORTS_PER_SOL);

    const reserveBalance = await connection.getBalance(reserve.publicKey);
    if (reserveBalance < amountLamports + MIN_RESERVE_BALANCE_SOL * LAMPORTS_PER_SOL) {
      await kv.del(walletKey);
      await kv.del(ipKey);
      res.status(503).json({ error: "Faucet reserve is low right now. Please try the public Solana faucet instead." });
      return;
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: reserve.publicKey,
        toPubkey: recipient,
        lamports: amountLamports,
      })
    );

    const signature = await sendAndConfirmTransaction(connection, tx, [reserve], { commitment: "confirmed" });

    res.status(200).json({ signature, amountSol: FAUCET_AMOUNT_SOL });
  } catch (err) {
    // Release both locks — the request never actually disbursed anything.
    await kv.del(walletKey);
    await kv.del(ipKey);
    console.error("devnet-faucet error:", err);
    res.status(500).json({ error: "Internal faucet error, please try again" });
  }
};
