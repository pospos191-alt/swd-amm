// The crosschain-assist commands (src/assistcli.js): certify (item 19), attest-pq sign / verify through the CLI
// (item 30), and one round of the herd-immunity pusher (item 28) against a stand-in sender.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBytes32String, decodeBytes32String } from 'ethers';
import { certify, badgeText } from '../src/assistcli.js';
import { pushRound, REGISTRY_EVENTS } from '../src/neurooracle.js';
import { verdictOf } from '../../zetaphy-neuro/src/verdict.js';

const CLI = new URL('../cli.js', import.meta.url).pathname;
const REPORT = { chain: 'zetaphy', address: '0x00000000000000000000000000000000000000aa', functions: ['a()'], unknownSelectors: [], analysis: { level: 'ok', findings: [] } };

test('certify: runs Neuro on the token (ZETAPHY), attests its verdict hash, skill and model', async () => {
  const calls = [];
  const attest = { attest: async (...a) => { calls.push(a); return { wait: async () => ({ logs: [{ topics: ['0x', '0x' + '00'.repeat(31) + '07'] }] }) }; } };
  const read = async (chain, token, opts) => { assert.equal(chain, 'zetaphy'); assert.equal(opts.chainConfig.id, 77390); assert.deepEqual(opts.chainConfig.rpcs, ['http://node:8545']); return { ...REPORT, address: token }; };
  const r = await certify({ attest, token: REPORT.address, rpc: 'http://node:8545', model: 'claude-sonnet-5-5', read, skill: '0x' + '5c'.repeat(32) });
  assert.equal(r.uid, 7n);
  assert.equal(r.reportHash, await verdictOf(REPORT));
  const [subject, reportHash, skill, model, uri] = calls[0];
  assert.equal(subject.toLowerCase(), REPORT.address);
  assert.equal(reportHash, r.reportHash);
  assert.equal(skill, '0x' + '5c'.repeat(32));
  assert.equal(decodeBytes32String(model), 'claude-sonnet-5-5');
  assert.equal(uri, `neuro:zetaphy:${REPORT.address}`);
});

test('badge words: checked (never "safe"), revoked, none', () => {
  const b = { checked: true, uid: 3n, reportHash: '0x' + '11'.repeat(32), skill: '0x' + '22'.repeat(32), model: encodeBytes32String('rules'), by: '0x' + 'ab'.repeat(20), time: 1_800_000_000n };
  assert.match(badgeText(b), /^Neuro-checked: attestation #3 .* model rules\. A check, not a guarantee/);
  assert.doesNotMatch(badgeText(b), /\bsafe\b/i);
  assert.match(badgeText({ ...b, checked: false }), /REVOKED/);
  assert.match(badgeText({ uid: 0n }), /not Neuro-checked/);
});

test('zetaphy attest-pq sign / verify: a valid archive, then a one-character edit is NOT VALID (exit 1)', () => {
  const home = mkdtempSync(join(tmpdir(), 'zpq-'));
  const f = join(home, 'report.json');
  writeFileSync(f, JSON.stringify(REPORT));
  const run = (...a) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: { ...process.env, ZETAPHY_HOME: home, ZETAPHY_RPC: '' } });
  const s = run('attest-pq', 'sign', f, '--model', 'rules');
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /signed .*report\.pq\.json: ML-DSA-44 key 0x[0-9a-f]{64}, archive hash 0x[0-9a-f]{64}/);
  assert.ok(existsSync(join(home, 'pq.seed')), 'the same key file as zetaphy pq');
  const out = join(home, 'report.pq.json');
  const v = run('attest-pq', 'verify', out);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /^VALID: .*not anchored/);
  const a = JSON.parse(readFileSync(out, 'utf8'));
  a.payload.report.analysis.level = 'danger';
  writeFileSync(out, JSON.stringify(a));
  const t = run('attest-pq', 'verify', out);
  assert.equal(t.status, 1);
  assert.match(t.stdout, /NOT VALID:[\s\S]*payload changed/);
});

test('herd-immunity pusher: first run sends every flagged key pending on each route; then only keys from new events', async () => {
  const FP = '0x' + 'f1'.repeat(32), FP2 = '0x' + 'f2'.repeat(32);
  const pushed = [];
  let pendingSet = new Set([FP, FP2]);
  const sender = {
    snapshot: async (start) => (start === 0 ? [[FP, FP2], [1, 1], [true, true]] : [[], [], []]),
    domainCount: async () => 2n,
    domains: async (i) => [11155111n, 84532n][i],
    receivers: async (d) => (d === 84532 ? '0x' + '00'.repeat(32) : '0x' + '00'.repeat(12) + 'ab'.repeat(20)),
    pending: async (_d, keys) => keys.map((k) => pendingSet.has(k)),
    quote: async () => 100n,
    push: async (domain, keys, { value }) => { pushed.push({ domain, keys, value }); for (const k of keys) pendingSet.delete(k); return { hash: '0x01', wait: async () => ({}) }; },
  };
  let head = 10;
  let logs = [];
  const provider = { getBlockNumber: async () => head, getLogs: async () => logs };
  let r = await pushRound({ sender, provider, registry: '0x' + '99'.repeat(20) });
  assert.deepEqual(pushed, [{ domain: 11155111, keys: [FP, FP2], value: 100n }], 'the route without a receiver is skipped');
  assert.equal(r.state.fromBlock, 11);
  head = 12;
  r = await pushRound({ sender, provider, registry: '0x' + '99'.repeat(20), state: r.state });
  assert.equal(pushed.length, 1, 'nothing new');
  const ev = REGISTRY_EVENTS.encodeEventLog('Cleared', [FP]);
  logs = [{ topics: ev.topics, data: ev.data }];
  pendingSet = new Set([FP]);
  head = 13;
  r = await pushRound({ sender, provider, registry: '0x' + '99'.repeat(20), state: r.state });
  assert.deepEqual(pushed[1].keys, [FP]);
  // a fee above --max-fee is refused and the keys are retried next round
  pendingSet = new Set([FP2]);
  head = 14;
  logs = [{ topics: REGISTRY_EVENTS.encodeEventLog('Flagged', [FP2, 1]).topics, data: REGISTRY_EVENTS.encodeEventLog('Flagged', [FP2, 1]).data }];
  r = await pushRound({ sender: { ...sender, quote: async () => 10n ** 18n }, provider, registry: '0x', state: r.state, maxFee: 10n ** 17n });
  assert.deepEqual(r.state.retry, { 11155111: [FP2] });
  logs = [];
  head = 15;
  r = await pushRound({ sender, provider, registry: '0x', state: r.state });
  assert.deepEqual(pushed.at(-1).keys, [FP2]);
});
