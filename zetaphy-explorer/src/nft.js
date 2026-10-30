// NFT gallery (#/nft/<collection>, #/nft/<collection>/<id>): ERC-721 tokenURI / ERC-1155 uri,
// metadata from data: URIs, ipfs:// (through a configurable public gateway, ipfs.io by
// default) or https. Metadata is untrusted: only text is shown (tags stripped, control and
// bidi characters removed, lengths bounded), links only https, and images only through
// <img> from https: or data:image/… (an SVG is never put inline, so its scripts never run).
// Images from the gateway load directly (it is in the CSP's img-src); an image on any other
// host is fetched only when the viewer asks, and shown from a blob: URL.
import { TOPICS, decodeTransfer, decodeUint, readTokenInfo, hexBytes, topicAddress } from './evm.js';
import { logWindows } from './holders.js';
import { safeText, groupDigits, tokenText, toAddress, toBig } from './format.js';
import { keccak_256, bytesToHex } from '../vendor/zetaphy-lib.js';

const enc = new TextEncoder();
const sel = (sig) => bytesToHex(keccak_256(enc.encode(sig))).slice(0, 8);
export const NFT_SEL = {
  tokenURI: sel('tokenURI(uint256)'), uri: sel('uri(uint256)'), ownerOf: sel('ownerOf(uint256)'), tokenByIndex: sel('tokenByIndex(uint256)'),
};
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
export const MAX_META_BYTES = 256 * 1024;
export const MAX_DATA_IMAGE = 1024 * 1024;
export const MAX_REMOTE_IMAGE = 8 * 1024 * 1024;
export const IMAGE_TYPES = ['png', 'jpeg', 'jpg', 'gif', 'webp', 'svg+xml', 'avif', 'bmp'];
export const DEFAULT_GATEWAY = 'https://ipfs.io';
const PAGE = 12;

/** An ABI string return value, unsanitised (for URIs; bounded to 1 MB). null when not one. */
export function abiStringRaw(hex, max = 1024 * 1024) {
  const b = hexBytes(hex);
  if (!b || b.length < 64) return null;
  const off = BigInt('0x' + bytesToHex(b.subarray(0, 32)));
  if (off + 32n > BigInt(b.length)) return null;
  const o = Number(off);
  const len = BigInt('0x' + bytesToHex(b.subarray(o, o + 32)));
  if (len > BigInt(max) || BigInt(o + 32) + len > BigInt(b.length)) return null;
  return new TextDecoder().decode(b.subarray(o + 32, o + 32 + Number(len)));
}

/** ERC-1155: "{id}" in a uri is the id as 64 lower-case hex digits. */
export const fillIdTemplate = (uri, id) => String(uri).replaceAll('{id}', BigInt(id).toString(16).padStart(64, '0'));

/** A gateway base URL (https, no query): the configured one or ipfs.io. */
export function gatewayBase(g) {
  try { const u = new URL(String(g || DEFAULT_GATEWAY)); if (u.protocol !== 'https:' || u.search || u.username) throw new Error(); return u.origin + u.pathname.replace(/\/+$/, ''); } catch { return DEFAULT_GATEWAY; }
}

/**
 * Where a token / metadata URI points: { kind: 'data' | 'ipfs' | 'https', url } or null.
 * ipfs://CID/path and ipfs://ipfs/CID/path go through the gateway; http:// is upgraded
 * to https://; anything else (javascript:, file:, ar:, relative…) is refused.
 */
