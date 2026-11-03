// zetaphy-chain/wireguard/pq-link.sh: validator <-> sentry WireGuard links with a pre-shared key, against stand-in
// wg, ssh and systemctl. The PSK only travels over SSH restricted to a post-quantum key exchange (or not at all),
// every key file is private, a peer can be replaced (PSK rotation) without touching the others, and the CometBFT
// settings it writes keep the validator behind the sentry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SH = new URL('../../zetaphy-chain/wireguard/pq-link.sh', import.meta.url).pathname;
const KEY = (c) => `${c.repeat(42)}A=`; // a well-formed WireGuard key
const SENTRY_ID = 'ab'.repeat(20);
const VAL_ID = 'cd'.repeat(20);

function machine({ kex = 'curve25519-sha256\nsntrup761x25519-sha512@openssh.com\nmlkem768x25519-sha256', sshFails = false } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'pqlink-'));
  const exe = (name, body) => { writeFileSync(join(d, name), `#!/bin/bash\n${body}\n`); chmodSync(join(d, name), 0o755); };
  let n = 0;
  exe('wg', `case "$1" in
  genkey) echo '${KEY('k')}' ;;
  pubkey) read -r k; echo '${KEY('p')}' ;;
  genpsk) echo "$(cat ${d}/next-psk 2>/dev/null || echo '${KEY('s')}')" ;;
  show) echo "interface: $2"; echo "  preshared key: (hidden)" ;;
esac`);
  exe('ssh', `if [ "$1" = -Q ]; then printf '%s\\n' "${kex}"; exit 0; fi
echo "$@" > ${d}/ssh.args; cat > ${d}/ssh.stdin; exit ${sshFails ? 255 : 0}`);
  exe('systemctl', `echo "$@" >> ${d}/systemctl.log; [ "$1" = is-active ] && [ -f ${d}/active ] && exit 0; [ "$1" = is-active ] && exit 3; exit 0`);
  mkdirSync(join(d, 'home', 'config'), { recursive: true });
  writeFileSync(join(d, 'home', 'config', 'config.toml'), '[p2p]\nseeds = "x@1.2.3.4:26656"\npersistent_peers = ""\npex = true\naddr_book_strict = true\nprivate_peer_ids = ""\nunconditional_peer_ids = "ee"\n');
  const env = { ...process.env, WG_DIR: join(d, 'etc-wg'), NODE_HOME: join(d, 'home'), WG: join(d, 'wg'), SSH: join(d, 'ssh'), SYSTEMCTL: join(d, 'systemctl') };
  const run = (...args) => { const r = spawnSync('bash', [SH, ...args], { encoding: 'utf8', env }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };
  const read = (f) => (existsSync(join(d, f)) ? readFileSync(join(d, f), 'utf8') : '');
  const mode = (f) => statSync(join(d, f)).mode & 0o777;
  return { run, read, mode, dir: d };
}

test('init, psk, peer, up: a private config with the pre-shared key; status shows it in use', () => {
  const m = machine();
  let r = m.run('init', '10.77.0.1/24');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`public key of this machine.*${KEY('p').replace(/[\\^$.*+?()[\]{}|/=-]/g, '\\$&')}`));
  assert.equal(m.mode('etc-wg/zetaphy-pq.conf'), 0o600);
  assert.match(m.read('etc-wg/zetaphy-pq.conf'), /^Address = 10\.77\.0\.1\/24$/m);
  assert.notEqual(m.run('init', '10.77.0.1/24').code, 0, 'never overwrites an existing key');
  assert.notEqual(m.run('peer', 'sentry-1', KEY('q'), '10.77.0.2').code, 0, 'no peer without its PSK');
  assert.notEqual(m.run('up').code, 0, 'no tunnel without a PSK');
  assert.equal(m.run('psk', 'sentry-1').code, 0);
  assert.equal(m.mode('etc-wg/zetaphy-pq-sentry-1.psk'), 0o600);
  r = m.run('peer', 'sentry-1', KEY('q'), '10.77.0.2', 'sentry.example:51820');
  assert.equal(r.code, 0, r.out);
  const conf = m.read('etc-wg/zetaphy-pq.conf');
  assert.match(conf, new RegExp(`^PresharedKey = ${KEY('s')}$`, 'm'));
  assert.match(conf, /^AllowedIPs = 10\.77\.0\.2\/32$/m);
  assert.match(conf, /^Endpoint = sentry\.example:51820$/m);
  assert.equal(m.mode('etc-wg/zetaphy-pq.conf'), 0o600);
  assert.equal(m.run('up').code, 0);
  assert.match(m.read('systemctl.log'), /enable --now wg-quick@zetaphy-pq/);
  writeFileSync(join(m.dir, 'active'), '');
  assert.equal(m.run('up').code, 0);
  assert.match(m.read('systemctl.log'), /reload wg-quick@zetaphy-pq/, 'a running tunnel is reloaded, not restarted');
  assert.match(m.run('status').out, /preshared key: \(hidden\)/);
});

