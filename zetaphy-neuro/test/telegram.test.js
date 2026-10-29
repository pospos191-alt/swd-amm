// The Telegram bot (server/telegram.js, api/telegram.js): the airdrop list rules, the languages, the admin
// commands, the webhook secret, and the set commands on the real D1 SQL (node:sqlite) and in memory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../server/usage.js';
import { d1Store } from '../server/d1store.js';
import { bech32Encode } from '../src/bech32.js';
import { BOT, BOT_LANGS, COMMANDS, botLang } from '../server/telegram-i18n.js';
import { botConfig, handleUpdate, normalizeAddress, setupBot, webhookSecret } from '../server/telegram.js';

const A = '0x' + 'ab'.repeat(20);
const B = '0x' + '12'.repeat(20);
const fakeApi = ({ member = 'member' } = {}) => {
  const calls = [];
  const api = async (method, params) => {
    calls.push([method, params]);
    if (method === 'getChatMember') return { status: member };
    if (method === 'getMe') return { username: 'awasdeebot' };
    return true;
  };
  api.sendFile = async (chat, name, text, caption) => { calls.push(['sendFile', { chat, name, text, caption }]); };
  return { api, calls, texts: () => calls.filter(([m]) => m === 'sendMessage').map(([, p]) => p.text) };
};
const msg = (text, { id = 1, lang = 'en', type = 'private', bot = false } = {}) =>
  ({ message: { text, from: { id, is_bot: bot, language_code: lang }, chat: { id: id * 10, type } } });

test('addresses: 0x… any case, zetaphy1… with a good checksum, nothing else', () => {
  assert.equal(normalizeAddress(A.toUpperCase().replace('0X', '0x')), A);
  const bytes = Uint8Array.from({ length: 20 }, () => 0xab);
  assert.equal(normalizeAddress(bech32Encode('zetaphy', bytes)), A);
  assert.equal(normalizeAddress(bech32Encode('cosmos', bytes)), null, 'another chain\'s prefix');
  const good = bech32Encode('zetaphy', bytes);
  assert.equal(normalizeAddress(good.slice(0, -1) + (good.at(-1) === 'q' ? 'p' : 'q')), null, 'bad checksum');
  for (const x of ['', '0x123', 'hello', `${A}00`, null]) assert.equal(normalizeAddress(x), null, String(x));
});

test('/claim: one wallet per account and one account per wallet, then the list is full', async () => {
  const store = memoryStore();
  const cfg = botConfig({ AIRDROP_MAX: '2', AIRDROP_AMOUNT: '100' });
  const t = fakeApi();
  const go = (text, o) => handleUpdate(msg(text, o), { api: t.api, store, cfg });
  assert.equal(await go(`/claim ${A}`, { id: 1 }), 'claim-ok');
  assert.match(t.texts().at(-1), new RegExp(`Registered: ${A}[\\s\\S]*100 test ZETAPHY`));
  assert.equal(await go(`/claim ${B}`, { id: 1 }), 'claim-already');
  assert.equal(await go(`/claim ${A.toUpperCase().replace('0X', '0x')}`, { id: 2 }), 'claim-taken');
  assert.equal(await go(`/claim ${B}`, { id: 2 }), 'claim-ok', 'the refused try did not keep user 2');
  assert.equal(await go(`/claim 0x${'cd'.repeat(20)}`, { id: 3 }), 'claim-closed');
  assert.match(t.texts().at(-1), /full \(2 wallets\)/);
  assert.deepEqual((await store.pipeline([['SMEMBERS', 'tg:airdrop:addrs']]))[0], [B, A].sort());
  assert.equal(await go('/claim nope', { id: 4 }), 'claim-bad');
  assert.equal(await go('/claim', { id: 4 }), 'claim-how');
});

test('/claim only in a private chat, only for channel members when a channel is set, never for bots', async () => {
  const store = memoryStore();
  const t = fakeApi({ member: 'left' });
  const cfg = botConfig({ TELEGRAM_CHANNEL: '@zetaphy_official' });
  assert.equal(await handleUpdate(msg(`/claim@awasdeebot ${A}`, { type: 'supergroup' }), { api: t.api, store, cfg }), 'claim-private');
  assert.match(t.texts().at(-1), /t\.me\/awasdeebot\?start=claim/);
  assert.equal(await handleUpdate(msg(`/claim ${A}`), { api: t.api, store, cfg }), 'claim-join');
  assert.match(t.texts().at(-1), /Join @zetaphy_official first/);
  assert.equal(await handleUpdate(msg(`/claim ${A}`, { bot: true }), { api: t.api, store, cfg }), 'ignored');
  const ok = fakeApi({ member: 'member' });
  assert.equal(await handleUpdate(msg(`/claim ${A}`), { api: ok.api, store, cfg }), 'claim-ok');
  assert.equal(await handleUpdate(msg(`/claim ${A}`), { api: t.api, store: null, cfg: botConfig({}) }), 'claim-nostore');
});

