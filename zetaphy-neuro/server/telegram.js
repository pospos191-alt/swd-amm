// The ZETAPHY Telegram bot (api/telegram.js is its webhook). It keeps a list of wallets for the testnet
// airdrop and never holds a key or a coin: the list is exported to the admin, who sends with
// `gov.sh airdrop` on the genesis node (zetaphy-chain/README.md, "Testnet airdrop").
// It answers in English (TELEGRAM_BOT_LANG: another of the 8 codes, or "auto" for each user's language).
//   /start            what ZETAPHY is, buttons to the apps
//   /claim <address>  put a wallet on the list: private chat only, one wallet per Telegram account, one
//                     account per wallet, at most AIRDROP_MAX wallets, and (if TELEGRAM_CHANNEL is set)
//                     only for members of that channel
//   /check <address> [chain]   a link to Neuro's check of that contract
//   admins (TELEGRAM_ADMIN_IDS): /count, /export (the list as airdrop.txt), /announce <text> (to the channel)
// Store: the same as the usage counter (server/store.js; D1 or Upstash), set commands only.
import { createHmac } from 'node:crypto';
import { bech32Decode } from '../src/bech32.js';
import { CHAINS } from '../src/chains.js';
import { BOT, BOT_LANGS, botLang, COMMANDS } from './telegram-i18n.js';

export const APP = 'https://app.sawasdeecoin.com';
export const NEURO = 'https://neuro.sawasdeecoin.com/web/';
const K_ADDRS = 'tg:airdrop:addrs';   // the list: 0x… lowercase
const K_USERS = 'tg:airdrop:users';   // Telegram user ids that have a wallet on it
const RATE = 20;                      // messages a minute per user before the bot stops answering

const fill = (s, o) => s.replace(/\{(\w+)\}/g, (_, k) => String(o[k] ?? ''));
const toHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** A wallet address as the list keeps it (0x…, lowercase), or null. zetaphy1… is decoded (checksum checked). */
export function normalizeAddress(s) {
  const a = String(s ?? '').trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(a)) return a.toLowerCase();
  try {
    const { hrp, bytes } = bech32Decode(a.toLowerCase());
    if (hrp === 'zetaphy' && bytes.length === 20) return `0x${toHex(bytes)}`;
  } catch { /* not bech32 */ }
  return null;
}

/** The secret Telegram sends back on every webhook call (X-Telegram-Bot-Api-Secret-Token), from the token. */
export const webhookSecret = (token) => createHmac('sha256', String(token)).update('zetaphy-telegram-webhook').digest('hex').slice(0, 48);

/** Settings from the environment. */
export function botConfig(env = process.env) {
  const ch = String(env.TELEGRAM_CHANNEL ?? '').trim();
  return {
    token: env.TELEGRAM_BOT_TOKEN || '',
    admins: new Set(String(env.TELEGRAM_ADMIN_IDS ?? '').split(/[,\s]+/).filter((x) => /^\d+$/.test(x))),
    channel: /^@[A-Za-z0-9_]{5,32}$/.test(ch) ? ch : '',
    max: Math.max(1, Number.parseInt(env.AIRDROP_MAX ?? '10000', 10) || 10000),
    amount: Math.max(1, Number.parseInt(env.AIRDROP_AMOUNT ?? '100', 10) || 100),
    // ZETAPHY Early (ZEARLY, zetaphy-chain/rewards/EARLY.md): the per-wallet amount and the token, once deployed
    early: Math.max(0, Number.parseInt(env.AIRDROP_EARLY ?? '0', 10) || 0),
    earlyToken: /^0x[0-9a-fA-F]{40}$/.test(env.EARLY_TOKEN ?? '') ? env.EARLY_TOKEN : '',
    // the bot's language: English for everyone by default; "auto" follows each user's Telegram language
    lang: String(env.TELEGRAM_BOT_LANG ?? 'en').trim().toLowerCase() === 'auto' ? 'auto' : botLang(env.TELEGRAM_BOT_LANG ?? 'en'),
  };
}

