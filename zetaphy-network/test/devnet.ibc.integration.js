// IBC + USDC from Noble, end to end on two real ZETAPHY devnets with the
// pinned Hermes: zetaphy-chain/ibc/test-ibc.sh (channel, USDC in and out,
// ERC-20 via eth_call, rate limit voted in and enforced both ways).
// Without network access to fetch Hermes it skips; set HERMES_TARBALL to a
// downloaded hermes-v1.13.3-<arch>-unknown-linux-gnu.tar.gz to run offline.
//   ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm run test:devnet:ibc
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const SCRIPT = new URL('../../zetaphy-chain/ibc/test-ibc.sh', import.meta.url).pathname;

test('two devnets + Hermes: channel, USDC transfers, ERC-20, rate limit', { timeout: 30 * 60_000 }, (t) => {
  const r = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, ZETAPHYD: process.env.ZETAPHYD || 'zetaphyd' },
  });
  process.stdout.write(r.stdout || '');
  if (r.status === 0 && /^SKIP:/m.test(r.stdout)) return t.skip(r.stdout.match(/^SKIP: .*/m)[0]);
  assert.equal(r.status, 0, 'test-ibc.sh failed');
  assert.match(r.stdout, /^ALL PASS$/m);
});
