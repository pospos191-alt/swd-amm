// ZETAPHY Mesh (docs/future/offline-cash.md): packets, base45 / base32, frames sized for SMS / LoRa / QR, reassembly
// with loss, reorder and duplicates, multi-path relays (the first copy lands, the chain refuses the others), deadlines,
// the size table, and the hub's copy of frames.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as F from '../src/mesh/frames.js';
import { MeshRelay, planSubmit } from '../src/mesh/relay.js';
import { sizeTable, payloadFromFile } from '../src/mesh/cli.js';
import { createChain, ZETA } from './helpers/evm.js';
import { PRECOMPILES } from './helpers/precompiles.js';
import { core, NODE_CRYPTO as C, holderFromSeed } from '../src/offlinecash.js';

const rnd = (n, seed = 1) => { let x = seed; return Uint8Array.from({ length: n }, () => ((x = (x * 1103515245 + 12345) >>> 0) >>> 16) & 255); };
const shuffle = (a, seed = 7) => { const r = [...a]; let x = seed; for (let i = r.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) >>> 0; const j = x % (i + 1); [r[i], r[j]] = [r[j], r[i]]; } return r; };
const GSM7 = /^[A-Za-z0-9 @£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà\n\r]*$/;

test('base45 (RFC 9285 vectors) and base32 (RFC 4648 vectors), both ways', () => {
  for (const [plain, b45] of [['AB', 'BB8'], ['Hello!!', '%69 VD92EX0'], ['base-45', 'UJCLQE7W581'], ['ietf!', 'QED8WEX0']]) {
    assert.equal(F.base45Encode(F.utf8(plain)), b45);
    assert.equal(new TextDecoder().decode(F.base45Decode(b45)), plain);
  }
  assert.throws(() => F.base45Decode('GGW'), /out of range/);
  assert.throws(() => F.base45Decode('a'), /bad character|bad length/);
  for (const [plain, b32] of [['', ''], ['f', 'my'], ['fo', 'mzxq'], ['foo', 'mzxw6'], ['foob', 'mzxw6yq'], ['fooba', 'mzxw6ytb'], ['foobar', 'mzxw6ytboi']]) {
    assert.equal(F.base32Encode(F.utf8(plain)), b32);
    assert.equal(new TextDecoder().decode(F.base32Decode(b32.toUpperCase())), plain);
  }
  for (let n = 0; n < 40; n++) {
    const b = rnd(n, n + 3);
    assert.deepEqual(F.base45Decode(F.base45Encode(b)), b);
    assert.deepEqual(F.base32Decode(F.base32Encode(b)), b);
  }
});

test('packets: type, deadline, fee hint, payload; malformed ones refused', () => {
  const payload = rnd(300);
  const p = F.encodePacket({ type: 'note', payload, deadline: 1_900_000_000, fee: 10n ** 16n });
  const d = F.decodePacket(p);
  assert.deepEqual([d.type, d.deadline, d.fee, d.flags], ['note', 1_900_000_000, 10n ** 16n, 0]);
  assert.deepEqual(d.payload, payload);
  assert.match(d.id, /^[0-9a-f]{16}$/);
  assert.throws(() => F.decodePacket(p.subarray(0, p.length - 1)), /length/);
  assert.throws(() => F.decodePacket(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)), /not a ZETAPHY/);
  assert.throws(() => F.encodePacket({ type: 'nope', payload }), /unknown type/);
  assert.throws(() => F.encodePacket({ type: 'tx', payload, deadline: 2 ** 32 }), /deadline/);
});