/** Telegram Bot API client: api(method, params) -> result, or throws. */
export function telegramApi(token, fetchImpl = globalThis.fetch) {
  const base = `https://api.telegram.org/bot${token}/`;
  const api = async (method, params = {}) => {
    const res = await fetchImpl(base + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
    const out = await res.json().catch(() => ({}));
    if (!out.ok) throw new Error(`telegram ${method}: ${out.description ?? res.status}`);
    return out.result;
  };
  /** A text file as a document (the airdrop list). */
  api.sendFile = async (chatId, name, text, caption) => {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', caption);
    form.append('document', new Blob([text], { type: 'text/plain' }), name);
    const res = await fetchImpl(`${base}sendDocument`, { method: 'POST', body: form });
    const out = await res.json().catch(() => ({}));
    if (!out.ok) throw new Error(`telegram sendDocument: ${out.description ?? res.status}`);
    return out.result;
  };
  return api;
}

/** One update from Telegram. Answers through `api`; returns what it did (for tests and logs). */
export async function handleUpdate(update, { api, store, cfg, me = 'awasdeebot' }) {
  const m = update?.message;
  if (!m || typeof m.text !== 'string' || !m.from || m.from.is_bot) return 'ignored';
  const lang = (cfg.lang ?? 'auto') === 'auto' ? botLang(m.from.language_code) : cfg.lang;
  const L = BOT[lang];
  const chat = m.chat.id;
  const say = (text, extra = {}) => api('sendMessage', { chat_id: chat, text, disable_web_page_preview: true, ...extra });
  const [head, ...args] = m.text.trim().split(/\s+/);
  const cmd = head.toLowerCase().replace(/@[a-z0-9_]+$/, '');
  if (!cmd.startsWith('/')) return 'ignored';
  const admin = cfg.admins.has(String(m.from.id));

  if (store && !admin) {
    const [n] = await store.pipeline([['INCR', `tg:rl:${m.from.id}`], ['EXPIRE', `tg:rl:${m.from.id}`, 60]]);
    if (Number(n) > RATE) return 'rate-limited';
  }

  switch (cmd) {
    case '/start':
    case '/help':
      await say(fill(L.start, { amount: cfg.amount }), { reply_markup: { inline_keyboard: [
        [{ text: L.open, url: APP }, { text: L.neuro, url: NEURO }],
        [{ text: L.about, url: `${APP}/about/${lang === 'en' ? '' : `${lang}.html`}` }],
      ] } });
      return 'start';

    case '/claim': {
      if (m.chat.type !== 'private') { await say(fill(L.private, { link: `https://t.me/${me}?start=claim` })); return 'claim-private'; }
      if (!args.length) { await say(L.claimHow); return 'claim-how'; }
      const a = normalizeAddress(args[0]);
      if (!a) { await say(L.badAddr); return 'claim-bad'; }
      if (!store) { await say(L.noStore); return 'claim-nostore'; }
      if (cfg.channel) {
        let member = false;
        try { member = ['creator', 'administrator', 'member'].includes((await api('getChatMember', { chat_id: cfg.channel, user_id: m.from.id })).status); } catch { /* not a member, or the bot is not in the channel */ }
        if (!member) { await say(fill(L.needJoin, { ch: cfg.channel })); return 'claim-join'; }
      }
      const [count] = await store.pipeline([['SCARD', K_ADDRS]]);
      if (Number(count) >= cfg.max) { await say(fill(L.closed, { max: cfg.max })); return 'claim-closed'; }
      const [newUser] = await store.pipeline([['SADD', K_USERS, String(m.from.id)]]);
      if (!Number(newUser)) { await say(L.already); return 'claim-already'; }
      const [newAddr] = await store.pipeline([['SADD', K_ADDRS, a]]);
      if (!Number(newAddr)) { await store.pipeline([['SREM', K_USERS, String(m.from.id)]]); await say(L.taken); return 'claim-taken'; }
      await say(fill(L.claimOk, { a, amount: cfg.amount }) + (cfg.early && cfg.earlyToken ? `\n\n${fill(L.early, { early: cfg.early.toLocaleString('en-US'), token: cfg.earlyToken })}` : ''));
      return 'claim-ok';
    }

    case '/check': {
      const chains = Object.keys(CHAINS).join(', ');
      if (!args.length) { await say(fill(L.checkHow, { chains })); return 'check-how'; }
      const addr = args[0].slice(0, 120);
      const chain = Object.hasOwn(CHAINS, args[1] ?? '') ? args[1] : /^0x[0-9a-fA-F]{40}$/.test(addr) ? 'bsc' : null;
      if (!chain || !/^[\w:.•-]+$/u.test(addr)) { await say(fill(L.checkHow, { chains })); return 'check-how'; }
      await say(fill(L.check, { chain, url: `${NEURO}?chain=${chain}&address=${encodeURIComponent(addr)}` }));
      return 'check';
    }

    case '/count':
      if (!admin) return 'ignored';
      if (!store) { await say(L.noStore); return 'count-nostore'; }
      await say(fill(L.count, { n: (await store.pipeline([['SCARD', K_ADDRS]]))[0], max: cfg.max }));
      return 'count';

    case '/export': {
      if (!admin) return 'ignored';
      if (!store) { await say(L.noStore); return 'export-nostore'; }
      const [list] = await store.pipeline([['SMEMBERS', K_ADDRS]]);
      const text = `# ZETAPHY testnet airdrop list (${list.length} wallets), for: gov.sh airdrop airdrop.txt ${cfg.amount}\n${list.join('\n')}\n`;
      await api.sendFile(chat, 'airdrop.txt', text, fill(L.exported, { n: list.length, amount: cfg.amount }));
      return 'export';
    }

    case '/announce': {
      if (!admin) return 'ignored';
      if (!cfg.channel) { await say(L.noChannel); return 'announce-nochannel'; }
      const text = m.text.trim().slice(head.length).trim();
      if (!text) return 'ignored';
      await api('sendMessage', { chat_id: cfg.channel, text, disable_web_page_preview: false });
      await say(fill(L.posted, { ch: cfg.channel }));
      return 'announce';
    }

    default:
      return 'ignored';
  }
}

/**
 * Point Telegram at this webhook and set the command menu: in the bot's one language for everyone (the menus
 * per language are removed), or with lang "auto" in every language.
 */
export async function setupBot(api, url, token, lang = 'en') {
  await api('setWebhook', { url, secret_token: webhookSecret(token), allowed_updates: ['message'], drop_pending_updates: true });
  const menu = (l) => COMMANDS[l].map(([command, description]) => ({ command, description }));
  if (lang === 'auto') {
    for (const l of BOT_LANGS) await api('setMyCommands', { commands: menu(l), ...(l === 'en' ? {} : { language_code: l }) });
  } else {
    await api('setMyCommands', { commands: menu(lang) });
    for (const l of BOT_LANGS) if (l !== 'en') await api('deleteMyCommands', { language_code: l });
  }
  const me = await api('getMe');
  return { ok: true, bot: me?.username ?? null, url };
}
