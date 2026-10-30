// PQMultisigIsm (contracts/PQMultisigIsm.sol) and src/qsafe/pqism.js: a Hyperlane ISM whose validators sign
// the message-id checkpoint with ML-DSA-44 (real keys; helpers/precompiles.js runs FIPS 204 at 0x…0900).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { solidityPacked, AbiCoder, dataSlice } from 'ethers';
import { createChain } from './helpers/evm.js';
import { PRECOMPILES, mldsaKey } from './helpers/precompiles.js';
import { pqCheckpointDigest, pqIsmMetadata } from '../src/qsafe/pqism.js';

const V = [mldsaKey(), mldsaKey(), mldsaKey()];
const outsider = mldsaKey();
const message = solidityPacked(['uint8', 'uint32', 'uint32', 'bytes32', 'uint32', 'bytes32', 'bytes'],
  [3, 7, 56, '0x' + 'aa'.repeat(32), 77390, '0x' + 'bb'.repeat(32), '0x1234']);
const opts = { merkleTreeHook: '0x' + '99'.repeat(20), root: '0x' + '42'.repeat(32), index: 7 };

let c, ism;
beforeEach(async () => {
  c = await createChain(['gov', 'relay', 'mallory'], {}, { precompiles: PRECOMPILES });
  ism = await c.deploy('PQMultisigIsm', [c.acct.gov.toString(), V.map((k) => k.keyHash), 2], 'gov');
});

/** verify() as a relayer would see it: true, or the revert reason. */
async function verify(metadata) {
  const data = ism.iface.encodeFunctionData('verify', [metadata, message]);
  const r = await c.rawCall('relay', ism.address, data);
  if (r.ok) return ism.iface.decodeFunctionResult('verify', r.returnHex)[0];
  return AbiCoder.defaultAbiCoder().decode(['string'], dataSlice(r.returnHex, 4))[0];
}

test('the JS checkpoint digest equals the contract digest', async () => {
  const md = pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 2, key: V[2] }], opts);
  assert.equal(await ism.call('digest', [md, message]), pqCheckpointDigest(message, opts));
  assert.equal(await ism.call('moduleType'), 0n);
  const [vals, t] = await ism.call('validatorsAndThreshold', [message]);
  assert.deepEqual([...vals], V.map((k) => k.keyHash));
  assert.equal(t, 2n);
});

test('2 of 3 ML-DSA validators verify a message', async () => {
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 2, key: V[2] }], opts)), true);
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 2, key: V[2] }, { index: 1, key: V[1] }], opts)), true, 'sorted by the builder');
});

test('below threshold, a repeated validator, an unknown key or a bad signature fail', async () => {
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 1, key: V[1] }], opts)), 'PQISM: below threshold');
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 1, key: V[1] }, { index: 1, key: V[1] }], opts)), 'PQISM: validator order');
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 1, key: outsider }], opts)), 'PQISM: wrong key');
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 5, key: V[1] }], opts)), 'PQISM: unknown validator');
  const otherDigest = pqCheckpointDigest(message, { ...opts, index: 8 });
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 1, key: V[1], signature: V[1].sign(otherDigest) }], opts)), 'PQISM: bad signature');
  // signatures over one message do not verify another
  const md = pqIsmMetadata(message, [{ index: 0, key: V[0] }, { index: 1, key: V[1] }], opts);
  const other = message.slice(0, -4) + '5678';
  const r = await c.rawCall('relay', ism.address, ism.iface.encodeFunctionData('verify', [md, other]));
  assert.equal(r.ok, false);
});

test('only governance changes the validator set, and the set must be sane', async () => {
  await assert.rejects(ism.send('mallory', 'setValidators', [[outsider.keyHash], 1]), /OnlyGovernance/);
  await assert.rejects(ism.send('gov', 'setValidators', [[outsider.keyHash, outsider.keyHash], 1]), /BadSet/);
  await assert.rejects(ism.send('gov', 'setValidators', [[outsider.keyHash], 2]), /BadSet/);
  await assert.rejects(ism.send('gov', 'setValidators', [[outsider.keyHash], 0]), /BadSet/);
  await ism.send('gov', 'setValidators', [[outsider.keyHash], 1]);
  assert.equal(await verify(pqIsmMetadata(message, [{ index: 0, key: outsider }], opts)), true);
});
