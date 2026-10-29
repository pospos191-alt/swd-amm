// The "in this browser" provider of the AI panel (web/ai-panel.js): loads the
// registered model through the verified loader, shares it with other browsers
// over WebRTC (manual codes, no server), and optionally reads on-chain records
// (ThreatRegistry, NeuroJobs) as extra context. Everything shown is textContent.

// It also finds other browsers by itself through the ZETAPHY chain (SignalBoard,
// ai/browser/discovery.js) when that is configured, and runs the tiny language
// model (ai/browser/llama.js) here or split with another browser.

import { aiText } from '../ai/i18n.js';
import { BROWSER_AI, PINNED, BROWSER_LLM, PINNED_LLM } from '../ai/browser/config.js';
import { chainBoard } from '../ai/browser/boards.js';
import { sessionWallet } from '../ai/browser/evmtx.js';
import { createSwarm } from '../ai/browser/discovery.js';
import { topicFor } from '../ai/browser/signal.js';
import { loadLlm } from '../ai/browser/llmload.js';
import { createHead, createStage, chainStages, generate } from '../ai/browser/llama.js';
import { loadTokenizer } from '../ai/browser/tokenizer.js';
import { serveLlmStage, remoteLlmStage } from '../ai/browser/pipeline.js';
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
      el('p', { class: 'ai-help', 'data-ai': 'p2pAutoHelp' }),
      el('button', { type: 'button', id: 'ai-p2p-auto', 'data-ai': 'p2pAuto' }),
      el('p', { id: 'ai-p2p-auto-status', role: 'status' }),
      el('p', { class: 'ai-help', 'data-ai': 'p2pHelp' }),
      el('button', { type: 'button', id: 'ai-p2p-offer', 'data-ai': 'p2pOffer' }),
      el('textarea', { id: 'ai-p2p-out', readonly: 'readonly', rows: '3', spellcheck: 'false', hidden: true }),
      el('label', { for: 'ai-p2p-in', 'data-ai': 'p2pPaste' }),
      el('textarea', { id: 'ai-p2p-in', rows: '3', spellcheck: 'false', maxlength: '20000' }),
      el('button', { type: 'button', id: 'ai-p2p-go', 'data-ai': 'p2pConnect' }),
      el('p', { id: 'ai-p2p-status', role: 'status' }),
    ]),
    el('details', { id: 'ai-llm' }, [
      el('summary', { 'data-ai': 'llmTitle' }),
      el('p', { class: 'ai-help', 'data-ai': 'llmHelp' }),
      el('label', { for: 'ai-llm-prompt', 'data-ai': 'llmPrompt' }),
      el('textarea', { id: 'ai-llm-prompt', rows: '2', spellcheck: 'false', maxlength: '400' }),
      el('div', { class: 'ai-row' }, [
        el('button', { type: 'button', id: 'ai-llm-here', 'data-ai': 'llmHere' }),
        el('button', { type: 'button', id: 'ai-llm-split', 'data-ai': 'llmSplit' }),
        el('button', { type: 'button', id: 'ai-llm-serve', 'data-ai': 'llmServe' }),
      ]),
      el('p', { id: 'ai-llm-status', role: 'status', 'aria-live': 'polite' }),
      el('p', { id: 'ai-llm-out' }),
    ]),
  ]);
}

/** "Use on-chain records" (any provider). */
export const knowledgeBox = (el) => el('label', { class: 'ai-check', id: 'ai-knowledge-label' }, [el('input', { id: 'ai-knowledge', type: 'checkbox' }), el('span', { 'data-ai': 'knowledge' })]);

const $ = (id) => document.getElementById(id);
const say = (id, text, error = false) => { $(id).textContent = text; $(id).className = error ? 'error' : ''; };

function addPeer(channel) {
  servers.push(servePeer(channel, store, BROWSER_AI.upload));
  peers.push(peerSource(channel, `browser-${peers.length + 1}`));
  say('ai-p2p-status', aiText(lang()).p2pConnected);
}

// ---- automatic discovery through the ZETAPHY chain (SignalBoard) ----

let board = null;
const swarms = {};
/** The chain board, or null when SignalBoard is not configured (then only the manual codes exist). */
function signalBoard() {
  if (!BROWSER_AI.signalBoard) return null;
  let storage = null;
  try { storage = globalThis.localStorage; } catch { storage = null; }
  board ??= chainBoard({ rpc: [BROWSER_AI.rpc], chainId: BROWSER_AI.chainId, address: BROWSER_AI.signalBoard, wallet: sessionWallet({ storage }) });
  return board;
}
async function joinSwarm(name, purpose, hash, opts) {
  if (swarms[name]) return swarms[name];
  const b = signalBoard();
  if (!b) throw new Error(aiText(lang()).p2pAutoOff);
  const d = BROWSER_AI.discovery;
  const s = createSwarm({ board: b, topic: await topicFor(purpose, hash), iceServers: BROWSER_AI.iceServers, pollMs: d.pollMs, ttl: d.ttl, maxPeers: d.maxPeers, offerTimeoutMs: d.offerTimeoutMs, ...opts });
  swarms[name] = s;
  await s.start();
  return s;
}

