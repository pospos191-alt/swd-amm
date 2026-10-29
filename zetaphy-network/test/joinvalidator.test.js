// zetaphy-chain/join-validator.sh "check" (what the 10-minute timer runs), against a stand-in
// zetaphyd, curl, systemctl and setup-node.sh: it waits while the node syncs, asks the faucet at
// most once a day while the balance is short, stakes once synced and funded, and stops the timer
// once the chain knows the validator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  const check = (extra = {}) => {
    const r = spawnSync('bash', [JOIN_SH, 'check'], { encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
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

test('balances above 9.22 ZETAPHY (2^63 azetaphy) show right, with no printf overflow', () => {
  const r = node({ balance: '10000000000000000000' }).check({ STAKE: '11' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /waiting for funds: 10\.00 ZETAPHY, needs 11\.10/);
  assert.doesNotMatch(r.out, /out of range|warning/i);
  assert.match(node({ balance: '123456789000000000000000000' }).check({ STAKE: '200000000' }).out, /123456789\.00 ZETAPHY/);
});

// Runs one function of join-validator.sh (with asn and die) in a scratch NODE_HOME.
function fn(name, extra = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zjv-'));
  mkdirSync(join(d, 'config'));
  writeFileSync(join(d, 'config', 'app.toml'), '[json-rpc]\nenable = true\naddress = "0.0.0.0:8545"\nws-address = "127.0.0.1:8546"\n[grpc]\naddress = "localhost:9090"\n');
  writeFileSync(join(d, 'systemctl'), `#!/bin/sh\necho "$@" >> ${d}/systemctl.log\n[ "$1" = is-enabled ] && exit ${extra.caddy === false ? 1 : 0}\nexit 0\n`);
  chmodSync(join(d, 'systemctl'), 0o755);
  const src = readFileSync(JOIN_SH, 'utf8');
  const pick = (f) => src.match(new RegExp(`^${f}\\(\\) \\{[\\s\\S]*?^\\}`, 'm'))[0];
  const asn = src.match(/^asn\(\) .*$/m)[0];
  const die = src.match(/^die\(\) .*$/m)[0];
  const r = spawnSync('bash', ['-c', `${asn}\n${die}\n${pick(name)}\n${name}`], { encoding: 'utf8', env: { ...process.env, NODE_HOME: d, SYSTEMCTL: join(d, 'systemctl'), NODE_USER: 'no-such-user-zetaphy-test', ...extra.env } });
  const read = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8') : '');
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), app: read('config/app.toml'), sys: read('systemctl.log') };
}

test('a joined validator keeps its RPC to itself: 8545 on localhost, no https proxy (PUBLIC_RPC=1 keeps them)', () => {
  const r = fn('private_rpc');
  assert.equal(r.code, 0, r.out);
  assert.match(r.app, /^address = "127\.0\.0\.1:8545"$/m);
  assert.match(r.app, /^address = "localhost:9090"$/m, 'other sections untouched');
  assert.match(r.sys, /disable --now caddy/);
  assert.match(r.sys, /restart zetaphyd/);
  const again = fn('private_rpc', { caddy: false });
  assert.doesNotMatch(again.sys, /disable/);
  const pub = fn('private_rpc', { env: { PUBLIC_RPC: '1' } });
  assert.match(pub.app, /^address = "0\.0\.0\.0:8545"$/m);
  assert.equal(pub.sys, '');
});

test('MONIKER: letters, digits, . _ - only (it goes into commands and a systemd unit)', () => {
  for (const ok of ['', 'my-node', 'Node_1.a']) assert.equal(fn('check_moniker', { env: { MONIKER: ok } }).code, 0, ok);
  for (const bad of ['a b', 'x;reboot', 'x$(id)', 'x"y', 'a'.repeat(41), 'x\nExecStart=/bin/sh']) {
    const r = fn('check_moniker', { env: { MONIKER: bad } });
    assert.notEqual(r.code, 0, bad);
    assert.match(r.out, /MONIKER: use only/);
  }
});

// "secure": after the backup, the plaintext words go, SSH takes keys only (never locking the owner out),
// security updates and fail2ban come on, key files get tight permissions, open ports are reported.
function secureBox({ keyUser = true, sudo = true, oslogin = false, sshdOk = true, keyring = true, include = true, listen = '' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zsec-'));
  const p = (...x) => join(d, ...x);
  const exe = (name, body) => { writeFileSync(p('bin', name), `#!/bin/bash\n${body}\n`); chmodSync(p('bin', name), 0o755); };
  for (const x of ['bin', 'node/config', 'node/data', 'keys/keyring-test', 'home/ubuntu/.ssh', 'home/ubuntu/zbackup', 'root', 'ssh/sshd_config.d', 'apt', 'f2b', 'sudoers', 'run']) mkdirSync(p(x), { recursive: true });
  writeFileSync(p('keys', 'MNEMONICS-KEEP-SECRET.txt'), 'validator abandon abandon about\n', { mode: 0o644 });
  writeFileSync(p('keys', 'keyring-test', 'validator.info'), 'k', { mode: 0o644 });
  writeFileSync(p('home/ubuntu/zbackup/MNEMONICS-KEEP-SECRET.txt'), 'validator abandon abandon about\n');
  writeFileSync(p('home/ubuntu/zbackup/priv_validator_key.json'), '{}');
  for (const f of ['priv_validator_key.json', 'node_key.json', 'pq_vote_key.seed']) writeFileSync(p('node/config', f), 'x', { mode: 0o644 });
  writeFileSync(p('node/data/priv_validator_state.json'), '{}', { mode: 0o644 });
  writeFileSync(p('ssh/sshd_config'), include ? 'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n' : 'Port 22\n');
  if (keyUser) writeFileSync(p('home/ubuntu/.ssh/authorized_keys'), 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA user@pc\n');
  writeFileSync(p('passwd'), `root:x:0:0:root:${p('root')}:/bin/bash\nubuntu:x:1000:1000::${p('home/ubuntu')}:/bin/bash\nnobody:x:65534:65534::/nonexistent:/usr/sbin/nologin\n`);
  writeFileSync(p('nsswitch.conf'), oslogin ? 'passwd: files cache_oslogin oslogin\n' : 'passwd: files systemd\n');
  exe('id', `if [ "$1" = -nG ]; then [ "$2" = ubuntu ] && echo "ubuntu adm ${sudo ? 'sudo' : 'users'}"; exit 0; fi\nif [ "$1" = zetaphy-no-user ]; then exit 1; fi\nexec /usr/bin/id "$@"`);
  exe('sshd', `echo "sshd $*" >> ${p('calls.log')}\n[ "$1" = -T ] && { echo "passwordauthentication no"; exit 0; }\nexit ${sshdOk ? 0 : 1}`);
  exe('zetaphyd', `[ "$1 $2 $3" = "keys show validator" ] && { ${keyring ? 'echo zetaphy1abc; exit 0' : 'exit 1'}; }\nexit 1`);
  exe('systemctl', `echo "systemctl $*" >> ${p('calls.log')}\n[ "$1" = is-active ] && exit 3\nexit 0`);
  exe('apt-get', `echo "apt-get $*" >> ${p('calls.log')}`);
  exe('apt-cache', 'exit 0');
  exe('dpkg', 'exit 1');
  exe('ss', `printf '%s' '${listen}'`);
  const env = {
    SECURE_TEST: '1', SECURE_TTY: p('no-tty'), NODE_USER: 'zetaphy-no-user', NODE_HOME: p('node'), KEYS_DIR: p('keys'),
    ZETAPHYD: p('bin', 'zetaphyd'), SYSTEMCTL: p('bin', 'systemctl'), SSHD: p('bin', 'sshd'), SSHD_DIR: p('ssh'), RUN_SSHD: p('run', 'sshd'),
    NSSWITCH: p('nsswitch.conf'), SUDOERS_DIR: p('sudoers'), PASSWD_FILE: p('passwd'), HOME_BASE: p('home'), ROOT_HOME: p('root'),
    APT_CONF_DIR: p('apt'), F2B_DIR: p('f2b'), PATH: `${p('bin')}:${process.env.PATH}`,
  };
  const run = (args, input = '') => {
    const r = spawnSync('bash', [JOIN_SH, 'secure', ...args], { input, encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const has = (...x) => existsSync(p(...x));
  const read = (...x) => (has(...x) ? readFileSync(p(...x), 'utf8') : '');
  const mode = (...x) => (statSync(p(...x)).mode & 0o777).toString(8);
  return { run, has, read, mode };
}

test('secure words: shreds the plaintext words and zbackup copies only after "y"; the node keys stay', () => {
  const no = secureBox();
  const r0 = no.run(['--only', 'words'], 'n\n');
  assert.equal(r0.code, 0, r0.out);
  assert.match(r0.out, /kept\. Run secure again/);
  assert.ok(no.has('keys', 'MNEMONICS-KEEP-SECRET.txt'));
  assert.doesNotMatch(r0.out, /abandon/, 'the words are never printed');

  const b = secureBox();
  const r = b.run(['--only', 'words'], 'y\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /shredded: .*keys\/MNEMONICS-KEEP-SECRET\.txt/);
  assert.match(r.out, /shredded: .*zbackup\/priv_validator_key\.json/);
  assert.ok(!b.has('keys', 'MNEMONICS-KEEP-SECRET.txt') && !b.has('home', 'ubuntu', 'zbackup'));
  for (const f of ['priv_validator_key.json', 'node_key.json', 'pq_vote_key.seed']) assert.ok(b.has('node', 'config', f), f);
  assert.ok(b.has('keys', 'keyring-test', 'validator.info'), 'the keyring stays');
  assert.match(r.out, /What stays on this machine/);
  assert.match(b.run(['--only', 'words']).out, /no plaintext recovery words left/, 'idempotent');
});

test('secure words: --yes alone keeps them (needs --words-saved); a keyring without the key keeps them', () => {
  const y = secureBox();
  assert.match(y.run(['--yes', '--only', 'words']).out, /only when --words-saved is given too/);
  assert.ok(y.has('keys', 'MNEMONICS-KEEP-SECRET.txt'));
  y.run(['--yes', '--words-saved', '--only', 'words']);
  assert.ok(!y.has('keys', 'MNEMONICS-KEEP-SECRET.txt'));
  const k = secureBox({ keyring: false });
  assert.match(k.run(['--only', 'words'], 'y\n').out, /not in this node's keyring/);
  assert.ok(k.has('keys', 'MNEMONICS-KEEP-SECRET.txt'));
});

test('secure ssh: keys only and no root login, via a drop-in checked with sshd -t; never without a key user', () => {
  const b = secureBox();
  const r = b.run(['--only', 'ssh'], 'y\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /accounts log in with an SSH key and can use sudo: ubuntu/);
  const conf = b.read('ssh', 'sshd_config.d', '60-zetaphy.conf');
  for (const l of ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin no']) assert.match(conf, new RegExp(`^${l}$`, 'm'));
  assert.match(b.read('calls.log'), /sshd -t\n[\s\S]*systemctl reload ssh/);
  assert.match(b.run(['--only', 'ssh']).out, /already set/);

  for (const opts of [{ keyUser: false }, { sudo: false }]) {
    const n = secureBox(opts);
    assert.match(n.run(['--only', 'ssh'], 'y\n').out, /WARNING: skipped/, JSON.stringify(opts));
    assert.ok(!n.has('ssh', 'sshd_config.d', '60-zetaphy.conf'));
  }
  const g = secureBox({ keyUser: false, oslogin: true });
  assert.match(g.run(['--only', 'ssh'], 'y\n').out, /OS Login is on/);
  assert.ok(g.has('ssh', 'sshd_config.d', '60-zetaphy.conf'));

  const bad = secureBox({ sshdOk: false });
  assert.match(bad.run(['--only', 'ssh'], 'y\n').out, /rolled back/);
  assert.ok(!bad.has('ssh', 'sshd_config.d', '60-zetaphy.conf'));
  assert.doesNotMatch(bad.read('calls.log'), /reload/);
  const old = secureBox({ include: false });
  assert.match(old.run(['--only', 'ssh'], 'y\n').out, /does not read sshd_config\.d/);
  const no = secureBox();
  assert.match(no.run(['--only', 'ssh'], 'n\n').out, /skipped/);
  assert.ok(!no.has('ssh', 'sshd_config.d', '60-zetaphy.conf'));
});

test('secure perms, updates, fail2ban and ports', () => {
  const b = secureBox({ listen: 'tcp LISTEN 0 4096 0.0.0.0:26656 0.0.0.0:* users:(("zetaphyd",pid=1,fd=3))\ntcp LISTEN 0 128 [::]:22 [::]:*\ntcp LISTEN 0 4096 127.0.0.1:26657 0.0.0.0:*\ntcp LISTEN 0 4096 0.0.0.0:9090 0.0.0.0:* users:(("zetaphyd",pid=1,fd=9))\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\n' });
  const r = b.run(['--yes', '--only', 'perms,updates,fail2ban,ports']);
  assert.equal(r.code, 0, r.out);
  assert.equal(b.mode('keys'), '700');
  assert.equal(b.mode('keys', 'keyring-test', 'validator.info'), '600');
  assert.equal(b.mode('node', 'config'), '700');
  for (const f of ['priv_validator_key.json', 'node_key.json', 'pq_vote_key.seed']) assert.equal(b.mode('node', 'config', f), '600', f);
  assert.equal(b.mode('node', 'data', 'priv_validator_state.json'), '600');
  assert.match(b.read('calls.log'), /apt-get .*install -y -qq unattended-upgrades/);
  assert.match(b.read('apt', '20auto-upgrades'), /Unattended-Upgrade "1"/);
  assert.match(b.read('f2b', 'zetaphy-sshd.local'), /\[sshd\]\nenabled = true/);
  assert.match(r.out, /tcp 0\.0\.0\.0:9090 \(zetaphyd\)/);
  assert.doesNotMatch(r.out, /:26657|:26656 \(|\[::\]:22 /);
  assert.match(b.run(['--only', 'perms']).out, /done \(0 changed\)/);
});
