// Private identity card (zkid.js), pure parts: zkid-core.js (Poseidon, tree, paths, circuit input, proof words, ABI
// encodings against ethers, the encrypted backup), the words in all 8 languages, the prover files against their
// manifest, and the CSP split (only the prover worker may run WebAssembly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, id, AbiCoder, getAddress } from 'ethers';
import {
  F, poseidon2, newIdentity, commitment, leafOf, nullifierOf, parseIdentity, identityJson, zeros, buildTree, merklePath, findLeaf, proofInput, proofWords, DEPTH,
  SEL, encodeRegister, encodeLeavesRange, encodeSignalOf, encodeClaim, encodeAddr, encodeUint, decodeUintArray, encryptBackup, decryptBackup, toHex32,
} from '../zkid-core.js';
import { ZKID } from '../zkid-i18n.js';
import { LANG_CODES } from '../i18n.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const R = getAddress('0x' + '33'.repeat(20));

test('Poseidon(2) is circomlib\'s (test vector), rejects non-field inputs', () => {
  assert.equal(poseidon2(1n, 2n), 7853200120776062878684798364095072458815029376092732009249414926327459813530n);
  assert.throws(() => poseidon2(F, 0n), RangeError);
  assert.throws(() => poseidon2(-1n, 0n), RangeError);
});

test('identities: random field elements; commitment, leaf and nullifier are the documented hashes; parsing is strict', () => {
  const a = newIdentity();
  const b = newIdentity();
  assert.notEqual(a.secret, b.secret);
  for (const x of [a.secret, a.nullifierKey]) assert.ok(x > 0n && x < 2n ** 248n);
  assert.equal(commitment(a), poseidon2(a.secret, a.nullifierKey));
  assert.equal(leafOf(commitment(a), 2), poseidon2(commitment(a), 2n));
  assert.equal(nullifierOf(a, 7n), poseidon2(a.nullifierKey, 7n));
  assert.notEqual(nullifierOf(a, 7n), nullifierOf(a, 8n));
  assert.deepEqual(parseIdentity(identityJson(a)), a);
  for (const bad of [null, {}, { secret: '0', nullifierKey: '1' }, { secret: toHex32(F), nullifierKey: '1' }, { secret: '1e5', nullifierKey: '1' }, { secret: ' 1', nullifierKey: '1' }]) {
    assert.throws(() => parseIdentity(bad), /identity/);
  }
});

test('the Merkle tree: empty subtrees, paths that hash back to the root, local leaf search', () => {
  const z = zeros();
  assert.equal(z.length, DEPTH + 1);
  assert.equal(buildTree([]).root, z[DEPTH]);
  const ids = [newIdentity(), newIdentity(), newIdentity()];
  const leaves = [leafOf(commitment(ids[0]), 1), 0n, leafOf(commitment(ids[2]), 2)];
  const tree = buildTree(leaves);
  for (const i of [0, 2]) {
    const { pathElements, pathIndices } = merklePath(tree, i);
    let node = leaves[i];
    for (let h = 0; h < DEPTH; h++) node = pathIndices[h] ? poseidon2(pathElements[h], node) : poseidon2(node, pathElements[h]);
    assert.equal(node, tree.root);
  }
  assert.deepEqual(findLeaf(leaves, ids[2]), { index: 2, level: 2 });
  assert.equal(findLeaf(leaves, ids[1]), null);
  const { input } = proofInput({ id: ids[2], leaves, scope: 5n, signalHash: 6n, minLevel: 2 });
  assert.equal(input.root, String(tree.root));
  assert.equal(input.nullifier, String(nullifierOf(ids[2], 5n)));
  assert.equal(input.level, '2');
  assert.equal(input.pathElements.length, DEPTH);
  assert.throws(() => proofInput({ id: ids[0], leaves, scope: 5n, signalHash: 6n, minLevel: 2 }), /level-too-low/);
  assert.throws(() => proofInput({ id: ids[1], leaves, scope: 5n, signalHash: 6n, minLevel: 1 }), /not-in-tree/);
});

