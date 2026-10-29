// zetaphy-chain/horcrux/setup-horcrux.sh against a stand-in horcrux, zetaphyd and systemctl: the node's key is
// split into 3 bundles, each cosigner takes only its own pasted bundle, the switch keeps the validator's address
// in a stand-in key file (for the ML-DSA vote code) while the real key leaves the machine, cosigners start one
// height above the last one signed, and rollback never signs a height the cosigners may have signed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HX_SH = new URL('../../zetaphy-chain/horcrux/setup-horcrux.sh', import.meta.url).pathname;
const ADDR = 'AB'.repeat(20);
const KEY = JSON.stringify({ address: ADDR, pub_key: { type: 'tendermint/PubKeyEd25519', value: 'real-pub' }, priv_key: { type: 'tendermint/PrivKeyEd25519', value: 'real-priv' } });

function box() {
  const d = mkdtempSync(join(tmpdir(), 'zhx-'));
  const p = (...x) => join(d, ...x);
  for (const x of ['bin', 'node/config', 'node/data', 'cos']) mkdirSync(p(x), { recursive: true });
  const exe = (name, body) => { writeFileSync(p('bin', name), `#!/bin/bash\necho "${name} $*" >> ${p('calls.log')}\n${body}\n`); chmodSync(p('bin', name), 0o755); };
  // horcrux: makes the files the real one makes (ids 1..3), and records state set
  exe('horcrux', `
out=""; home=""; prev=""
for a in "$@"; do case "$prev" in --out) out=$a ;; --home) home=$a ;; esac; prev=$a; done
case "$1" in
  create-ecies-shards) for i in 1 2 3; do mkdir -p "$out/cosigner_$i"; echo "{\\"eciesKey\\":\\"k$i\\",\\"id\\":$i,\\"eciesPubs\\":[]}" > "$out/cosigner_$i/ecies_keys.json"; done ;;
  create-ed25519-shards) for i in 1 2 3; do echo "{\\"pubKey\\":\\"p\\",\\"privateShard\\":\\"s$i\\",\\"id\\":$i}" > "$out/cosigner_$i/zetaphy_77390-1_shard.json"; done ;;
  config) mkdir -p "$home"; { echo "signMode: threshold"; echo "thresholdMode:"; echo "  threshold: 2"; echo "  cosigners:";
          for a in "$@"; do case "$a" in tcp://*:2222) echo "  - shardID: x"; echo "    p2pAddr: $a" ;; esac; done;
          echo "chainNodes:"; for a in "$@"; do case "$a" in tcp://*:1234) echo "- privValAddr: $a" ;; esac; done; } > "$home/config.yaml" ;;
esac`);
  exe('zetaphyd', `
case "$1" in
  init) h=""; prev=""; for a in "$@"; do [ "$prev" = --home ] && h=$a; prev=$a; done; mkdir -p "$h/config"
        echo '{"address":"0000000000000000000000000000000000000000","pub_key":{"value":"new-pub"},"priv_key":{"value":"new-priv"}}' > "$h/config/priv_validator_key.json" ;;
  status) echo '{"sync_info":{"latest_block_height":"500"}}' ;;
esac`);
  exe('systemctl', '');
  writeFileSync(p('node/config/priv_validator_key.json'), KEY);
  writeFileSync(p('node/config/config.toml'), 'proxy_app = "tcp://127.0.0.1:26658"\npriv_validator_laddr = ""\n');
  writeFileSync(p('node/data/priv_validator_state.json'), '{\n  "height": "420",\n  "round": 0,\n  "step": 3\n}\n');
  const env = {
    HX_TEST: '1', TTY: p('no-tty'), HORCRUX: p('bin', 'horcrux'), ZETAPHYD: p('bin', 'zetaphyd'), SYSTEMCTL: p('bin', 'systemctl'),
    NODE_USER: 'no-such-user-zetaphy-test', HX_USER: 'no-such-user-zetaphy-test', NODE_HOME: p('node'), KEYS_DIR: p('keys'),
    WORK: p('work'), PATH: `${p('bin')}:${process.env.PATH}`,
  };
  const run = (args, input = '', extra = {}) => {
    const r = spawnSync('bash', [HX_SH, ...args], { input, encoding: 'utf8', env: { ...process.env, ...env, ...extra } });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const read = (...x) => (existsSync(p(...x)) ? readFileSync(p(...x), 'utf8') : '');
  return { run, read, p, has: (...x) => existsSync(p(...x)) };
}
const COS = { COSIGNERS: '10.0.0.11 10.0.0.12 10.0.0.13', NODE_ADDR: '10.0.0.10' };

test('shard: 3 bundles from the node key, 2 of 3, node and cosigner addresses checked', () => {
  const b = box();
  const r = b.run(['shard'], '', COS);
  assert.equal(r.code, 0, r.out);
  assert.match(b.read('calls.log'), /create-ed25519-shards --chain-id zetaphy_77390-1 --key-file .*priv_validator_key\.json --threshold 2 --shards 3/);
  assert.match(b.read('calls.log'), /config init .*--node tcp:\/\/10\.0\.0\.10:1234 .*--cosigner tcp:\/\/10\.0\.0\.11:2222 --cosigner tcp:\/\/10\.0\.0\.12:2222 --cosigner tcp:\/\/10\.0\.0\.13:2222/);
  for (const n of [1, 2, 3]) assert.ok(b.has('work', `cosigner_${n}.b64`), `bundle ${n}`);
  assert.match(b.run(['shard'], '', COS).out, /exists from an earlier run/);
  assert.match(box().run(['shard'], '', { ...COS, COSIGNERS: '10.0.0.11 10.0.0.12' }).out, /COSIGNERS: the 3 cosigner addresses/);
  assert.match(box().run(['shard'], '', { ...COS, NODE_ADDR: '1.2.3.4;reboot' }).out, /not an address/);
});

test('cosigner N takes only bundle N, pasted; start sets the height, then starts horcrux', () => {
  const b = box();
  b.run(['shard'], '', COS);
  const bundle = (n) => b.run(['bundle', String(n)]).out;
  const two = bundle(2);
  assert.match(two, /-----BEGIN ZETAPHY HORCRUX 2-----[\s\S]+-----END ZETAPHY HORCRUX 2-----/);
  const home = b.p('cos', 'h2');
  const wrong = b.run(['cosigner', '2'], bundle(3).replace(/HORCRUX 3/g, 'HORCRUX 2'), { HX_HOME: home });
  assert.notEqual(wrong.code, 0);
  assert.match(wrong.out, /for another cosigner/);
  assert.match(b.run(['cosigner', '2'], bundle(1), { HX_HOME: home }).out, /not bundle 2/);
  const r = b.run(['cosigner', '2'], two, { HX_HOME: home });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cosigner 2 ready \(bundle check [0-9a-f]{16}/);
  assert.ok(r.out.includes(two.match(/check on the cosigner: ([0-9a-f]{16})/)[1]), 'the same check on both sides');
  assert.match(b.read('cos', 'h2', 'zetaphy_77390-1_shard.json'), /"id":2/);
  assert.match(b.read('cos', 'h2', 'config.yaml'), /p2pAddr: tcp:\/\/10\.0\.0\.13:2222/);
  assert.match(r.out, /allow 2222\/tcp from 10\.0\.0\.11 10\.0\.0\.12 10\.0\.0\.13/);
  assert.match(b.run(['cosigner', '2'], two, { HX_HOME: home }).out, /already holds a shard/);
  const s = b.run(['start', '421'], '', { HX_HOME: home });
  assert.equal(s.code, 0, s.out);
  assert.match(b.read('calls.log'), /horcrux state set zetaphy_77390-1 421 --home .*h2\n[\s\S]*systemctl enable --now horcrux/);
});

test('switch: node stopped, cosigners start above the last signed height, the real key leaves, the address stays', () => {
  const b = box();
  b.run(['shard'], '', COS);
  const no = b.run(['switch'], 'n\n');
  assert.match(no.out, /nothing changed/);
  assert.equal(b.read('node/config/priv_validator_key.json'), KEY);
  const r = b.run(['switch'], 'y\nstarted\ny\n');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /sudo bash setup-horcrux\.sh start 421/);
  const k = JSON.parse(b.read('node/config/priv_validator_key.json'));
  assert.equal(k.address, ADDR, 'the ML-DSA vote code and pq-vote-key read this address');
  assert.equal(k.priv_key.value, 'new-priv', 'the real private key is gone from the node');
  assert.doesNotMatch(b.read('node/config/priv_validator_key.json'), /real-priv/);
  assert.match(b.read('node/config/config.toml'), /^priv_validator_laddr = "tcp:\/\/0\.0\.0\.0:1234"$/m);
  assert.match(b.read('node/config/HORCRUX-REMOTE-SIGNER.txt'), new RegExp(ADDR));
  assert.match(b.read('calls.log'), /systemctl stop zetaphyd[\s\S]*systemctl start zetaphyd/);
  assert.match(r.out, /allow 1234\/tcp from 10\.0\.0\.11 10\.0\.0\.12 10\.0\.0\.13/);
  assert.ok(!b.has('work'), 'shards shredded on the node');
  assert.match(b.run(['switch']).out, /already switched/);

  // rollback: the offline key back, the node signs two heights above the last block
  writeFileSync(b.p('key-backup.json'), KEY);
  assert.match(b.run(['rollback'], 'n\n', { KEY_FILE: b.p('key-backup.json') }).out, /nothing changed/);
  const rb = b.run(['rollback'], 'y\n', { KEY_FILE: b.p('key-backup.json') });
  assert.equal(rb.code, 0, rb.out);
  assert.equal(b.read('node/config/priv_validator_key.json'), KEY);
  assert.match(b.read('node/data/priv_validator_state.json'), /"height": "502"/);
  assert.match(b.read('node/config/config.toml'), /^priv_validator_laddr = ""$/m);
  assert.ok(!b.has('node/config/HORCRUX-REMOTE-SIGNER.txt') && !b.has('key-backup.json'));
});

test('rollback refuses a key file of another validator', () => {
  const b = box();
  b.run(['shard'], '', COS);
  b.run(['switch'], 'y\nstarted\nn\n');
  writeFileSync(b.p('other.json'), KEY.replace(ADDR, 'CD'.repeat(20)));
  const r = b.run(['rollback'], 'y\n', { KEY_FILE: b.p('other.json') });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not this validator's key/);
});