test('frames fit each medium: 140-byte SMS, 160 GSM-7 characters, 200-byte LoRa, QR; round trip in any order', () => {
  const packet = F.encodePacket({ type: 'note', payload: rnd(3900, 5) });
  for (const [name, p] of Object.entries(F.PROFILES)) {
    const bin = F.toFrames(packet, name);
    if (p.maxBytes) assert.ok(bin.every((f) => f.length <= p.maxBytes), `${name}: binary frames within ${p.maxBytes} bytes`);
    const text = p.maxChars ? F.toTextFrames(packet, name) : null;
    if (text) {
      assert.ok(text.every((t) => t.length <= p.maxChars), `${name}: text frames within ${p.maxChars} characters`);
      assert.ok(text.every((t) => GSM7.test(t)), `${name}: only GSM 7-bit characters`);
      assert.ok(text.every((t) => /^ZM[0-9A-Z_$%*+\-./:]+$/.test(t)), `${name}: base45 with "_" for space: no whitespace in a frame`);
    }
    const asm = new F.Reassembler();
    const got = shuffle(text ?? bin).map((f) => asm.add(f));
    const done = got.find((g) => g.status === 'complete');
    assert.ok(done, name);
    assert.deepEqual(done.packet, packet, `${name}: the packet back`);
    assert.equal(got.filter((g) => g.status === 'complete').length, 1);
  }
  const t32 = F.toTextFrames(packet, 'sms-text', { base32: true });
  assert.ok(t32.every((t) => t.length <= 160 && /^zm[a-z2-7]+$/.test(t)));
  const asm = new F.Reassembler();
  assert.deepEqual(t32.map((t) => asm.add(t)).at(-1).packet, packet, 'base32 frames too');
  assert.equal(F.chunkSize('sms-binary'), 129);
  assert.equal(F.chunkSize('lora'), 189);
  assert.equal(F.chunkSize('sms-text'), 105 - 11);
});

test('reassembly: losses are reported, duplicates ignored, corrupt and foreign frames refused, multi-path copies are "done"', () => {
  const packet = F.encodePacket({ type: 'cheque', payload: rnd(1000, 9) });
  const frames = F.toFrames(packet, 'sms-binary');
  const asm = new F.Reassembler();
  const id = F.parseFrame(frames[0]).id;
  for (const f of frames.filter((_, i) => i !== 2 && i !== 5)) asm.add(f);
  assert.deepEqual(asm.missing(id), [2, 5]);
  assert.equal(asm.add(frames[0]).status, 'duplicate');
  const bad = Uint8Array.from(frames[2]); bad[20] ^= 1;
  assert.match(asm.add(bad).error, /checksum/);
  assert.equal(asm.add(F.frameToText(frames[2])).status, 'partial', 'the same packet may continue on another medium (text)');
  assert.equal(asm.add(frames[5]).status, 'complete');
  assert.equal(asm.add(frames[1]).status, 'done', 'a copy from another path');
  assert.equal(asm.add('ZM???').status, 'bad');
  assert.equal(asm.add('hello').status, 'bad');
  // two packets interleaved
  const p2 = F.encodePacket({ type: 'order', payload: rnd(700, 11) });
  const a2 = new F.Reassembler();
  const mixed = shuffle([...F.toFrames(packet, 'lora'), ...F.toFrames(p2, 'lora')], 3);
  const done = mixed.map((f) => a2.add(f)).filter((r) => r.status === 'complete').map((r) => r.packet);
  assert.equal(done.length, 2);
  assert.ok(done.some((p) => F.equalBytes(p, packet)) && done.some((p) => F.equalBytes(p, p2)));
  // framesInText finds the frames in a chat export
  const chat = `Bob: here\n${F.toTextFrames(p2, 'sms-text').join('\nBob: ')}\nthanks`;
  const a3 = new F.Reassembler();
  assert.ok(F.framesInText(chat).map((t) => a3.add(t)).some((r) => r.status === 'complete'));
});