export function resolveUri(uri, gateway) {
  const s = String(uri ?? '').trim();
  if (!s || s.length > 2 * MAX_DATA_IMAGE) return null;
  if (/^data:/i.test(s)) return { kind: 'data', url: s };
  const m = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/[^?#\s]*)?$/i.exec(s);
  if (m) return { kind: 'ipfs', url: `${gatewayBase(gateway)}/ipfs/${m[1]}${m[2] ?? ''}` };
  try {
    const u = new URL(s);
    if (u.username || u.password) return null;
    if (u.protocol === 'http:') u.protocol = 'https:';
    if (u.protocol !== 'https:') return null;
    return { kind: 'https', url: u.href };
  } catch { return null; }
}

/** A data: URI's { mime, bytes } (base64 or percent-encoded), or null. */
export function decodeDataUri(uri, max = MAX_META_BYTES) {
  const m = /^data:([^,]*?),(.*)$/is.exec(String(uri ?? ''));
  if (!m) return null;
  const meta = m[1].split(';').map((x) => x.trim().toLowerCase());
  const mime = meta[0] || 'text/plain';
  const isB64 = meta.includes('base64');
  let bytes;
  try {
    if (isB64) {
      const bin = atob(m[2].replace(/\s+/g, ''));
      if (bin.length > max) return null;
      bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    } else {
      const raw = decodeURIComponent(m[2]);
      bytes = enc.encode(raw);
      if (bytes.length > max) return null;
    }
  } catch { return null; }
  return { mime, bytes };
}

/** Tags removed, then safeText: metadata text never becomes markup (and does not show raw tags). */
export const metaText = (s, max = 400) => safeText(String(s ?? '').replace(/<[^>]*>/g, ' '), max);

/**
 * An image URL from metadata, allow-listed: { kind: 'data' | 'ipfs' | 'https', url } or null.
 * data: only data:image/<png|jpeg|gif|webp|svg+xml|avif|bmp> (≤ 1 MB); ipfs via the gateway; https.
 */
export function imageSource(u, gateway) {
  const r = resolveUri(u, gateway);
  if (!r) return null;
  if (r.kind === 'data') {
    const m = /^data:image\/([a-z0-9.+-]+)(;[a-z0-9=.+-]+)*,/i.exec(r.url);
    if (!m || !IMAGE_TYPES.includes(m[1].toLowerCase()) || r.url.length > MAX_DATA_IMAGE * 1.4) return null;
    return r;
  }
  return r;
}

/** Raw SVG markup from `image_data` -> a data:image/svg+xml;base64 URI (shown with <img>, never inline). */
export function svgDataUri(svg) {
  const b = enc.encode(String(svg ?? ''));
  if (!b.length || b.length > MAX_DATA_IMAGE) return null;
  let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(s)}`;
}

/**
 * Untrusted metadata JSON -> { name, description, image, externalUrl, attributes: [{ trait, value }], animation }.
 * Text only; external_url kept only when https; at most 50 attributes.
 */
export function sanitizeMetadata(j, gateway) {
  const o = j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  let image = typeof o.image === 'string' ? imageSource(o.image, gateway) : typeof o.image_url === 'string' ? imageSource(o.image_url, gateway) : null;
  if (!image && typeof o.image_data === 'string') { const d = svgDataUri(o.image_data); image = d ? { kind: 'data', url: d } : null; }
  let externalUrl = null;
  try { const u = new URL(String(o.external_url ?? '')); if (u.protocol === 'https:' && !u.username) externalUrl = u.href; } catch { externalUrl = null; }
  const attrs = Array.isArray(o.attributes) ? o.attributes : o.attributes && typeof o.attributes === 'object' ? Object.entries(o.attributes).map(([k, v]) => ({ trait_type: k, value: v })) : [];
  return {
    name: metaText(o.name, 120),
    description: metaText(o.description, 2000),
    image,
    externalUrl,
    attributes: attrs.slice(0, 50).map((a) => ({ trait: metaText(a?.trait_type ?? a?.key ?? '', 60), value: metaText(typeof a?.value === 'object' ? JSON.stringify(a.value) : a?.value ?? '', 120) })).filter((a) => a.trait || a.value),
  };
}

/** Metadata JSON at a resolved URI (data: decoded here; ipfs / https fetched with no cookies, bounded). */
export async function loadMetadata(resolved, fetchFn = (...a) => fetch(...a)) {
  if (!resolved) throw new Error('unsupported URI');
  let text;
  if (resolved.kind === 'data') {
    const d = decodeDataUri(resolved.url);
    if (!d) throw new Error('bad data: URI');
    text = new TextDecoder().decode(d.bytes);
  } else {
    const res = await fetchFn(resolved.url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'default', signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > MAX_META_BYTES) throw new Error('metadata too large');
    text = await res.text();
    if (text.length > MAX_META_BYTES) throw new Error('metadata too large');
  }
  return JSON.parse(text);
}

// ---- reading the contract ----

async function tokenUri(c, addr, id, standard) {
  const s = standard === 'erc1155' ? NFT_SEL.uri : NFT_SEL.tokenURI;
  const raw = abiStringRaw(await c.chain.ethCall(addr, '0x' + s + word(id)));
  if (raw == null) throw new Error('no URI');
  return standard === 'erc1155' ? fillIdTemplate(raw, id) : raw;
}

async function ownerOf(c, addr, id) {
  try { return topicAddress(await c.chain.ethCall(addr, '0x' + NFT_SEL.ownerOf + word(id))); } catch { return null; }
}

/** Token ids: ERC721Enumerable's tokenByIndex when it answers, else the newest ids in recent Transfer logs. */
async function collectIds(c, addr, info, latest) {
  const supply = info.totalSupply ?? 0n;
  if (info.standard === 'erc721' && supply > 0n) {
    try {
      const n = Number(supply < BigInt(PAGE) ? supply : BigInt(PAGE));
      const ids = await Promise.all(Array.from({ length: n }, (_, i) => c.chain.ethCall(addr, '0x' + NFT_SEL.tokenByIndex + word(i)).then(decodeUint)));
      if (ids.every((x) => x != null)) return { ids, source: 'enumerable' };
    } catch { /* not enumerable */ }
  }
  const from = Math.max(1, Number(latest) - 1999);
  const ids = [];
  for (const [lo, hi] of logWindows(from, Number(latest))) {
    const logs = await c.chain.tokenLogs(addr, lo, hi, TOPICS).catch(() => []);
    for (const l of logs) {
      const tr = decodeTransfer(l);
      const got = tr?.standard === 'erc721' ? [tr.tokenId] : tr?.standard === 'erc1155' ? tr.ids : [];
      for (const id of got) if (!ids.some((x) => x === id)) ids.push(id);
    }
    if (ids.length >= PAGE) break;
  }
  return { ids: ids.slice(0, PAGE), source: 'logs', from };
}

// ---- views ----

function remoteImage(c, url, alt) {
  const { h, t } = c;
  const host = (() => { try { return new URL(url).host; } catch { return '?'; } })();
  const box = h('div', { class: 'nft-img nft-img-remote' });
  const btn = h('button', { type: 'button', class: 'secondary', on: { click: async () => {
    btn.disabled = true; btn.textContent = t('loading');
    try {
      const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(15000) });
      const type = String(res.headers.get('content-type') ?? '');
      if (!res.ok || !/^image\//i.test(type)) throw new Error(type || `HTTP ${res.status}`);
      const blob = await res.blob();
      if (blob.size > MAX_REMOTE_IMAGE) throw new Error('too large');
      c.fill(box, h('img', { src: URL.createObjectURL(blob), alt, referrerpolicy: 'no-referrer', decoding: 'async' }));
    } catch { c.fill(box, c.note(t('nftImageFailed'), 'warn'), h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, t('nftOpenImage', { host: safeText(host, 60) }))); }
  } } }, t('nftLoadImage', { host: safeText(host, 60) }));
  return c.append(box, btn);
}

/** An <img> for an allow-listed source: data:image and the default gateway directly, other hosts on request. */
export function imageNode(c, img, alt = '', { inLink = false } = {}) {
  const { h } = c;
  if (!img) return h('div', { class: 'nft-img nft-noimg' }, c.t('nftNoImage'));
  let direct = img.kind === 'data';
  try { if (!direct && new URL(img.url).origin === DEFAULT_GATEWAY) direct = true; } catch { /* no */ }
  if (!direct && inLink) return h('div', { class: 'nft-img nft-noimg' }, c.t('nftImageOnItem')); // no buttons inside a link
  if (direct) return h('div', { class: 'nft-img' }, h('img', { src: img.url, alt: safeText(alt, 80), loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' }));
  if (img.kind === 'ipfs') { // a gateway the viewer chose: fetched (blob) since only ipfs.io is in img-src
    const box = remoteImage(c, img.url, alt); box.querySelector('button')?.click(); return box;
  }
  return remoteImage(c, img.url, alt);
}

export async function pageNft(c, view, param) {
  const { t, h, chain } = c;
  const [addrPart, idPart] = String(param ?? '').split('/');
  const a = toAddress(decodeURIComponent(addrPart ?? ''));
  if (!a) { c.append(view, c.errorBox(t('badAddress'))); return; }
  const info = await readTokenInfo((to, data) => chain.ethCall(to, data), a.hex).catch(() => ({ standard: null }));
  const title = `${tokenText(info.name, 48)}${info.symbol ? ` (${tokenText(info.symbol, 16)})` : ''}`;
  if (info.standard !== 'erc721' && info.standard !== 'erc1155') {
    c.append(view, h('h1', null, t('nftTitle')), c.note(t('nftNotNft'), 'warn'), c.routeLink(`token/${a.hex}`, t('tokenPage')));
    return;
  }
  if (idPart != null && idPart !== '') return pageItem(c, view, a, info, title, idPart);
  const st = await chain.status();
  const grid = h('div', { class: 'nft-grid' }, c.loading());
  c.append(view, [
    h('h1', null, t('nftTitle'), ': ', h('span', { class: 'token-name' }, title)),
    h('p', null, c.badge(info.standard.toUpperCase().replace('ERC', 'ERC-'), 'token'), ' ', c.routeLink(`token/${a.hex}`, t('tokenPage')),
      info.totalSupply != null ? h('span', { class: 'dim' }, ` · ${t('totalSupply')} ${groupDigits(info.totalSupply.toString())}`) : null),
    c.card(null, grid, c.note(t('nftMetaNote'), 'info')),
  ]);
  const { ids, source, from } = await collectIds(c, a.hex, info, st.height);
  c.fill(grid, ids.length ? ids.map((id) => {
    const ttl = h('div', { class: 'nft-name' }, `#${safeText(id.toString(), 40)}`);
    const img = h('div', { class: 'nft-img nft-noimg' }, '…');
    tokenUri(c, a.hex, id, info.standard).then((u) => loadMetadata(resolveUri(u, c.cfg.ipfsGateway))).then((j) => {
      const m = sanitizeMetadata(j, c.cfg.ipfsGateway);
      if (m.name) c.fill(ttl, `${m.name} `, h('span', { class: 'dim small' }, `#${safeText(id.toString(), 20)}`));
      img.replaceWith(imageNode(c, m.image, m.name, { inLink: true }));
    }).catch(() => { img.textContent = t('nftNoMeta'); });
    return c.routeLink(`nft/${a.hex}/${id}`, h('span', { class: 'nft-card' }, img, ttl), { class: 'nft-link' });
  }) : c.note(t('nftNoIds')));
  if (source === 'logs') grid.after(c.note(t('nftIdsFromLogs', { from: groupDigits(from), to: groupDigits(st.height) })));
}

