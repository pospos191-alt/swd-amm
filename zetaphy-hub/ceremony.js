// Browser contribution to the phase-2 trusted setup of Neuro's zkML circuit (ceremony.html; docs/future/onchain-ml.md).
// Entirely client-side: the page reads the transcript and the latest zkey from files the person picks, adds a
// contribution with snarkjs (vendor/snarkjs.min.js, pinned) using entropy from crypto.getRandomValues plus what they
// type, and hands back the new zkey and the updated transcript as downloads. Nothing is sent anywhere: the page's
// CSP allows no network connections at all (connect-src 'self', and the page fetches nothing).
import { pickLang } from './i18n.js';
import { CEREMONY } from './ceremony-i18n.js';
import { checkChain, tip, nextEntry, mixEntropy, sha256Hex, validName, GITHUB_LOGIN, ZKEY_URL, MAX_NAME } from './ceremony-core.js';

const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
const qs = new URLSearchParams(globalThis.location?.search ?? '');
let lang = pickLang(qs.get('lang') ?? store.get('zetaphy-hub:lang'));
const L = () => ({ ...CEREMONY.en, ...(CEREMONY[lang] ?? {}) });
const T = (k, ...a) => { const v = L()[k]; return typeof v === 'function' ? v(...a) : (v ?? k); };
const $ = (id) => document.getElementById(id);
export const zkeyName = (i) => `neuro_score_${String(i).padStart(4, '0')}.zkey`;
export const defaultUrl = (github, i) => `https://github.com/${github}/swd-amm/releases/download/zk-ceremony-${i}/${zkeyName(i)}`;

const S = { t: null, tOk: false, zkey: null, zOk: false, result: null, extra: [], urlTouched: false };

function say(id, text, cls = '') { const n = $(id); n.textContent = text; n.className = `mono ${cls}`.trim(); }

function texts() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-t]')) n.textContent = T(n.dataset.t);
  $('lang').value = lang;
  $('name').placeholder = T('namePh');
  $('github').placeholder = 'octocat';
  refresh();
  if (S.result) nextSteps();
}

/** Re-checks every input and enables the button only when a contribution can be made. */
function refresh() {
  const gh = $('github').value.trim();
  const k = S.t ? tip(S.t).index + 1 : 1;
  if (!S.urlTouched) $('url').value = GITHUB_LOGIN.test(gh) ? defaultUrl(gh, k) : '';
  const ready = S.tOk && S.zOk && validName($('name').value.trim()) && GITHUB_LOGIN.test(gh) && ZKEY_URL.test($('url').value.trim()) && !S.busy;
  $('go').disabled = !ready;
  if (!S.busy && !S.result) {
    const why = !S.tOk ? T('needTranscript') : !S.zOk ? T('needZkey') : !validName($('name').value.trim()) ? T('needName', MAX_NAME) : !GITHUB_LOGIN.test(gh) ? T('needGithub') : !ZKEY_URL.test($('url').value.trim()) ? T('needUrl') : T('ready');
    say('gstatus', why, ready ? 'good' : 'muted');
  }
}

async function onTranscript(file) {
  S.t = null; S.tOk = false; S.zOk = false;
  try {
    const t = JSON.parse(await file.text());
    const problems = await checkChain(t);
    if (problems.length) { say('tstatus', `${T('badTranscript')} ${problems.slice(0, 3).join('; ')}`, 'bad'); return refresh(); }
    S.t = t;
    const tp = tip(t);
    if (tp.final) say('tstatus', T('isFinal'), 'bad');
    else if (t.beacon) say('tstatus', T('closed'), 'bad');
    else { S.tOk = true; say('tstatus', T('tOk', t.contributions.length, tp.index + 1, t.circuit.modelHash, t.rehearsal ? T('rehearsal') : ''), 'good'); }
    if (S.zkey) await checkZkey();
  } catch (e) { say('tstatus', `${T('badTranscript')} ${String(e.message ?? e).slice(0, 120)}`, 'bad'); }
  refresh();
}

async function checkZkey() {
  S.zOk = false;
  if (!S.zkey) return;
  say('zstatus', T('hashing'), 'muted');
  S.zkey.sha = await sha256Hex(S.zkey.bytes);
  if (!S.t) say('zstatus', T('zLoaded', S.zkey.sha), 'muted');
  else if (S.zkey.sha === tip(S.t).zkeySha256) { S.zOk = true; say('zstatus', T('zOk', tip(S.t).index, S.zkey.sha), 'good'); }
  else say('zstatus', T('zBad', S.zkey.sha, tip(S.t).zkeySha256), 'bad');
}

