// `zetaphy mesh …` and `zetaphy cash …` (docs/future/offline-cash.md).
//   zetaphy mesh send <tx|note|redeem|swap|cheque|order|proof|raw> <file> [--profile sms-text|sms-binary|lora|lora-text|qr|file]
//        [--deadline-hours 72] [--fee <wei hint>] [--base32]      print the frames, one per line
//   zetaphy mesh relay [--in <file, default stdin>] [--submit]  read frames from anywhere, reassemble, queue; --submit sends
//        the queue (online: --rpc, this machine's key pays gas and earns the fees in the signed payloads)
//   zetaphy mesh sizes                                         frames per medium for a cheque, an order, notes, a proof
//   zetaphy cash key                                           this machine's ML-DSA-44 holder key (its 32-byte key hash)
//   zetaphy cash check <note.txt> [--pin pinned.json] [--contract 0x…]   verify a received note with no network
//   zetaphy cash pass <note.txt> <next holder key 0x…64>       sign it over (prints the new ZNOTE1: text)
//   zetaphy cash cashout <note.txt> <payout 0x…> [--fee <wei>] sign the cash-out (anyone can submit it: mesh send redeem)
//   zetaphy cash proof <note.txt> --comet <CometBFT RPC> --height <H of the issue tx>   attach the offline proof of funds
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as F from './frames.js';
import { MeshRelay } from './relay.js';
import { core, NODE_CRYPTO, loadOrCreateHolder, buildResultsProof } from '../offlinecash.js';
import * as off from '../../../zetaphy-hub/offline-core.js';

const readIn = (file) => (file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'));

/** Payload bytes of a file for a packet type: notes / swaps as text are turned into their compact binary form. */
export function payloadFromFile(type, text) {
  const t = String(text).trim();
  if (type === 'note' || type === 'redeem') return core.encodeBundle(t.startsWith(core.NOTE_PREFIX) ? core.noteFromText(t) : JSON.parse(t));
  if (type === 'swap') return core.encodeSwap(JSON.parse(t));
  if (type === 'proof') return core.encodeProof(JSON.parse(t));
  if (type === 'tx' || type === 'raw') return core.bytes(t);
  return F.utf8(t); // cheque / order: their ZCHQ1: / ZORD1: text
}

export async function meshCommand({ cmd, rest, opt, write, s, connect, home }) {
  if (cmd === 'send') {
    const [type, file] = rest;
    if (!F.TYPES[type] || !file) { write('usage: zetaphy mesh send <tx|note|redeem|swap|cheque|order|proof|raw> <file> [--profile sms-text]'); return 2; }
    const hours = Number(opt['deadline-hours'] ?? 72);
    const packet = F.encodePacket({ type, payload: payloadFromFile(type, readIn(file)), deadline: hours > 0 ? Math.floor(Date.now() / 1000) + Math.round(hours * 3600) : 0, fee: BigInt(opt.fee ?? 0) });
    const profile = opt.profile ?? 'sms-text';
    const p = F.PROFILES[profile];
    if (!p) { write(`unknown profile ${profile}: ${Object.keys(F.PROFILES).join(', ')}`); return 2; }
    const frames = p.maxChars || opt.base32 ? F.toTextFrames(packet, profile, { base32: !!opt.base32 }) : F.toFrames(packet, profile).map(F.frameToText);
    write(frames.join('\n'));
    console.error(`${packet.length} bytes -> ${frames.length} frame(s) for ${p.label}${p.maxChars ? '' : ' (shown as base45 text; send the binary frames on a binary medium)'}`);
    return 0;
  }
  if (cmd === 'relay') {
    const file = join(home, 'mesh-relay.json');
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    let send = null;
    if (opt.submit) {
      const { signer, provider } = await connect(s, { needJobs: false });
      send = async (plan) => (plan.raw ? provider.send('eth_sendRawTransaction', [plan.raw]) : (await signer.sendTransaction({ to: plan.to, data: plan.data })).hash);
    }
    const relay = new MeshRelay({ send, state });
    for (const r of relay.acceptText(opt.in || !process.stdin.isTTY ? readIn(opt.in) : '')) {
      if (r.status === 'partial') write(`frame ${r.have}/${r.total} of ${r.id}`);
      else if (r.status !== 'duplicate') write(`${r.status}${r.id ? ` ${r.id}` : ''}${r.type ? ` (${r.type})` : ''}${r.error ? `: ${r.error}` : ''}`);
    }
    if (opt.submit) for (const o of await relay.flush()) write(`${o.id} ${o.type}: ${o.outcome}${o.tx ? ` ${o.tx}` : ''}${o.error ? ` (${o.error.slice(0, 120)})` : ''}`);
    write(`${relay.queue.length} packet(s) waiting${opt.submit ? '' : ' (send them with --submit when online)'}`);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(relay.state()));
    return 0;
  }
  if (cmd === 'sizes') { write(sizeTable().text); return 0; }
  write('usage: zetaphy mesh send | relay | sizes');
  return 2;
}

