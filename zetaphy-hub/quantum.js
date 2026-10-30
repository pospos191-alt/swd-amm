// The hub's "Quantum safety" tab (docs/future/quantum-safe-settlement.md):
//   - the network's Q-day readiness score from the quantum-exposure inventory (hub-config.json `qsafe`, from build.mjs);
//   - Q-day status (zetaphy_securityStatus);
//   - "is my address exposed?": the explorer's own verdict (explorer/src/quantum.js quantumExposure) + zetaphy_migration;
//   - create an ML-DSA-44 key and lock to it: the ZETAPHY wallet / Snap do this (this tab sends you there);
//   - a QuantumRescue pre-commitment: the browser makes an ML-DSA-44 key (the wallet's own ML-DSA code,
//     wallet/vendor/pqwallet.js) and a secret, shows the kit once, the connected account sends commit(hash).
// Everything shown goes in with textContent; no inline styles (CSP style-src 'self'); scripts only from this site.
import { withFallback } from './i18n.js';
import { QUANTUM } from './quantum-i18n.js';
import { toBech32, toEvm, isEvmAddress } from './chainlib.js';
import * as core from './quantum-core.js';

export const QL = (lang) => withFallback(QUANTUM, lang);
export const fmt = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, x) => (x in vars ? String(vars[x]) : m));
const ZETAPHY = 77390;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const say = (ctx, box, text, cls = 'msg small') => box.replaceChildren(ctx.el('p', { class: cls, text }));
const hex = (b) => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 240);
let keccak = null;
const loadKeccak = async () => (keccak ??= (await import('./neuro/src/keccak.js')).keccak256);

/** 0x address from a 0x… or zetaphy1… input, or null. */
export function parseAddress(v) {
  const s = String(v ?? '').trim();
  if (isEvmAddress(s)) return s;
  if (/^zetaphy1[02-9ac-hj-np-z]{38}$/.test(s)) { try { return toEvm(s); } catch { return null; } }
  return null;
}

async function readRescue(ctx, contract, account) {
  const k = await loadKeccak();
  const c = (sig, args = []) => ctx.evmCall('eth_call', [{ to: contract, data: core.calldata(k, sig, args) }, 'latest']);
  const [slot, effective, controller, qday, maturity, block] = await Promise.all([
    c(core.SIG.slotOf, [account]), c(core.SIG.effectiveCommitment, [account]), c(core.SIG.controllerOf, [account]),
    c(core.SIG.qdayHeight), c(core.SIG.maturity), ctx.evmCall('eth_blockNumber')]);
  return core.rescueState({ ...core.decodeRescueReads({ slot, effective, controller, qday, maturity }), block: BigInt(block) });
}

