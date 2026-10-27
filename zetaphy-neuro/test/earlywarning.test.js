// Early-warning tier (server/earlywarning.js, api/early-warning.js): the
// private rule pack, its loader, each rule kind on real compiled contracts,
// and that answers never carry rule content.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePack, normalizeRule, createPackLoader, decodeEnvPack, refOf, readCodes, codeContext, matchRule, warningsFor,
  handleEarlyWarning, memoryLimiter, redisLimiter, answerCache, parseOpcodes, opcodesMatch, MAX_WARNINGS, DEFAULT_REPO, DEFAULT_PATH,
} from '../server/earlywarning.js';
import { memoryStore } from '../server/usage.js';
import { makeEntry } from '../src/similarity.js';
import { THREAT_SIGNATURES } from '../src/threat-signatures.js';
import { selectorOf } from '../src/keccak.js';
import { createLocalChain, encodeAddressBytes } from './helpers/local-chain.js';

const day = (d) => `2026-${d}`;
const rule = (id, kind, extra = {}) => ({ id, addedAt: day('10-01'), publishAfter: day('11-01'), kind, reason: 'cannot-sell-in-simulation', severity: 'medium', ...extra });
const REF = /^ew-[0-9a-f]{12}$/;

// ------------------------------------------------------------ pack format
test('parsePack keeps valid rules, drops bad ones, and never echoes their content', () => {
  const p = parsePack({ version: 3, refKey: 'k'.repeat(32), rules: [
    rule('ok-sel', 'selectors', { selectors: ['mint(address,uint256)', '0x44337ea1'] }),
    rule('ok-hex', 'bytecode', { hex: '0xDEADBEEF' }),
    rule('ok-ops', 'bytecode', { opcodes: 'ORIGIN * EQ' }),
    rule('bad-reason', 'selectors', { selectors: ['a9059cbb'], reason: 'scam' }),
    rule('bad-kind', 'magic'),
    rule('bad-date', 'bytecode', { hex: 'aabb', publishAfter: 'soon' }),
    rule('bad-sev', 'bytecode', { hex: 'aabb', severity: 'critical' }),
    rule('both', 'bytecode', { hex: 'aabb', opcodes: 'ORIGIN EQ' }),
    rule('bad-op', 'bytecode', { opcodes: 'ORIGIN FROBNICATE' }),
    rule('ok-sel', 'selectors', { selectors: ['a9059cbb'] }), // duplicate id
    rule('bad id with spaces', 'bytecode', { hex: 'aabb' }),
    rule('sig-short', 'signature', { fingerprint: 'fp1:' + '0'.repeat(64), baseline: 'x', selectors: [], n: 9, minhash: 'ab' }),
    'not an object',
  ] });
  assert.equal(p.version, 3);
  assert.deepEqual(p.rules.map((r) => r.id), ['ok-sel', 'ok-hex', 'ok-ops']);
  assert.equal(p.invalid, 10);
  assert.deepEqual(p.rules[0].selectors, [selectorOf('mint(address,uint256)'), '44337ea1']);
  assert.equal(p.rules[1].hex, 'deadbeef');
  assert.throws(() => parsePack('{nope'), /not JSON/);
  assert.throws(() => parsePack({ version: 0, rules: [] }), /version/);
  assert.throws(() => parsePack({ version: 1 }), /rules/);
  assert.throws(() => parsePack([]), /object/);
  // Error messages name the field, never the private value.
  try { normalizeRule(rule('x', 'bytecode', { hex: 'zz-secret-pattern' })); assert.fail(); } catch (e) { assert.doesNotMatch(e.message, /secret/); }
});

test('refs are opaque: keyed by the pack, stable, and not the rule id', () => {
  const a = parsePack({ version: 1, refKey: 'a'.repeat(32), rules: [rule('r1', 'bytecode', { hex: 'aabb' })] });
  const b = parsePack({ version: 1, refKey: 'b'.repeat(32), rules: [rule('r1', 'bytecode', { hex: 'aabb' })] });
  assert.match(refOf(a, a.rules[0]), REF);
  assert.equal(refOf(a, a.rules[0]), refOf(a, a.rules[0]));
  assert.notEqual(refOf(a, a.rules[0]), refOf(b, b.rules[0]));
  assert.ok(!refOf(a, a.rules[0]).includes('r1'));
  // No refKey: keyed by the private pack's own digest.
  const c = parsePack({ version: 1, rules: [rule('r1', 'bytecode', { hex: 'aabb' })] });
  assert.equal(c.refKey, c.digest);
});

