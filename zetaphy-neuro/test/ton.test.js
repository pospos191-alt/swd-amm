// TON reader tests. Responses follow the tonapi.io v2 schema
// (@ton-api/client: Account {status, interfaces, get_methods, is_scam,
// is_wallet}, JettonInfo {mintable, total_supply, admin, metadata,
// verification, holders_count}).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readContract } from '../src/reader.js';
import { createTonApi } from '../src/rpc.js';
import { parseTonAddress, isTonAddress } from '../src/ton.js';
import { isChainAddress } from '../src/chains.js';
import { explain } from '../src/explain.js';

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
const OTHER_RAW = `0:${'ab'.repeat(32)}`;
const ADMIN = `0:${'cd'.repeat(32)}`;
const ids = (r) => r.analysis.findings.map((f) => f.id);
const find = (r, id) => r.analysis.findings.find((f) => f.id === id);

/** Builds a friendly address (flags, workchain, hash, CRC16) like the TON SDKs do. */
function friendly(raw, { bounceable = true, testnet = false } = {}) {
  const [wc, h] = raw.split(':');
  const b = Buffer.alloc(36);
  b[0] = (bounceable ? 0x11 : 0x51) | (testnet ? 0x80 : 0);
  b[1] = Number(wc) & 0xff;
  Buffer.from(h, 'hex').copy(b, 2);
  let crc = 0;
  for (const x of b.subarray(0, 34)) {
    crc ^= x << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  b.writeUInt16BE(crc, 34);
  return b.toString('base64url');
}

function fakeTon(accounts, jettons) {
  const paths = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      const m = path.match(/^\/v2\/(accounts|jettons)\/(.+)$/);
      const key = decodeURIComponent(m[2]);
      return (m[1] === 'accounts' ? accounts : jettons)[key] ?? null;
    },
  };
}

const master = { status: 'active', interfaces: ['jetton_master'], get_methods: ['get_jetton_data'], is_wallet: false, is_scam: false };
const jetton = (over = {}) => ({
  mintable: true, total_supply: '1000000000000000', holders_count: 1234, verification: 'none', preview: '',
  admin: { address: ADMIN, is_scam: false, is_wallet: true },
  metadata: { address: OTHER_RAW, name: 'Doge Ton', symbol: 'DOGET', decimals: '9' }, ...over,
});

test('addresses: raw and friendly forms, checksum and testnet are enforced', () => {
  assert.equal(parseTonAddress(USDT).raw, USDT_RAW);
  assert.equal(parseTonAddress(USDT_RAW.toUpperCase().replace('0X', '0x')).raw, USDT_RAW);
  assert.equal(parseTonAddress(friendly(OTHER_RAW, { bounceable: false })).raw, OTHER_RAW, 'UQ… form');
  assert.equal(parseTonAddress(friendly(`-1:${'11'.repeat(32)}`)).raw, `-1:${'11'.repeat(32)}`);
  const typo = USDT.slice(0, 10) + (USDT[10] === 'A' ? 'B' : 'A') + USDT.slice(11);
  assert.throws(() => parseTonAddress(typo), /invalid address/, 'CRC16 catches a typo');
  assert.ok(!isTonAddress(friendly(OTHER_RAW, { testnet: true })), 'testnet addresses are refused');
  assert.ok(isChainAddress('ton', USDT));
  assert.ok(!isChainAddress('ton', '0x' + 'ab'.repeat(20)));
});

test('a mintable jetton with an active admin is high risk', async () => {
  const addr = friendly(OTHER_RAW);
  const api = fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton() });
  const r = await readContract('ton', addr, { api });
  assert.equal(r.analysis.level, 'high');
  assert.equal(r.raw, OTHER_RAW);
  assert.equal(find(r, 'ton-mintable').params.admin, ADMIN);
  assert.ok(ids(r).includes('ton-admin'));
  assert.match(explain(r, 'th').lines[0].text, /Doge Ton.*DOGET.*1,000,000.*1,234/);
  assert.ok(api.paths.every((p) => p.startsWith('/v2/')), 'GET only, tonapi v2');
});

test('dropped admin is good; scam marks are high', async () => {
  const ok = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton({ admin: undefined, mintable: false, verification: 'whitelist' }) }) });
  assert.deepEqual(ids(ok).filter((i) => i !== 'ton-jetton' && i !== 'ton-caveat'), ['ton-listed', 'ton-admin-dropped']);
  assert.equal(ok.analysis.level, 'info');
  const scam = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton({ verification: 'blacklist' }) }) });
  assert.ok(ids(scam).includes('ton-scam'));
  const badAdmin = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton({ admin: { address: ADMIN, is_scam: true } }) }) });
  assert.ok(ids(badAdmin).includes('ton-scam'));
});

