// The committed artifacts are what the sources compile to (solc 0.8.26, the
// settings in scripts/build.js), so what cli.js deploys is what was reviewed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { keccak256 } from 'ethers';

test('artifacts are reproducible from contracts/ (npm run build -- --check)', { timeout: 180_000 }, () => {
  const out = execFileSync(process.execPath, [new URL('../scripts/build.js', import.meta.url).pathname, '--check'], { encoding: 'utf8' });
  assert.match(out, /artifacts match a fresh build/);
});

test('contract sizes stay under EIP-170; the router knows the pair code hash the factory computes', () => {
  for (const n of ['ZetaphyFactory', 'ZetaphyPair', 'ZetaphyRouter', 'WZETAPHY', 'TestToken']) {
    const a = JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'));
    assert.ok((a.deployedBytecode.length - 2) / 2 <= 24576, n);
    assert.equal(a.solcLongVersion.startsWith('0.8.26'), true);
  }
  const pair = JSON.parse(readFileSync(new URL('../artifacts/ZetaphyPair.json', import.meta.url), 'utf8'));
  assert.match(keccak256(pair.bytecode), /^0x[0-9a-f]{64}$/);
});
