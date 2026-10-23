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

// "preflight": which machines can run a validator, and what it tells people on the others.
function preflight({ os = 'Linux', wsl = false, systemd = true, conf = '' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zetaphy-pre-'));
  writeFileSync(join(d, 'version'), wsl ? 'Linux version 5.15.153.1-microsoft-standard-WSL2' : 'Linux version 6.8.0-45-generic');
  if (conf) writeFileSync(join(d, 'wsl.conf'), conf);
  const env = { UNAME_S: os, PROC_VERSION: join(d, 'version'), SYSTEMD_DIR: systemd ? d : join(d, 'none'), WSL_CONF: join(d, 'wsl.conf') };
  const r = spawnSync('bash', [JOIN_SH, 'preflight'], { encoding: 'utf8', env: { ...process.env, ...env } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), conf: existsSync(join(d, 'wsl.conf')) ? readFileSync(join(d, 'wsl.conf'), 'utf8') : '' };
}

test('preflight: any Linux with systemd (cloud or home) can run a validator', () => {
  const r = preflight();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /this machine can run a ZETAPHY validator/);
  assert.doesNotMatch(r.out, /WSL/);
});

test('preflight: WSL without systemd switches it on and says to restart WSL; with systemd it works', () => {
  const off = preflight({ wsl: true, systemd: false, conf: '[network]\nhostname=pc\n' });
  assert.equal(off.code, 1);
  assert.match(off.out, /wsl --shutdown/);
  assert.match(off.conf, /\[network\]\nhostname=pc\n\n\[boot\]\nsystemd=true\n/);
  const on = preflight({ wsl: true });
  assert.equal(on.code, 0, on.out);
  assert.match(on.out, /keep one Ubuntu window open/);
});

test('preflight: macOS, Windows shells and containers get told what to use instead', () => {
  assert.match(preflight({ os: 'Darwin' }).out, /multipass launch 24\.04/);
  assert.match(preflight({ os: 'MINGW64_NT-10.0' }).out, /wsl --install -d Ubuntu-24\.04/);
  const c = preflight({ systemd: false });
  assert.equal(c.code, 1);
  assert.match(c.out, /systemd is not running here/);
});

// "import-key": the user's own recovery phrase becomes the staking account; the node's key is kept.
function keyNode({ isValidator = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zetaphy-key-'));
  writeFileSync(join(d, 'zetaphyd'), `#!/bin/bash
echo "$*" >> ${d}/calls.log
case "$1 $2" in
  "keys add") cat > ${d}/stdin.txt; echo ok ;;
  "keys show") case "$*" in *"--bech val"*) echo zetaphyvaloper1new ;; *) echo zetaphy1new ;; esac ;;
  "keys delete"|"keys rename") : ;;
  "debug addr") echo "Address hex: 0x00000000000000000000000000000000000000CD" ;;
  "q staking") ${isValidator ? `echo '{"validator":{}}'` : 'exit 1'} ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`);
  chmodSync(join(d, 'zetaphyd'), 0o755);
  const env = { ZETAPHYD: join(d, 'zetaphyd'), LIB: d, STATE: join(d, 'state'), NODE_HOME: d, KEYS_DIR: d, NODE_USER: 'no-such-user-zetaphy-test', IMPORT_TEST: 1 };
  const run = (input, extra = {}) => {
    const r = spawnSync('bash', [JOIN_SH, 'import-key'], { input, encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const log = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8') : '');
  return { run, log };
}
const PHRASE = 'test test test test test test test test test test test junk';

test('import-key: the phrase goes in on stdin (never as an argument); the node key is renamed, not deleted', () => {
  const n = keyNode();
  const r = n.run(`  ${PHRASE.toUpperCase()}  \n`, { ACCOUNT_INDEX: '2' });
  assert.equal(r.code, 0, r.out);
  assert.equal(n.log('stdin.txt'), `${PHRASE}\n`);
  const calls = n.log('calls.log');
  assert.doesNotMatch(calls, /junk/);
  assert.match(calls, /keys add imported --recover --algo eth_secp256k1 --coin-type 60 --index 2/);
  assert.match(calls, /keys rename validator validator-made-by-node -y/);
  assert.match(calls, /keys rename imported validator -y/);
  assert.doesNotMatch(calls, /keys delete validator -y/);
  assert.doesNotMatch(r.out, /junk/);
  assert.match(r.out, /staking account is now: zetaphy1new/);
});

test('import-key: refuses a wrong word count, a bad index, and a node that already staked', () => {
  assert.match(keyNode().run('one two three\n').out, /expected 12 or 24 words, got 3/);
  assert.match(keyNode().run(`${PHRASE}\n`, { ACCOUNT_INDEX: 'x' }).out, /ACCOUNT_INDEX must be a number/);
  const v = keyNode({ isValidator: true }).run(`${PHRASE}\n`);
  assert.equal(v.code, 1);
  assert.match(v.out, /already staked/);
});
