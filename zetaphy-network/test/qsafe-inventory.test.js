// The quantum-exposure inventory (src/qsafe/inventory.js) is machine-checked: every row is complete, every
// referenced repo path exists, the doc's table is generated from it, the score is consistent; plus the
// offline `zetaphy qsafe` commands (src/qsafe/cli.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Interface, keccak256, getBytes } from 'ethers';
import { INVENTORY, STATUS, IMPACT, LAYERS, checkInventory, readinessScore, summary, toMarkdownTable, TABLE_BEGIN, TABLE_END } from '../src/qsafe/inventory.js';
import { qsafeCommand } from '../src/qsafe/cli.js';
import { commitmentOf, rescueDigest } from '../src/qsafe/rescue.js';
import { pqFromSeed } from '../src/pq.js';
import { ml_dsa44 } from '@noble/post-quantum/ml-dsa.js';

const ROOT = new URL('../../', import.meta.url);
const exists = (p) => existsSync(new URL(p, ROOT));

test('every row is complete and every referenced path exists', () => {
  assert.deepEqual(checkInventory(INVENTORY, exists), []);
  assert.ok(INVENTORY.length >= 20);
});

test('the inventory covers the classical dependencies the brief names', () => {
  const ids = new Set(INVENTORY.map((r) => r.id));
  for (const id of ['consensus-votes', 'evm-accounts', 'ibc-light-clients', 'hyperlane-ism', 'hyperlane-relayer', 'ibc-relayer', 'injected-wallets', 'tls', 'governance-signers', 'snap', 'native-pq-accounts', 'pq-settlement'])
    assert.ok(ids.has(id), id);
  for (const l of LAYERS) assert.ok(INVENTORY.some((r) => r.layer === l), `layer ${l} has a row`);
  // the honest part: classical rows stay classical, and Ed25519 / secp256k1 appear where they are
  assert.equal(INVENTORY.find((r) => r.id === 'ibc-light-clients').status, 'classical');
  assert.match(INVENTORY.find((r) => r.id === 'consensus-votes').crypto, /Ed25519/);
  assert.match(INVENTORY.find((r) => r.id === 'evm-accounts').crypto, /secp256k1/);
});

test('checkInventory catches broken rows', () => {
  const good = INVENTORY[0];
  const bad = [
    good, { ...good, id: 'Bad Id' }, { ...good }, { ...good, id: 'x1', status: 'maybe' }, { ...good, id: 'x2', impact: 'huge' },
    { ...good, id: 'x3', layer: 'moon' }, { ...good, id: 'x4', hndl: 'yes' }, { ...good, id: 'x5', refs: ['no/such/file'] },
    { ...good, id: 'x6', status: 'classical', migration: 'Done.' }, { ...good, id: 'x7', risk: '' },
  ];
  const problems = checkInventory(bad, exists);
  for (const s of ['kebab-case', 'duplicate id', 'status maybe', 'impact huge', 'layer moon', 'hndl', 'does not exist', 'says done', 'risk missing'])
    assert.ok(problems.some((p) => p.includes(s)), s);
});

test('readiness score: impact-weighted, 0..100, monotone in status', () => {
  const s = readinessScore();
  assert.ok(s > 0 && s < 100, `score ${s}`);
  assert.equal(readinessScore(INVENTORY.map((r) => ({ ...r, status: 'pq' }))), 100);
  assert.equal(readinessScore(INVENTORY.map((r) => ({ ...r, status: 'classical' }))), 0);
  const i = INVENTORY.findIndex((r) => r.status === 'classical');
  const better = INVENTORY.map((r, j) => (j === i ? { ...r, status: 'pq' } : r));
  assert.ok(readinessScore(better) > s);
  const sum = summary();
  assert.equal(sum.score, s);
  assert.equal(Object.values(sum.byStatus).reduce((a, b) => a + b, 0), INVENTORY.length);
  assert.ok(sum.open.every((o) => o.status !== 'pq'));
  for (let k = 1; k < sum.open.length; k++) assert.ok(IMPACT[sum.open[k - 1].impact] >= IMPACT[sum.open[k].impact], 'sorted by impact');
  assert.deepEqual(Object.keys(sum.byStatus), Object.keys(STATUS));
});

