// `zetaphy-validator status` diagnostics (item 22, zetaphy-chain/join-validator.sh diagnose / jail_eta): sync, peers,
// disk, missed blocks and jail risk with a time estimate, each with advice in plain words. Against stand-ins for
// zetaphyd, curl and df (as test/joinvalidator.test.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JOIN_SH = new URL('../../zetaphy-chain/join-validator.sh', import.meta.url).pathname;

function box({ catchingUp = false, isValidator = true, jailed = false, missed = 0, window = 10000, minSigned = '0.050000000000000000', peers = 8, usedPct = 40, tombstoned = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zvs-'));
  const exe = (name, body) => { writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`); chmodSync(join(d, name), 0o755); };
  const status = { sync_info: { latest_block_height: '11000', latest_block_time: '2026-10-28T10:00:00Z', earliest_block_height: '1000', earliest_block_time: '2026-10-28T07:13:20Z', catching_up: catchingUp } };
  exe('zetaphyd', `
case "$1 $2" in
  "keys show") case "$*" in *"--bech val"*) echo zetaphyvaloper1abc ;; *) echo zetaphy1abc ;; esac ;;
  "debug addr") echo "Address hex: 0x00000000000000000000000000000000000000AB" ;;
  "status --home"*) echo '${JSON.stringify(status)}' ;;
  "q staking") ${isValidator ? `echo '{"validator":{"status":"BOND_STATUS_BONDED","jailed":${jailed},"tokens":"9"}}'` : 'echo "not found" >&2; exit 1'} ;;
  "q bank") echo '{"balance":{"denom":"azetaphy","amount":"9100000000000000000"}}' ;;
  "comet show-address") echo zetaphyvalcons1xyz ;;
  "q slashing") case "$3" in
      signing-info) echo '{"val_signing_info":{"address":"zetaphyvalcons1xyz","missed_blocks_counter":"${missed}","tombstoned":${tombstoned},"jailed_until":"1970-01-01T00:00:00Z"}}' ;;
      params) echo '{"params":{"signed_blocks_window":"${window}","min_signed_per_window":"${minSigned}","downtime_jail_duration":"600s"}}' ;;
    esac ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`);
  exe('curl', `case "$*" in *net_info*) echo '{"result":{"n_peers":"${peers}"}}' ;; *) exit 7 ;; esac`);
  exe('df', `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"; echo "/dev/sda1 100000000 ${usedPct * 1000000} ${(100 - usedPct) * 1000000} ${usedPct}% /"`);
  const env = { ...process.env, ZETAPHYD: join(d, 'zetaphyd'), DF: join(d, 'df'), NODE_HOME: d, KEYS_DIR: d, STATE: join(d, 'state'), NODE_USER: 'no-such-user-zetaphy-test', PATH: `${d}:${process.env.PATH}` };
  const r = spawnSync('bash', [JOIN_SH, 'status'], { encoding: 'utf8', env });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/** jail_eta / human_secs alone (pure arithmetic). */
function fn(call) {
  const src = readFileSync(JOIN_SH, 'utf8');
  const pick = (f) => src.match(new RegExp(`^${f}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))?.[0] ?? src.match(new RegExp(`^${f}\\(\\) \\{.*\\}$`, 'm'))[0];
  return spawnSync('bash', ['-c', `${pick('jail_eta')}\n${pick('human_secs')}\n${call}`], { encoding: 'utf8' }).stdout.trim();
}

test('jail_eta: misses left before jail (window - ceil(window x min signed)) and the time at the block rate', () => {
  assert.equal(fn('jail_eta 0 10000 0.05 1'), '9500 9500');
  assert.equal(fn('jail_eta 9000 10000 0.05 2'), '500 1000');
  assert.equal(fn('jail_eta 9600 10000 0.05 1'), '0 0', 'past the limit: zero, never negative');
  assert.equal(fn('jail_eta 0 100 0.333 1'), '66 66', 'ceil(33.3) = 34 must be signed');
  assert.equal(fn('human_secs 9500'), '2h 38m');
  assert.equal(fn('human_secs 45'), '45s');
  assert.equal(fn('human_secs 200000'), '2d 7h');
});

test('a healthy validator: in sync, peers, disk, low jail risk with the time if it stopped now', () => {
  const r = box();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /== diagnostics/);
  assert.match(r.out, /sync: +in sync \(block 11000, about 1\.00s per block\)/);
  assert.match(r.out, /peers: +8$/m);
  assert.match(r.out, /disk: +40% used, 57 GB free$/m);
  assert.match(r.out, /missed: +0 of the last 10000 blocks \(at least 5% must be signed\)/);
  assert.match(r.out, /jail risk: low: 9500 more missed blocks allowed; .* about 2h 38m/);
});

test('trouble spotted, with advice: catching up, no peers, a nearly full disk, many missed blocks', () => {
  const r = box({ catchingUp: true, peers: 0, usedPct: 96, missed: 9200 });
  assert.match(r.out, /sync: +catching up .*Advice: wait/);
  assert.match(r.out, /peers: +0\. Advice: .*26656/);
  assert.match(r.out, /disk: +96% used.*URGENT/);
  assert.match(r.out, /jail risk: medium: 300 more missed blocks allowed, about 5m if the node stopped now\. Advice: find why/);
  assert.match(box({ missed: 9500 }).out, /jail risk: HIGH, the next missed block jails/);
  assert.match(box({ peers: 2, usedPct: 88 }).out, /peers: +2 \(few\)[\s\S]*disk: +88% used.*free space soon/);
});

test('jailed, tombstoned, not a validator yet', () => {
  assert.match(box({ jailed: true }).out, /jail risk: JAILED now .*sudo zetaphy-validator unjail/);
  assert.match(box({ tombstoned: true }).out, /TOMBSTONED/);
  const r = box({ isValidator: false });
  assert.equal(r.code, 0);
  assert.match(r.out, /jail risk: not a validator yet/);
});
