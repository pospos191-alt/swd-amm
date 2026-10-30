// ZETAPHY Mesh relay (docs/future/offline-cash.md, "Mesh"): accepts frames from any medium (SMS text, LoRa, QR, a
// file), reassembles packets, drops duplicates and expired ones, and submits them when online. The same packet may
// arrive through several relays (multi-path): whichever lands first wins; the others are refused by the chain's own
// replay protection (a tx nonce, a cheque's cumulative total, an order nonce, a note's spentBy record) and are
// recorded as "landed elsewhere", not retried forever.
import { Reassembler, decodePacket, TYPES } from './frames.js';
import { core as cash, NODE_CRYPTO } from '../offlinecash.js';
import * as off from '../../../zetaphy-hub/offline-core.js';

/** Revert reasons / RPC errors that mean "someone already did this" (a copy landed through another path). */
export const LANDED = /AlreadyPaid|NoteDone|NothingToCash|NonceUsed|nonce too low|already known|OwnDoubleSpend|ChannelDone|Expired order/i;
const dec = (b) => new TextDecoder().decode(b);

/**
 * What to send on chain for a packet: { to, data } (a contract call the relayer pays gas for, earning the fee in
 * the signed payload) or { raw } (an already signed transaction). Throws for a payload that does not parse.
 */
export function planSubmit(packet) {
  switch (packet.type) {
    case 'tx': return { raw: cash.hex(packet.payload) };
    case 'redeem':
    case 'note': {
      const b = cash.decodeBundle(packet.payload);
      if (!b.terminal) throw new Error('a note without a cash-out signature: nothing to submit (it is for its holder)');
      return { to: b.contract, data: cash.encodeRedeem(NODE_CRYPTO, b) };
    }
    case 'swap': {
      const s = cash.decodeSwap(packet.payload);
      return { to: s.a.contract, data: cash.encodeSettleSwap(NODE_CRYPTO, s) };
    }
    case 'cheque': {
      const ch = off.decodeCheque(dec(packet.payload));
      return { to: ch.contract, data: off.encodeCash(ch.channelId, ch.cumulative, ch.sig) };
    }
    case 'order': {
      const o = off.decodeOrder(dec(packet.payload));
      return { to: o.contract, data: off.encodeFill(o.order, o.sig, []) };
    }
    default: throw new Error(`packet type ${packet.type}: nothing to submit`);
  }
}

export class MeshRelay {
  /**
   * @param send  async ({ to, data } | { raw }) => tx hash; throws with the chain's error text
   * @param now   () => unix seconds
   * @param state { done: [packet ids], queue: [{ id, packetHex, ... }] } from an earlier run (JSON)
   */
  constructor({ send = null, now = () => Math.floor(Date.now() / 1000), state = null } = {}) {
    this.send = send; this.now = now;
    this.asm = new Reassembler({ now: () => this.now() * 1000 });
    this.seen = new Set(state?.done ?? []);
    this.queue = (state?.queue ?? []).filter((q) => q && typeof q.packetHex === 'string');
    this.log = [];
  }
  /** One frame (bytes or text). Returns the reassembler's answer, plus `packet` info once complete. */
  accept(input) {
    const r = this.asm.add(input);
    if (r.status !== 'complete') return r;
    let p;
    try { p = decodePacket(r.packet); } catch (e) { return { status: 'bad', error: e.message }; }
    if (this.seen.has(p.id) || this.queue.some((q) => q.id === p.id)) return { status: 'done', id: p.id };
    if (p.deadline && p.deadline < this.now()) { this.seen.add(p.id); return { status: 'expired', id: p.id, type: p.type }; }
    try { planSubmit(p); } catch (e) { this.seen.add(p.id); return { status: 'unsendable', id: p.id, type: p.type, error: e.message }; }
    this.queue.push({ id: p.id, type: p.type, deadline: p.deadline, fee: String(p.fee), packetHex: cash.hex(r.packet), at: this.now(), tries: 0 });
    return { status: 'queued', id: p.id, type: p.type };
  }
  /** Every frame token in a pasted text / file. */
  acceptText(text) { return String(text).split(/[\s,;]+/).filter((w) => /^(ZM|zm)/.test(w)).map((w) => this.accept(w)); }
  /** Online: submit the queue, highest fee hint first, then the nearest deadline. Returns [{ id, outcome, tx?, error? }]. */
  async flush() {
    if (!this.send) throw new Error('no way to submit: start the relay with an RPC and a key');
    const order = [...this.queue].sort((a, b) => (BigInt(b.fee) > BigInt(a.fee) ? 1 : BigInt(b.fee) < BigInt(a.fee) ? -1 : (a.deadline || 4e9) - (b.deadline || 4e9)));
    const out = [];
    for (const q of order) {
      const p = decodePacket(cash.bytes(q.packetHex));
      let outcome, tx = null, error = null;
      if (p.deadline && p.deadline < this.now()) outcome = 'expired';
      else {
        try { tx = await this.send(planSubmit(p)); outcome = 'submitted'; } catch (e) {
          error = String(e?.shortMessage ?? e?.message ?? e);
          outcome = LANDED.test(error) ? 'landed-elsewhere' : (q.tries += 1) >= 5 ? 'failed' : 'retry';
        }
      }
      if (outcome !== 'retry') { this.queue = this.queue.filter((x) => x.id !== q.id); this.seen.add(q.id); }
      out.push({ id: q.id, type: q.type, outcome, tx, error });
    }
    this.log.push(...out);
    return out;
  }
  state() { return { done: [...this.seen].slice(-5000), queue: this.queue }; }
}

export { TYPES };