test('the doc carries exactly the generated table', () => {
  const doc = readFileSync(new URL('docs/future/quantum-safe-settlement.md', ROOT), 'utf8');
  const a = doc.indexOf(TABLE_BEGIN), b = doc.indexOf(TABLE_END);
  assert.ok(a >= 0 && b > a, 'markers present');
  assert.equal(doc.slice(a + TABLE_BEGIN.length, b).trim(), toMarkdownTable().trim(), 'regenerate: node -e "import(\'./zetaphy-network/src/qsafe/inventory.js\').then(m=>console.log(m.toMarkdownTable()))"');
  assert.match(doc, new RegExp(`readiness score[^\\n]*${readinessScore()}`, 'i'), 'the doc states the current score');
  const th = readFileSync(new URL('docs/future/quantum-safe-settlement.th.md', ROOT), 'utf8');
  assert.match(th, new RegExp(`${readinessScore()}/100`), 'the Thai doc states the current score');
});

test('cells with | and newlines stay one table cell', () => {
  const t = toMarkdownTable([{ ...INVENTORY[0], component: 'a|b', mitigation: 'x\ny' }]);
  assert.match(t, /a\\\|b/);
  assert.doesNotMatch(t.split('\n')[2], /\n/);
});

test('zetaphy qsafe inventory / rescue-kit / rescue-reveal (offline)', () => {
  const out = [];
  const write = (s) => out.push(s);
  assert.equal(qsafeCommand({ cmd: 'inventory', write }), 0);
  assert.match(out[0], new RegExp(`${readinessScore()}/100`));
  out.length = 0;
  qsafeCommand({ cmd: 'inventory', opt: { json: true }, write });
  assert.equal(JSON.parse(out[0]).total, INVENTORY.length);

  const account = '0x00000000000000000000000000000000000a11ce';
  const contract = '0x000000000000000000000000000000000000c0de';
  out.length = 0;
  qsafeCommand({ cmd: 'rescue-kit', rest: [account], opt: { contract }, write });
  const { kit, commit } = JSON.parse(out[0]);
  const key = pqFromSeed(kit.mldsa44Seed);
  assert.equal(kit.keyHash, keccak256(key.publicKey));
  assert.equal(commit.commitment, commitmentOf({ chainId: 77390, contract, account, publicKey: key.publicKey, secret: kit.secret }));
  const iface = new Interface(JSON.parse(readFileSync(new URL('../artifacts/QuantumRescue.json', import.meta.url), 'utf8')).abi);
  assert.equal(iface.decodeFunctionData('commit', commit.data)[0], commit.commitment);

  const dir = mkdtempSync(join(tmpdir(), 'qsafe-'));
  try {
    writeFileSync(join(dir, 'kit.json'), JSON.stringify(kit));
    out.length = 0;
    qsafeCommand({ cmd: 'rescue-reveal', rest: [join(dir, 'kit.json')], write });
    const r = JSON.parse(out[0]);
    const [acc, pk, secret, sig] = iface.decodeFunctionData('reveal', r.data);
    assert.equal(acc.toLowerCase(), account);
    assert.equal(secret, kit.secret);
    assert.equal(r.controller, kit.controller);
    const d = rescueDigest({ chainId: 77390, contract, account, controller: kit.controller });
    assert.ok(ml_dsa44.verify(getBytes(sig), getBytes(d), getBytes(pk)), 'a real ML-DSA-44 signature');
    const { mldsa44Seed, ...noSeed } = kit;
    writeFileSync(join(dir, 'kit2.json'), JSON.stringify(noSeed));
    assert.throws(() => qsafeCommand({ cmd: 'rescue-reveal', rest: [join(dir, 'kit2.json')], write }), /no ML-DSA-44 seed/);
    assert.throws(() => qsafeCommand({ cmd: 'rescue-reveal', rest: [join(dir, 'kit2.json')], write, env: { ZETAPHY_RESCUE_SEED: '0x' + '11'.repeat(32) } }), /not the key/);
    assert.ok(mldsa44Seed);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.throws(() => qsafeCommand({ cmd: 'nope', write }), /usage/);
});
