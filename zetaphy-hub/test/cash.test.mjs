// The Offline tab's "Offline cash" and "Mesh" cards (offline-cash.js) and their logic (cash-core.js, mesh-frames.js)
// with the browser's own crypto (ML-DSA-44 and keccak-256 from the wallet bundle the page loads): a note made, signed
// over and checked; calldata against ethers; Mesh packets for notes (with proofs), cheques and orders; the stored
// state cleaned; the words in 8 languages; the files in the build and the offline shell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface } from 'ethers';
import * as cash from '../cash-core.js';
import * as M from '../mesh-frames.js';
import * as off from '../offline-core.js';
import { CASH } from '../offline-cash-i18n.js';
import { cleanCashState, packetsFor, meshIn, noteFromPackets, holderOf, keyLabel } from '../offline-cash.js';
import { LANG_CODES } from '../i18n.js';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const { ml_dsa44: ml, keccak_256 } = await import('../../zetaphy-wallet/vendor/pqwallet.js');
const C = { keccak: (b) => keccak_256(b), verify: (s, m, pk) => ml.verify(s, m, pk) };
const shape = (v, at = '') => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => shape(x, `${at}/${k}`)) : [`${at}:${typeof v}`]);
const CONTRACT = '0x' + 'ca'.repeat(20);
const issuer = holderOf(ml, C, new Uint8Array(32).fill(1));
const me = holderOf(ml, C, new Uint8Array(32).fill(2));
const next = holderOf(ml, C, new Uint8Array(32).fill(3));
const NOW = 1_800_000_000;
const note = { v: 1, chainId: 77390, contract: CONTRACT, note: { id: '7', issuer: '0x' + '11'.repeat(20), value: String(25n * 10n ** 17n), lockUntil: NOW + 30 * 86400, issuerKey: issuer.key }, links: [] };

test('CASH words: every language has every key, translated; the five risks include who pays a double-spend and the radio rules', () => {
  assert.deepEqual(Object.keys(CASH).sort(), [...LANG_CODES].sort());
  const en = shape(CASH.en);
  for (const l of LANG_CODES) {
    const T = CASH[l];
    assert.deepEqual(shape(T), en, l);
    assert.equal(T.risks.length, 5, l);
    if (l !== 'en') for (const k of ['tip', 'recvTip', 'meshTip', 'keyTip', 'passed']) assert.notEqual(T[k], CASH.en[k], `${l}.${k} translated`);
    assert.ok(T.valid('2.5', 3).includes('2.5') && T.valid('2.5', 3).includes('3'), `${l}.valid`);
    assert.ok(T.funds('1', '2', 'T').includes('1') && T.funds('1', '2', 'T').includes('T'), `${l}.funds`);
    assert.ok(T.progress(4, 9).includes('4') && T.progress(4, 9).includes('9'), `${l}.progress`);
    for (const k of Object.keys(CASH.en.problem)) assert.ok(T.problem[k]?.trim(), `${l}.problem.${k}`);
    for (const k of Object.keys(CASH.en.warn)) assert.ok(T.warn[k]?.trim(), `${l}.warn.${k}`);
    assert.ok(T.risks.some((r) => /ML-DSA|LoRa/.test(r)), `${l}: the radio rule names LoRa`);
  }
});

test('a note made, signed over and checked with the browser bundle\'s ML-DSA-44; the redeem calldata is the ABI\'s', () => {
  const mine = cash.passOn(C, note, issuer, me.key);
  const r = cash.receiveCheck(C, mine, { me: me.key, now: NOW, contract: CONTRACT });
  assert.ok(r.ok, r.problems.join());
  assert.deepEqual(r.warnings, ['noProof']);
  assert.equal(r.seq, 1);
  assert.deepEqual(cash.receiveCheck(C, mine, { me: next.key, now: NOW }).problems, ['notToYou']);
  const passed = cash.passOn(C, mine, me, next.key);
  assert.throws(() => cash.passOn(C, mine, next, me.key), /not the holder/);
  const out = cash.signTerminal(C, passed, next, '0x' + '22'.repeat(20), 10n ** 16n);
  assert.ok(cash.walk(C, out).ok);
  assert.deepEqual(cash.receiveCheck(C, out, { me: next.key, now: NOW }).problems, ['hasTerminal']);
  const iface = new Interface(['function redeem(uint256 id, (bytes32 to, bytes32 cond, bytes pk, bytes sig)[] links, (address payout, uint96 fee, bytes pk, bytes sig) t)']);
  const b = cash.cleanBundle(out);
  assert.equal(cash.encodeRedeem(C, out), iface.encodeFunctionData('redeem', [b.note.id, b.links.map((l) => [l.to, l.cond, l.pk, l.sig]), [b.terminal.payout, b.terminal.fee, b.terminal.pk, b.terminal.sig]]));
  // two copies signed from the same position: the payee can show who split it
  const split = cash.findSplit(C, passed, cash.passOn(C, mine, me, issuer.key));
  assert.deepEqual([split.seq, split.cheater, split.issuer], [1, me.key, false]);
  assert.equal(keyLabel(me.key), `0x${me.key.slice(-40)}`);
});