test('opcode patterns: "?" one opcode, "*" up to 8, families, PUSH data ignored', () => {
  // ORIGIN PUSH20 <20 bytes> EQ PUSH1 0x32 (data, not ORIGIN) CALLER
  const ops = [0x32, 0x73, 0x14, 0x60, 0x33];
  assert.ok(opcodesMatch(ops, parseOpcodes('ORIGIN PUSH* EQ')));
  assert.ok(opcodesMatch(ops, parseOpcodes('ORIGIN ? EQ')));
  assert.ok(opcodesMatch(ops, parseOpcodes('ORIGIN * CALLER')));
  assert.ok(opcodesMatch(ops, parseOpcodes(['eq', 'push1'])));
  assert.ok(!opcodesMatch(ops, parseOpcodes('ORIGIN EQ')));
  assert.ok(!opcodesMatch(ops, parseOpcodes('CALLER ORIGIN')));
  assert.ok(!opcodesMatch([0x32, ...Array(9).fill(0x50), 0x14], parseOpcodes('ORIGIN * EQ')), 'the gap is bounded');
  assert.throws(() => parseOpcodes('ORIGIN'), /2 to 64/);
  assert.throws(() => parseOpcodes('* ORIGIN'), /between/);
});

// ----------------------------------------------------------------- loader
const PACK = { version: 1, refKey: 'r'.repeat(32), rules: [rule('a', 'bytecode', { hex: 'aabb' })] };

test('loader: NEURO_PRIVATE_RULES as JSON or base64 JSON; nothing set = not configured', async () => {
  const json = createPackLoader({ env: { NEURO_PRIVATE_RULES: JSON.stringify(PACK) } });
  assert.equal(json.configured, true);
  assert.equal(json.source, 'env');
  assert.deepEqual((await json.load()).rules.map((r) => r.id), ['a']);
  const b64 = createPackLoader({ env: { NEURO_PRIVATE_RULES: Buffer.from(JSON.stringify(PACK)).toString('base64') } });
  assert.deepEqual((await b64.load()).rules.map((r) => r.id), ['a']);
  assert.equal(decodeEnvPack(`  ${JSON.stringify(PACK)}\n`), JSON.stringify(PACK));
  const broken = createPackLoader({ env: { NEURO_PRIVATE_RULES: 'bm90IGpzb24=' } }); // "not json"
  assert.equal(broken.configured, true);
  assert.equal(await broken.load(), null);
  const none = createPackLoader({ env: {} });
  assert.equal(none.configured, false);
  assert.equal(await none.load(), null);
  assert.equal(createPackLoader({ env: { NEURO_PRIVATE_RULES: '  ', NEURO_RULES_TOKEN: '' } }).configured, false);
});

test('loader: private GitHub file with a read-only token, cached ~10 minutes, last good pack kept on errors', async () => {
  let t = 0;
  const calls = [];
  let fail = false;
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (fail) return { ok: false, status: 502, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify(PACK) };
  };
  const l = createPackLoader({ env: { NEURO_RULES_TOKEN: 'github_pat_SECRET' }, fetchImpl, now: () => t });
  assert.equal(l.source, 'github');
  const [p1, p2] = await Promise.all([l.load(), l.load()]);
  assert.equal(p1, p2);
  assert.equal(calls.length, 1, 'one request for concurrent loads');
  assert.equal(calls[0].url, `https://api.github.com/repos/${DEFAULT_REPO}/contents/${DEFAULT_PATH}`);
  assert.equal(calls[0].init.headers.authorization, 'Bearer github_pat_SECRET');
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github.raw+json');
  assert.equal(calls[0].init.method, undefined, 'a GET');
  t = 9 * 60_000;
  await l.load();
  assert.equal(calls.length, 1, 'cached for 10 minutes');
  t = 11 * 60_000;
  fail = true;
  assert.equal(await l.load(), p1, 'refresh failed: the last good pack is kept');
  assert.equal(calls.length, 2);
  t += 30_000;
  await l.load();
  assert.equal(calls.length, 2, 'waits a minute before trying again');
  t += 31_000;
  fail = false;
  assert.notEqual(await l.load(), p1, 'refreshed');
  assert.equal(calls.length, 3);
  // Repo and path from env; anything odd in them is refused.
  const other = [];
  const custom = createPackLoader({ env: { NEURO_RULES_TOKEN: 'x', NEURO_RULES_REPO: 'me/rules', NEURO_RULES_PATH: 'a/b.json' }, fetchImpl: async (u) => { other.push(u); return { ok: true, text: async () => JSON.stringify(PACK) }; } });
  await custom.load();
  assert.deepEqual(other, ['https://api.github.com/repos/me/rules/contents/a/b.json']);
  for (const env of [{ NEURO_RULES_REPO: 'x/../y' }, { NEURO_RULES_PATH: '../etc/passwd' }, { NEURO_RULES_REPO: 'https://evil.example/x' }]) {
    const bad = createPackLoader({ env: { NEURO_RULES_TOKEN: 'x', ...env }, fetchImpl: () => assert.fail('no request') });
    assert.equal(await bad.load(), null);
  }
  // First load fails: nothing to serve.
  const down = createPackLoader({ env: { NEURO_RULES_TOKEN: 'x' }, fetchImpl: async () => { throw new Error('network'); } });
  assert.equal(await down.load(), null);
});

