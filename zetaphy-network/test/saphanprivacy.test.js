// Saphan PR 6, item F: optional private transfers of a bridged token. SaphanPrivacyPool reuses the private-identity
// Groth16 circuit and verifier (DEV setup: testnet only); the proofs come from test/fixtures/saphan-privacy.json,
// made by zetaphy-network/zkid/privacy-fixture.js with the hub's prover files for this fixed scenario.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'ethers';
import { createChain } from './helpers/evm.js';
import { kit } from './helpers/saphankits.js';
import { poolScope, signalOf, poolRoot, encodeNote, decodeNote, newNote, noteLeaf, withdrawInput } from '../src/saphanprivacy.js';

const FX = JSON.parse(readFileSync(new URL('./fixtures/saphan-privacy.json', import.meta.url), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(new URL('../../zetaphy-hub/zkid/manifest.json', import.meta.url), 'utf8'));
const E = 10n ** 18n;
const DENOM = E / 100n;
const R1 = '0x00000000000000000000000000000000000000b1';
const R2 = '0x00000000000000000000000000000000000000b2';
let c, token, pool;
const a = (n) => c.acct[n].toString();
const P = (x) => [x[0], BigInt(x[1]), BigInt(x[2]), BigInt(x[3]), x[4].map(BigInt)];

beforeEach(async () => {
  c = await createChain(['pooler', 'gov', 'alice', 'relay', 'anyone']);
  const poseidon = await c.deploy('PoseidonT3', [], 'gov');
  const verifier = await c.deploy('ZkIdentityVerifier', [], 'gov');
  token = await c.deployRaw(kit('TokenKit.sol').KitToken, ['sepETH (stand-in)', 'sepETH', 18], 'gov');
  pool = await c.deploy('SaphanPrivacyPool', [poseidon.address, verifier.address, token.address, DENOM], 'pooler');
  await token.send('gov', 'mint', [a('alice'), E]);
  await token.send('alice', 'approve', [pool.address, E]);
});

const depositAll = async (n = 3) => { for (const cm of FX.commitments.slice(0, n)) await pool.send('alice', 'deposit', [cm]); };

test('the fixture matches this pool: address, scope, DEV key of the hub, leaves; the tree on chain = the JS tree', async () => {
  assert.equal(getAddress(pool.address), getAddress(FX.pool), 'the pool must be the first account\'s first contract (privacy-fixture.js)');
  assert.equal(FX.zkeySha256, MANIFEST.zkey.sha256);
  assert.equal(await pool.call('scope'), BigInt(FX.scope));
  assert.equal(poolScope(1, pool.address), BigInt(FX.scope));
  assert.equal(await pool.call('signalOf', [R1, 10n ** 15n]), signalOf(R1, 10n ** 15n));
  assert.equal(await pool.call('root'), poolRoot([]));
  const ev = await pool.send('alice', 'deposit', [FX.commitments[0]]);
  assert.equal(ev.find((e) => e?.name === 'Deposit').args.leaf, BigInt(FX.leaves[0]));
  await pool.send('alice', 'deposit', [FX.commitments[1]]);
  await pool.send('alice', 'deposit', [FX.commitments[2]]);
  assert.equal(await pool.call('root'), poolRoot(FX.leaves));
  assert.equal(await pool.call('root'), BigInt(FX.proofs.a[2]));
  assert.equal(await token.call('balanceOf', [pool.address]), 3n * DENOM);
  const g = await pool.gas('alice', 'deposit', [123n]);
  console.log(`SaphanPrivacyPool.deposit: execution gas ${g.exec}`);
});

test('withdraw: a proof spends one note to the bound recipient, the relayer gets the fee; never twice; nothing can be redirected', async () => {
  await depositAll();
  const [rcpt, fee, root, nullifier, words] = P(FX.proofs.a);
  await assert.rejects(pool.send('relay', 'withdraw', [R2, fee, root, nullifier, words]), /BadProof/, 'other recipient');
  await assert.rejects(pool.send('relay', 'withdraw', [rcpt, fee + 1n, root, nullifier, words]), /BadProof/, 'other fee');
  await assert.rejects(pool.send('relay', 'withdraw', [rcpt, fee, root, nullifier + 1n, words]), /BadProof/, 'other nullifier');
  const bad = [...words]; bad[0] += 1n;
  await assert.rejects(pool.send('relay', 'withdraw', [rcpt, fee, root, nullifier, bad]), /BadProof|revert/);
  await assert.rejects(pool.send('relay', 'withdraw', [rcpt, fee, root + 1n, nullifier, words]), /UnknownRoot/);
  await assert.rejects(pool.send('relay', 'withdraw', [rcpt, DENOM + 1n, root, nullifier, words]), /BadFee/);
  await pool.send('relay', 'withdraw', [rcpt, fee, root, nullifier, words]);
  assert.equal(await token.call('balanceOf', [R1]), DENOM - fee);
  assert.equal(await token.call('balanceOf', [a('relay')]), fee);
  await assert.rejects(pool.send('anyone', 'withdraw', [rcpt, fee, root, nullifier, words]), /Spent/);
  // an older root stays valid (the tree only grows): note 1 against the root after 2 deposits
  const b = P(FX.proofs.b);
  await pool.send('anyone', 'withdraw', b);
  assert.equal(await token.call('balanceOf', [R2]), DENOM);
  assert.equal(await token.call('balanceOf', [pool.address]), DENOM);
});

test('deposits: field elements, each commitment once, exactly the denomination; notes as text', async () => {
  await assert.rejects(pool.send('alice', 'deposit', [0n]), /BadCommitment/);
  await assert.rejects(pool.send('alice', 'deposit', [await pool.call('SNARK_FIELD')]), /BadCommitment/);
  await pool.send('alice', 'deposit', [FX.commitments[0]]);
  await assert.rejects(pool.send('alice', 'deposit', [FX.commitments[0]]), /BadCommitment/);
  await token.send('alice', 'approve', [pool.address, 0n]);
  await assert.rejects(pool.send('alice', 'deposit', [FX.commitments[1]]));
  const note = newNote();
  const text = encodeNote({ chainId: 77390, pool: pool.address, note });
  const back = decodeNote(text);
  assert.equal(back.note.secret, note.secret);
  assert.equal(back.pool, getAddress(pool.address));
  assert.throws(() => decodeNote(text.replace('ZNOTE1', 'ZNOTE2')), /format/);
  // the JS input builder refuses a note that is not in the tree
  assert.throws(() => withdrawInput({ note, leaves: FX.leaves, chainId: 1, pool: pool.address, recipient: R1 }), /not-in-tree/);
  assert.equal(withdrawInput({ note, leaves: [...FX.leaves, noteLeaf(note)], chainId: 1, pool: pool.address, recipient: R1 }).index, 3);
});
