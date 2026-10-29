// zetaphy-chain/join-validator.sh "upgrade-watch" (what the 1-minute zetaphy-upgrade.timer runs), against a
// stand-in journalctl, zetaphyd and update step. The 2026-10-29 case: the chain stops at a voted upgrade the
// running binary lacks ("UPGRADE "zetaphy-v5" NEEDED at height: 123522"); the node must move to the current
// release by itself, once, and wait instead of looping when that fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JOIN_SH = new URL('../../zetaphy-chain/join-validator.sh', import.meta.url).pathname;
const NEEDED = 'Oct 29 10:59:47 node zetaphyd[1]: 10:59AM ERR UPGRADE "zetaphy-v5" NEEDED at height: 123522:  module=x/upgrade';

function node({ journal = '', height = '123521', update = 'ok' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zetaphy-upgw-'));
  const exe = (name, body) => { writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`); chmodSync(join(d, name), 0o755); };
  writeFileSync(join(d, 'journal.txt'), journal);
  exe('journalctl', `cat ${d}/journal.txt`);
  exe('zetaphyd', height === null ? 'exit 1' : `echo '{"sync_info":{"latest_block_height":"${height}","catching_up":false}}'`);
  exe('fake-update', `echo run >> ${d}/update.log; ${update === 'ok' ? 'exit 0' : 'exit 1'}`);
  exe('systemctl', `echo "$*" >> ${d}/systemctl.log`);
  const env = {
    ZETAPHYD: join(d, 'zetaphyd'), JOURNALCTL: join(d, 'journalctl'), SYSTEMCTL: join(d, 'systemctl'),
    UPGRADE_CMD: join(d, 'fake-update'), STATE: join(d, 'state'), NODE_HOME: d, KEYS_DIR: d, LIB: d,
    SYSTEMD_UNITS: d, NODE_USER: 'no-such-user-zetaphy-test', PATH: `${d}:${process.env.PATH}`,
  };
  const run = (cmd = 'upgrade-watch') => {
    const r = spawnSync('bash', [JOIN_SH, cmd], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const updates = () => (existsSync(join(d, 'update.log')) ? readFileSync(join(d, 'update.log'), 'utf8').trim().split('\n').filter(Boolean).length : 0);
  return { run, updates, dir: d };
}

test('no upgrade in the log: nothing happens', () => {
  const n = node({ journal: '10:59AM INF committed state height=123510\n' });
  const r = n.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(n.updates(), 0);
});

test('stopped at a voted upgrade this binary lacks: moves to the current release once', () => {
  const n = node({ journal: `noise\n${NEEDED}\n` });
  const r = n.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stopped at block 123522 for the voted upgrade "zetaphy-v5"/);
  assert.equal(n.updates(), 1);
  // the next minute: already done within the hour, no second update
  const r2 = n.run();
  assert.equal(r2.code, 0, r2.out);
  assert.match(r2.out, /tried within the hour/);
  assert.equal(n.updates(), 1);
});

test('the node already passed the height (the upgrade applied): nothing happens', () => {
  const n = node({ journal: NEEDED, height: '123530' });
  n.run();
  assert.equal(n.updates(), 0);
});

test('the node is down (no status answer) at the upgrade: still moves to the release', () => {
  const n = node({ journal: NEEDED, height: null });
  assert.equal(n.run().code, 0);
  assert.equal(n.updates(), 1);
});

test('no release yet: fails, and tries again next minute (no hour-long wait)', () => {
  const n = node({ journal: NEEDED, update: 'fail' });
  const r = n.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no usable release yet/);
  n.run();
  assert.equal(n.updates(), 2, 'retried, since the failed try left no mark');
});

test('usage lists upgrade-watch, and only the header', () => {
  const r = spawnSync('bash', [JOIN_SH, 'no-such-command'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /zetaphy-validator upgrade-watch/);
  assert.ok(!r.stdout.includes('set -euo'), r.stdout);
});
