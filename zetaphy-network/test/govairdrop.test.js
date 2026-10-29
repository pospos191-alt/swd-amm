// zetaphy-chain/gov.sh airdrop: a testnet airdrop from a list. A stand-in zetaphyd answers `debug addr`,
// `keys show`, `q bank balances` and records each `tx bank send / multi-send` it is asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GOV = new URL('../../zetaphy-chain/gov.sh', import.meta.url).pathname;
// valid bech32 characters only (no 1, b, i, o after the prefix)
const addr = (n) => `zetaphy1${String(n).padStart(4, '0').replace(/[1bio]/g, 'q')}${'q'.repeat(34)}`;
const HEX = '0x' + 'ab'.repeat(20);
const HEX_AS = addr(9999);

function chain({ balance = '1000000000000000000000000' /* 1,000,000 ZETAPHY */ } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'zetaphy-airdrop-'));
  const log = join(d, 'tx.log');
  writeFileSync(join(d, 'zetaphyd'), `#!/bin/bash
case "$1 $2" in
  "debug addr") [ "$3" = "${HEX}" ] && printf 'Address bytes: [1 2]\\nAddress hex: ${HEX}\\nBech32 Acc: ${HEX_AS}\\n'; exit 0 ;;
  "keys show") echo zetaphy1fundfundfundfundfundfundfundfundfund ;;
  "q bank") echo '{"balances":[{"denom":"azetaphy","amount":"${balance}"}]}' ;;
  "tx bank") echo "$*" >> ${log}; echo '{"code":0,"txhash":"AB"}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac`);
  chmodSync(join(d, 'zetaphyd'), 0o755);
  const run = (list, args = [], env = {}) => {
    const f = join(d, 'list.txt');
    writeFileSync(f, list);
    const r = spawnSync('bash', [GOV, 'airdrop', f, ...args], {
      encoding: 'utf8', input: '',
      env: { ...process.env, ZETAPHYD: join(d, 'zetaphyd'), NODE_HOME: d, KEYS_DIR: d, PATH: `${d}:${process.env.PATH}`, ...env },
    });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const txs = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);
  const ledger = () => (existsSync(join(d, 'airdrop-paid.txt')) ? readFileSync(join(d, 'airdrop-paid.txt'), 'utf8').trim().split('\n').filter(Boolean) : []);
  return { run, txs, ledger };
}

test('dry run: checks, converts 0x, drops repeats and bad lines, shows the total, sends nothing', () => {
  const c = chain();
  const r = c.run(`# testers\n${addr(2)}\n${HEX}\n${addr(2)}\nnot-an-address\n${addr(3)},250\n`);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 addresses, 450 ZETAPHY in all; the fund has 1000000 ZETAPHY/);
  assert.match(r.out, /skipped: 1 bad, 1 repeated, 0 paid before/);
  assert.match(r.out, /dry run: nothing sent/);
  assert.deepEqual(c.txs(), []);
});

test('SEND=1: one multi-send per amount and per 50 addresses, then each address is paid only once', () => {
  const c = chain();
  const many = Array.from({ length: 60 }, (_, i) => addr(i + 10)).join('\n');
  const r = c.run(`${many}\n${HEX}\n${addr(5)},7\n`, [], { SEND: '1', BATCH: '50' });
  assert.equal(r.code, 0, r.out);
  const t = c.txs();
  assert.equal(t.length, 3, t.join('\n')); // 61 × 100 → 50 + 11, and 1 × 7 (a plain send)
  assert.ok(t.some((x) => x.startsWith('tx bank send community') && x.includes('7000000000000000000azetaphy')));
  const multi = t.filter((x) => x.startsWith('tx bank multi-send community'));
  assert.deepEqual(multi.map((x) => x.split(' ').filter((w) => w.startsWith('zetaphy1')).length).sort((a, b) => a - b), [11, 50]);
  assert.ok(multi.every((x) => x.includes(' 100000000000000000000azetaphy')));
  assert.ok(t.join(' ').includes(HEX_AS), 'the 0x address went as zetaphy1…');
  assert.equal(c.ledger().length, 62);
  assert.match(r.out, /airdrop done: 62 addresses, 6107 ZETAPHY/);

  const again = c.run(`${many}\n${HEX}\n${addr(5)},7\n${addr(6)}\n`, [], { SEND: '1' });
  assert.match(again.out, /1 addresses, 100 ZETAPHY in all/);
  assert.match(again.out, /62 paid before/);
  assert.equal(c.txs().length, 4);
});

test('the amount per address and the key can be chosen', () => {
  const c = chain();
  const r = c.run(`${addr(2)}\n${addr(3)}\n`, ['25', 'liquidity'], { SEND: '1' });
  assert.equal(r.code, 0, r.out);
  assert.match(c.txs()[0], /^tx bank multi-send liquidity .* 25000000000000000000azetaphy/);
  assert.match(c.txs()[0], /--from liquidity/);
});

test('refused: not enough in the fund, an amount over MAX_EACH, a bad amount', () => {
  const low = chain({ balance: '50000000000000000000' }); // 50 ZETAPHY
  const r = low.run(`${addr(2)}\n`, [], { SEND: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /refused: the fund has 50 ZETAPHY, the airdrop needs 100/);
  assert.deepEqual(low.txs(), []);
  const c = chain();
  assert.match(c.run(`${addr(2)},20000\n${addr(3)}\n`).out, /skip \(amount 20000\)/);
  assert.match(c.run(`${addr(2)}\n`, ['1.5']).out, /amount: whole ZETAPHY/);
});