test('rotation: a new PSK replaces the peer\'s block only', () => {
  const m = machine();
  m.run('init', '10.77.0.1/24');
  m.run('psk', 'sentry-1'); m.run('peer', 'sentry-1', KEY('q'), '10.77.0.2');
  m.run('psk', 'sentry-2'); m.run('peer', 'sentry-2', KEY('r'), '10.77.0.3');
  writeFileSync(join(m.dir, 'next-psk'), `${KEY('t')}\n`);
  m.run('psk', 'sentry-1');
  assert.equal(m.run('peer', 'sentry-1', KEY('q'), '10.77.0.2').code, 0);
  const conf = m.read('etc-wg/zetaphy-pq.conf');
  assert.equal((conf.match(/^\[Peer\]$/gm) ?? []).length, 2);
  assert.equal((conf.match(/^\[Interface\]$/gm) ?? []).length, 1);
  assert.match(conf, new RegExp(`PublicKey = ${KEY('q')}\nPresharedKey = ${KEY('t')}`));
  assert.match(conf, new RegExp(`PublicKey = ${KEY('r')}\nPresharedKey = ${KEY('s')}`), 'the other peer keeps its key');
});

test('send-psk: SSH limited to post-quantum key exchanges, or nothing is sent', () => {
  const m = machine();
  m.run('psk', 'validator');
  let r = m.run('send-psk', 'validator', 'root@10.0.0.9', 'validator-0');
  assert.equal(r.code, 0, r.out);
  const args = m.read('ssh.args');
  assert.match(args, /KexAlgorithms=mlkem768x25519-sha256,sntrup761x25519-sha512@openssh\.com root@10\.0\.0\.9/);
  assert.doesNotMatch(args, /curve25519-sha256[,\s]/, 'no classical-only fallback');
  assert.match(args, /zetaphy-pq-validator-0\.psk/);
  assert.equal(m.read('ssh.stdin').trim(), KEY('s'), 'the PSK goes over stdin, never on a command line');
  const old = machine({ kex: 'curve25519-sha256\necdh-sha2-nistp256' });
  old.run('psk', 'validator');
  r = old.run('send-psk', 'validator', 'root@10.0.0.9', 'v');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /no post-quantum key exchange/);
  assert.equal(old.read('ssh.args'), '', 'ssh never ran');
  const refused = machine({ sshFails: true });
  refused.run('psk', 'validator');
  assert.match(refused.run('send-psk', 'validator', 'root@10.0.0.9', 'v').out, /not sent/);
  assert.notEqual(m.run('send-psk', 'validator', 'root@host;rm -rf /', 'v').code, 0, 'the target is checked');
  assert.notEqual(m.run('send-psk', 'nobody', 'root@h').code, 0, 'no PSK, nothing to send');
});

test('CometBFT: the validator peers only with the sentry over the tunnel; the sentry keeps it private', () => {
  const v = machine();
  assert.notEqual(v.run('comet-validator', 'nope').code, 0);
  let r = v.run('comet-validator', `${SENTRY_ID}@10.77.0.2`);
  assert.equal(r.code, 0, r.out);
  const cfg = v.read('home/config/config.toml');
  assert.match(cfg, new RegExp(`^persistent_peers = "${SENTRY_ID}@10\\.77\\.0\\.2:26656"$`, 'm'));
  assert.match(cfg, /^seeds = ""$/m);
  assert.match(cfg, /^pex = false$/m);
  assert.match(cfg, /^addr_book_strict = false$/m);
  assert.match(v.read('home/config/config.toml.before-pq-link'), /^pex = true$/m, 'backup kept');
  const s = machine();
  r = s.run('comet-sentry', VAL_ID);
  assert.equal(r.code, 0, r.out);
  s.run('comet-sentry', VAL_ID);
  const sc = s.read('home/config/config.toml');
  assert.match(sc, new RegExp(`^private_peer_ids = "${VAL_ID}"$`, 'm'));
  assert.match(sc, new RegExp(`^unconditional_peer_ids = "ee,${VAL_ID}"$`, 'm'), 'added once, existing ids kept');
  assert.match(sc, /^pex = true$/m, 'the sentry keeps talking to the public network');
});

test('usage and bad input', () => {
  const m = machine();
  const r = m.run();
  assert.equal(r.code, 2);
  assert.match(r.out, /post-quantum pre-shared key/);
  assert.notEqual(m.run('init', '10.77.0.1').code, 0);
  assert.notEqual(m.run('psk', 'Bad Name').code, 0);
  m.run('init', '10.77.0.1/24'); m.run('psk', 'x');
  assert.notEqual(m.run('peer', 'x', 'notakey', '10.77.0.2').code, 0);
  assert.notEqual(m.run('peer', 'x', KEY('q'), '10.77.0.2', 'bad endpoint').code, 0);
});