// ------------------------------------------------- rule kinds, real code
describe('rule kinds on compiled contracts (in-memory EVM)', () => {
  let chain; let codes;
  const ctxOf = async (name) => codeContext(await readCodes(chain.rpc, codes[name]));
  before(async () => {
    chain = await createLocalChain();
    codes = {};
    for (const n of ['CleanToken', 'ScamToken', 'QuietHoneypot', 'QuietCopy', 'Drainer', 'SimAware']) {
      codes[n] = await chain.deploy(n, n === 'SimAware' ? '0'.repeat(128) : '');
    }
  });

  test('signature: the entry\'s code and a lightly edited copy match; an ordinary token does not', async () => {
    const code = await chain.rpc.call('eth_getCode', [codes.QuietHoneypot, 'latest']);
    const entry = await makeEntry(code, THREAT_SIGNATURES.baseline, { reason: 'cannot-sell-in-simulation', source: 'test' });
    const p = parsePack({ version: 1, rules: [rule('sig', 'signature', { ...entry, severity: 'high' })] });
    assert.equal(p.invalid, 0);
    const r = p.rules[0];
    assert.ok(matchRule(r, await ctxOf('QuietHoneypot')), 'exact code');
    assert.ok(matchRule(r, await ctxOf('QuietCopy')), 'renamed copy');
    assert.ok(!matchRule(r, await ctxOf('CleanToken')));
    const strict = parsePack({ version: 1, rules: [rule('sig', 'signature', { ...entry, minPercent: 100 })] }).rules[0];
    assert.ok(matchRule(strict, await ctxOf('QuietHoneypot')));
    assert.ok(!matchRule(strict, await ctxOf('QuietCopy')), 'minPercent 100: exact only');
  });

  test('selectors: functions it offers (all, or at least `min`), or any 4-byte constant with anywhere', async () => {
    const p = parsePack({ version: 1, rules: [
      rule('all', 'selectors', { selectors: ['mint(address,uint256)', 'setBlacklist(address,bool)'] }),
      rule('two-of-three', 'selectors', { selectors: ['mint(address,uint256)', 'setBlacklist(address,bool)', 'nope()'], min: 2 }),
      rule('three', 'selectors', { selectors: ['mint(address,uint256)', 'setBlacklist(address,bool)', 'nope()'] }),
      rule('calls-transferFrom', 'selectors', { selectors: ['transferFrom(address,address,uint256)'], anywhere: true }),
      rule('offers-transferFrom', 'selectors', { selectors: ['transferFrom(address,address,uint256)'] }),
    ] });
    const hits = async (name) => {
      const ctx = await ctxOf(name);
      return p.rules.filter((r) => matchRule(r, ctx)).map((r) => r.id);
    };
    assert.deepEqual(await hits('ScamToken'), ['all', 'two-of-three', 'calls-transferFrom', 'offers-transferFrom']);
    assert.deepEqual(await hits('Drainer'), ['calls-transferFrom'], 'calls transferFrom on others, does not offer it');
    assert.deepEqual(await hits('CleanToken'), ['calls-transferFrom', 'offers-transferFrom']);
  });

  test('bytecode: a byte string (whole bytes only) or an opcode pattern', async () => {
    const quiet = await ctxOf('QuietHoneypot');
    const piece = quiet.hex[0].slice(200, 232); // 16 bytes from the code
    const p = parsePack({ version: 1, rules: [
      rule('hex', 'bytecode', { hex: piece }),
      rule('origin-check', 'bytecode', { opcodes: 'ORIGIN * EQ' }),
      rule('gasprice', 'bytecode', { opcodes: 'GASPRICE ISZERO' }),
    ] });
    const hit = (ctx) => p.rules.filter((r) => matchRule(r, ctx)).map((r) => r.id);
    assert.deepEqual(hit(quiet), ['hex']);
    assert.deepEqual(hit(await ctxOf('Drainer')), [], 'other code');
    // SimAware compares tx.origin with a constant and tests tx.gasprice == 0.
    assert.deepEqual(hit(await ctxOf('SimAware')).filter((id) => id !== 'hex'), ['origin-check', 'gasprice']);
    assert.ok(!hit(await ctxOf('CleanToken')).includes('origin-check'));
    // A match that only exists across a byte boundary does not count.
    const odd = await codeContext({ code: '0x0abcd0', logic: null }); // 0a bc d0: "abcd" only straddles bytes
    assert.ok(!matchRule(normalizeRule(rule('h', 'bytecode', { hex: 'abcd' })), odd));
    assert.ok(matchRule(normalizeRule(rule('h', 'bytecode', { hex: 'abcd' })), await codeContext({ code: '0xabcdef', logic: null })));
  });

  test('proxies: rules see the code behind EIP-1967 and EIP-1167 too', async () => {
    const impl = await chain.deploy('UpgradeableToken');
    const proxy = await chain.deploy('Proxy1967', encodeAddressBytes(impl, '8129fc1c'));
    const c = await readCodes(chain.rpc, proxy);
    assert.ok(c.logic && c.logic !== c.code);
    const r = normalizeRule(rule('up', 'selectors', { selectors: ['upgradeTo(address)'] }));
    assert.ok(matchRule(r, await codeContext(c)));
    // EIP-1167 clone and EIP-7702 delegation, through a fake RPC.
    const target = '0x' + '77'.repeat(20);
    const logic = await chain.rpc.call('eth_getCode', [codes.ScamToken, 'latest']);
    const fake = (code) => ({ call: async (m, p) => (m === 'eth_getCode' ? (p[0] === target ? logic : code) : '0x' + '0'.repeat(64)) });
    const clone = await readCodes(fake(`0x363d3d373d3d3d363d73${'77'.repeat(20)}5af43d82803e903d91602b57fd5bf3`), '0x' + '01'.repeat(20));
    assert.equal(clone.logic, logic.toLowerCase());
    const delegated = await readCodes(fake(`0xef0100${'77'.repeat(20)}`), '0x' + '01'.repeat(20));
    assert.deepEqual(delegated, { code: logic.toLowerCase(), logic: null });
    assert.equal(await readCodes(fake('0x'), '0x' + '01'.repeat(20)), null, 'no code');
    assert.equal(await readCodes(fake('0xeff00000'), '0x' + '01'.repeat(20)), null, 'Stylus: not EVM bytecode');
  });

  test('warnings: reason, severity and ref only, most severe first, at most MAX_WARNINGS', async () => {
    const many = Array.from({ length: 8 }, (_, i) => rule(`m${i}`, 'selectors', { selectors: ['mint(address,uint256)'], severity: i === 5 ? 'high' : 'low' }));
    const p = parsePack({ version: 1, refKey: 'z'.repeat(32), rules: many });
    const ws = warningsFor(p, await ctxOf('ScamToken'));
    assert.equal(ws.length, MAX_WARNINGS);
    assert.equal(ws[0].severity, 'high');
    for (const w of ws) assert.deepEqual(Object.keys(w).sort(), ['reason', 'ref', 'severity']);
  });
});