test('proof words: snarkjs\' b coordinates swapped, as the Solidity verifier takes them', () => {
  const p = { pi_a: ['1', '2', '1'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'] };
  assert.deepEqual(proofWords(p), [1n, 2n, 4n, 3n, 6n, 5n, 7n, 8n]);
});

test('selectors and calldata match ethers', () => {
  const sigs = {
    register: 'register(uint256)', sync: 'sync(address)', root: 'root()', leafCount: 'leafCount()', leavesRange: 'leavesRange(uint256,uint256)',
    memberOf: 'memberOf(address)', levelNow: 'levelNow(address)', scope: 'scope()', minLevel: 'minLevel()', amount: 'amount()',
    signalOf: 'signalOf(address,uint256)', claim: 'claim(address,uint256,uint256,uint256,uint256[8])', nullifierUsed: 'nullifierUsed(uint256)',
  };
  assert.deepEqual(Object.keys(SEL).sort(), Object.keys(sigs).sort());
  for (const [k, s] of Object.entries(sigs)) assert.equal(SEL[k], id(s).slice(0, 10), k);
  const i = new Interface(['function register(uint256)', 'function leavesRange(uint256,uint256)', 'function signalOf(address,uint256)',
    'function claim(address,uint256,uint256,uint256,uint256[8])', 'function levelNow(address)', 'function nullifierUsed(uint256)']);
  assert.equal(encodeRegister(5n), i.encodeFunctionData('register', [5n]));
  assert.equal(encodeLeavesRange(3, 500), i.encodeFunctionData('leavesRange', [3, 500]));
  assert.equal(encodeSignalOf(R, 7n), i.encodeFunctionData('signalOf', [R, 7n]).toLowerCase());
  const w = [1n, 2n, 3n, 4n, 5n, 6n, 7n, F - 1n];
  assert.equal(encodeClaim(R, 9n, 10n, 11n, w), i.encodeFunctionData('claim', [R, 9n, 10n, 11n, w]).toLowerCase());
  assert.equal(encodeAddr(SEL.levelNow, R), i.encodeFunctionData('levelNow', [R]).toLowerCase());
  assert.equal(encodeUint(SEL.nullifierUsed, 12n), i.encodeFunctionData('nullifierUsed', [12n]));
  assert.deepEqual(decodeUintArray(AbiCoder.defaultAbiCoder().encode(['uint256[]'], [[1n, 0n, F - 1n]])), [1n, 0n, F - 1n]);
  assert.deepEqual(decodeUintArray(AbiCoder.defaultAbiCoder().encode(['uint256[]'], [[]])), []);
});

test('encrypted backup: round trip; a wrong password, a changed file or another file are refused', async () => {
  const a = newIdentity();
  const b = await encryptBackup(a, 'correct horse', { iterations: 100_000 });
  assert.equal(b.kind, 'zetaphy-zkid-backup');
  assert.doesNotMatch(JSON.stringify(b), new RegExp(a.secret.toString(16)));
  assert.deepEqual(await decryptBackup(JSON.stringify(b), 'correct horse'), a);
  await assert.rejects(decryptBackup(b, 'wrong horse!'), /bad-password/);
  const changed = structuredClone(b);
  const ct = Buffer.from(changed.cipher.data, 'base64'); ct[0] ^= 1; changed.cipher.data = ct.toString('base64');
  await assert.rejects(decryptBackup(changed, 'correct horse'), /bad-password/);
  await assert.rejects(decryptBackup({ kind: 'other' }, 'correct horse'), /bad-backup/);
  await assert.rejects(decryptBackup({ ...b, kdf: { ...b.kdf, iterations: 1 } }, 'correct horse'), /bad-backup/);
  await assert.rejects(encryptBackup(a, 'short'), /password-too-short/);
  // the default work factor is the documented one
  const d = await encryptBackup(a, 'correct horse');
  assert.equal(d.kdf.iterations, 600_000);
});

test('the card speaks 8 languages with every English key and placeholder; no Thai in the code', () => {
  const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);
  assert.deepEqual(Object.keys(ZKID).sort(), [...LANG_CODES].sort());
  const en = shape(ZKID.en);
  const ph = (s) => (String(s).match(/\{\w+\}/g) ?? []).sort();
  for (const l of LANG_CODES) {
    assert.deepEqual(shape(ZKID[l]), en, l);
    for (const [k, v] of Object.entries(ZKID.en)) if (typeof v === 'string') assert.deepEqual(ph(ZKID[l][k]), ph(v), `${l}.${k}`);
    if (l !== 'en') assert.notEqual(ZKID[l].limits, ZKID.en.limits, `${l}: translated`);
    assert.match(ZKID[l].limits, /BN254/, `${l}: says the curve`);
  }
  for (const f of ['zkid.js', 'zkid-core.js', 'zkid-worker.js']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /[฀-๿]/, f);
});

test('the prover files match their manifest; the build ships them', () => {
  const m = JSON.parse(readFileSync(join(HERE, 'zkid/manifest.json'), 'utf8'));
  for (const f of [m.wasm, m.zkey]) {
    const b = readFileSync(join(HERE, 'zkid', f.file));
    assert.equal(b.length, f.bytes);
    assert.equal(createHash('sha256').update(b).digest('hex'), f.sha256);
  }
  assert.deepEqual(m.publicSignals, ['root', 'nullifier', 'scope', 'signalHash', 'minLevel']);
  assert.match(m.setup.phase2, /DEV/);
  const build = readFileSync(join(HERE, 'build.mjs'), 'utf8');
  for (const f of ['zkid.js', 'zkid-i18n.js', 'zkid-core.js', 'zkid-poseidon.js', 'zkid-worker.js', 'zkid/manifest.json', 'zkid/identity.wasm', 'zkid/identity.zkey']) {
    assert.ok(build.includes(`'${f}'`), `${f} shipped`);
  }
});

test('CSP: the pages keep script-src \'self\' (no WebAssembly); only the prover worker gets \'wasm-unsafe-eval\'', () => {
  const v = JSON.parse(readFileSync(join(HERE, 'vercel.json'), 'utf8'));
  const csp = (h) => h.headers.find((x) => x.key === 'Content-Security-Policy').value;
  const main = v.headers[0];
  assert.doesNotMatch(csp(main), /wasm|unsafe/);
  const re = new RegExp(`^${main.source.slice(1)}$`);
  assert.equal(re.test('zkid-worker.js'), false, 'the worker is not under the page CSP');
  assert.equal(re.test('zkid.js'), true);
  assert.equal(re.test('index.html'), true);
  const w = v.headers.find((h) => h.source === '/zkid-worker.js');
  assert.match(csp(w), /script-src 'self' 'wasm-unsafe-eval';/);
  assert.match(csp(w), /connect-src 'none'/);
  assert.doesNotMatch(csp(w), /'unsafe-eval'|'unsafe-inline'/);
  const worker = readFileSync(join(HERE, 'zkid-worker.js'), 'utf8');
  assert.deepEqual(worker.match(/importScripts\([^)]*\)/g), ["importScripts('vendor/snarkjs.min.js')"]);
});
