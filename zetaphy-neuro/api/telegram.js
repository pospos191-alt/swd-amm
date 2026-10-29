// Vercel serverless function: the Telegram bot's webhook (server/telegram.js).
// Needs, in the Vercel project settings:
//   - TELEGRAM_BOT_TOKEN (Sensitive): the token @BotFather gave for the bot;
//   - a store (server/store.js: Cloudflare D1 or Upstash), for the airdrop list;
//   - optional: TELEGRAM_ADMIN_IDS (numeric Telegram user ids, comma separated: /count /export /announce),
//     TELEGRAM_CHANNEL (@name: /announce posts there, and /claim needs membership),
//     TELEGRAM_BOT_USERNAME (default awasdeebot), AIRDROP_MAX (10000), AIRDROP_AMOUNT (100).
// After a deploy, open https://neuro.sawasdeecoin.com/api/telegram?setup=1 once: it points Telegram at
// this function (with a secret derived from the token, checked on every call) and sets the command menu.
import { timingSafeEqual } from 'node:crypto';
import { storeFromEnv } from '../server/store.js';
import { botConfig, handleUpdate, setupBot, telegramApi, webhookSecret } from '../server/telegram.js';

const store = storeFromEnv(process.env);
const HOSTS = new Set(['neuro.sawasdeecoin.com', 'swd-amm-zetaphy-neuro.vercel.app']);

const same = (a, b) => {
  const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
};

export default async function handler(req, res) {
  const cfg = botConfig(process.env);
  if (!cfg.token) { res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN is not set' }); return; }
  const api = telegramApi(cfg.token);

  if (req.method === 'GET') {
    if (req.query?.setup !== '1') { res.status(200).json({ bot: true, store: Boolean(store), channel: cfg.channel || null }); return; }
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!HOSTS.has(host)) { res.status(400).json({ error: 'unknown host' }); return; }
    try { res.status(200).json(await setupBot(api, `https://${host}/api/telegram`, cfg.token)); }
    catch (e) { res.status(502).json({ error: String(e.message ?? e).replace(cfg.token, '…') }); }
    return;
  }

  if (req.method !== 'POST') { res.setHeader('allow', 'GET, POST'); res.status(405).end(); return; }
  if (!same(req.headers['x-telegram-bot-api-secret-token'], webhookSecret(cfg.token))) { res.status(401).end(); return; }
  const update = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  try {
    await handleUpdate(update, { api, store, cfg, me: process.env.TELEGRAM_BOT_USERNAME || 'awasdeebot' });
  } catch (e) {
    console.error('telegram:', String(e.message ?? e).replace(cfg.token, '…'));
  }
  // always 200: Telegram would resend a failed update again and again
  res.status(200).json({ ok: true });
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
