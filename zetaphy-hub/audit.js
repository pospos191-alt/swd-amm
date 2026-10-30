// The hub's "Audit" tab (docs/future/audit-network.md): the open audit network on ZETAPHY.
//   - certificate lookup (AuditCertificate.certificate: level, expiry, report hash, valid now?);
//   - the requests, their phase, findings, automated tier and why they are (not) certifiable;
//   - ask for an audit (AuditNetwork.request, deposit = pool + fee);
//   - auditors: bond, commit a finding or a participation report (only a hash goes on-chain; the salt stays in
//     this browser, localStorage), reveal it after the contest; the PoC / evidence file is hashed here, never uploaded;
//   - judges: vote on a finding, appeal a decision.
// Everything shown goes in with textContent; no inline styles (CSP style-src 'self').
import { withFallback } from './i18n.js';
import { AUDIT } from './audit-i18n.js';
import { AAS } from './aas-i18n.js';
import { keccak256 } from './neuro/src/keccak.js';
import { parseZeta } from './chainlib.js';
import * as core from './audit-core.js';

export const AU = (lang) => withFallback(AUDIT, lang);
const STORE = 'zetaphy-audit:v1';
const ZETAPHY = 77390;
const k = keccak256;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
export const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? String(vars[x]) : m));
const utf8 = (s) => new TextEncoder().encode(s);
/** A source reference as bytes32: a 0x 32-byte hash as is, anything else (a git commit) hashed. */
export const sourceHash = (v) => (HEX32.test(String(v).trim()) ? String(v).trim().toLowerCase() : core.keccakHex(k, utf8(String(v).trim())));
const randomSalt = () => core.keccakHex(k, globalThis.crypto.getRandomValues(new Uint8Array(32)));

// ---------------------------------------------------------------- what this browser keeps (salts until the reveal)
export function cleanStore(j) {
  const out = { commits: [] };
  if (!j || !Array.isArray(j.commits)) return out;
  for (const c of j.commits.slice(-200)) {
    if (!c || !['finding', 'report'].includes(c.kind) || !ADDR.test(c.network) || !/^\d{1,12}$/.test(String(c.req)) || !HEX32.test(c.hash) || !HEX32.test(c.salt)) continue;
    if (c.kind === 'finding' && (!/^\d{1,12}$/.test(String(c.fid)) || !(c.sev >= 1 && c.sev <= 5) || !HEX32.test(c.evidence))) continue;
    out.commits.push({ kind: c.kind, network: c.network.toLowerCase(), req: String(c.req), fid: c.fid != null ? String(c.fid) : null, hash: c.hash, sev: Number(c.sev) || 0,
      evidence: c.evidence ?? null, salt: c.salt, revealed: c.revealed === true, at: Number(c.at) || 0 });
  }
  return out;
}
const load = () => { try { return cleanStore(JSON.parse(localStorage.getItem(STORE) ?? 'null')); } catch { return { commits: [] }; } };
const save = (s) => { try { localStorage.setItem(STORE, JSON.stringify(s)); return true; } catch { return false; } };

// ---------------------------------------------------------------- reads
const call = async (ctx, to, sig, args = []) => ctx.evmCall('eth_call', [{ to, data: core.calldata(k, sig, args) }, 'latest']);
export async function readCertificate(ctx, certAddr, chainId, address) {
  return core.decodeCertificate(await call(ctx, certAddr, core.SIG.certificate, [BigInt(chainId), address]));
}
async function readRequests(ctx, C, max = 20) {
  const n = Number(core.decodeArgs(['uint256'], await call(ctx, C.auditNetwork, core.SIG.requestCount))[0]);
  const params = core.decodeParams(await call(ctx, C.auditNetwork, core.SIG.getParams));
  const ids = Array.from({ length: Math.min(n, max) }, (_, i) => n - 1 - i);
  const reqs = await Promise.all(ids.map(async (id) => {
    const r = core.decodeRequest(await call(ctx, C.auditNetwork, core.SIG.getRequest, [BigInt(id)]));
    const fids = core.decodeArgs(['uint256[]'], await call(ctx, C.auditNetwork, core.SIG.findingsOf, [BigInt(id)]))[0];
    return { id, ...r, findings: fids.map(Number) };
  }));
  return { n, params, reqs };
}