test('official USDT is capped at low; a copied symbol is flagged', async () => {
  const usdt = jetton({ metadata: { name: 'Tether USD', symbol: 'USD₮', decimals: '6' } });
  const r = await readContract('ton', USDT, { api: fakeTon({ [USDT_RAW]: master }, { [USDT_RAW]: usdt }) });
  assert.ok(ids(r).includes('known-issuer'));
  assert.equal(r.analysis.level, 'low');
  const fake = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton({ metadata: { name: 'Tether', symbol: 'USDT', decimals: '6' } }) }) });
  assert.equal(find(fake, 'lookalike').params.official, USDT, 'shown in the friendly form');
});

test('wallets, jetton wallets and missing accounts are explained', async () => {
  const w = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: { status: 'active', interfaces: ['wallet_v4r2'], get_methods: [], is_wallet: true } }, {}) });
  assert.match(explain(w, 'en').lines[0].text, /wallet, not a token/);
  const jw = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: { status: 'active', interfaces: ['jetton_wallet'], get_methods: ['get_wallet_data'], is_wallet: false } }, {}) });
  assert.match(explain(jw, 'en').lines[0].text, /jetton master/);
  const none = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: { status: 'nonexist', get_methods: [], is_wallet: false } }, {}) });
  assert.ok(ids(none).includes('ton-not-found'));
});

test('the largest holder\'s wallet code: recognised standard wallet vs custom code', async () => {
  const WALLET = `0:${'ee'.repeat(32)}`;
  const holders = { addresses: [{ address: WALLET, owner: { address: ADMIN, is_scam: false, is_wallet: true }, balance: '5' }], total: 1 };
  const world = (interfaces, compiler) => {
    const api = fakeTon({ [OTHER_RAW]: master, [WALLET]: { status: 'active', interfaces, get_methods: ['get_wallet_data'], is_wallet: false } }, { [OTHER_RAW]: jetton({ admin: undefined, mintable: false }) });
    const get = api.get;
    api.get = async (path) => {
      if (path === `/v2/jettons/${encodeURIComponent(OTHER_RAW)}/holders?limit=1`) return holders;
      if (path === `/v2/blockchain/accounts/${encodeURIComponent(WALLET)}/inspect`) return { code: 'b5ee', code_hash: 'f'.repeat(64), methods: [{ id: 1, method: 'get_wallet_data' }], compiler };
      return get(path);
    };
    return api;
  };
  const ok = await readContract('ton', OTHER_RAW, { api: world(['jetton_wallet_v2'], 'func') });
  assert.ok(ids(ok).includes('ton-wallet-standard'));
  assert.equal(ok.ton.wallet.address, WALLET);
  assert.equal(ok.analysis.level, 'info');
  const bad = await readContract('ton', OTHER_RAW, { api: world([], 'tact') });
  assert.equal(find(bad, 'ton-wallet-custom').severity, 'high');
  assert.equal(find(bad, 'ton-wallet-custom').params.compiler, 'tact');
  assert.match(explain(bad, 'en').lines.find((l) => l.id === 'ton-wallet-custom').text, /buy but not sell/);
  // no holders yet: nothing is claimed either way
  const none = await readContract('ton', OTHER_RAW, { api: fakeTon({ [OTHER_RAW]: master }, { [OTHER_RAW]: jetton() }) });
  assert.ok(!ids(none).some((i) => i.startsWith('ton-wallet')));
});

test('client spaces requests about a second apart (free tier)', async () => {
  const at = [];
  const api = createTonApi(['https://ton.example'], { fetchImpl: async () => { at.push(Date.now()); return { ok: true, status: 200, json: async () => ({}) }; }, spacingMs: 200 });
  await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')]);
  assert.ok(at[1] - at[0] >= 190 && at[2] - at[1] >= 190, String(at.map((t) => t - at[0])));
});

test('client retries once on the free tier\'s rate limit', async () => {
  let n = 0;
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'GET');
    n++;
    return n === 1 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ ok: 1 }) };
  };
  const api = createTonApi(['https://ton.example'], { fetchImpl });
  assert.deepEqual(await api.get('/v2/x'), { ok: 1 });
  assert.equal(n, 2);
});
