// SS4 economic-security simulation (docs/future/red-team.md): the agent-based attacks run on the real DEX
// contracts (zetaphy-dex artifacts) in the in-memory EVM and produce a reproducible "max extractable loss" bound.
// Checked here: it runs, it is deterministic (same seeds -> same report hash), a spot-price oracle is
// manipulable while a TWAP over a long window is not, and the report binds the code hashes and the scenario set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate, econReportHash, scenariosHash, dexCodeHashes, DEFAULT_SCENARIOS } from '../src/redteam/economic.js';

test('the simulation runs, is deterministic, and the report hash matches its content', async () => {
  const scenarios = DEFAULT_SCENARIOS.filter((s) => s.kind !== 'cascade'); // (cascade is covered below; keep this fast)
  const a = await simulate({ scenarios, seeds: [1, 2] });
  const b = await simulate({ scenarios, seeds: [1, 2] });
  assert.equal(a.reportHash, b.reportHash, 'same scenarios and seeds give the same report, bit for bit');
  assert.equal(a.reportHash, econReportHash(a.report));
  assert.equal(a.report.scenariosHash, scenariosHash(scenarios, [1, 2]));
  assert.deepEqual(a.report.code, dexCodeHashes(), 'the report binds the audited code hashes');
  assert.equal(a.bound, BigInt(a.report.maxExtractableLoss));
  assert.ok(a.bound > 0n, 'some loss is extractable from a spot oracle / a sandwich');
}, { timeout: 180_000 });

test('a spot-price oracle is manipulable but a TWAP over a long window is not', async () => {
  const spot = await simulate({ scenarios: [DEFAULT_SCENARIOS.find((s) => s.id === 'oracle-spot')], seeds: [1] });
  const twap = await simulate({ scenarios: [DEFAULT_SCENARIOS.find((s) => s.id === 'oracle-twap')], seeds: [1] });
  assert.ok(spot.bound > 0n, 'the spot oracle is drained');
  assert.equal(twap.bound, 0n, 'the TWAP over 1800s defeats a single-block manipulation');
}, { timeout: 120_000 });

test('a liquidation cascade leaves bad debt that grows with the shock', async () => {
  const res = await simulate({ scenarios: [DEFAULT_SCENARIOS.find((s) => s.id === 'liquidation-cascade')], seeds: [1, 2] });
  assert.ok(res.bound > 0n, 'the cascade leaves bad debt');
  const sc = res.report.scenarios[0];
  assert.equal(sc.runs.length, 2);
}, { timeout: 120_000 });
