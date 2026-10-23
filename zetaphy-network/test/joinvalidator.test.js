// zetaphy-chain/join-validator.sh "check" (what the 10-minute timer runs), against a stand-in
// zetaphyd, curl, systemctl and setup-node.sh: it waits while the node syncs, asks the faucet at
// most once a day while the balance is short, stakes once synced and funded, and stops the timer
// once the chain knows the validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JOIN_SH = new URL('../../zetaphy-chain/join-validator.sh', import.meta.url).pathname;

function node({ catchingUp = false, balance = '0', isValidator = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zetaphy-join-'));
  const exe = (name, body) => { writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`); chmodSync(join(d, name), 0o755); };
  exe('zetaphyd', `
case "$1 $2" in
  "keys show") case "$*" in *"--bech val"*) echo zetaphyvaloper1abc ;; *) echo zetaphy1abc ;; esac ;;
  "debug addr") echo "Address hex: 0x00000000000000000000000000000000000000AB" ;;
  "status --home"*|"status "*) echo '{"sync_info":{"latest_block_height":"5","catching_up":${catchingUp}}}' ;;
  "q staking") ${isValidator ? `echo '{"validator":{"status":"BOND_STATUS_BONDED","tokens":"9"}}'` : 'echo "not found" >&2; exit 1'} ;;
  "q bank") echo '{"balance":{"denom":"azetaphy","amount":"${balance}"}}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`);
  exe('curl', `echo "$*" >> ${d}/curl.log; echo '{"jsonrpc":"2.0","id":1,"result":"0xabc"}'`);
  exe('systemctl', `echo "$*" >> ${d}/systemctl.log`);
  writeFileSync(join(d, 'setup-node.sh'), `echo "$*" >> ${d}/setup.log\n`);
  const env = {
    ZETAPHYD: join(d, 'zetaphyd'), SYSTEMCTL: join(d, 'systemctl'), LIB: d, STATE: join(d, 'state'),
    NODE_HOME: d, KEYS_DIR: d, JOIN: 'join.example', NODE_USER: 'no-such-user-zetaphy-test', PATH: `${d}:${process.env.PATH}`,
  };
  const check = () => {
    const r = spawnSync('bash', [JOIN_SH, 'check'], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const log = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8') : '');
  return { check, log, dir: d };
}

test('while syncing: waits, stakes nothing', () => {
  const n = node({ catchingUp: true, balance: '10000000000000000000' });
  const r = n.check();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /syncing: block 5/);
  assert.equal(n.log('setup.log'), '');
});

test('synced but short of coins: asks the faucet, at most once a day', () => {
  const n = node({ balance: '9099999999999999999' });
  const r = n.check();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /waiting for funds: 9\.09 ZETAPHY, needs 9\.10/);
  assert.match(n.log('curl.log'), /https:\/\/join\.example .*zetaphy_faucet.*0x00000000000000000000000000000000000000AB/);
  n.check();
  assert.equal(n.log('curl.log').split('\n').filter(Boolean).length, 1);
  assert.equal(n.log('setup.log'), '');
  assert.match(node({ balance: '0' }).check().out, /waiting for funds: 0\.00 ZETAPHY/);
});

test('synced and funded: stakes 9 ZETAPHY (STAKE), once the balance covers it plus fees', () => {
  const n = node({ balance: '9100000000000000000' });
  const r = n.check();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /staking 9 ZETAPHY/);
  assert.equal(n.log('setup.log').trim(), '--become-validator 9');
  assert.equal(n.log('curl.log'), '');
  assert.match(node({ balance: '123000000000000000000' }).check().out, /staking 9/);
});

test('a validator already: marks it done and stops the timer', () => {
  const n = node({ isValidator: true, balance: '10000000000000000000' });
  const r = n.check();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /this node is a validator: zetaphyvaloper1abc/);
  assert.match(n.log('systemctl.log'), /disable --now zetaphy-become-validator\.timer/);
  assert.ok(existsSync(join(n.dir, 'state', 'done')));
  assert.equal(n.log('setup.log'), '');
  assert.match(n.check().out, /already a validator/);
});
