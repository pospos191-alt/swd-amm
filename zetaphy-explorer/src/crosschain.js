// Cross-chain trace on the tx page:
//   - Hyperlane (Saphan): a tx that dispatched a message through ZETAPHY's Mailbox
//     (Dispatch + DispatchId events) shows the message id, the destination chain and,
//     by asking that chain's public RPC (crosschain.json, built from
//     zetaphy-chain/hyperlane/saphan-chains.json, https only), whether the message was
//     delivered (Mailbox.delivered(id)), and when (its ProcessId event), with a link to
//     that chain's explorer. Incoming messages (Process + ProcessId) show their origin
//     chain and, best effort, the origin tx (DispatchId on the origin Mailbox).
//   - IBC: packets sent, received, acknowledged or timed out (Cosmos events) with their
//     ports, channels and sequence.
// Message id = keccak256(message); message = version(1) nonce(4) origin(4) sender(32)
// destination(4) recipient(32) body (Hyperlane's Message.sol).
import { h } from './dom.js';
import { keccak_256, bytesToHex, hexToBytes, toChecksumHex } from '../vendor/zetaphy-lib.js';
import { createApi, TTL } from './rpc.js';
import { safeText, short, utcTime, groupDigits } from './format.js';

const enc = new TextEncoder();
const topicOf = (sig) => '0x' + bytesToHex(keccak_256(enc.encode(sig)));
export const HL_TOPICS = {
  dispatch: topicOf('Dispatch(address,uint32,bytes32,bytes)'),
  dispatchId: topicOf('DispatchId(bytes32)'),
  process: topicOf('Process(uint32,bytes32,address)'),
  processId: topicOf('ProcessId(bytes32)'),
};
export const DELIVERED_SEL = bytesToHex(keccak_256(enc.encode('delivered(bytes32)'))).slice(0, 8);
const HEX32 = /^0x[0-9a-fA-F]{64}$/;

let table = { zetaphy: { domain: 77390, mailbox: null }, chains: {} };
/** The chain table (crosschain.json); bad rows dropped, only https RPCs kept. */
export function setCrossChain(cc) {
  const chains = {};
  for (const [k, c] of Object.entries(cc?.chains ?? {})) {
    if (!c || !Number.isInteger(c.domain) || !/^0x[0-9a-fA-F]{40}$/.test(c.mailbox ?? '')) continue;
    const https = (u) => { try { return new URL(u).protocol === 'https:'; } catch { return false; } };
    chains[k] = { key: k, name: safeText(c.name ?? k, 40), domain: c.domain, mailbox: c.mailbox, rpc: (c.rpc ?? []).filter(https).slice(0, 4),
      explorer: https(c.explorer) ? String(c.explorer).replace(/\/+$/, '') : '', blockTime: Number(c.blockTime) || 12 };
  }
  table = { zetaphy: { domain: cc?.zetaphy?.domain ?? 77390, mailbox: /^0x[0-9a-fA-F]{40}$/.test(cc?.zetaphy?.mailbox ?? '') ? cc.zetaphy.mailbox : null, name: safeText(cc?.zetaphy?.name ?? 'ZETAPHY', 40) }, chains };
  return Object.keys(chains).length;
}
export async function loadCrossChain(fetchFn = (...a) => fetch(...a)) {
  try { const r = await fetchFn('crosschain.json', { credentials: 'omit', cache: 'default' }); if (r.ok) return setCrossChain(await r.json()); } catch { /* none */ }
  return 0;
}
export const chainByDomain = (d) => Object.values(table.chains).find((c) => c.domain === Number(d)) ?? null;
export const zetaphyMailbox = () => table.zetaphy.mailbox;

