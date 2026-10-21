// Token metadata, safely. Token URIs are written by whoever made the collection,
// so everything here treats them as hostile:
//   - only ipfs:// (through a public https gateway the user can change), https://
//     and data: URIs are followed; http:, javascript:, blob:, file: … are refused;
//   - a metadata fetch reads at most MAX_METADATA bytes (and data: URIs are
//     limited too), with a timeout, no cookies and no referrer;
//   - images are only ever an <img src>: https, a gateway URL, or a data:image/…
//     URI. SVG is fine there (an <img> never runs an SVG's scripts); it is never
//     put inline. animation_url (could be HTML) is never loaded;
//   - names, descriptions and traits are plain text: control, bidi and other
//     invisible characters are removed, lengths are capped, and the page only
//     ever sets them with textContent.

export const MAX_METADATA = 256 * 1024;        // bytes of JSON we read
export const MAX_DATA_IMAGE = 2 * 1024 * 1024; // characters of a data:image URI
export const FETCH_TIMEOUT_MS = 10_000;
export const DEFAULT_GATEWAY = 'https://ipfs.io/ipfs/';
export const GATEWAYS = ['https://ipfs.io/ipfs/', 'https://dweb.link/ipfs/', 'https://w3s.link/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];

// Cc: control, Cf: format (bidi overrides, zero-width), Co: private use, Cn: unassigned.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;
const HAS_INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;
const INVISIBLE_KEEP_NL = /(?!\n)[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu;

/** Text another party wrote, safe to show with textContent: one line, no invisible characters. */
export const cleanText = (s, max = 200) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(INVISIBLE, '').trim().slice(0, max);
/** Like cleanText, but keeps line breaks (descriptions; shown with white-space: pre-line). */
export const cleanMultiline = (s, max = 2000) => String(s ?? '').replace(/\r\n?/g, '\n').replace(INVISIBLE_KEEP_NL, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/** A gateway the user typed: https, ending in "/". Null when unusable. */
export function normalizeGateway(g) {
  try {
    const u = new URL(String(g).trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    let s = u.origin + u.pathname;
    if (!s.endsWith('/')) s += '/';
    return s;
  } catch { return null; }
}

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/;
/** True for a bare IPFS CID (v0 "Qm…" or v1 base32 "b…"). */
export const isCid = (s) => CID.test(String(s).trim());

/**
 * What a creator pasted, as a token URI: a bare CID (or CID/path) becomes ipfs://CID/path;
 * ipfs://, https:// and data: are kept; anything else is null.
 */
export function normalizeTokenUri(input) {
  const s = String(input ?? '').trim();
  if (!s) return '';
  const first = s.split('/')[0];
  if (isCid(first)) return 'ipfs://' + s;
  if (/^ipfs:\/\//i.test(s) || /^https:\/\//i.test(s) || /^data:/i.test(s)) return s;
  return null;
}

/** ERC-1155 {id} substitution: the id as 64 lowercase hex digits. */
export const substituteId = (uri, id) => (id === undefined || id === null ? uri : uri.replaceAll('{id}', BigInt(id).toString(16).padStart(64, '0')));

/**
 * Where a URI is actually read from: { kind: 'https', url } or { kind: 'data', url },
 * or null if it is not followed. ipfs://CID/path and ipfs://ipfs/CID/path go through the gateway.
 */
export function resolveUri(uri, gateway = DEFAULT_GATEWAY) {
  const s = String(uri ?? '').trim();
  if (!s || HAS_INVISIBLE.test(s)) return null;
  if (/^ipfs:\/\//i.test(s)) {
    const path = s.slice(7).replace(/^ipfs\//i, '');
    if (!path || /[\s\\]/.test(path) || path.includes('..')) return null;
    const gw = normalizeGateway(gateway) ?? DEFAULT_GATEWAY;
    try { return { kind: 'https', url: new URL(path, gw).href }; } catch { return null; }
  }
  if (/^https:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      return { kind: 'https', url: u.href };
    } catch { return null; }
  }
  if (/^data:/i.test(s)) return { kind: 'data', url: s };
  return null;
}

/** Decodes a data: URI's payload as text (base64 or percent-encoded). */
function dataText(url, max) {
  const comma = url.indexOf(',');
  if (comma < 0) throw new Error('bad data URI');
  const head = url.slice(5, comma).toLowerCase();
  const body = url.slice(comma + 1);
  if (body.length > max * 2) throw new Error('metadata too large');
  let bytes;
  if (/;base64$/.test(head)) {
    const bin = atob(body.replace(/\s/g, ''));
    bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  if (bytes.length > max) throw new Error('metadata too large');
  return { mime: head.split(';')[0], text: new TextDecoder().decode(bytes) };
}

/** Reads at most `max` bytes of a response body; throws beyond that. */
async function readLimited(res, max) {
  const len = Number(res.headers.get('content-length'));
  if (len > max) throw new Error('metadata too large');
  if (!res.body?.getReader) {
    const t = await res.text();
    if (t.length > max) throw new Error('metadata too large');
    return t;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) { reader.cancel().catch(() => {}); throw new Error('metadata too large'); }
    chunks.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
}

/** The raw metadata JSON object of a token URI (throws when refused, too large, or not JSON). */
export async function fetchMetadataJson(uri, { gateway = DEFAULT_GATEWAY, fetchImpl = globalThis.fetch, max = MAX_METADATA, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const r = resolveUri(uri, gateway);
  if (!r) throw new Error('unsupported URI');
  let text;
  if (r.kind === 'data') {
    const d = dataText(r.url, max);
    if (!/^(application\/json|text\/plain|application\/octet-stream|)$/.test(d.mime)) throw new Error('not JSON');
    text = d.text;
  } else {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(r.url, { signal: ctl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await readLimited(res, max);
    } finally { clearTimeout(timer); }
  }
  const json = JSON.parse(text);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('not a metadata object');
  return json;
}

const IMAGE_DATA = /^data:image\/(png|jpeg|jpg|gif|webp|avif|svg\+xml|bmp)(;[a-z0-9=.+-]+)*(;base64)?,/i;

/** An image URL safe for <img src>, or null. */
export function imageSrc(image, gateway = DEFAULT_GATEWAY) {
  if (typeof image !== 'string') return null;
  const r = resolveUri(image, gateway);
  if (!r) return null;
  if (r.kind === 'data') return IMAGE_DATA.test(r.url) && r.url.length <= MAX_DATA_IMAGE && !/["'<>\s]/.test(r.url.slice(0, r.url.indexOf(','))) ? r.url : null;
  return r.url;
}

/** OpenSea's image_data (raw SVG text) as a data: URI, so it is still only an <img src>. */
function svgData(svg) {
  if (typeof svg !== 'string' || !/^\s*<svg[\s>]/i.test(svg) || svg.length > MAX_DATA_IMAGE / 3) return null;
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** An https link to show (external_url): nothing else. */
export function safeLink(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' && !x.username && !x.password ? x.href : null;
  } catch { return null; }
}

/** What the page shows of a metadata object: plain, bounded values. */
export function readMetadata(json, gateway = DEFAULT_GATEWAY) {
  const attrs = Array.isArray(json.attributes) ? json.attributes.slice(0, 30).map((a) => ({
    trait: cleanText(a?.trait_type ?? a?.name ?? '', 60),
    value: cleanText(typeof a?.value === 'object' ? JSON.stringify(a.value) : a?.value ?? '', 120),
  })).filter((a) => a.trait || a.value) : [];
  return {
    name: cleanText(json.name, 120),
    description: cleanMultiline(json.description, 2000),
    image: imageSrc(json.image ?? json.image_url, gateway) ?? svgData(json.image_data),
    externalUrl: safeLink(json.external_url),
    attributes: attrs,
  };
}

/** Fetches and reads a token's metadata; { error } when it cannot be shown. */
export async function loadMetadata(uri, opts = {}) {
  try {
    return readMetadata(await fetchMetadataJson(uri, opts), opts.gateway);
  } catch (e) {
    return { error: cleanText(e?.message ?? 'error', 100) };
  }
}