// ---------------------------------------------------------------- handler
const ADDR = '0x' + '42'.repeat(20);
const SECRET_PACK = {
  version: 7, refKey: 'refkey-SECRET-0123456789',
  rules: [
    rule('wave-2026-10-origin-check', 'bytecode', { hex: 'c0ffee00c0ffee', severity: 'high', reason: 'owner-can-block-transfers' }),
    rule('wave-2026-10-selectors', 'selectors', { selectors: ['a9059cbb', 'deadbeef'], min: 1 }),
    rule('no-match', 'bytecode', { hex: '1234567890abcdef' }),
  ],
};
/** A runtime code that offers transfer(...) and contains the secret byte string. */
const CODE = '0x63a9059cbb1460005760c0ffee00c0ffee00';

function setup({ pack = SECRET_PACK, code = CODE, limiter = memoryLimiter({ perMinute: 3 }), env } = {}) {
  const calls = [];
  const rpc = { call: async (m, p) => { calls.push(m); if (m === 'eth_getCode') return code; return '0x' + '0'.repeat(64); } };
  const deps = { loader: createPackLoader({ env: env ?? { NEURO_PRIVATE_RULES: JSON.stringify(pack) } }), limiter, cache: answerCache(), rpcFor: () => rpc };
  const ask = (body, extra = {}) => handleEarlyWarning({ method: 'POST', body, ip: '203.0.113.9', ...extra }, deps);
  return { ask, calls };
}