/** The fields of a Hyperlane message (bytes or hex), or null when too short. */
export function decodeMessage(msg) {
  const b = typeof msg === 'string' ? hexToBytes(msg.replace(/^0x/, '')) : msg;
  if (!b || b.length < 77) return null;
  const u32 = (o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const b32 = (o) => '0x' + bytesToHex(b.subarray(o, o + 32));
  return { version: b[0], nonce: u32(1), origin: u32(5), sender: b32(9), destination: u32(41), recipient: b32(45), bodyLength: b.length - 77, id: '0x' + bytesToHex(keccak_256(b)) };
}

/** A bytes32 that holds an address (12 zero bytes first) -> EIP-55 address, else the bytes32. */
export function bytes32Address(x) {
  const s = String(x ?? '');
  return /^0x0{24}[0-9a-fA-F]{40}$/.test(s) ? toChecksumHex(hexToBytes(s.slice(26))) : s;
}

/** ABI `bytes` at the start of log data (offset, length, bytes) -> Uint8Array or null. */
function abiBytes(data) {
  const d = String(data ?? '').replace(/^0x/, '');
  if (!/^([0-9a-fA-F]{2})*$/.test(d) || d.length < 128) return null;
  const off = Number(BigInt('0x' + d.slice(0, 64))); const len = Number(BigInt('0x' + d.slice(off * 2, off * 2 + 64)));
  const start = off * 2 + 64;
  if (!Number.isSafeInteger(off) || !Number.isSafeInteger(len) || d.length < start + len * 2) return null;
  return hexToBytes(d.slice(start, start + len * 2));
}

/**
 * Hyperlane messages in a tx's logs, from the given Mailbox only (any other emitter could fake the events):
 * [{ dir: 'out', id, origin, destination, sender, recipient, nonce } | { dir: 'in', id, origin, sender, recipient }]
 */
export function hyperlaneMessages(logs, mailbox = table.zetaphy.mailbox) {
  if (!mailbox) return [];
  const mine = (logs ?? []).filter((l) => String(l?.address ?? '').toLowerCase() === mailbox.toLowerCase())
    .sort((x, y) => Number(BigInt(x.logIndex ?? 0) - BigInt(y.logIndex ?? 0)));
  const out = []; const byId = new Map();
  mine.forEach((l, i) => {
    const t = (l.topics ?? []).map((x) => String(x).toLowerCase());
    if (t[0] === HL_TOPICS.dispatch && t.length === 4) {
      const bytes = abiBytes(l.data); const m = bytes && decodeMessage(bytes);
      if (!m) return;
      const x = { dir: 'out', id: m.id, origin: m.origin, destination: m.destination, sender: bytes32Address(m.sender), recipient: bytes32Address(m.recipient), nonce: m.nonce, bodyLength: m.bodyLength };
      out.push(x); byId.set(m.id, x);
    } else if (t[0] === HL_TOPICS.dispatchId && HEX32.test(t[1] ?? '')) {
      const x = byId.get(t[1]);
      if (x) x.idConfirmed = true; else { const y = { dir: 'out', id: t[1], destination: null }; out.push(y); byId.set(t[1], y); }
    } else if (t[0] === HL_TOPICS.process && t.length === 4) {
      // Mailbox.process emits Process(origin, sender, recipient) then ProcessId(id)
      const next = mine[i + 1]; const nt = (next?.topics ?? []).map((x) => String(x).toLowerCase());
      const id = nt[0] === HL_TOPICS.processId && HEX32.test(nt[1] ?? '') ? nt[1] : null;
      out.push({ dir: 'in', id, origin: Number(BigInt(t[1])), sender: bytes32Address(t[2]), recipient: bytes32Address(t[3]) });
    }
  });
  return out;
}

/** IBC packets in a Cosmos tx's events (normalised: [{ type, attributes: [{ key, value }] }]). */
export function ibcPackets(events) {
  const KINDS = { send_packet: 'sent', recv_packet: 'received', acknowledge_packet: 'acknowledged', timeout_packet: 'timeout', write_acknowledgement: 'ackWritten' };
  const out = []; const seen = new Set();
  for (const e of events ?? []) {
    const kind = KINDS[e?.type];
    if (!kind) continue;
    const a = Object.fromEntries((e.attributes ?? []).map((x) => [String(x.key), String(x.value ?? '')]));
    const p = { kind, sequence: a.packet_sequence ?? '', srcPort: a.packet_src_port ?? '', srcChannel: a.packet_src_channel ?? '', dstPort: a.packet_dst_port ?? '', dstChannel: a.packet_dst_channel ?? '',
      timeoutHeight: a.packet_timeout_height ?? '', connection: a.packet_connection ?? a.connection_id ?? '' };
    const k = `${kind}|${p.sequence}|${p.srcChannel}|${p.dstChannel}`;
    if (!p.sequence || seen.has(k)) continue;
    seen.add(k); out.push(p);
  }
  return out;
}

// ---- other chains' RPCs (rpc.js clients, one per RPC URL, polite and cached) ----

const apis = new Map();
const apiFor = (url, fetchFn) => {
  if (!apis.has(url)) apis.set(url, createApi({ evm: url, comet: url, rest: url }, { maxConcurrent: 2, maxRps: 4, timeoutMs: 12000, fetchFn }));
  return apis.get(url);
};
async function onAnyRpc(chain, fn, fetchFn) {
  let last;
  for (const url of chain.rpc) {
    try { return await fn(apiFor(url, fetchFn).evm); } catch (e) { last = e; if (e?.kind === 'rpc') throw e; }
  }
  throw last ?? new Error('no https RPC for this chain');
}

/** Searches recent blocks of `chain` for a Mailbox event with topic1 = id (bounded window). */
async function findEvent(evm, chain, topic, id, { span }) {
  const latest = Number(BigInt(await evm('eth_blockNumber', [], TTL.latest)));
  const logs = await evm('eth_getLogs', [{ address: chain.mailbox, topics: [topic, id], fromBlock: '0x' + Math.max(0, latest - span).toString(16), toBlock: '0x' + latest.toString(16) }], TTL.short);
  const l = Array.isArray(logs) ? logs[0] : null;
  if (!l) return null;
  let time = null;
  try { const b = await evm('eth_getBlockByNumber', [l.blockNumber, false], TTL.forever); time = b?.timestamp ? new Date(Number(BigInt(b.timestamp)) * 1000).toISOString() : null; } catch { time = null; }
  return { txHash: l.transactionHash, block: BigInt(l.blockNumber).toString(), time };
}

/**
 * Was message `id` delivered on `chain`? { delivered, txHash?, block?, time?, link? }.
 * delivered() is exact; the "when" is searched in the last ~`span` blocks (public RPCs limit ranges).
 */
export async function checkDelivery(chain, id, { fetchFn = (...a) => fetch(...a), span = 9000 } = {}) {
  return onAnyRpc(chain, async (evm) => {
    const r = await evm('eth_call', [{ to: chain.mailbox, data: '0x' + DELIVERED_SEL + id.replace(/^0x/, '') }, 'latest'], TTL.short);
    const delivered = /^0x0*1$/.test(String(r));
    if (!delivered) return { delivered: false };
    let ev = null;
    try { ev = await findEvent(evm, chain, HL_TOPICS.processId, id, { span }); } catch { ev = null; }
    return { delivered: true, ...(ev ?? {}), link: ev && chain.explorer ? `${chain.explorer}/tx/${ev.txHash}` : '' };
  }, fetchFn);
}

/** The origin tx of an incoming message (DispatchId on the origin chain's Mailbox), best effort. */
export async function findDispatch(chain, id, { fetchFn = (...a) => fetch(...a), span = 9000 } = {}) {
  return onAnyRpc(chain, async (evm) => {
    const ev = await findEvent(evm, chain, HL_TOPICS.dispatchId, id, { span });
    return ev ? { ...ev, link: chain.explorer ? `${chain.explorer}/tx/${ev.txHash}` : '' } : null;
  }, fetchFn);
}

/** The tx page's cross-chain card, or null when the tx has no Hyperlane message and no IBC packet. */
export function crossChainCard(ui, { logs = [], events = [] } = {}) {
  const { t, card, kv, badge, note, addrLink, slot } = ui;
  const msgs = hyperlaneMessages(logs);
  const packets = ibcPackets(events);
  if (!msgs.length && !packets.length) return null;
  const chainName = (d) => (Number(d) === table.zetaphy.domain ? table.zetaphy.name : chainByDomain(d)?.name ?? t('xcUnknownDomain', { d: String(d) }));
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'mono' }, text);
  const parts = msgs.map((m) => {
    if (m.dir === 'out') {
      const dest = m.destination != null ? chainByDomain(m.destination) : null;
      const status = !dest ? note(m.destination == null ? t('xcNoDest') : t('xcNotInTable'), 'warn')
        : slot(checkDelivery(dest, m.id), (r) => (r.delivered
          ? h('span', { class: 'xc-status' }, badge(t('xcDelivered'), 'ok'), ' ', r.time ? `${utcTime(r.time)} · ` : '', r.block ? `${t('block')} ${groupDigits(r.block)} · ` : '',
            r.link ? ext(r.link, `${t('xcOpenOn', { c: dest.name })} ↗`) : t('xcWhenUnknown'))
          : h('span', { class: 'xc-status' }, badge(t('xcNotDelivered'), 'warn'), ' ', t('xcNotDeliveredNote'))), { inline: true });
      return h('div', { class: 'xc-msg' }, h('h3', null, badge('Hyperlane', 'pq'), ' ', t('xcOut', { c: dest?.name ?? chainName(m.destination) })), kv([
        [t('xcMessageId'), h('span', { class: 'mono break' }, m.id)],
        [t('xcRoute'), `${chainName(m.origin ?? table.zetaphy.domain)} → ${m.destination != null ? chainName(m.destination) : '?'}`],
        m.sender ? [t('from'), /^0x[0-9a-fA-F]{40}$/.test(m.sender) ? addrLink(m.sender) : h('span', { class: 'mono small' }, m.sender)] : null,
        m.recipient ? [t('xcRecipient'), h('span', { class: 'mono small break' }, m.recipient)] : null,
        m.nonce != null ? [t('xcNonce'), String(m.nonce)] : null,
        [t('status'), status],
      ]));
    }
    const origin = chainByDomain(m.origin);
    const src = origin && m.id ? slot(findDispatch(origin, m.id), (r) => (r ? h('span', null, r.time ? `${utcTime(r.time)} · ` : '', r.link ? ext(r.link, `${t('xcOpenOn', { c: origin.name })} ↗`) : short(r.txHash, 10, 6)) : t('xcOriginNotFound')), { inline: true }) : t('xcOriginNotFound');
    return h('div', { class: 'xc-msg' }, h('h3', null, badge('Hyperlane', 'pq'), ' ', t('xcIn', { c: chainName(m.origin) })), kv([
      [t('xcMessageId'), m.id ? h('span', { class: 'mono break' }, m.id) : '—'],
      [t('xcRoute'), `${chainName(m.origin)} → ${table.zetaphy.name}`],
      [t('from'), h('span', { class: 'mono small break' }, m.sender)],
      [t('xcRecipient'), /^0x[0-9a-fA-F]{40}$/.test(m.recipient) ? addrLink(m.recipient) : h('span', { class: 'mono small' }, m.recipient)],
      [t('xcOriginTx'), src],
    ]));
  });
  if (packets.length) {
    parts.push(h('div', { class: 'xc-msg' }, h('h3', null, badge('IBC', 'cosmos'), ' ', t('xcIbcTitle')), ui.table(
      [t('xcIbcKind'), t('xcSequence'), t('xcSource'), t('xcDestination')],
      packets.map((p) => [t(`xcIbc_${p.kind}`), safeText(p.sequence, 20), h('span', { class: 'mono small' }, `${safeText(p.srcPort, 40)}/${safeText(p.srcChannel, 40)}`),
        h('span', { class: 'mono small' }, `${safeText(p.dstPort, 40)}/${safeText(p.dstChannel, 40)}`)]))));
  }
  return card(t('xcCrossTitle'), parts, msgs.length ? note(t('xcNote'), 'info') : null);
}
