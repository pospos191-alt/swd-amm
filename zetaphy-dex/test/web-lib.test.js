// The DEX page's own libraries (test-ui/zetaphy/lib/*.js, no third-party code)
// checked against ethers, the contracts' math, Neuro's vaccine and the wallet:
// selectors, ABI encoding, amounts, slippage, price impact, text cleaning, the
// fp1 fingerprint, and that the page loads nothing from other sites.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { id, Interface, AbiCoder, keccak256, toUtf8Bytes, parseUnits as eParse } from 'ethers';
import { SEL, ERRORS, encodeCall, decode, decodeError, parseUnits, formatUnits, decodeBytes32String } from '../../test-ui/zetaphy/lib/abi.js';
import { getAmountOut, getAmountIn, minWithSlippage, maxWithSlippage, priceImpactBps, impactLevel, candidatePaths } from '../../test-ui/zetaphy/lib/amm.js';
import { cleanText, cleanSymbol, validEntry, lookalikes } from '../../test-ui/zetaphy/lib/tokens.js';
import { fingerprint1, SLOT_IMPL, SLOT_BEACON, REASON_TEXT, DISCLAIMER } from '../../test-ui/zetaphy/lib/neuro.js';
import { amountOut, amountIn } from './helpers/dex.js';

const PAGE = fileURLToPath(new URL('../../test-ui/zetaphy/', import.meta.url));
const art = (n) => JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));

test('every precomputed selector is keccak256(signature)[0..4]; every listed error exists in the router or pair', () => {
  for (const [sig, sel] of Object.entries(SEL)) assert.equal(sel, id(sig).slice(0, 10), sig);
  const errs = new Interface([...art('ZetaphyRouter').abi, ...art('ZetaphyPair').abi].filter((x) => x.type === 'error'));
  for (const [sel, name] of Object.entries(ERRORS)) {
    if (name === 'Error') { assert.equal(sel, id('Error(string)').slice(0, 10)); continue; }
    assert.equal(errs.getError(name).selector, sel, name);
  }
  // Every router function the page calls exists with that signature.
  const router = new Interface(art('ZetaphyRouter').abi);
  for (const sig of Object.keys(SEL).filter((s) => /^(swap|add|remove|getAmounts)/.test(s))) assert.ok(router.getFunction(sig), sig);
});

test('ABI encoding matches ethers; decoding reads what ethers encodes', () => {
  const r = new Interface(art('ZetaphyRouter').abi);
  const path = ['0x' + '11'.repeat(20), '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', '0x' + 'ab'.repeat(20)];
  const to = '0x' + '22'.repeat(20);
  const cases = [
    ['swapExactTokensForTokens(uint256,uint256,address[],address,uint256)', [10n ** 18n, 5n, path, to, 1_900_000_000n]],
    ['swapExactETHForTokens(uint256,address[],address,uint256)', [0n, path.slice(1), to, 7n]],
    ['addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)', [path[0], path[2], 1n, 2n, 3n, 4n, to, 5n]],
    ['removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)', [path[0], 2n ** 200n, 0n, 0n, to, 9n]],
    ['getAmountsOut(uint256,address[])', [123n, path]],
  ];
  for (const [sig, args] of cases) assert.equal('0x' + encodeCall(sig, args).slice(2), r.encodeFunctionData(sig, args), sig);
  assert.throws(() => encodeCall('approve(address,uint256)', ['0x1234', 1n]), /bad address/);
  assert.throws(() => encodeCall('approve(address,uint256)', [to, -1n]), /range/);
  const coder = AbiCoder.defaultAbiCoder();
  assert.deepEqual(decode(['uint256[]'], coder.encode(['uint256[]'], [[1n, 2n, 3n]])), [[1n, 2n, 3n]]);
  assert.deepEqual(decode(['string'], coder.encode(['string'], ['สวัสดี ZTPHY'])), ['สวัสดี ZTPHY']);
  assert.deepEqual(decode(['uint112', 'uint112', 'uint32'], coder.encode(['uint112', 'uint112', 'uint32'], [5n, 6n, 7n])), [5n, 6n, 7n]);
  assert.deepEqual(decode(['bool', 'uint8'], coder.encode(['bool', 'uint8'], [true, 3])), [true, 3n]);
  assert.equal(decode(['address'], coder.encode(['address'], [to]))[0], to);
  assert.equal(decodeBytes32String('0x4d4b520000000000000000000000000000000000000000000000000000000000'), 'MKR');
  assert.throws(() => decode(['string'], '0x' + '00'.repeat(31) + '20' + 'ff'.repeat(32)), /bad string/);
  const enforced = r.encodeErrorResult('TokenEnforced', [to, 2]);
  assert.deepEqual(decodeError(enforced), { name: 'TokenEnforced', args: [to, 2] });
  assert.equal(decodeError(r.encodeErrorResult('Expired', [])).name, 'Expired');
  assert.equal(decodeError('0xdeadbeef'), null);
});

