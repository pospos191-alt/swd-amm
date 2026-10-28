// The "in this browser" provider of the AI panel (web/ai-panel.js): loads the
// registered model through the verified loader, shares it with other browsers
// over WebRTC (manual codes, no server), and optionally reads on-chain records
// (ThreatRegistry, NeuroJobs) as extra context. Everything shown is textContent.

import { aiText } from '../ai/i18n.js';
import { BROWSER_AI, PINNED } from '../ai/browser/config.js';
import { loadVerified } from '../ai/browser/loader.js';
import { bestStore } from '../ai/browser/stores.js';
import { createReader } from '../ai/browser/rpc.js';
import { registryId, readLatest } from '../ai/browser/registry.js';
import { loadEngine } from '../ai/browser/engine.js';
import { createOffer, acceptOffer, servePeer, peerSource, decodeSignal } from '../ai/browser/p2p.js';
import { createKnowledgeIndex } from '../ai/onchain.js';

const KNOWLEDGE = 'neuro-ai-onchain-index'; // the local index (public chain data), localStorage
const store = bestStore('zetaphy-models-v1');
let engine = null;
let loading = null;
const peers = [];     // loader sources from connected browsers
const servers = [];   // our side serving chunks to them
let pendingOffer = null;
let index = null;

const lang = () => document.documentElement.lang || 'en';
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

export function browserBox(el) {
  return el('div', { id: 'ai-browser', hidden: true }, [
    el('p', { class: 'ai-help', 'data-ai': 'browserHelp' }),
    el('button', { type: 'button', id: 'ai-load', 'data-ai': 'loadModel' }),
    el('p', { id: 'ai-load-status', role: 'status', 'aria-live': 'polite' }),
    el('details', { id: 'ai-p2p' }, [
      el('summary', { 'data-ai': 'p2pTitle' }),
      el('p', { class: 'ai-help', 'data-ai': 'p2pHelp' }),
      el('button', { type: 'button', id: 'ai-p2p-offer', 'data-ai': 'p2pOffer' }),
      el('textarea', { id: 'ai-p2p-out', readonly: 'readonly', rows: '3', spellcheck: 'false', hidden: true }),
      el('label', { for: 'ai-p2p-in', 'data-ai': 'p2pPaste' }),
      el('textarea', { id: 'ai-p2p-in', rows: '3', spellcheck: 'false', maxlength: '20000' }),
      el('button', { type: 'button', id: 'ai-p2p-go', 'data-ai': 'p2pConnect' }),
      el('p', { id: 'ai-p2p-status', role: 'status' }),
    ]),
  ]);
}

/** "Use on-chain records" (any provider). */
export const knowledgeBox = (el) => el('label', { class: 'ai-check', id: 'ai-knowledge-label' }, [el('input', { id: 'ai-knowledge', type: 'checkbox' }), el('span', { 'data-ai': 'knowledge' })]);

const $ = (id) => document.getElementById(id);
const say = (id, text, error = false) => { $(id).textContent = text; $(id).className = error ? 'error' : ''; };

function addPeer(channel) {
  servers.push(servePeer(channel, store));
  peers.push(peerSource(channel, `browser-${peers.length + 1}`));
  say('ai-p2p-status', aiText(lang()).p2pConnected);
}

export function wireBrowserBox() {
  $('ai-load').addEventListener('click', () => ensureEngine().catch(() => {}));
  $('ai-p2p-offer').addEventListener('click', async () => {
    try {
      pendingOffer = await createOffer();
      $('ai-p2p-out').value = pendingOffer.code;
      $('ai-p2p-out').hidden = false;
    } catch (e) { say('ai-p2p-status', e.message, true); }
  });
  $('ai-p2p-go').addEventListener('click', async () => {
    const code = $('ai-p2p-in').value.trim();
    if (!code) return;
    try {
      const kind = (await decodeSignal(code)).type;
      if (kind === 'answer') {
        if (!pendingOffer) throw new Error('make an offer code first');
        const ch = await pendingOffer.accept(code);
        pendingOffer = null;
        addPeer(ch);
      } else {
        const a = await acceptOffer(code);
        $('ai-p2p-out').value = a.code;
        $('ai-p2p-out').hidden = false;
        a.channel.then(addPeer, (e) => say('ai-p2p-status', e.message, true));
      }
      $('ai-p2p-in').value = '';
    } catch (e) { say('ai-p2p-status', e.message, true); }
  });
}

/** The release to load: from ModelRegistry when configured, else the pinned one (the panel says which). */
async function release() {
  const t = aiText(lang());
  if (!BROWSER_AI.modelRegistry) return { release: PINNED, note: t.pinned };
  const reader = createReader([BROWSER_AI.rpc], BROWSER_AI.chainId);
  const r = await readLatest(reader, BROWSER_AI.modelRegistry, registryId(BROWSER_AI.model.kind, BROWSER_AI.model.name));
  return { release: r, note: fill(t.onRegistry, { a: BROWSER_AI.modelRegistry, v: r.version, s: r.status }) };
}

export function ensureEngine() {
  if (engine) return Promise.resolve(engine);
  if (loading) return loading;
  const t = aiText(lang());
  $('ai-load').disabled = true;
  loading = (async () => {
    try {
      const { release: rel, note } = await release();
      say('ai-load-status', note);
      const out = await loadVerified({
        release: rel, mirrors: BROWSER_AI.mirrors, peers, store,
        onProgress: ({ done, total }) => say('ai-load-status', `${note} ${fill(t.loadingModel, { n: done, m: total })}`),
      });
      engine = loadEngine(out.bytes, out.manifest);
      const s = out.stats;
      say('ai-load-status', `${note} ${fill(t.modelLoaded, { m: engine.id, c: out.manifest.chunks.length, k: s.cache, p: s.peer, s: s.mirror })}`);
      return engine;
    } catch (e) {
      say('ai-load-status', t.failed + e.message, true);
      throw e;
    } finally {
      loading = null;
      $('ai-load').disabled = false;
    }
  })();
  return loading;
}

export const loadedEngine = () => engine;

/** On-chain records about this report, when the box is ticked (null otherwise or on failure). */
export async function knowledgeFor(report, { code, verdict } = {}) {
  if (!$('ai-knowledge')?.checked || !BROWSER_AI.threatRegistry) return null;
  try {
    if (!index) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(KNOWLEDGE) ?? 'null'); } catch { saved = null; }
      index = createKnowledgeIndex(saved);
    }
    const reader = createReader([BROWSER_AI.rpc], BROWSER_AI.chainId);
    // First visit: the most recent knowledgeWindows x 500 blocks; later visits go on from there.
    const head = Number(BigInt(await reader.call('eth_blockNumber', [])));
    const fromBlock = Math.max(0, head - BROWSER_AI.knowledgeWindows * 500);
    await index.sync(reader, { threatRegistry: BROWSER_AI.threatRegistry, neuroJobs: BROWSER_AI.neuroJobs, fromBlock, toBlock: head, maxWindows: BROWSER_AI.knowledgeWindows });
    try { localStorage.setItem(KNOWLEDGE, JSON.stringify(index.toJSON())); } catch { /* full or blocked */ }
    say('ai-status', fill(aiText(lang()).knowledgeSynced, { b: index.toJSON().lastBlock[BROWSER_AI.threatRegistry.toLowerCase()] ?? head }));
    return index.lookup(report, { code, verdict });
  } catch { return null; }
}
