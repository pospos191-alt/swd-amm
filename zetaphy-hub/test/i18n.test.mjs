// Every language the hub offers has every English text (hub, tabs, data pages), and the language rules hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANGS, LANG_CODES, pickLang, locale, withFallback, TEXT, TAB_TEXT } from '../i18n.js';
import { EARN, EARN_METHODS, SAPHAN } from '../pages-i18n.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Every key path of a table (array entries by index, a function counts as a leaf). */
const shape = (v, at = '') => (v && typeof v === 'object'
  ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`))
  : [`${at}:${typeof v}`]);

test('the 8 languages, in menu order, with their native names', () => {
  assert.deepEqual(LANGS, [['en', 'English'], ['zh', '中文'], ['es', 'Español'], ['ko', '한국어'], ['ja', '日本語'], ['ru', 'Русский'], ['vi', 'Tiếng Việt'], ['th', 'ไทย']]);
});

test('English by default; a stored code from the set is kept; anything else is English', () => {
  for (const c of LANG_CODES) assert.equal(pickLang(c), c);
  for (const v of [null, undefined, '', 'EN', 'fr', 'zh-CN', 'th-TH', '"th"']) assert.equal(pickLang(v), 'en', String(v));
  assert.equal(locale('en'), 'en-GB');
  for (const c of LANG_CODES.filter((x) => x !== 'en')) {
    assert.equal(locale(c), c);
    assert.doesNotThrow(() => new Date(0).toLocaleString(locale(c)));
  }
});

test('every language has the full English key set: TEXT, TAB_TEXT, Earn, Saphan', () => {
  for (const [name, table] of [['TEXT', TEXT], ['TAB_TEXT', TAB_TEXT], ['EARN', EARN], ['SAPHAN', SAPHAN]]) {
    assert.deepEqual(Object.keys(table).sort(), [...LANG_CODES].sort(), `${name}: one entry per language`);
    const en = shape(table.en);
    for (const l of LANG_CODES) assert.deepEqual(shape(table[l]), en, `${name}.${l}`);
  }
  for (const l of LANG_CODES) {
    for (const [k, v] of Object.entries(TEXT[l])) assert.ok(typeof v === 'string' && v.trim(), `TEXT.${l}.${k}`);
    for (const m of EARN_METHODS) assert.equal(EARN[l].m[m.id].steps.length, m.cmds.length, `EARN.${l}.${m.id}: one text per step`);
    assert.match(SAPHAN[l].badTo('noble'), /noble1…/, `SAPHAN.${l}.badTo`);
    assert.ok(SAPHAN[l].recvHow('channel-7', 'Noble').includes('channel-7') && SAPHAN[l].recvHow('channel-7', 'Noble').includes('Noble'), `SAPHAN.${l}.recvHow placeholders`);
  }
});

test('placeholders and brand names survive translation', () => {
  for (const l of LANG_CODES) {
    const runner = EARN[l].m.runner;
    assert.match(runner.need, /BOND/, `${l}: runner bond placeholder`);
    assert.match(runner.steps[3], /BOND/, `${l}: runner bond step`);
    assert.match(TEXT[l].tipAddNet, /77390/);
    assert.match(TEXT[l].tipMyStake, /0x…0800/);
    assert.equal(TEXT[l].app_swap, 'ZETAPHY Swap');
    assert.match(TAB_TEXT[l].saphan[1], /^ZETAPHY Saphan/);
  }
});

test('a missing key or language falls back to English, never a raw key', () => {
  const t = { en: { a: 'A', b: 'B', m: { x: { steps: ['1', '2'] } }, f: (x) => `en ${x}` }, xx: { a: 'a', m: { x: { steps: ['one'] } } } };
  const r = withFallback(t, 'xx');
  assert.deepEqual([r.a, r.b, r.m.x.steps, r.f(1)], ['a', 'B', ['one', '2'], 'en 1']);
  assert.equal(withFallback(t, 'nope').b, 'B');
});

test('no Thai left in the code, only in the translation tables; the language menu is a select', () => {
  for (const f of ['hub.js', 'pages.js']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /[฀-๿]/, f);
  const html = readFileSync(join(HERE, 'index.html'), 'utf8');
  assert.match(html, /<select[^>]*id="lang"/);
  const build = readFileSync(join(HERE, 'build.mjs'), 'utf8');
  for (const f of ['i18n.js', 'pages-i18n.js']) assert.ok(build.includes(`'${f}'`), `${f} shipped in dist/`);
});