test('amounts: parseUnits / formatUnits round-trip like ethers; junk is refused', () => {
  for (const s of ['0', '1', '1.5', '0.000000000000000001', '123456789.123456789']) assert.equal(parseUnits(s, 18), eParse(s, 18), s);
  assert.equal(parseUnits('.5', 6), 500000n);
  for (const bad of ['', 'abc', '1e18', '-1', '1.2.3', '0x10', '1.0000001']) assert.throws(() => parseUnits(bad, 6), bad);
  assert.equal(formatUnits(1234567891234567891234n, 18, 4), '1,234.5678');
  assert.equal(formatUnits(10n ** 18n, 18), '1');
  assert.equal(formatUnits(1n, 18), '0');
});

test('quote math is the router\'s: getAmountOut / getAmountIn, slippage limits, price impact', () => {
  const rs = [[10n ** 21n, 4n * 10n ** 21n], [12345n, 99999999n], [10n ** 30n, 7n]];
  for (const [ri, ro] of rs) {
    for (const x of [1n, 1000n, 10n ** 18n, ri / 3n]) {
      assert.equal(getAmountOut(x, ri, ro), amountOut(x, ri, ro));
      const y = ro / 5n;
      if (y > 0n) assert.equal(getAmountIn(y, ri, ro), amountIn(y, ri, ro));
    }
  }
  assert.equal(getAmountIn(10n, 100n, 10n), null, 'not more than the reserve');
  assert.equal(minWithSlippage(10_000n, 50), 9_950n);
  assert.equal(maxWithSlippage(10_000n, 50), 10_050n);
  assert.equal(maxWithSlippage(1n, 50), 2n, 'rounded up');
  // A trade of 1% of the pool moves the price ~1%; a tiny one ~0.
  const R = 10n ** 24n;
  const hop = (x) => ({ amountIn: x, amountOut: getAmountOut(x, R, R), reserveIn: R, reserveOut: R });
  assert.ok(priceImpactBps([hop(10n ** 12n)]) <= 1n, 'a tiny trade: ~0 (rounding)');
  const one = priceImpactBps([hop(R / 100n)]);
  assert.ok(one >= 98n && one <= 100n, String(one));
  assert.equal(impactLevel(one), 'low');
  assert.equal(impactLevel(priceImpactBps([hop(R / 5n)])), 'severe');
  const two = priceImpactBps([hop(R / 100n), hop(getAmountOut(R / 100n, R, R))]);
  assert.ok(two > one, 'impact compounds over hops');
  const W = '0x' + 'ee'.repeat(20);
  assert.deepEqual(candidatePaths('0x' + '01'.repeat(20), '0x' + '02'.repeat(20), W).length, 2);
  assert.deepEqual(candidatePaths(W, '0x' + '02'.repeat(20), W).length, 1);
});

test('token text: control, bidi, zero-width and private-use characters removed, length capped; lookalikes found', () => {
  assert.equal(cleanText('a‮b​c\u0000de\n f'), 'abcde f');
  assert.equal(cleanText('x'.repeat(100), 40).length, 40);
  assert.equal(cleanSymbol(''), '?');
  assert.equal(cleanText('<script>alert(1)</script>'), '<script>alert(1)</script>', 'kept as text; the page only uses textContent');
  assert.equal(validEntry({ address: '0x123', decimals: 18 }, 77390), null);
  assert.equal(validEntry({ address: '0x' + '11'.repeat(20), decimals: 99 }, 77390), null);
  assert.equal(validEntry({ address: '0x' + '11'.repeat(20), decimals: 18, chainId: 1 }, 77390), null);
  const list = [{ address: '0x' + '11'.repeat(20), symbol: 'tUSD', name: 'Test USD' }];
  assert.equal(lookalikes({ address: '0x' + '22'.repeat(20), symbol: 'TUSD', name: 'x' }, list).length, 1);
  assert.equal(lookalikes({ address: '0x' + '22'.repeat(20), symbol: 'tUSD​', name: 'x' }, list).length, 1);
  assert.equal(lookalikes({ address: '0x' + '22'.repeat(20), symbol: 'tUSО', name: 'x' }, list).length, 0, 'Cyrillic O in "USО" vs D: different');
  assert.equal(lookalikes({ address: '0x' + '22'.repeat(20), symbol: 'tU5D', name: 'x' }, list).length, 0);
  assert.equal(lookalikes({ address: '0x' + '11'.repeat(20), symbol: 'tUSD', name: 'x' }, list).length, 0, 'same address is not a lookalike');
});

