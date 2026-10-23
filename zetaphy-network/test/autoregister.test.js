// --auto-register: register only once the wallet covers the bond plus a gas reserve.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoRegisterPlan } from '../cli.js';

const Z = 10n ** 18n;

test('autoRegisterPlan: waits until bond + 0.1 ZETAPHY, says what is missing', () => {
  assert.deepEqual(autoRegisterPlan(0n, 100n * Z), { ready: false, missing: 100n * Z + Z / 10n });
  assert.deepEqual(autoRegisterPlan(100n * Z, 100n * Z), { ready: false, missing: Z / 10n });
  assert.deepEqual(autoRegisterPlan(100n * Z + Z / 10n, 100n * Z), { ready: true, missing: 0n });
  assert.deepEqual(autoRegisterPlan(500n * Z, 100n * Z), { ready: true, missing: 0n });
  assert.deepEqual(autoRegisterPlan(5n, 3n, 2n), { ready: true, missing: 0n }); // custom reserve
});
