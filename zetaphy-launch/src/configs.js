// Config writers: each takes the file's current text and the launch outputs and
// returns the new text (pure, so the unit tests check them without a chain).
//
//   zetaphy-dex/web/deployments.json   the DEX deploy's own output + neuroRegistry
//   zetaphy-nft/web/deployments.json   the NFT deploy's own output
//   zetaphy-explorer/config.json       node (the https RPC host), threatRegistry, neuroReportUrl
//   zetaphy-wallet/index.html          <meta name="zetaphy-rpc"> and <meta name="zetaphy-threat-registry">
//   zetaphy-snap/snap.config.js        ZETAPHY_THREAT_RPC / _REGISTRY / ZETAPHY_WALLET_ORIGINS (then npm run build)

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const need = (v, what) => { if (!ADDR.test(String(v ?? ''))) throw new Error(`${what}: no address yet (${v})`); return v; };

/** The RPC the web apps use: the node's https host, no trailing slash (Caddy serves the EVM JSON-RPC at /). */
export function publicBase(rpc) {
  const u = new URL(String(rpc));
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`the public RPC must be https:// (got ${rpc})`);
  if (u.username || u.password || u.search || u.hash) throw new Error('the public RPC must not hold credentials, ? or #');
  return u.href.replace(/\/+$/, '');
}

/** The Neuro report link template for the explorer, from the Neuro web page URL. */
export function neuroReportUrl(neuroUrl) {
  if (!neuroUrl) return '';
  const u = new URL(String(neuroUrl));
  if (u.protocol !== 'https:') throw new Error('--neuro-url must be https://');
  return `${u.origin}${u.pathname}?chain=zetaphy&address={address}`;
}

const json = (o) => JSON.stringify(o, null, 2) + '\n';

export function dexWeb(_current, out) {
  const dex = out.dex;
  if (!dex?.contracts) throw new Error('dex: not deployed yet');
  need(dex.contracts.factory, 'DEX factory'); need(dex.contracts.router, 'DEX router');
  return json({ ...dex, rpc: publicBase(out.publicRpc), neuroRegistry: out.threatRegistry ? need(out.threatRegistry, 'ThreatRegistry') : null });
}

export function nftWeb(_current, out) {
  const nft = out.nft;
  if (!nft) throw new Error('nft: not deployed yet');
  need(nft.factory, 'NFT factory'); need(nft.marketplace, 'NFT marketplace');
  return json({ ...nft, rpc: publicBase(out.publicRpc) });
}

export function explorerConfig(current, out) {
  const cur = current ? JSON.parse(current) : {};
  return json({
    ...cur,
    node: publicBase(out.publicRpc),
    // Derived from `node` (/, /rpc/, /rest/): clear any old per-API override.
    evmRpc: '', cometRpc: '', rest: '',
    threatRegistry: out.threatRegistry ? need(out.threatRegistry, 'ThreatRegistry') : '',
    // Only once the Neuro web page reads ZETAPHY itself (zetaphy-neuro/src/chains.js has `zetaphy`):
    // before that a link would open Neuro on another chain with this address.
    neuroReportUrl: out.neuroUrl && out.neuroReadsZetaphy ? neuroReportUrl(out.neuroUrl) : (cur.neuroReportUrl ?? ''),
  });
}

/** Sets <meta name="NAME" content="…">; adds it after the threat-registry meta (or before <title>) if missing. */
function setMeta(html, name, value, comment) {
  const esc = String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const re = new RegExp(`<meta name="${name}" content="[^"]*">`);
  if (re.test(html)) return html.replace(re, `<meta name="${name}" content="${esc}">`);
  const tag = `${comment ? `<!-- ${comment} -->\n` : ''}<meta name="${name}" content="${esc}">\n`;
  if (!html.includes('<title>')) throw new Error(`no <title> to put <meta name="${name}"> before`);
  return html.replace('<title>', `${tag}<title>`);
}

export function walletHtml(current, out) {
  let html = setMeta(current, 'zetaphy-rpc', publicBase(out.publicRpc));
  html = setMeta(html, 'zetaphy-threat-registry', out.threatRegistry ? need(out.threatRegistry, 'ThreatRegistry') : '');
  return html;
}

/** Replaces the three build-time constants in snap.config.js (single-quoted strings). */
export function snapConfig(current, out) {
  const set = (text, key, value) => {
    const re = new RegExp(`(${key}: )'[^']*'`);
    if (!re.test(text)) throw new Error(`snap.config.js: no ${key}: '…' line`);
    if (/['\\\n]/.test(value)) throw new Error(`${key}: bad value`);
    return text.replace(re, `$1'${value}'`);
  };
  let t = set(current, 'ZETAPHY_THREAT_RPC', publicBase(out.publicRpc));
  t = set(t, 'ZETAPHY_THREAT_REGISTRY', need(out.threatRegistry, 'ThreatRegistry'));
  if (out.walletOrigin) {
    const origins = String(out.walletOrigin).split(',').map((s) => s.trim()).filter(Boolean).map((o) => {
      const u = new URL(o);
      if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash) throw new Error(`--wallet-origin ${o}: an https origin such as https://wallet.example.com`);
      return u.origin;
    });
    t = set(t, 'ZETAPHY_WALLET_ORIGINS', origins.join(','));
  }
  return t;
}

/** [repo-relative path, writer] in the order they are written. */
export const CONFIG_FILES = [
  ['zetaphy-dex/web/deployments.json', dexWeb],
  ['zetaphy-nft/web/deployments.json', nftWeb],
  ['zetaphy-explorer/config.json', explorerConfig],
  ['zetaphy-wallet/index.html', walletHtml],
  ['zetaphy-snap/snap.config.js', snapConfig],
];