async function pageItem(c, view, a, info, title, idPart) {
  const { t, h, chain } = c;
  if (!/^\d{1,78}$/.test(idPart)) { c.append(view, c.errorBox(t('nftBadId'))); return; }
  const id = BigInt(idPart);
  const st = await chain.status();
  const meta = h('div', null, c.loading());
  const imgBox = h('div', { class: 'nft-hero' });
  let uri = null;
  try { uri = await tokenUri(c, a.hex, id, info.standard); } catch { uri = null; }
  const owner = info.standard === 'erc721' ? await ownerOf(c, a.hex, id) : null;
  c.append(view, [
    h('h1', null, h('span', { class: 'token-name' }, title), ` #${safeText(id.toString(), 80)}`),
    h('p', null, c.routeLink(`nft/${a.hex}`, `← ${t('nftTitle')}`)),
    h('div', { class: 'nft-item' }, imgBox, c.card(t('overview'), c.kv([
      [t('contract'), c.addrLink(a.hex, { full: true })],
      [t('standard'), info.standard.toUpperCase().replace('ERC', 'ERC-')],
      [t('nftTokenId'), h('span', { class: 'mono break' }, safeText(id.toString(), 80))],
      info.standard === 'erc721' ? [t('nftOwner'), owner ? c.addrLink(owner, { full: true }) : t('unknown')] : null,
      [t('nftUri'), uri ? h('span', { class: 'mono small break' }, safeText(uri.length > 140 ? `${uri.slice(0, 140)}…` : uri, 160)) : t('nftNoUri')],
    ]), meta)),
    transfersCard(c, a, id, info, st.height),
  ]);
  if (!uri) { c.fill(meta, c.note(t('nftNoUri'), 'warn')); c.fill(imgBox, imageNode(c, null)); return; }
  const r = resolveUri(uri, c.cfg.ipfsGateway);
  if (!r) { c.fill(meta, c.note(t('nftBadUri'), 'warn')); c.fill(imgBox, imageNode(c, null)); return; }
  try {
    const m = sanitizeMetadata(await loadMetadata(r), c.cfg.ipfsGateway);
    c.fill(imgBox, imageNode(c, m.image, m.name));
    c.fill(meta, c.kv([
      [t('name'), m.name || '—'],
      m.description ? [t('nftDescription'), h('div', { class: 'nft-desc' }, m.description)] : null,
      m.externalUrl ? [t('nftExternal'), h('a', { href: m.externalUrl, target: '_blank', rel: 'noopener noreferrer' }, safeText(m.externalUrl, 80))] : null,
    ]), m.attributes.length ? c.table([t('nftTrait'), t('value')], m.attributes.map((x) => [x.trait || '—', x.value || '—'])) : null,
    c.note(t('nftMetaNote'), 'info'));
  } catch (e) { c.fill(meta, c.note(`${t('nftNoMeta')} (${safeText(e.message, 120)})`, 'warn')); c.fill(imgBox, imageNode(c, null)); }
}

function transfersCard(c, a, id, info, latest) {
  const { t, h, chain } = c;
  const from = Math.max(1, Number(latest) - 1999);
  return c.card(t('nftTransfers'), c.slot((async () => {
    const out = [];
    for (const [lo, hi] of logWindows(from, Number(latest))) {
      const logs = await chain.tokenLogs(a.hex, lo, hi, TOPICS).catch(() => []);
      for (const l of logs) {
        const tr = decodeTransfer(l);
        const hit = tr?.standard === 'erc721' ? tr.tokenId === id : tr?.standard === 'erc1155' ? tr.ids.some((x) => x === id) : false;
        if (hit) out.push({ l, tr });
      }
    }
    return h('div', null, out.length ? out.slice(0, 50).map(({ l, tr }) => h('div', { class: 'transfer-row' }, c.blockLink(String(toBig(l.blockNumber) ?? '')), ' · ', c.hashLink(l.transactionHash), ' · ', c.transferView(tr)))
      : c.note(t('noTransfers')), c.note(t('nftTransfersNote', { from: groupDigits(from), to: groupDigits(latest) })));
  })(), (x) => x));
}