test('Neuro in the page: fp1 matches zetaphy-network/src/vaccine.js, EIP-1967 slots, same neutral texts and disclaimer', async () => {
  for (const name of ['ZetaphyPair', 'TestToken', 'ZetaphyRouter']) {
    const code = art(name).deployedBytecode;
    const fp = await fingerprint1(code);
    // The same algorithm, written out: PUSH20/PUSH32 data zeroed, CBOR metadata dropped, sha256.
    const b = Buffer.from(code.slice(2), 'hex');
    const metaLen = (b[b.length - 2] << 8) | b[b.length - 1];
    let end = b.length - 2 - metaLen;
    if (!(metaLen > 0 && end > 0 && b[end] >= 0xa1 && b[end] <= 0xa5)) end = b.length;
    const out = Buffer.from(b.subarray(0, end));
    for (let pc = 0; pc < end; pc++) { const op = out[pc]; if (op >= 0x60 && op <= 0x7f) { const n = op - 0x5f; if (op === 0x73 || op === 0x7f) out.fill(0, pc + 1, Math.min(pc + 1 + n, end)); pc += n; } }
    assert.equal(fp, '0x' + createHash('sha256').update(out).digest('hex'), name);
    try {
      const v = await import('../../zetaphy-network/src/vaccine.js');
      assert.equal(fp, '0x' + v.fingerprint1(code).slice(4), `${name} vs vaccine.js`);
    } catch (e) { if (!/Cannot find (package|module)/.test(e.message)) throw e; } // zetaphy-network deps not installed
  }
  const slot = (s) => '0x' + (BigInt(keccak256(toUtf8Bytes(s))) - 1n).toString(16).padStart(64, '0');
  assert.equal(SLOT_IMPL, slot('eip1967.proxy.implementation'));
  assert.equal(SLOT_BEACON, slot('eip1967.proxy.beacon'));
  assert.equal(id('implementation()').slice(0, 10), '0x5c60da1b');
  assert.equal(DISCLAIMER.th, 'ข้อมูลวิเคราะห์โค้ดอัตโนมัติ ไม่ใช่คำกล่าวหา');
  const vaccine = readFileSync(new URL('../../zetaphy-network/src/vaccine.js', import.meta.url), 'utf8');
  for (const r of REASON_TEXT.slice(1)) { assert.ok(vaccine.includes(r.th), r.en); assert.ok(vaccine.includes(r.en.replace(/'/g, "\\'")) || vaccine.includes(r.en), r.en); }
  // Neutral wording everywhere in the page (docs/LEGAL.md).
  const words = /\b(scam|fraud|rug ?pull|drainer|phishing|honeypot)\b|หลอกลวง|ฉ้อโกง|มิจฉาชีพ/i;
  for (const f of ['i18n.js', 'lib/neuro.js', 'app.js', 'index.html']) assert.doesNotMatch(readFileSync(join(PAGE, f), 'utf8'), words, f);
});

test('the page loads nothing from other sites: no inline or external scripts, no remote imports, no innerHTML', () => {
  const html = readFileSync(join(PAGE, 'index.html'), 'utf8');
  for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(m[1], /src="\/zetaphy\/[a-z]+\.js"/, 'only same-origin script files');
    assert.equal(m[2].trim(), '', 'no inline script');
  }
  assert.doesNotMatch(html, /<link[^>]+href="https?:/, 'no remote stylesheets or fonts');
  assert.doesNotMatch(html, /\son[a-z]+=/i, 'no inline event handlers');
  assert.doesNotMatch(html, /style="/, 'no inline styles (CSP style-src self)');
  const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk(PAGE).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(f, 'utf8');
    assert.doesNotMatch(src, /import[^;]*from\s+['"]https?:/, f);
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, f);
  }
});

test('chain values and wallet discovery are the same as zetaphy-wallet/wallets.js', () => {
  const page = readFileSync(join(PAGE, 'lib/wallets.js'), 'utf8');
  const wallet = readFileSync(new URL('../../zetaphy-wallet/wallets.js', import.meta.url), 'utf8');
  for (const c of ['CHAIN_ID', 'EVM_CHAIN_ID', 'EVM_CHAIN_ID_HEX', 'CHAIN_NAME', 'EVM_SYMBOL', 'DECIMALS', 'DISPLAY_DENOM']) {
    const re = new RegExp(`export const ${c} = ([^;]+);`);
    assert.equal(re.exec(page)?.[1], re.exec(wallet)?.[1], c);
  }
  const fn = (src, name) => { const i = src.indexOf(`export function ${name}`); return src.slice(i, src.indexOf('\n}\n', i)); };
  for (const f of ['nodeEndpoints', 'evmChainParams', 'discoverWallets', 'safeIcon', 'kindOf', 'openInAppLinks']) assert.equal(fn(page, f), fn(wallet, f), f);
});