const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);
const say = (ctx, box, text, cls = 'msg small') => box.replaceChildren(ctx.el('p', { class: cls, text }));
const dateOf = (ctx, sec) => { const d = new Date(Number(sec) * 1000); return Number(sec) && Number.isFinite(d.getTime()) ? d.toLocaleDateString(ctx.lang === 'en' ? 'en-GB' : ctx.lang) : '–'; };

// ---------------------------------------------------------------- the page
const page = {
  render(root, ctx) {
    const L = AU(ctx.lang);
    const el = ctx.el;
    const C = ctx.cfg.contracts ?? {};
    const deployed = ADDR.test(C.auditNetwork ?? '') && ADDR.test(C.auditCertificate ?? '');
    const card = (id, title, tip, ...kids) => el('div', { class: 'card off-card au-card', id },
      el('div', { class: 'card-head' }, el('h2', { text: title }), tip ? el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }) : null), ...kids);
    const field = (label, input) => el('label', { class: 'off-field' }, el('span', { class: 'dim small', text: label }), input);
    const input = (id, attrs = {}) => el('input', { id, class: 'mono', spellcheck: 'false', autocomplete: 'off', ...attrs });
    const notDeployed = () => el('p', { class: 'msg small warn', text: L.notDeployed });
    const sevSelect = (id, from = 1) => el('select', { id }, ...L.sev.slice(from).map((s, i) => el('option', { value: String(i + from), text: s })).reverse());

    // ---- certificate lookup
    const certOut = el('div', { id: 'au-cert-out', role: 'status' });
    const cChain = input('au-cert-chain', { value: String(ZETAPHY), inputmode: 'numeric', 'aria-label': L.chainId });
    const cAddr = input('au-cert-addr', { placeholder: '0x…', 'aria-label': L.address });
    const certForm = el('form', { id: 'au-cert-form', class: 'off-form' }, el('div', { class: 'off-2' }, field(L.chainId, cChain), field(L.address, cAddr)),
      el('button', { type: 'submit', class: 'btn sm', id: 'au-cert-go', text: L.lookup }));
    certForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!ADDR.test(cAddr.value.trim())) return say(ctx, certOut, L.badAddress, 'msg small bad');
      if (!/^\d{1,12}$/.test(cChain.value.trim())) return say(ctx, certOut, L.badNumber, 'msg small bad');
      say(ctx, certOut, '…');
      try {
        const d = await readCertificate(ctx, C.auditCertificate, cChain.value.trim(), cAddr.value.trim());
        const st = core.certState(d, Date.now() / 1000);
        certOut.dataset.state = st;
        if (st === 'none') return say(ctx, certOut, L.certNone);
        const c = d.cert;
        const head = { valid: L.certValid, revoked: L.certRevoked, expired: L.certExpired, changed: L.certChanged }[st];
        certOut.replaceChildren(el('p', { class: `msg small ${st === 'valid' ? 'ok' : 'bad'}`, id: 'au-cert-state', text: st === 'valid' ? `✓ ${head} · ${L.levels[c.level]}` : head }),
          el('dl', { class: 'kv3' },
            el('dt', { text: L.level }), el('dd', { id: 'au-cert-level', text: L.levels[c.level] ?? String(c.level) }),
            el('dt', { text: L.issued }), el('dd', { text: dateOf(ctx, c.issuedAt) }),
            el('dt', { text: L.expires }), el('dd', { id: 'au-cert-expires', text: dateOf(ctx, c.expiresAt) }),
            el('dt', { text: L.request }), el('dd', { class: 'mono', text: `#${c.requestId}` }),
            el('dt', { text: L.auditors }), el('dd', { text: String(c.auditors) }),
            el('dt', { text: L.mutation }), el('dd', { text: `${c.mutationBps / 100}%` }),
            el('dt', { text: L.codeHash }), el('dd', { class: 'mono', text: c.codeHash }),
            el('dt', { text: L.reportHash }), el('dd', { class: 'mono', id: 'au-cert-report', text: c.reportHash })),
          el('p', { class: 'dim small', text: L.meaning }));
      } catch (err) { say(ctx, certOut, errText(err), 'msg small bad'); }
    });

    // ---- requests
    const reqBox = el('div', { id: 'au-reqs-box' });
    const detail = el('div', { id: 'au-detail' });
    async function drawRequests() {
      if (!deployed) return reqBox.replaceChildren(notDeployed());
      try {
        const { params, reqs } = await readRequests(ctx, C);
        if (!reqs.length) return reqBox.replaceChildren(el('p', { class: 'small dim', text: L.reqNone }));
        const now = Date.now() / 1000;
        reqBox.replaceChildren(el('div', { class: 'scroll' }, el('table', { class: 'tbl', id: 'au-req-table' },
          el('thead', {}, el('tr', {}, ...[L.colId, L.colTarget, L.colPhase, L.colPool, L.colReports, L.colFindings, L.colCert].map((h) => el('th', { text: h })))),
          el('tbody', {}, ...reqs.map((r) => el('tr', { class: 'link', 'data-id': String(r.id), tabindex: 0, onclick: () => drawDetail(r, params) },
            el('td', { class: 'num', text: String(r.id) }), el('td', { class: 'mono', text: `${ctx.short(r.target, 8, 4)}${Number(r.chainId) !== ZETAPHY ? ` @${r.chainId}` : ''}` }),
            el('td', { text: L.phases[core.phaseOf(r, now, params)] }), el('td', { class: 'num', text: ctx.formatZeta(r.pool) }),
            el('td', { class: 'num', text: `${r.reports - r.rejected}/${r.minAuditors}` }), el('td', { class: 'num', text: String(r.findings.length) }),
            el('td', { text: r.certified ? L.certified : L.notYet })))))));
      } catch (err) { reqBox.replaceChildren(el('p', { class: 'msg small bad', text: errText(err) })); }
    }
    async function drawDetail(r, params) {
      say(ctx, detail, '…');
      try {
        const fs = await Promise.all(r.findings.slice(0, 100).map(async (fid) => ({ fid, ...core.decodeFinding(await call(ctx, C.auditNetwork, core.SIG.getFinding, [BigInt(fid)])) })));
        const [agreed, res] = ADDR.test(C.auditRunners ?? '') ? core.decodeArgs(['bool', core.RESULT_TUPLE], await call(ctx, C.auditRunners, core.SIG.runResult, [BigInt(r.id)])) : [false, null];
        const why = Number(core.decodeArgs(['uint8'], await call(ctx, C.auditCertificate, core.SIG.check, [BigInt(r.id)]))[0]);
        detail.replaceChildren(el('h3', { text: fmt(L.detailTitle, { id: r.id }) }),
          el('dl', { class: 'kv3' },
            el('dt', { text: L.codeHash }), el('dd', { class: 'mono', text: r.codeHash }),
            el('dt', { text: L.automated }), el('dd', { id: 'au-auto', text: agreed ? fmt(L.autoLine, { ch: res[1], f: res[2], n: res[3], m: Number(res[4]) / 100 }) : L.autoNone }),
            el('dt', { text: L.reason }), el('dd', { id: 'au-why', 'data-reason': core.REASONS[why] ?? String(why), text: L.reasons[core.REASONS[why]] ?? String(why) }),
            el('dt', { text: L.phases.contest }), el('dd', { text: `${dateOf(ctx, r.createdAt)} → ${dateOf(ctx, r.contestEnd)} (${L.phases[core.phaseOf(r, Date.now() / 1000, params)]})` })),
          el('h3', { text: L.findings }),
          fs.length ? el('div', { class: 'scroll' }, el('table', { class: 'tbl', id: 'au-findings' }, el('tbody', {}, ...fs.map((f) => el('tr', {},
            el('td', { class: 'num', text: `#${f.fid}` }), el('td', { class: 'mono', text: ctx.short(f.auditor, 8, 4) }),
            el('td', { text: f.claimed ? L.sev[f.claimed] : '–' }), el('td', { text: L.fStatus[f.status] ?? '?' }),
            el('td', { text: f.status === 3 ? `${L.sev[f.sev]}${f.group !== BigInt(f.fid) ? ` (= #${f.group})` : ''}` : '' })))))) : el('p', { class: 'small dim', text: L.none }));
      } catch (err) { say(ctx, detail, errText(err), 'msg small bad'); }
    }

    // ---- ask for an audit
    const nOut = el('div', { role: 'status' });
    const n = { chain: input('au-n-chain', { value: String(ZETAPHY), inputmode: 'numeric' }), addr: input('au-n-addr', { placeholder: '0x…' }), source: input('au-n-source', { placeholder: 'git commit / 0x…' }),
      codeHash: input('au-n-code', { placeholder: '0x…' }), tier: el('select', { id: 'au-n-tier' }, ...L.tiers.map((t, i) => el('option', { value: String(i), text: t }))),
      days: input('au-n-days', { value: '7', inputmode: 'numeric' }), auditors: input('au-n-auditors', { value: '3', inputmode: 'numeric' }),
      pool: input('au-n-pool', { value: '100', inputmode: 'decimal' }), fixes: input('au-n-fixes', { inputmode: 'numeric' }) };
    const newForm = el('form', { id: 'au-new-form', class: 'off-form' },
      el('div', { class: 'off-2' }, field(L.chainId, n.chain), field(L.address, n.addr)), el('div', { class: 'off-2' }, field(L.source, n.source), field(L.codeHashIn, n.codeHash)),
      el('div', { class: 'off-2' }, field(L.tier, n.tier), field(L.days, n.days)), el('div', { class: 'off-2' }, field(L.minAuditors, n.auditors), field(L.pool, n.pool)),
      field(L.fixes, n.fixes), el('button', { type: 'submit', class: 'btn sm', id: 'au-n-go', text: L.requestBtn }), nOut);
    newForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const chainId = Number(n.chain.value.trim());
        const target = n.addr.value.trim();
        if (!ADDR.test(target)) return say(ctx, nOut, L.badAddress, 'msg small bad');
        if (!n.source.value.trim()) return say(ctx, nOut, L.badHash, 'msg small bad');
        let codeHash = n.codeHash.value.trim();
        if (chainId === ZETAPHY) {
          const code = await ctx.evmCall('eth_getCode', [target, 'latest']);
          if (!code || code === '0x') return say(ctx, nOut, L.noCode, 'msg small bad');
          codeHash = core.keccakHex(k, code);
        } else if (!HEX32.test(codeHash)) return say(ctx, nOut, L.badHash, 'msg small bad');
        for (const x of [n.days, n.auditors]) if (!/^\d{1,4}$/.test(x.value.trim())) return say(ctx, nOut, L.badNumber, 'msg small bad');
        const prev = n.fixes.value.trim() ? BigInt(n.fixes.value.trim()) + 1n : 0n;
        const data = core.calldata(k, core.SIG.request, [[BigInt(chainId), target, codeHash, sourceHash(n.source.value)], Number(n.tier.value), Number(n.days.value) * 86400, Number(n.auditors.value), prev, '']);
        say(ctx, nOut, L.sending);
        await ctx.send(C.auditNetwork, data, `${L.requestBtn}: ${ctx.short(target)}`, parseZeta(n.pool.value));
        say(ctx, nOut, L.done, 'msg small ok');
        drawRequests();
      } catch (err) { say(ctx, nOut, errText(err), 'msg small bad'); }
    });

    // ---- auditor: bond, commit, reveal
    const aOut = el('div', { role: 'status', id: 'au-a-out' });
    const bondIn = input('au-bond', { value: '10', inputmode: 'decimal' });
    const bondForm = el('form', { class: 'row wrap', id: 'au-bond-form' }, field(L.bond, bondIn), el('button', { type: 'submit', class: 'btn ghost sm', text: L.bondBtn }));
    bondForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try { say(ctx, aOut, L.sending); await ctx.send(C.auditNetwork, core.calldata(k, core.SIG.bond), L.bondBtn, parseZeta(bondIn.value)); say(ctx, aOut, L.done, 'msg small ok'); } catch (err) { say(ctx, aOut, errText(err), 'msg small bad'); }
    });
    const cId = input('au-c-id', { inputmode: 'numeric' });
    const cSev = sevSelect('au-c-sev');
    const cText = el('textarea', { id: 'au-c-text', class: 'off-text', rows: 5, 'aria-label': L.findingText });
    const cPoc = el('input', { type: 'file', id: 'au-c-poc', 'aria-label': L.poc });
    const evOut = el('p', { class: 'small mono', id: 'au-c-evidence' });
    let evidence = `0x${'00'.repeat(32)}`;
    cPoc.addEventListener('change', async () => {
      try { evidence = core.keccakHex(k, new Uint8Array(await cPoc.files[0].arrayBuffer())); evOut.textContent = `${L.evidenceHash}: ${evidence}`; } catch { evidence = `0x${'00'.repeat(32)}`; evOut.textContent = ''; }
    });
    async function commit(kind) {
      const me = ctx.account?.() ?? await ctx.connect();
      if (!/^\d{1,12}$/.test(cId.value.trim())) return say(ctx, aOut, L.badNumber, 'msg small bad');
      const req = BigInt(cId.value.trim());
      const text = cText.value.trim();
      if (!text) return say(ctx, aOut, L.needText, 'msg small bad');
      const hash = core.docHash(k, text);
      const salt = randomSalt();
      const sev = Number(cSev.value);
      const c = kind === 'finding' ? core.findingCommitment(k, hash, sev, evidence, me, salt, req) : core.reportCommitment(k, hash, me, salt, req);
      const before = kind === 'finding' ? Number(core.decodeArgs(['uint256'], await call(ctx, C.auditNetwork, core.SIG.findingCount))[0]) : 0;
      // the salt is kept BEFORE the transaction, so a closed tab cannot lose it
      const st = load();
      const rec = { kind, network: C.auditNetwork.toLowerCase(), req: String(req), fid: kind === 'finding' ? String(before) : null, hash, sev, evidence, salt, at: Date.now() };
      st.commits.push(rec);
      save(st);
      say(ctx, aOut, L.sending);
      await ctx.send(C.auditNetwork, core.calldata(k, kind === 'finding' ? core.SIG.commitFinding : core.SIG.commitReport, [req, c]), kind === 'finding' ? L.commitBtn : L.reportBtn);
      if (kind === 'finding') { // the id it got (another finding may have landed first)
        const count = Number(core.decodeArgs(['uint256'], await call(ctx, C.auditNetwork, core.SIG.findingCount))[0]);
        for (let f = before; f < count; f++) {
          const got = core.decodeFinding(await call(ctx, C.auditNetwork, core.SIG.getFinding, [BigInt(f)]));
          if (got.commitment.toLowerCase() === c.toLowerCase()) { const s2 = load(); const r = s2.commits.find((x) => x.salt === salt); if (r) r.fid = String(f); save(s2); break; }
        }
      }
      say(ctx, aOut, L.saved, 'msg small ok');
      drawCommits();
    }
    const commitForm = el('form', { id: 'au-commit-form', class: 'off-form' }, el('div', { class: 'off-2' }, field(L.reqId, cId), field(L.severity, cSev)),
      field(L.findingText, cText), el('label', { class: 'btn ghost sm off-pick', text: L.poc }, cPoc), evOut,
      el('div', { class: 'row wrap' }, el('button', { type: 'submit', class: 'btn sm', id: 'au-c-go', text: L.commitBtn }),
        el('button', { type: 'button', class: 'btn ghost sm', id: 'au-c-report', text: L.reportBtn, onclick: () => commit('report').catch((err) => say(ctx, aOut, errText(err), 'msg small bad')) })), aOut);
    cPoc.classList.add('off-file');
    commitForm.addEventListener('submit', (e) => { e.preventDefault(); commit('finding').catch((err) => say(ctx, aOut, errText(err), 'msg small bad')); });
    const commitsBox = el('div', { id: 'au-commits' });
    function drawCommits() {
      const mine = load().commits.filter((c) => !C.auditNetwork || c.network === C.auditNetwork.toLowerCase());
      if (!mine.length) return commitsBox.replaceChildren(el('p', { class: 'small dim', text: L.noCommits }));
      commitsBox.replaceChildren(el('table', { class: 'tbl' }, el('tbody', {}, ...mine.map((c) => el('tr', { 'data-salt': c.salt.slice(0, 10) },
        el('td', { text: c.kind === 'finding' ? `#${c.fid}` : L.reportBtn }), el('td', { text: `${L.reqId}${c.req}` }), el('td', { text: c.kind === 'finding' ? L.sev[c.sev] : '' }),
        el('td', {}, c.revealed ? el('span', { class: 'dim small', text: '✓' }) : el('button', { type: 'button', class: 'btn ghost sm au-reveal', text: L.reveal, onclick: async () => {
          try {
            say(ctx, aOut, L.sending);
            const data = c.kind === 'finding' ? core.calldata(k, core.SIG.revealFinding, [BigInt(c.fid), c.hash, c.sev, c.evidence, c.salt, ''])
              : core.calldata(k, core.SIG.revealReport, [BigInt(c.req), c.hash, c.salt]);
            await ctx.send(C.auditNetwork, data, L.reveal);
            const st = load(); const r = st.commits.find((x) => x.salt === c.salt); if (r) r.revealed = true; save(st);
            say(ctx, aOut, L.done, 'msg small ok'); drawCommits();
          } catch (err) { say(ctx, aOut, errText(err), 'msg small bad'); }
        } })))))));
    }

    // ---- judging
    const jOut = el('div', { role: 'status' });
    const jId = input('au-j-id', { inputmode: 'numeric' });
    const jValid = el('select', { id: 'au-j-valid' }, el('option', { value: '1', text: L.valid }), el('option', { value: '0', text: L.invalid }));
    const jSev = sevSelect('au-j-sev');
    const jDup = input('au-j-dup', { inputmode: 'numeric' });
    const judgeForm = el('form', { id: 'au-judge-form', class: 'off-form' }, el('div', { class: 'off-2' }, field(L.findingId, jId), field(L.valid, jValid)),
      el('div', { class: 'off-2' }, field(L.severity, jSev), field(L.dupOf, jDup)),
      el('div', { class: 'row wrap' }, el('button', { type: 'submit', class: 'btn sm', text: L.voteBtn }),
        el('button', { type: 'button', class: 'btn ghost sm', text: L.appealBtn, onclick: async () => {
          try {
            if (!/^\d{1,12}$/.test(jId.value.trim())) return say(ctx, jOut, L.badNumber, 'msg small bad');
            const p = core.decodeArgs(['uint16', 'uint16', 'uint16', 'uint32', 'uint128', 'uint128'], await call(ctx, C.auditJudges, 'params()'));
            say(ctx, jOut, L.sending); await ctx.send(C.auditJudges, core.calldata(k, core.SIG.appeal, [BigInt(jId.value.trim())]), L.appealBtn, p[5]); say(ctx, jOut, L.done, 'msg small ok');
          } catch (err) { say(ctx, jOut, errText(err), 'msg small bad'); }
        } })), jOut);
    judgeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        if (!/^\d{1,12}$/.test(jId.value.trim()) || (jDup.value.trim() && !/^\d{1,12}$/.test(jDup.value.trim()))) return say(ctx, jOut, L.badNumber, 'msg small bad');
        const fid = BigInt(jId.value.trim());
        const valid = jValid.value === '1';
        const group = jDup.value.trim() ? BigInt(jDup.value.trim()) : fid;
        say(ctx, jOut, L.sending);
        await ctx.send(C.auditJudges, core.calldata(k, core.SIG.voteFinding, [fid, valid, valid ? Number(jSev.value) : 0, valid ? group : fid]), `${L.voteBtn} #${fid}`);
        say(ctx, jOut, L.done, 'msg small ok');
      } catch (err) { say(ctx, jOut, errText(err), 'msg small bad'); }
    });

    root.replaceChildren(
      el('p', { class: 'small', id: 'au-intro', text: L.intro }),
      el('p', { class: 'small dim', text: `${L.meaning} ${L.testnet}` }),
      // Audit-as-a-Service (docs/future/audit-as-a-service.md): the live check for any chain and the public directory
      el('p', { class: 'small', id: 'au-aas' }, el('a', { href: 'audit.html', text: withFallback(AAS, ctx.lang).vTitle }), ' · ', el('a', { href: 'audits.html', text: withFallback(AAS, ctx.lang).dTitle })),
      el('div', { class: 'au-grid' },
        card('au-cert', L.certTitle, L.certTip, deployed ? certForm : notDeployed(), certOut),
        card('au-reqs', L.reqTitle, L.reqTip, reqBox, detail),
        card('au-new', L.newTitle, L.newTip, deployed ? newForm : notDeployed()),
        card('au-auditor', L.auditorTitle, L.auditorTip, deployed ? el('div', { class: 'off-in' }, bondForm, commitForm, el('h3', { text: L.myCommits }), commitsBox) : notDeployed()),
        card('au-judge', L.judgeTitle, L.judgeTip, deployed ? judgeForm : notDeployed())));
    drawCommits();
    page._draw = drawRequests;
    drawRequests();
  },
  refresh() { /* requests are read when the tab is drawn; the lookup on demand */ },
};
export default page;