test('/start in the user\'s language with buttons; /check links to Neuro; unknown text is ignored', async () => {
  const t = fakeApi();
  const cfg = botConfig({});
  await handleUpdate(msg('/start', { lang: 'th' }), { api: t.api, store: memoryStore(), cfg });
  const [, p] = t.calls.find(([m]) => m === 'sendMessage');
  assert.equal(p.text, BOT.th.start.replace('{amount}', '100'));
  assert.deepEqual(p.reply_markup.inline_keyboard.flat().map((b) => b.url), ['https://app.sawasdeecoin.com', 'https://neuro.sawasdeecoin.com/web/', 'https://app.sawasdeecoin.com/about/th.html']);
  assert.equal(await handleUpdate(msg(`/check ${A}`), { api: t.api, store: memoryStore(), cfg }), 'check');
  assert.match(t.texts().at(-1), new RegExp(`\\?chain=bsc&address=${A}`));
  assert.equal(await handleUpdate(msg(`/check ${A} base`), { api: t.api, store: memoryStore(), cfg }), 'check');
  assert.match(t.texts().at(-1), /chain=base/);
  assert.equal(await handleUpdate(msg('hello'), { api: t.api, store: memoryStore(), cfg }), 'ignored');
  assert.equal(await handleUpdate({}, { api: t.api, store: memoryStore(), cfg }), 'ignored');
});

test('admin commands: only for TELEGRAM_ADMIN_IDS; /export sends airdrop.txt for gov.sh airdrop', async () => {
  const store = memoryStore();
  const cfg = botConfig({ TELEGRAM_ADMIN_IDS: '42, 43', TELEGRAM_CHANNEL: '@zetaphy_official' });
  const t = fakeApi();
  await handleUpdate(msg(`/claim ${A}`, { id: 7 }), { api: t.api, store, cfg });
  assert.equal(await handleUpdate(msg('/export', { id: 7 }), { api: t.api, store, cfg }), 'ignored');
  assert.equal(await handleUpdate(msg('/count', { id: 42 }), { api: t.api, store, cfg }), 'count');
  assert.match(t.texts().at(-1), /1 wallets registered/);
  assert.equal(await handleUpdate(msg('/export', { id: 43 }), { api: t.api, store, cfg }), 'export');
  const [, f] = t.calls.find(([m]) => m === 'sendFile');
  assert.equal(f.name, 'airdrop.txt');
  assert.deepEqual(f.text.split('\n').filter((l) => l && !l.startsWith('#')), [A]);
  assert.equal(await handleUpdate(msg('/announce Testnet opens on 1 November', { id: 42 }), { api: t.api, store, cfg }), 'announce');
  assert.ok(t.calls.some(([m, p]) => m === 'sendMessage' && p.chat_id === '@zetaphy_official' && p.text === 'Testnet opens on 1 November'));
});

test('too many messages from one user: the bot stops answering for a minute', async () => {
  const store = memoryStore();
  const t = fakeApi();
  const cfg = botConfig({});
  let last;
  for (let i = 0; i < 22; i++) last = await handleUpdate(msg('/start', { id: 9 }), { api: t.api, store, cfg });
  assert.equal(last, 'rate-limited');
});

test('every language has every message; Telegram language codes map to them', () => {
  for (const l of BOT_LANGS) {
    assert.deepEqual(Object.keys(BOT[l]).sort(), Object.keys(BOT.en).sort(), l);
    for (const [k, v] of Object.entries(BOT[l])) {
      const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort();
      assert.deepEqual(ph(v), ph(BOT.en[k]), `${l}.${k} placeholders`);
    }
    assert.ok(/seed|semilla|24|助记词|시드|シード|сид|khôi phục/i.test(BOT[l].start), `${l}: never asks for a seed`);
    assert.equal(COMMANDS[l].length, 3);
  }
  assert.equal(botLang('zh-hans'), 'zh');
  assert.equal(botLang('pt-br'), 'en');
  assert.equal(botLang(undefined), 'en');
});

test('setup: webhook with the secret derived from the token, commands in every language', async () => {
  const t = fakeApi();
  const out = await setupBot(t.api, 'https://neuro.sawasdeecoin.com/api/telegram', 'TOKEN');
  assert.equal(out.bot, 'awasdeebot');
  const [, w] = t.calls.find(([m]) => m === 'setWebhook');
  assert.equal(w.secret_token, webhookSecret('TOKEN'));
  assert.match(w.secret_token, /^[0-9a-f]{48}$/);
  assert.notEqual(webhookSecret('TOKEN'), webhookSecret('OTHER'));
  assert.equal(t.calls.filter(([m]) => m === 'setMyCommands').length, BOT_LANGS.length);
});

test('set commands on the real D1 SQL (node:sqlite) and in memory', async () => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return; }
  const db = new DatabaseSync(':memory:');
  const fetchImpl = async (url, init) => {
    const { batch } = JSON.parse(init.body);
    const result = batch.map(({ sql, params = [] }) => {
      const st = db.prepare(sql);
      if (/^\s*select|returning/i.test(sql)) return { success: true, results: st.all(...params), meta: {} };
      return { success: true, results: [], meta: { changes: Number(st.run(...params).changes) } };
    });
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  for (const s of [d1Store('a'.repeat(32), '12345678-1234-1234-1234-123456789abc', 't', { fetchImpl, random: () => 0.5 }), memoryStore()]) {
    assert.deepEqual(await s.pipeline([['SADD', 'k', 'b'], ['SADD', 'k', 'a'], ['SADD', 'k', 'a'], ['SCARD', 'k']]), [1, 1, 0, 2]);
    assert.deepEqual(await s.pipeline([['SMEMBERS', 'k'], ['SREM', 'k', 'b'], ['SREM', 'k', 'b'], ['SMEMBERS', 'k']]), [['a', 'b'], 1, 0, ['a']]);
  }
});