test('Mesh: a note with a proof, a cheque and an order go out as frames and come back in any order', () => {
  const proof = { kind: 'attest', chainId: 'zetaphy_77390-1', height: 9, time: NOW, log: { address: CONTRACT, topics: ['0x' + '00'.repeat(32)], data: '0x' }, attestations: '0x' + 'ab'.repeat(2440) };
  const mine = { ...cash.passOn(C, note, issuer, me.key), proofs: [proof] };
  const packets = packetsFor(cash.noteToText(mine));
  assert.deepEqual(packets.map((p) => M.decodePacket(p).type), ['note', 'proof']);
  const frames = packets.flatMap((p) => M.toTextFrames(p, 'sms-text'));
  assert.ok(frames.every((f) => f.length <= 160));
  const asm = new M.Reassembler();
  const first = meshIn(asm, frames.slice(0, 10).join('\n'));
  assert.equal(first.packets.length, 0);
  assert.ok(first.progress[0].missing.length > 0);
  const rest = meshIn(asm, [...frames.slice(10)].reverse().join(' '));
  const back = noteFromPackets(rest.packets);
  assert.deepEqual(back, JSON.parse(JSON.stringify(cash.cleanBundle(mine))));
  const cheque = off.encodeCheque({ contract: CONTRACT, channelId: 3n, cumulative: 5n, sig: '0x' + '12'.repeat(64) + '1b' });
  const [cp] = packetsFor(cheque);
  assert.equal(M.decodePacket(cp).type, 'cheque');
  assert.equal(new TextDecoder().decode(M.decodePacket(cp).payload), cheque);
  assert.ok(M.toTextFrames(cp, 'lora-text').length <= 3, 'a cheque fits in a few LoRa messages');
  assert.equal(packetsFor('hello'), null);
  const t = cash.signTerminal(C, mine, me, '0x' + '22'.repeat(20), 0n);
  assert.equal(M.decodePacket(packetsFor(cash.noteToText(t))[0]).type, 'redeem', 'a signed cash-out goes as a redeem packet a relay can submit');
});

test('the stored state is cleaned: malformed notes, keys and pins are dropped', () => {
  const good = cash.noteToText(cash.passOn(C, note, issuer, me.key));
  const s = cleanCashState({ key: { keyHash: me.key, blob: { v: 1 } }, notes: [{ text: good, at: 5 }, { text: good }, { text: 'ZNOTE1:xxx' }, null], pin: '{"validators":{}}' });
  assert.deepEqual(s.notes.map((n) => n.text), [good]);
  assert.equal(s.key.keyHash, me.key);
  assert.equal(s.pin, null);
  assert.deepEqual(cleanCashState({ key: { keyHash: '0x12', blob: {} } }), { key: null, notes: [], pin: null });
  assert.deepEqual(cleanCashState('nope'), { key: null, notes: [], pin: null });
});

test('files: the hub copy of frames.js is the CLI\'s; the build ships the cash files and the offline shell keeps them', async () => {
  assert.equal(readFileSync(join(HERE, 'mesh-frames.js'), 'utf8'), readFileSync(join(HERE, '..', 'zetaphy-network', 'src', 'mesh', 'frames.js'), 'utf8'));
  const { build, shellFiles } = await import('../build.mjs');
  const out = build();
  const files = shellFiles(out);
  for (const f of ['offline-cash.js', 'offline-cash-i18n.js', 'cash-core.js', 'mesh-frames.js']) assert.ok(files.includes(f), `in the offline shell: ${f}`);
  for (const f of ['cash-core.js', 'offline-cash.js']) assert.doesNotMatch(readFileSync(join(HERE, f), 'utf8'), /innerHTML|style=|eval\(|new Function/, `${f}: CSP-safe`);
});