async function autoDiscover() {
  const t = aiText(lang());
  if (swarms.chunks) {
    swarms.chunks.stop(); delete swarms.chunks;
    $('ai-p2p-auto').textContent = t.p2pAuto;
    say('ai-p2p-auto-status', '');
    return;
  }
  const update = () => say('ai-p2p-auto-status', fill(aiText(lang()).p2pSearching, { n: swarms.chunks?.known.size ?? 0, m: swarms.chunks?.peers.size ?? 0 }));
  try {
    const { release: rel } = await release();
    await joinSwarm('chunks', 'chunks', rel.manifestHash, {
      meta: { role: 'chunks' },
      onPeer: ({ channel }) => { addPeer(channel); update(); },
      onEvent: update,
    });
    $('ai-p2p-auto').textContent = t.p2pAutoStop;
    update();
  } catch (e) { say('ai-p2p-auto-status', e.message, true); }
}

// ---- the tiny language model, split across browsers ----

const llm = { full: null, parts: new Map(), lastHere: null, serving: null };
const SPLIT = (L) => Math.floor(L / 2);

async function llmModel({ from, to, head }) {
  const key = `${from}-${to}-${head}`;
  if (llm.full) return llm.full;
  if (llm.parts.has(key)) return llm.parts.get(key);
  const t = aiText(lang());
  const loaded = await loadLlm({
    release: PINNED_LLM, mirrors: BROWSER_LLM.mirrors, peers, store, from, to, head,
    onProgress: ({ done, total }) => say('ai-llm-status', fill(t.llmLoading, { c: done, t: total })),
  });
  const m = { model: loaded.model, manifest: loaded.manifest, id: PINNED_LLM.manifestHash.replace(/^0x/, '') };
  if (from === 0 && to === null && head) llm.full = m; else llm.parts.set(key, m);
  return m;
}

function showGeneration(out, where) {
  const t = aiText(lang());
  $('ai-llm-out').textContent = out.text;
  say('ai-llm-status', fill(t.llmDone, { n: out.tokens.length, s: (out.ms / 1000).toFixed(2), r: out.tokensPerSecond.toFixed(1), where }));
}

async function llmHere() {
  const t = aiText(lang());
  const m = await llmModel({ from: 0, to: null, head: true });
  const head = createHead(m.model);
  const tokenizer = loadTokenizer(m.model.tokenizer, m.model.config.vocabSize);
  const prompt = $('ai-llm-prompt').value;
  const out = await generate({ head, tokenizer, runner: createStage(m.model) }, prompt, { maxNew: BROWSER_LLM.maxNew });
  llm.lastHere = { prompt, tokens: out.tokens };
  showGeneration(out, t.llmAllHere);
  return out;
}

async function llmServe() {
  const t = aiText(lang());
  if (llm.serving) return;
  const L = PINNED_LLM.layers;
  const k = SPLIT(L);
  const m = await llmModel({ from: k, to: L, head: false });
  const stage = createStage(m.model, { from: k, to: L });
  const servers = [];
  const show = () => say('ai-llm-status', fill(aiText(lang()).llmServing, { a: k, b: L, n: servers.reduce((s, x) => s + x.tokens, 0) }));
  llm.serving = await joinSwarm('stage', 'stage', m.id, {
    meta: { role: 'stage', from: k, to: L },
    want: (meta) => meta.role === 'coordinator',
    onPeer: ({ channel }) => { servers.push(serveLlmStage(channel, stage, { model: m.id })); show(); },
  });
  llm.servers = servers;
  setInterval(show, 1000);
  show();
  return t;
}

async function llmSplit() {
  const t = aiText(lang());
  const L = PINNED_LLM.layers;
  const k = SPLIT(L);
  const m = llm.full ?? await llmModel({ from: 0, to: k, head: true });
  say('ai-llm-status', fill(t.llmWaiting, { a: k, b: L }));
  const channel = await new Promise((resolve, reject) => {
    joinSwarm('coord', 'stage', m.id, {
      meta: { role: 'coordinator' },
      want: (meta) => meta.role === 'stage' && meta.from === k && meta.to === L,
      maxPeers: 1,
      onPeer: ({ channel: ch }) => resolve(ch),
    }).then((s) => { if (s.peers.size) resolve([...s.peers.values()][0].channel); }, reject);
  });
  const head = createHead(m.model);
  const tokenizer = loadTokenizer(m.model.tokenizer, m.model.config.vocabSize);
  const runner = chainStages([createStage(m.model, { from: 0, to: k }), remoteLlmStage(channel, { from: k, to: L, model: m.id })], L);
  const prompt = $('ai-llm-prompt').value;
  const out = await generate({ head, tokenizer, runner }, prompt, { maxNew: BROWSER_LLM.maxNew });
  showGeneration(out, fill(t.llmSplitWhere, { a: 0, k, b: L }));
  if (llm.lastHere && llm.lastHere.prompt === prompt) {
    const same = JSON.stringify(llm.lastHere.tokens) === JSON.stringify(out.tokens);
    $('ai-llm-status').textContent += ' ' + fill(t.llmSame, { v: same ? t.llmYes : t.llmNo });
  }
  return out;
}

function guard(id, fn) {
  $(id).addEventListener('click', async () => {
    $(id).disabled = true;
    try { await fn(); } catch (e) { say('ai-llm-status', aiText(lang()).failed + e.message, true); } finally { if (id !== 'ai-llm-serve' || !llm.serving) $(id).disabled = false; }
  });
}

export function wireBrowserBox() {
  $('ai-load').addEventListener('click', () => ensureEngine().catch(() => {}));
  $('ai-p2p-auto').addEventListener('click', () => autoDiscover());
  if (!BROWSER_AI.signalBoard) say('ai-p2p-auto-status', aiText(lang()).p2pAutoOff);
  $('ai-llm-prompt').value = 'The browser';
  guard('ai-llm-here', llmHere);
  guard('ai-llm-split', llmSplit);
  guard('ai-llm-serve', llmServe);
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
