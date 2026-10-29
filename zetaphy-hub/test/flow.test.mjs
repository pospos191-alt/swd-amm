// "How it works" strips (flow.js) and the AI map (aimap.js): every tab and every language complete, every icon
// drawn, every one of the 35 items placed once with a status and a target that exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANG_CODES, TAB_TEXT } from '../i18n.js';
import { FLOW, AIMAP, AI_TAB } from '../flow-i18n.js';
import { FLOWS, ICON, GROUPS, ITEMS, STATUS_ICON } from '../flow.js';
import { statusCounts, whereText } from '../aimap.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(HERE, '..');
const hubTabs = [...readFileSync(join(HERE, 'hub.js'), 'utf8').matchAll(/\{ id: '([a-z]+)'/g)].map((m) => m[1]);

test('every hub tab has a strip: four steps with icons, and next tabs that exist', () => {
  assert.deepEqual(Object.keys(FLOWS).sort(), [...hubTabs].sort());
  for (const [id, f] of Object.entries(FLOWS)) {
    assert.equal(f.icons.length, 4, id);
    for (const i of f.icons) assert.ok(ICON[i], `${id}: icon ${i}`);
    assert.ok(f.next.length >= 2, id);
    for (const t of f.next) assert.ok(hubTabs.includes(t) && t !== id, `${id} -> ${t}`);
  }
});

test('strip words in all 8 languages', () => {
  for (const l of LANG_CODES) {
    const F = FLOW[l];
    assert.ok(F, l);
    for (const k of ['how', 'hide', 'related', 'running', 'runningTip']) assert.ok(F[k]?.trim(), `${l}.${k}`);
    for (const id of Object.keys(FLOWS)) {
      assert.equal(F.steps[id]?.length, 4, `${l}.${id}`);
      for (const s of F.steps[id]) assert.ok(s.trim() && s.length <= 60, `${l}.${id}: ${s}`);
    }
    assert.equal(TAB_TEXT[l].ai?.length, 3, `${l}: AI map tab text`);
    assert.deepEqual(TAB_TEXT[l].ai, AI_TAB[l]);
  }
});

test('the AI map: items 1..35, each in one group, with an icon, a status and a doc', () => {
  const placed = GROUPS.flatMap(([, , nums]) => nums).sort((a, b) => a - b);
  assert.deepEqual(placed, Array.from({ length: 35 }, (_, i) => i + 1), 'each item in exactly one group');
  for (const [, gi] of GROUPS) assert.ok(ICON[gi], gi);
  assert.equal(Object.keys(ITEMS).length, 35);
  for (const [n, it] of Object.entries(ITEMS)) {
    assert.ok(ICON[it.i], `#${n} icon`);
    assert.ok(STATUS_ICON[it.s] && ICON[STATUS_ICON[it.s]], `#${n} status`);
    assert.ok(existsSync(join(ROOT, 'docs/future', `${it.doc}.md`)) && existsSync(join(ROOT, 'docs/future', `${it.doc}.th.md`)), `#${n} doc`);
    if (it.tab) assert.ok(hubTabs.includes(it.tab), `#${n} tab ${it.tab}`);
    if (it.page) assert.ok(existsSync(join(HERE, it.page.replace(/#.*$/, ''))), `#${n} page ${it.page}`);
    if (it.mode) assert.equal(it.tab, 'mine');
    // a chain-level or command-line item has no page to open
    if (it.s === 'chain') assert.ok(!it.tab && !it.page, `#${n}`);
  }
  const c = statusCounts();
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), 35);
});

test('the AI map words in all 8 languages', () => {
  for (const l of LANG_CODES) {
    const A = AIMAP[l];
    assert.ok(A, l);
    for (const k of ['title', 'intro', 'open', 'docs', 'all']) assert.ok(A[k]?.trim(), `${l}.${k}`);
    for (const s of Object.keys(STATUS_ICON)) assert.ok(A.status[s]?.trim(), `${l}.status.${s}`);
    for (const [g] of GROUPS) assert.ok(A.groups[g]?.trim(), `${l}.groups.${g}`);
    for (let n = 1; n <= 35; n++) {
      assert.equal(A.items[n]?.length, 2, `${l} #${n}`);
      assert.ok(A.items[n].every((x) => x.trim()), `${l} #${n}`);
      if (ITEMS[n].hint) assert.ok(whereText(ITEMS[n], l, A)?.trim(), `${l} #${n} hint`);
    }
  }
});

test('jobs go on while other tabs are open: no pause on hidden, and both Mine modes stay', () => {
  const mine = readFileSync(join(HERE, 'mine.js'), 'utf8');
  assert.doesNotMatch(mine, /document\.hidden \|\| root\.hidden/);
  assert.match(mine, /const away = !root\.isConnected \|\| r\.userPaused;/);
  assert.doesNotMatch(mine.slice(mine.indexOf('function setMode'), mine.indexOf('const mine = {')), /stopRun\(\)|stopWork\(\)/, 'switching modes stops nothing');
  for (const f of ['mine.js', 'work.js']) assert.match(readFileSync(join(HERE, f), 'utf8'), /hub:busy/, `${f} tells the hub`);
});