test('handler: answers only {reason, severity, ref}; no rule content ever leaves', async () => {
  const { ask } = setup();
  const r = await ask({ chain: 'bsc', address: ADDR });
  assert.equal(r.status, 200);
  assert.equal(r.json.configured, true);
  assert.deepEqual(r.json.warnings.map((w) => [w.reason, w.severity]), [['owner-can-block-transfers', 'high'], ['cannot-sell-in-simulation', 'medium']]);
  for (const w of r.json.warnings) assert.match(w.ref, REF);
  const text = JSON.stringify(r);
  for (const secret of ['wave-2026', 'c0ffee', 'a9059cbb', 'deadbeef', 'refkey', 'SECRET', 'selectors', 'bytecode', 'publishAfter', 'addedAt', '"version"', 'digest']) {
    assert.ok(!text.includes(secret), `leaked ${secret}`);
  }
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('handler: strict input validation, same-site only, POST only', async () => {
  const { ask, calls } = setup();
  for (const body of [null, 'bsc', [], {}, { chain: 'bsc' }, { address: ADDR }, { chain: 'bsc', address: '0x1234' },
    { chain: 'polygon', address: ADDR }, { chain: '__proto__', address: ADDR }, { chain: 'toString', address: ADDR },
    { chain: 'bsc', address: ADDR + 'ff' }, { chain: 'bsc', address: 42 }, { chain: 'x'.repeat(40), address: ADDR },
    { chain: 'bsc', address: ADDR.replace('0x', '') }]) {
    assert.equal((await ask(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { method: 'GET' })).status, 405);
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { origin: 'https://evil.example', host: 'neuro.example' })).status, 403);
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { origin: 'https://neuro.example', host: 'neuro.example' })).status, 200);
  // the hub, which proxies /api/* here, is let in; an allowed list never opens it to others
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { origin: 'https://app.example', host: 'neuro.example', allowedHosts: ['app.example'] })).status, 200);
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { origin: 'https://evil.example', host: 'neuro.example', allowedHosts: ['app.example'] })).status, 403);
  assert.ok(!calls.some((m) => m !== 'eth_getCode' && m !== 'eth_getStorageAt' && m !== 'eth_call'));
  // Mixed-case EVM address is fine; non-EVM chains have nothing to match.
  assert.equal((await ask({ chain: 'bsc', address: ADDR.toUpperCase().replace('0X', '0x') })).status, 200);
  const sol = await ask({ chain: 'sol', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' });
  assert.deepEqual(sol.json, { warnings: [], configured: true });
});

test('handler: not configured = { warnings: [], configured: false }, with no RPC call', async () => {
  const { ask, calls } = setup({ env: {} });
  const r = await ask({ chain: 'bsc', address: ADDR });
  assert.deepEqual([r.status, r.json], [200, { warnings: [], configured: false }]);
  assert.deepEqual(calls, []);
});

test('handler: per-IP rate limit (429 + retry-after), short answer cache, failures say little', async () => {
  const { ask, calls } = setup();
  for (let i = 0; i < 3; i++) assert.equal((await ask({ chain: 'bsc', address: ADDR })).status, 200);
  assert.equal(calls.filter((m) => m === 'eth_getCode').length, 1, 'answers cached per (chain, address)');
  const limited = await ask({ chain: 'bsc', address: ADDR });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers['retry-after']) > 0);
  assert.equal((await ask({ chain: 'bsc', address: ADDR }, { ip: '198.51.100.1' })).status, 200, 'another client is not limited');
  // RPC down: 502; broken pack: 503; no code: no warnings.
  const down = { loader: createPackLoader({ env: { NEURO_PRIVATE_RULES: JSON.stringify(SECRET_PACK) } }), limiter: memoryLimiter(), rpcFor: () => ({ call: async () => { throw new Error('all RPC endpoints failed: secret detail'); } }) };
  const r502 = await handleEarlyWarning({ method: 'POST', body: { chain: 'bsc', address: ADDR } }, down);
  assert.deepEqual([r502.status, r502.json], [502, { error: 'chain' }]);
  const broken = setup({ env: { NEURO_PRIVATE_RULES: '{"version": "x"}' } });
  assert.deepEqual((await broken.ask({ chain: 'bsc', address: ADDR })).json, { error: 'unavailable' });
  const empty = setup({ code: '0x' });
  assert.deepEqual((await empty.ask({ chain: 'bsc', address: ADDR })).json, { warnings: [], configured: true });
});

