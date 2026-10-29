// wallet-safety.js (help, banner, idle, signing summary): its texts in the 8 languages, the approval
// reading, and the copies every site serves (byte-identical to the canonical files here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Interface, MaxUint256 } from 'ethers';
import { SAFETY_TEXT, SAFETY_LANGS, decodeApproval, encodeApprove, fmtUnits, UNLIMITED_MIN, IDLE_MINUTES, IDLE_CHOICES, BANNER_DAYS } from '../wallet-safety.js';
import { LANG_CODES } from '../i18n.js';
import { pairs, SHARED } from '../tools/sync-shared.mjs';
import { cleanId, BIG_BALANCE } from '../walletbar.js';

test('the safety texts: every key in the 8 languages of the sites, placeholders kept', () => {
  assert.deepEqual([...SAFETY_LANGS].sort(), [...LANG_CODES].sort());
  const keys = Object.keys(SAFETY_TEXT.en).sort();
  for (const l of SAFETY_LANGS) {
    assert.deepEqual(Object.keys(SAFETY_TEXT[l]).sort(), keys, l);
    for (const k of keys) {
      const v = SAFETY_TEXT[l][k];
      assert.ok(typeof v === 'string' && v.trim(), `${l}.${k}`);
      assert.deepEqual((v.match(/\{\w+\}/g) ?? []).sort(), (SAFETY_TEXT.en[k].match(/\{\w+\}/g) ?? []).sort(), `${l}.${k} placeholders`);
      if (l !== 'en' && !['hwSolH', 'ldBtn', 'ok', 'ldErr', 'hwBadge'].includes(k) && k.length > 0 && SAFETY_TEXT.en[k].length > 12) assert.notEqual(v, SAFETY_TEXT.en[k], `${l}.${k} translated`);
    }
    // the facts the help must state in every language
    assert.match(SAFETY_TEXT[l].hwTrezor, /connect\.trezor\.io/, `${l}: why Trezor goes through MetaMask / Rabby`);
    assert.match(SAFETY_TEXT[l].hwEvm, /MetaMask[\s\S]*Rabby/, l);
    assert.match(SAFETY_TEXT[l].hwSol, /Phantom[\s\S]*Solflare/, l);
    assert.match(SAFETY_TEXT[l].hwCos, /Keplr[\s\S]*Ledger/, l);
    assert.match(SAFETY_TEXT[l].hwLock, /\{min\}/, `${l}: the idle time`);
    assert.match(SAFETY_TEXT[l].idleMsg, /\{min\}/, l);
    assert.match(SAFETY_TEXT[l].idleMins, /\{n\}/, l);
    assert.match(SAFETY_TEXT[l].hwLock, /MetaMask/, `${l}: the extension is locked by the user`);
    assert.match(SAFETY_TEXT[l].bnText, /Snap/, l);
  }
  assert.equal(IDLE_MINUTES, 30, 'the owner: 30 minutes by default');
  assert.deepEqual(IDLE_CHOICES, [30, 60, 120, 240]);
  assert.equal(BANNER_DAYS, 7);
  assert.equal(BIG_BALANCE, 1000n * 10n ** 18n, 'the hub banner: 1,000 ZETAPHY');
});

test('approvals: unlimited, exact, setApprovalForAll; anything else is not one', () => {
  const erc20 = new Interface(['function approve(address,uint256)', 'function increaseAllowance(address,uint256)', 'function setApprovalForAll(address,bool)', 'function transfer(address,uint256)']);
  const sp = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(decodeApproval(erc20.encodeFunctionData('approve', [sp, MaxUint256])), { kind: 'erc20', spender: sp, amount: MaxUint256, unlimited: true });
  assert.equal(decodeApproval(erc20.encodeFunctionData('approve', [sp, 2n ** 255n])).unlimited, true);
  assert.equal(decodeApproval(erc20.encodeFunctionData('approve', [sp, UNLIMITED_MIN])).unlimited, true, 'type(uint96).max');
  assert.equal(decodeApproval(erc20.encodeFunctionData('approve', [sp, 10n ** 24n])).unlimited, false, '1,000,000 tokens is a number, not unlimited');
  assert.equal(decodeApproval(erc20.encodeFunctionData('increaseAllowance', [sp, MaxUint256])).unlimited, true);
  assert.deepEqual(decodeApproval(erc20.encodeFunctionData('setApprovalForAll', [sp, true])), { kind: 'all', spender: sp, approved: true });
  assert.equal(decodeApproval(erc20.encodeFunctionData('setApprovalForAll', [sp, false])).approved, false);
  for (const x of [erc20.encodeFunctionData('transfer', [sp, 1n]), '0x', '0x095ea7b3', null, 'nope', '0x095ea7b3zz']) assert.equal(decodeApproval(x), null, String(x).slice(0, 12));
  assert.equal(encodeApprove(sp, 5n), erc20.encodeFunctionData('approve', [sp, 5n]));
  assert.throws(() => encodeApprove('0x12', 1n));
  assert.equal(fmtUnits(1234500000000000000000n), '1,234.5');
  assert.equal(fmtUnits(1500000n, 6), '1.5');
});

test('Ledger ids are kept like any other wallet id', () => {
  assert.equal(cleanId('"ledger:4"'), 'ledger:4');
  assert.equal(cleanId('ledger:x'), null);
});

test('every site serves the same safety / Ledger files as the hub', () => {
  assert.deepEqual(Object.keys(SHARED).sort(), ['test-ui', 'zetaphy-dex/web/lib', 'zetaphy-explorer/src', 'zetaphy-neuro/web', 'zetaphy-nft/web/lib']);
  for (const [from, to] of pairs()) assert.ok(readFileSync(from).equals(readFileSync(to)), `${to} differs: run npm run sync:shared`);
});

test('the Ledger bundle: Ledger\'s transport only, no eval, no third-party host, small', () => {
  const v = readFileSync(new URL('../vendor/ledger-hid.js', import.meta.url), 'utf8');
  assert.match(v.split('\n')[0], /@ledgerhq\/hw-transport-webhid 6\.36\.0 \(Apache-2\.0\)/);
  assert.doesNotMatch(v, /\beval\(|new Function\(/);
  assert.doesNotMatch(v, /https:\/\/(?!feross\.org|www\.apache\.org)/, 'no URLs it could call');
  assert.ok(v.length < 120_000, `${v.length} bytes`);
  const l = readFileSync(new URL('../ledger.js', import.meta.url), 'utf8');
  assert.match(l, /import\('\.\/vendor\/ledger-hid\.js'\)/, 'loaded from the site itself, on demand');
  assert.doesNotMatch(l, /https?:\/\//);
});
