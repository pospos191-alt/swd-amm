// Risk forecasts page (forecasts.html): shipped, strict-CSP friendly, every word in 8 languages,
// selectors and calldata equal to the contracts' ABIs (zetaphy-network/artifacts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress } from 'ethers';
import { FORECASTS } from '../forecasts-i18n.js';
import { LANG_CODES, TEXT } from '../i18n.js';
import { SEL, encodeForecast, encodeClaim, strAt, fmtZeta, parseZeta } from '../forecasts.js';
import { build } from '../build.mjs';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const abi = (n) => new Interface(JSON.parse(readFileSync(join(HERE, '..', 'zetaphy-network', 'artifacts', `${n}.json`), 'utf8')).abi);

test('forecasts page: shipped, no inline script/style, linked from the hub menu', () => {
  const out = build();
  for (const f of ['forecasts.html', 'forecasts.css', 'forecasts.js', 'forecasts-i18n.js']) assert.ok(existsSync(join(out, f)), f);
  const html = readFileSync(join(HERE, 'forecasts.html'), 'utf8');
  assert.doesNotMatch(html, /<script>|<style|\sstyle="|\son[a-z]+="/i);
  assert.match(html, /<script type="module" src="forecasts.js"><\/script>/);
  const js = readFileSync(join(HERE, 'forecasts.js'), 'utf8');
  assert.doesNotMatch(js, /\beval\(|new Function|innerHTML|\.style\./);
  assert.doesNotMatch(html + readFileSync(join(HERE, 'forecasts.css'), 'utf8'), /fonts\.googleapis|fonts\.gstatic|https?:\/\/(?!rpc\.sawasdeecoin)/);
  assert.match(readFileSync(join(HERE, 'hub.js'), 'utf8'), /href: 'forecasts.html', id: 'nav-forecasts'/);
  for (const l of LANG_CODES) assert.ok(TEXT[l].navForecasts && TEXT[l].tipForecasts, l);
  const tabs = [...html.matchAll(/role="tab" id="t-([a-z]+)" aria-controls="p-\1"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['forecasts', 'foresight', 'detectors', 'data', 'arena']);
});

test('forecasts page: every language has every English key; wording stays testnet / not money', () => {
  const en = Object.keys(FORECASTS.en).sort();
  assert.deepEqual(Object.keys(FORECASTS).sort(), [...LANG_CODES].sort());
  for (const l of LANG_CODES) {
    assert.deepEqual(Object.keys(FORECASTS[l]).sort(), en, l);
    for (const [k, v] of Object.entries(FORECASTS[l])) assert.ok(typeof v === 'function' ? v(1, 2) : String(v).trim(), `${l}.${k}`);
    assert.match(FORECASTS[l].qDrop(50), /50/);
    assert.match(FORECASTS[l].judgedN(3, 1), /3/);
    assert.match(FORECASTS[l].testnetOnly, /testnet|测试网|테스트넷|テストネット|тестнет/i);
  }
  for (const k of Object.keys(FORECASTS.en)) {
    const v = FORECASTS.en[k];
    if (typeof v === 'string') assert.doesNotMatch(v, /\b(bets?|betting|gambl\w*|odds|jackpot|profits?)\b/i, k);
  }
});

test('forecasts page: selectors and calldata match the contracts', () => {
  const ifs = ['RiskForecasts', 'ForesightRegistry', 'DetectorPool', 'DataDAO', 'RedBlueArena'].map(abi);
  for (const [name, sel] of Object.entries(SEL)) {
    const found = ifs.map((i) => i.getFunction(name)).filter(Boolean);
    assert.ok(found.some((f) => f.selector === sel), name); // e.g. claim(uint256,address) of RiskForecasts
  }
  const rf = abi('RiskForecasts');
  assert.equal(encodeForecast(7, true), rf.encodeFunctionData('forecast', [7, true]));
  const who = getAddress('0x' + 'ab'.repeat(20));
  assert.equal(encodeClaim(3, who), rf.encodeFunctionData('claim', [3, who]));
  // a string field from a real ABI encoding
  const dao = abi('DataDAO');
  const ret = dao.encodeFunctionResult('submission', [who, 1, 2, false, '0x' + '11'.repeat(32), 'ipfs://x', 'CC0-1.0']);
  assert.equal(strAt(ret, 5), 'ipfs://x');
  assert.equal(strAt(ret, 6), 'CC0-1.0');
  assert.equal(fmtZeta(1_500_000_000_000_000_000n), '1.5');
  assert.equal(parseZeta('0.01'), 10n ** 16n);
  assert.equal(parseZeta('x'), null);
});