test('limiters: memory windows reset; Redis counts per HMAC(ip), falls back if Redis fails', async () => {
  let t = 0;
  const m = memoryLimiter({ perMinute: 2, perDay: 4, now: () => t });
  assert.ok((await m.check('a')).ok && (await m.check('a')).ok);
  assert.equal((await m.check('a')).ok, false);
  t = 60_000;
  assert.ok((await m.check('a')).ok, 'next minute');
  assert.equal((await m.check('a')).ok, false, 'daily cap');
  const g = memoryLimiter({ perMinute: 100, globalPerMinute: 2, now: () => 0 });
  await g.check('x'); await g.check('y');
  assert.equal((await g.check('z')).ok, false, 'instance-wide cap');

  const store = memoryStore();
  const seen = [];
  const spy = { pipeline: (cmds) => { seen.push(...cmds.flat().map(String)); return store.pipeline(cmds); } };
  const r = redisLimiter(spy, 'salt-0123456789abcdef', { perMinute: 2, now: () => 0 });
  assert.ok((await r.check('203.0.113.77')).ok);
  assert.ok((await r.check('203.0.113.77')).ok);
  assert.equal((await r.check('203.0.113.77')).ok, false);
  assert.ok(!seen.join(' ').includes('203.0.113.77'), 'no IP stored');
  const shared = redisLimiter(memoryStore(), 'salt-0123456789abcdef', { perMinute: 100, globalPerMinute: 2, now: () => 0 });
  await shared.check('198.51.100.1'); await shared.check('198.51.100.2');
  assert.equal((await shared.check('198.51.100.3')).ok, false, 'all clients together are capped (shared store)');
  const flaky = redisLimiter({ pipeline: async () => { throw new Error('down'); } }, 'salt-0123456789abcdef', { fallback: memoryLimiter({ perMinute: 1 }) });
  assert.ok((await flaky.check('a')).ok);
  assert.equal((await flaky.check('a')).ok, false);
});

test('nothing is logged: the pack and the token stay out of the logs', async () => {
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => lines.push(a.join(' '));
  try {
    const gh = createPackLoader({ env: { NEURO_RULES_TOKEN: 'github_pat_SECRET' }, fetchImpl: async () => ({ ok: false, status: 401, text: async () => '' }) });
    await handleEarlyWarning({ method: 'POST', body: { chain: 'bsc', address: ADDR } }, { loader: gh, limiter: memoryLimiter(), rpcFor: () => ({ call: async () => CODE }) });
    const { ask } = setup();
    await ask({ chain: 'bsc', address: ADDR });
  } finally {
    Object.assign(console, orig);
  }
  assert.deepEqual(lines, []);
});

test('opcode patterns with many "*" stay linear on hostile code (no exponential backtracking)', async () => {
  const { parseOpcodes, opcodesMatch } = await import('../server/earlywarning.js');
  const ops = new Array(24_000).fill(0x01); // ADD everywhere: every "*" branch matches
  const t0 = Date.now();
  assert.equal(opcodesMatch(ops, parseOpcodes('ADD * ADD * ADD * ADD * ADD * ADD * STOP')), false);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
  assert.equal(opcodesMatch([0x32, 0x01, 0x01, 0x14], parseOpcodes('ORIGIN * EQ')), true);
});

test('rate limits count an IPv6 client by its /64', async () => {
  const { clientKeyOf, memoryLimiter } = await import('../server/earlywarning.js');
  assert.equal(clientKeyOf('2001:db8:1:2::9'), clientKeyOf('2001:0db8:0001:0002:ffff:1:2:3'));
  assert.notEqual(clientKeyOf('2001:db8:1:2::9'), clientKeyOf('2001:db8:1:3::9'));
  assert.equal(clientKeyOf('::ffff:203.0.113.9'), '203.0.113.9');
  const m = memoryLimiter({ perMinute: 2, now: () => 0 });
  assert.ok((await m.check('2001:db8:1:2::1')).ok && (await m.check('2001:db8:1:2::2')).ok);
  assert.equal((await m.check('2001:db8:1:2::3')).ok, false, 'a new address in the same /64 is the same client');
});