const page = {
  render(root, ctx) {
    const L = QL(ctx.lang);
    const el = ctx.el;
    const C = ctx.cfg.contracts ?? {};
    const rescueAddr = ADDR.test(C.quantumRescue ?? '') ? C.quantumRescue : null;
    const card = (id, title, tip, ...kids) => el('div', { class: 'card off-card au-card', id },
      el('div', { class: 'card-head' }, el('h2', { text: title }), tip ? el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }) : null), ...kids);

    // ---- readiness (inventory) and Q-day
    const r = core.readiness(ctx.cfg.qsafe);
    const qdayBox = el('p', { class: 'small dim', id: 'qs-qday', role: 'status' });
    const scoreKids = r ? [
      el('p', { class: `qs-score qs-${r.grade}`, id: 'qs-score' }, el('b', { text: fmt(L.scoreLine, { score: r.score, total: r.total }) }), ' · ', el('span', { text: L.grades[r.grade] })),
      el('meter', { class: 'qs-meter', min: '0', max: '100', low: '50', high: '80', optimum: '100', value: String(r.score), 'aria-label': L.scoreTitle }),
      el('p', { class: 'small' }, ...['pq', 'hybrid', 'partial', 'classical'].map((s) => el('span', { class: `pill qs-${s}`, text: `${L.statuses[s]} ${r[s]}` }))),
      el('h3', { text: L.openTitle }),
      el('ol', { class: 'qs-open small', id: 'qs-open' }, ...r.open.map((o) => el('li', {}, el('span', { class: 'pill', text: L.impact[o.impact] ?? o.impact }), ' ', el('span', { text: o.component }), ' ', el('span', { class: 'dim', text: `(${L.statuses[o.status] ?? o.status})` })))),
    ] : [el('p', { class: 'msg small warn', text: L.noData })];

    // ---- exposure check
    const out = el('div', { id: 'qs-check-out', role: 'status' });
    const addrIn = el('input', { id: 'qs-addr', class: 'mono', spellcheck: 'false', autocomplete: 'off', placeholder: '0x…', 'aria-label': L.address, value: ctx.account?.() ?? '' });
    const checkForm = el('form', { id: 'qs-check-form', class: 'off-form' },
      el('label', { class: 'off-field' }, el('span', { class: 'dim small', text: L.address }), addrIn),
      el('button', { type: 'submit', class: 'btn sm', id: 'qs-check-go', text: L.check }));
    checkForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const a = parseAddress(addrIn.value);
      if (!a) return say(ctx, out, L.badAddress, 'msg small bad');
      say(ctx, out, '…');
      try {
        const [{ quantumExposure }, pq, nonce, code, mig, rescue] = await Promise.all([
          import('./explorer/src/quantum.js'),
          ctx.evmCall('zetaphy_pqAccount', [toBech32(a)]).catch((err) => ({ error: errText(err) })),
          ctx.evmCall('eth_getTransactionCount', [a, 'latest']).then(BigInt).catch(() => null),
          ctx.evmCall('eth_getCode', [a, 'latest']).catch(() => '0x'),
          ctx.evmCall('zetaphy_migration', [a]).catch(() => null),
          rescueAddr ? readRescue(ctx, rescueAddr, a).catch(() => null) : null,
        ]);
        const v = quantumExposure({ pq, nonce, code });
        const step = core.nextStep({ level: v.level, migration: mig, rescue: rescue?.state ?? null });
        out.dataset.level = v.level;
        out.dataset.step = step;
        out.replaceChildren(
          el('p', { class: `msg small ${step === 'safe' ? 'ok' : step === 'unknown' || step === 'contract' ? '' : 'warn'}`, id: 'qs-level', text: fmt(L.levels[v.level], { to: v.lockedTo ?? '' }) }),
          mig?.migrated ? el('p', { class: 'small', text: L.migrated }) : null,
          rescue ? el('p', { class: 'small', id: 'qs-rescue-state', text: fmt(L.rescueStates[rescue.state], { at: rescue.countsFrom ?? '', to: rescue.controller ?? '' }) }) : null,
          el('p', { class: 'small', id: 'qs-step' }, el('b', { text: L.steps[step] })));
      } catch (err) { say(ctx, out, errText(err), 'msg small bad'); }
    });

    // ---- create / lock (the wallet and the Snap do it)
    const lockKids = [
      el('p', { class: 'small', text: L.lockText }),
      el('button', { type: 'button', class: 'btn sm', id: 'qs-open-wallet', text: L.openWallet, onclick: () => ctx.show?.('wallet') }),
      el('p', { class: 'small dim', text: L.snapText }),
    ];

    // ---- rescue pre-commitment
    const rOut = el('div', { id: 'qs-rescue-out', role: 'status' });
    let pending = null; // { commitment } after the kit was shown
    const commitBtn = el('button', { type: 'button', class: 'btn sm', id: 'qs-commit', text: L.commitBtn, hidden: true, onclick: async () => {
      if (!pending || !rescueAddr) return;
      try {
        const k = await loadKeccak();
        commitBtn.disabled = true;
        say(ctx, rStatus, L.sending);
        await ctx.send(rescueAddr, core.calldata(k, core.SIG.commit, [pending.commitment]), L.commitAction);
        say(ctx, rStatus, L.done, 'msg small ok');
      } catch (err) { say(ctx, rStatus, errText(err), 'msg small bad'); } finally { commitBtn.disabled = false; }
    } });
    const rStatus = el('div', { id: 'qs-rescue-status', role: 'status' });
    const makeBtn = el('button', { type: 'button', class: 'btn sm', id: 'qs-make-kit', text: L.makeKey, disabled: !rescueAddr, onclick: async () => {
      try {
        const account = ctx.account?.() ?? await ctx.connect?.();
        if (!ADDR.test(account ?? '')) return say(ctx, rStatus, L.needAccount, 'msg small bad');
        const [k, pw] = await Promise.all([loadKeccak(), import('./wallet/vendor/pqwallet.js')]);
        const seed = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const secret = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
        const { publicKey } = pw.ml_dsa44.keygen(seed);
        const keyHash = core.keccakHex(k, publicKey);
        const controller = pw.pqAddress(publicKey).hex;
        const commitment = core.rescueCommitment(k, { chainId: ZETAPHY, contract: rescueAddr, account, keyHash, secret });
        const kit = core.rescueKit({ chainId: ZETAPHY, contract: rescueAddr, account, keyHash, controller, secret, seed: hex(seed) });
        pending = { commitment };
        rOut.replaceChildren(el('h3', { text: L.kitTitle }), el('p', { class: 'msg small warn', text: L.kitWarn }),
          el('textarea', { id: 'qs-kit', class: 'mono qs-kit', readonly: true, rows: '9', spellcheck: 'false', text: kit }), ctx.copyBtn?.(kit));
        commitBtn.hidden = false;
        rStatus.replaceChildren();
        readRescue(ctx, rescueAddr, account).then((s) => say(ctx, rStatus, fmt(L.rescueStates[s.state], { at: s.countsFrom ?? '', to: s.controller ?? '' }))).catch(() => {});
      } catch (err) { say(ctx, rStatus, errText(err), 'msg small bad'); }
    } });
    const rescueKids = [el('p', { class: 'small', text: L.rescueHow }), rescueAddr ? null : el('p', { class: 'msg small warn', id: 'qs-not-deployed', text: L.notDeployed }), makeBtn, rOut, commitBtn, rStatus];

    root.replaceChildren(
      el('p', { class: 'small', id: 'qs-intro', text: L.intro }),
      el('p', { class: 'small dim', text: L.testnet }),
      qdayBox,
      el('div', { class: 'au-grid' },
        card('qs-ready', L.scoreTitle, L.scoreTip, ...scoreKids),
        card('qs-check', L.checkTitle, L.checkTip, checkForm, out),
        card('qs-lock', L.lockTitle, L.lockTip, ...lockKids),
        card('qs-rescue', L.rescueTitle, L.rescueTip, ...rescueKids)));

    ctx.evmCall('zetaphy_securityStatus').then((st) => {
      const h = Number(st?.qdayHeight ?? 0);
      qdayBox.textContent = !h ? L.qdayNone : st.qdayActive ? fmt(L.qdayPassed, { h }) : fmt(L.qdayAt, { h, now: st.latestHeight ?? '?' });
    }).catch(() => { qdayBox.textContent = ''; });
  },
};
export default page;