/** Frames per medium for the things people send (measured with real ML-DSA-44 sizes). */
export function sizeTable() {
  const pk = '0x' + '11'.repeat(core.PK_BYTES), sig = '0x' + '22'.repeat(core.SIG_BYTES), k32 = '0x' + '33'.repeat(32), addr = '0x' + '44'.repeat(20);
  const note = (links, terminal = false) => ({ v: 1, chainId: 77390, contract: addr, note: { id: '12345', issuer: addr, value: String(10n ** 18n), lockUntil: 1_900_000_000, issuerKey: k32 },
    links: Array.from({ length: links }, () => ({ to: k32, cond: core.ZERO32, pk, sig })), ...(terminal ? { terminal: { payout: addr, fee: '1000000000000000', pk, sig } } : {}) });
  const ecdsa = '0x' + '66'.repeat(64) + '1b';
  const cheque = off.encodeCheque({ contract: addr, channelId: 42n, cumulative: 12345n * 10n ** 15n, sig: ecdsa });
  const order = off.encodeOrder({ contract: addr, sig: ecdsa, order: { maker: addr, tokenIn: addr, tokenOut: addr, amountIn: String(10n ** 20n),
    minAmountOut: String(95n * 10n ** 18n), deadline: '1900000000', nonce: String(2n ** 200n), relayerFee: String(10n ** 17n) } });
  const logData = core.encodeResultData([{ address: addr, topics: [k32, k32, k32], data: '0x' + '77'.repeat(96) }]);
  const att = (n) => '0x' + '55'.repeat(core.ATTESTATION_BYTES * n);
  const header = { version: { block: '11' }, chain_id: 'zetaphy_77390-1', height: '123457', time: '2026-10-30T09:00:00.123456789Z', last_block_id: { hash: 'AA'.repeat(32), parts: { total: 1, hash: 'BB'.repeat(32) } },
    ...Object.fromEntries(['last_commit_hash', 'data_hash', 'validators_hash', 'next_validators_hash', 'consensus_hash', 'app_hash', 'last_results_hash', 'evidence_hash'].map((x) => [x, 'CC'.repeat(32)])), proposer_address: 'DD'.repeat(20) };
  const proof = (n) => ({ kind: 'results', chainId: 'zetaphy_77390-1', header, attestations: att(n), txIndex: 3, total: 8, aunts: ['0x' + 'ee'.repeat(32), '0x' + 'ee'.repeat(32), '0x' + 'ee'.repeat(32)],
    result: { code: 0, data: core.hex(logData), gasWanted: '300000', gasUsed: '120000' }, logIndex: 0 });
  const rows = [
    ['signed EVM tx (ECDSA, simple call)', 180],
    ['cheque (ZCHQ1 text)', F.utf8(cheque).length],
    ['swap order (ZORD1 text)', F.utf8(order).length],
    ['note, fresh from the issuer (0 links)', core.encodeBundle(note(0)).length],
    ['note after 1 hand-over (1 ML-DSA link)', core.encodeBundle(note(1)).length],
    ['note after 3 hand-overs', core.encodeBundle(note(3)).length],
    ['cash-out (1 link + terminal)', core.encodeBundle(note(1, true)).length],
    ['note proof, 4 validators sign', core.encodeProof(proof(4)).length],
    ['note proof, 21 validators sign 15', core.encodeProof(proof(15)).length],
  ].map(([what, payload]) => {
    const bytes = F.encodePacket({ type: 'raw', payload: new Uint8Array(payload), deadline: 1_900_000_000 }).length;
    return { what, bytes, frames: F.frameCounts(bytes) };
  });
  const cols = Object.keys(F.PROFILES);
  const text = [`| what | packet bytes | ${cols.join(' | ')} |`, `|---|---:|${cols.map(() => '---:').join('|')}|`,
    ...rows.map((r) => `| ${r.what} | ${r.bytes.toLocaleString('en-US')} | ${cols.map((c) => r.frames[c]).join(' | ')} |`)].join('\n');
  return { rows, text };
}

export async function cashCommand({ cmd, rest, opt, write }) {
  const crypto = NODE_CRYPTO;
  const readNote = (f) => core.noteFromText(readIn(f));
  if (cmd === 'key') {
    const h = loadOrCreateHolder();
    write(`holder key: ${h.key}${h.created ? ` (new, ${h.file})` : ''}\ngive this key hash to whoever pays you a note`);
    return 0;
  }
  if (cmd === 'check') {
    const b = readNote(rest[0]);
    const me = loadOrCreateHolder().key;
    const pin = opt.pin ? readFileSync(opt.pin, 'utf8') : null;
    const r = core.receiveCheck(crypto, b, { me, pin, contract: opt.contract });
    write(JSON.stringify({ ok: r.ok, problems: r.problems, warnings: r.warnings, value: r.value, handOvers: r.seq,
      covered: r.funds ? String(r.funds.covered) : null, asOf: r.funds?.asOf ?? null, proofProblems: r.funds?.problems ?? [] }, null, 2));
    return r.ok ? 0 : 1;
  }
  if (cmd === 'pass') {
    const [file, to] = rest;
    write(core.noteToText(core.passOn(crypto, readNote(file), loadOrCreateHolder(), to)));
    return 0;
  }
  if (cmd === 'cashout') {
    const [file, payout] = rest;
    write(core.noteToText(core.signTerminal(crypto, readNote(file), loadOrCreateHolder(), payout, BigInt(opt.fee ?? 0))));
    return 0;
  }
  if (cmd === 'proof') {
    const b = readNote(rest[0]);
    if (!opt.comet || !opt.height) { write('usage: zetaphy cash proof <note.txt> --comet <CometBFT RPC> --height <block of the issue tx>'); return 2; }
    const topic = core.topicOf(crypto, core.SIGS.noteIssued);
    const item = await buildResultsProof(opt.comet, { height: opt.height, contract: b.contract, topics: [topic, core.hex(core.word(b.note.id))] });
    write(core.noteToText({ ...b, proofs: [...(b.proofs ?? []), item] }));
    return 0;
  }
  write('usage: zetaphy cash key | check | pass | cashout | proof');
  return 2;
}