test('relay: a cash-out travels as SMS frames through two relays; the first lands, the second is refused by the chain', async () => {
  const c = await createChain(['issuer', 'relay1', 'relay2', 'alice'], {}, { precompiles: PRECOMPILES });
  const cash = await c.deploy('ZetaphyOfflineCash', [], 'issuer');
  const lockUntil = Number(c.now()) + 30 * 86400;
  await cash.send('issuer', 'bondIssuer', [BigInt(lockUntil + 31 * 86400)], 3n * ZETA);
  await cash.send('issuer', 'issue', [holderFromSeed(new Uint8Array(32).fill(1)).key, BigInt(lockUntil), [2n * ZETA]], 2n * ZETA);
  const issuer = holderFromSeed(new Uint8Array(32).fill(1)), A = holderFromSeed(new Uint8Array(32).fill(2));
  const note = { v: 1, chainId: 1, contract: cash.address.toLowerCase(), note: { id: '1', issuer: c.acct.issuer.toString(), value: String(2n * ZETA), lockUntil, issuerKey: issuer.key }, links: [] };
  const out = core.signTerminal(C, core.passOn(C, note, issuer, A.key), A, c.acct.alice.toString(), ZETA / 100n);
  const packet = F.encodePacket({ type: 'redeem', payload: payloadFromFile('redeem', core.noteToText(out)), deadline: Number(c.now()) + 3 * 86400, fee: ZETA / 100n });
  const sms = F.toTextFrames(packet, 'sms-text');
  assert.ok(sms.length > 60 && sms.length < 90, `${sms.length} SMS`);
  const sender = (who) => async (plan) => {
    const r = await c.rawCall(who, plan.to, plan.data);
    if (!r.ok) { let name = 'revert'; try { name = cash.iface.parseError(r.returnHex)?.name; } catch { /* raw */ } throw new Error(name); }
    return '0xtx';
  };
  const r1 = new MeshRelay({ send: sender('relay1'), now: () => Number(c.now()) });
  const r2 = new MeshRelay({ send: sender('relay2'), now: () => Number(c.now()) });
  // relay 1 hears the frames over SMS, relay 2 over LoRa text (different frames, same packet); both lose and repeat some
  const lora = F.toTextFrames(packet, 'lora-text');
  const res1 = r1.acceptText(shuffle([...sms, sms[0], sms[3]]).join('\n'));
  const res2 = r2.acceptText(shuffle([...lora, lora[1]], 5).join(' '));
  assert.equal(res1.filter((r) => r.status === 'queued').length, 1);
  assert.equal(res2.filter((r) => r.status === 'queued').length, 1);
  assert.equal(r1.acceptText(sms.join('\n')).every((r) => r.status === 'done'), true, 'the same packet again: done');
  const before = await c.balance('alice');
  const o1 = await r1.flush();
  assert.deepEqual(o1.map((o) => o.outcome), ['submitted']);
  assert.equal(await c.balance('alice') - before, 2n * ZETA - ZETA / 100n);
  const o2 = await r2.flush();
  assert.deepEqual(o2.map((o) => [o.outcome, o.error]), [['landed-elsewhere', 'AlreadyPaid']]);
  assert.equal(r2.queue.length, 0);
  // an expired packet is dropped on arrival
  const old = F.encodePacket({ type: 'redeem', payload: core.encodeBundle(out), deadline: Number(c.now()) - 1 });
  assert.equal(new MeshRelay({ now: () => Number(c.now()) }).acceptText(F.toTextFrames(old, 'qr').join('\n')).at(-1).status, 'expired');
  // a note without a cash-out is for its holder, not for relays
  const plain = F.encodePacket({ type: 'note', payload: core.encodeBundle(core.passOn(C, note, issuer, A.key)) });
  assert.equal(new MeshRelay().acceptText(F.toTextFrames(plain, 'qr').join('\n')).at(-1).status, 'unsendable');
  // the queue survives a restart; higher fee first
  const r3 = new MeshRelay({ state: r1.state() });
  assert.equal(r3.seen.size, 1);
  assert.equal(planSubmit(F.decodePacket(packet)).to, cash.address.toLowerCase());
});

test('size table: frames per medium (ML-DSA-44 signatures are 2,420 bytes, keys 1,312)', () => {
  const { rows, text } = sizeTable();
  const by = Object.fromEntries(rows.map((r) => [r.what, r]));
  assert.equal(by['note, fresh from the issuer (0 links)'].frames['sms-binary'], 1);
  assert.ok(by['note after 1 hand-over (1 ML-DSA link)'].bytes > 3765, 'a link is 32 + 1 + 1312 + 2420 bytes');
  assert.ok(by['note after 1 hand-over (1 ML-DSA link)'].frames['sms-text'] >= 40);
  assert.ok(by['cheque (ZCHQ1 text)'].frames['lora'] <= 2);
  const doc = readFileSync(new URL('../../docs/future/offline-cash.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(text), 'docs/future/offline-cash.md carries the current table (zetaphy mesh sizes)');
});

test('the hub serves a byte-identical copy of frames.js', () => {
  assert.equal(readFileSync(new URL('../../zetaphy-hub/mesh-frames.js', import.meta.url), 'utf8'), readFileSync(new URL('../src/mesh/frames.js', import.meta.url), 'utf8'));
});
