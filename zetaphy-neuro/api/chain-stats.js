// Vercel serverless function: GET /api/chain-stats
// ZETAPHY chain activity (server/chainstats.js): transactions by kind, this
// month and since genesis, for the Neuro page and the explorer (any origin may
// read it: public chain data). Uses the counter's store (server/store.js);
// without one it answers { enabled: false }. Refreshed by a daily Vercel cron
// (vercel.json) or the first view after 6 hours.
// Optional: NEURO_ZETAPHY_COMET, the node's CometBFT RPC (default below).
import { handleChainStats, cometClient } from '../server/chainstats.js';
import { storeFromEnv } from '../server/store.js';

const store = storeFromEnv(process.env);
const url = process.env.NEURO_ZETAPHY_COMET || 'https://rpc.sawasdeecoin.com/rpc/';
const comet = /^https:\/\/[^\s]+$/.test(url) ? cometClient(url) : null;

export default async function handler(req, res) {
  try {
    const out = await handleChainStats({ method: req.method }, store, comet);
    for (const [k, v] of Object.entries(out.headers ?? {})) res.setHeader(k, v);
    res.status(out.status).json(out.json ?? {});
  } catch {
    res.setHeader('access-control-allow-origin', '*');
    res.status(503).json({ error: 'unavailable' });
  }
}