async function onZkey(file) {
  S.zkey = { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name };
  await checkZkey();
  refresh();
}

/** Progress from snarkjs' debug lines ("… L Section: 1234/5678" then the H section). */
function logger() {
  const bar = $('bar');
  const step = (m) => {
    const x = /(L|H) Section: (\d+)\/(\d+)/.exec(String(m));
    if (x) bar.value = (x[1] === 'L' ? 0 : 50) + (50 * Number(x[2])) / Math.max(1, Number(x[3]));
  };
  return { debug: step, info: step, warn: () => {}, error: (m) => say('gstatus', String(m), 'bad') };
}

async function go() {
  const snarkjs = globalThis.snarkjs;
  if (!snarkjs?.zKey?.contribute) { say('gstatus', T('noEngine'), 'bad'); return; }
  S.busy = true; refresh();
  $('bar').hidden = false; $('bar').value = 0;
  say('gstatus', T('working'), 'muted');
  const name = $('name').value.trim();
  const github = $('github').value.trim();
  const url = $('url').value.trim();
  const random = crypto.getRandomValues(new Uint8Array(64));
  let entropy = await mixEntropy(random, $('entropy').value, S.extra.join(','));
  random.fill(0);
  $('entropy').value = '';
  S.extra = [];
  try {
    const t0 = performance.now();
    const out = { type: 'mem' };
    const hash = await snarkjs.zKey.contribute({ type: 'mem', data: S.zkey.bytes }, out, name, entropy, logger());
    entropy = null;
    if (!hash) throw new Error('snarkjs refused the zkey');
    const seconds = Math.round(performance.now() - t0) / 1000;
    const bytes = out.data;
    const contributionHash = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
    const entry = await nextEntry(S.t, { name, github, contributionHash, zkeySha256: await sha256Hex(bytes), zkeyBytes: bytes.byteLength, url });
    const t = { ...S.t, contributions: [...S.t.contributions, entry] };
    const problems = await checkChain(t);
    if (problems.length) throw new Error(problems.join('; '));
    S.result = { bytes, t, entry, seconds };
    $('chash').textContent = contributionHash;
    $('zsha').textContent = entry.zkeySha256;
    $('took').textContent = `${seconds} s`;
    $('done').hidden = false;
    $('bar').value = 100;
    say('gstatus', T('doneSay', entry.index), 'good');
    nextSteps();
  } catch (e) {
    say('gstatus', `${T('failed')} ${String(e?.message ?? e).slice(0, 200)}`, 'bad');
  } finally { S.busy = false; $('go').disabled = true; }
}

function nextSteps() {
  const { entry } = S.result;
  $('next').replaceChildren(...[T('next1', `zk-ceremony-${entry.index}`, zkeyName(entry.index), entry.url), T('next2'), T('next3')].map((s) => {
    const li = document.createElement('li'); li.textContent = s; return li;
  }));
}

function save(bytes, name, type) {
  const u = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60_000);
}

function main() {
  texts();
  $('lang').addEventListener('change', (e) => { lang = pickLang(e.target.value); store.set('zetaphy-hub:lang', lang); texts(); });
  $('transcript').addEventListener('change', (e) => e.target.files[0] && onTranscript(e.target.files[0]));
  $('zkey').addEventListener('change', (e) => e.target.files[0] && onZkey(e.target.files[0]));
  for (const id of ['name', 'github']) $(id).addEventListener('input', refresh);
  $('url').addEventListener('input', () => { S.urlTouched = $('url').value.trim() !== ''; refresh(); });
  // extra entropy: when keys are pressed and where the pointer moves (mixed in, never stored)
  $('entropy').addEventListener('keydown', () => { if (S.extra.length < 4096) S.extra.push(performance.now().toFixed(3)); });
  document.addEventListener('pointermove', (e) => { if (S.extra.length < 4096) S.extra.push(`${e.clientX}:${e.clientY}:${e.timeStamp.toFixed(2)}`); });
  $('go').addEventListener('click', go);
  $('dlZkey').addEventListener('click', () => save(S.result.bytes, zkeyName(S.result.entry.index), 'application/octet-stream'));
  $('dlTranscript').addEventListener('click', () => save(JSON.stringify(S.result.t, null, 1) + '\n', 'transcript.json', 'application/json'));
}

if (typeof document !== 'undefined' && $('go')) main();
