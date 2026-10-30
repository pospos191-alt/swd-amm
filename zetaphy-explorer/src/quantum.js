// Quantum exposure: is an address's secp256k1 public key already on chain?
// A key is exposed once the account has signed anything that reached the chain:
// an EVM tx (the signature lets anyone recover the public key) or a Cosmos tx
// (the public key is stored with the account). A large quantum computer could
// then derive the private key. ZETAPHY's answers: ML-DSA-44 accounts (post-quantum
// signatures) and the quantum lock (zetaphy_pqAccount quantumLockedTo: the chain
// refuses the account's own ECDSA key; only its ML-DSA-44 controller acts for it).
// This module: the plain-words verdict for one address (address page and
// #/quantum/<address>) and a chain-level dashboard (#/quantum).
import { h } from './dom.js';
import { anyAddressLower, toAddress, percent, groupDigits } from './format.js';

const SECP = /secp256k1/i;

/**
 * The verdict for one account from what the node says:
 *   pq: zetaphy_pqAccount's answer ({ pubKeyType, sequence, quantumLockedTo, exists }) or { error } / null
 *   nonce: EVM nonce (BigInt) or null; code: EVM code ('0x' for none)
 * level: 'pq' (ML-DSA-44 account) | 'locked' (quantum lock set) | 'exposed' (secp256k1 key on chain)
 *        | 'hidden' (no key on chain yet) | 'contract' (no key: code) | 'unknown'
 */
export function quantumExposure({ pq, nonce = null, code = '0x' } = {}) {
  const known = !!pq && typeof pq === 'object' && !pq.error;
  const keyType = known && pq.pubKeyType ? String(pq.pubKeyType) : null;
  const pqAccount = keyType === 'mldsa44';
  const lockedTo = known && pq.quantumLockedTo ? String(pq.quantumLockedTo) : null;
  const sentEvm = nonce != null && BigInt(nonce) > 0n;
  let seq = null;
  try { seq = known && pq.sequence != null ? BigInt(pq.sequence) : null; } catch { seq = null; }
  const secpOnChain = !!keyType && SECP.test(keyType);
  const isContract = typeof code === 'string' && code.length > 2;
  const exposed = !pqAccount && (sentEvm || secpOnChain || (!keyType && seq != null && seq > 0n));
  let level;
  if (pqAccount) level = 'pq';
  else if (lockedTo) level = 'locked';
  else if (isContract) level = 'contract';
  else if (exposed) level = 'exposed';
  else if (known) level = 'hidden';
  else level = 'unknown';
  return { level, known, keyType, pqAccount, lockedTo, sentEvm, secpOnChain, exposed, isContract, sequence: seq };
}

/** How a recent sender is counted on the dashboard (an EVM tx sender signed with secp256k1). */
export function senderClass(pq, { evm = false } = {}) {
  const v = quantumExposure({ pq, nonce: evm ? 1n : null });
  if (v.level === 'pq' || v.level === 'locked') return v.level;
  if (evm || v.exposed) return 'exposed';
  return v.known ? 'hidden' : 'unknown';
}

/** Unique senders of scanned txs (0x lower), EVM ones marked: [{ address, evm }], bounded. */
export function recentSenders(txs, max = 40) {
  const seen = new Map();
  for (const x of txs) {
    if (!x || x.ok === false) continue;
    const a = anyAddressLower(x.from);
    if (!a || String(x.from).startsWith('zetaphyvaloper')) continue;
    if (!seen.has(a)) seen.set(a, { address: a, evm: !!x.evm });
    else if (x.evm) seen.get(a).evm = true;
    if (seen.size >= max) break;
  }
  return [...seen.values()];
}

/** Counts per class and the PQ share (pq + locked) of a list of classes. */
export function tally(classes) {
  const n = { pq: 0, locked: 0, exposed: 0, hidden: 0, unknown: 0 };
  for (const c of classes) n[c] = (n[c] ?? 0) + 1;
  const known = classes.length - n.unknown;
  return { ...n, total: classes.length, known, protected: n.pq + n.locked };
}

const LEVEL_BADGE = { pq: 'ok', locked: 'ok', exposed: 'bad', hidden: 'warn', contract: '', unknown: '' };

/** The address-page section (and #/quantum/<address>): ui is app.js's view kit. */
export function quantumCard(ui, a, acc) {
  const { t, badge, card, note, kv, addrLink } = ui;
  const v = quantumExposure({ pq: acc.pq, nonce: acc.nonce, code: acc.code });
  const hub = ui.cfg.hubWalletUrl;
  const hubLink = hub ? h('a', { href: hub, target: '_blank', rel: 'noopener noreferrer' }, t('qHubLink')) : null;
  const facts = [
    [t('qFactKey'), v.pqAccount ? t('qKeyPQ') : v.secpOnChain ? t('qKeySecp') : v.keyType ? v.keyType : v.known ? t('qKeyNone') : t('qKeyUnknown')],
    [t('qFactSent'), v.sentEvm ? t('qSentYes', { n: groupDigits(String(acc.nonce)) }) : acc.nonce != null ? t('qSentNo') : '—'],
    [t('qFactLock'), v.lockedTo ? h('span', null, t('qLockedTo'), ' ', addrLink(v.lockedTo)) : v.known ? t('qNotLocked') : t('qKeyUnknown')],
  ];
  const actions = {
    pq: [t('qDoPQ')],
    locked: [t('qDoLocked')],
    exposed: [t('qDoExposed1'), t('qDoExposed2')],
    hidden: [t('qDoHidden1'), t('qDoHidden2')],
    contract: [t('qDoContract')],
    unknown: [t('qDoUnknown')],
  }[v.level];
  return card(t('qTitle'),
    h('p', { class: 'q-verdict' }, badge(t(`qLevel_${v.level}`), LEVEL_BADGE[v.level]), ' ', t(`qSay_${v.level}`)),
    kv(facts),
    h('div', { class: 'q-actions' }, h('strong', null, t('qWhatToDo')), h('ul', null, actions.map((x) => h('li', null, x)))),
    ['exposed', 'hidden', 'unknown'].includes(v.level) && hubLink ? h('p', null, hubLink) : null,
    note(t('qExplain'), 'info'));
}

/** #/quantum (dashboard) and #/quantum/<address> (one address). */
export async function pageQuantum(view, param, ui) {
  const { t, chain, cfg, card, note, kv, table, slot, badge, addrLink } = ui;
  const a = param ? toAddress(decodeURIComponent(String(param).split('?')[0])) : null;
  const form = h('form', { class: 'q-form', on: { submit: (e) => { e.preventDefault(); const x = toAddress(e.currentTarget.elements.q.value); if (x) location.hash = `#/quantum/${x.hex}`; } } },
    h('input', { name: 'q', placeholder: '0x… / zetaphy1…', spellcheck: 'false', autocomplete: 'off', 'aria-label': t('qCheckAddress') }),
    h('button', { type: 'submit' }, t('qCheck')));
  append(view, h('h1', null, t('qPageTitle')), note(t('qPageIntro')), card(t('qCheckAddress'), form));
  if (a) {
    const acc = await chain.account(a);
    append(view, h('h2', null, addrLink(a.hex, { full: true })), quantumCard(ui, a, acc));
  }
  const st = await chain.status();
  const vals = card(t('qValidatorsTitle'), slot(ui.getValidators(st.height), (rows) => {
    const active = rows.filter((r) => r.active);
    const total = active.reduce((n, r) => n + r.power, 0n);
    const keyed = active.filter((r) => r.voteKey?.registered);
    const power = keyed.reduce((n, r) => n + r.power, 0n);
    return h('div', null, kv([
      [t('qValKeyed'), `${keyed.length} / ${active.length}`],
      [t('qValPower'), `${percent(power, total || 1n)}`],
    ]), h('div', { class: 'q-bar', role: 'img', 'aria-label': percent(power, total || 1n) }, bar(power, total)), note(t('qValNote')));
  }));
  const senders = card(t('qSendersTitle'), slot((async () => {
    const r = await chain.recentTxs(st.height, cfg.scanBlocks);
    const list = recentSenders(r.txs, 40);
    const answers = await Promise.all(list.map((s) => chain.evmCall('zetaphy_pqAccount', [toAddress(s.address).bech32]).catch((e) => ({ error: String(e?.message ?? e) }))));
    const classes = list.map((s, i) => senderClass(answers[i], { evm: s.evm }));
    const n = tally(classes);
    return h('div', null,
      kv([
        [t('qSendersCount'), groupDigits(n.total)],
        [t('qSendersPQ'), n.known ? `${groupDigits(n.protected)} (${percent(BigInt(n.protected), BigInt(n.known))})` : '—'],
        [t('qSendersExposed'), groupDigits(n.exposed)],
        [t('qSendersHidden'), groupDigits(n.hidden)],
        n.unknown ? [t('qSendersUnknown'), groupDigits(n.unknown)] : null,
      ]),
      table([t('address'), t('qClass')], list.map((s, i) => [addrLink(s.address), badge(t(`qLevel_${classes[i]}`), LEVEL_BADGE[classes[i]])])),
      note(t('qSendersScope', { from: groupDigits(r.from), to: groupDigits(r.to), n: groupDigits(list.length) }), 'info'));
  })(), (x) => x));
  append(view, vals, senders);
}

function bar(part, total) {
  const pct = total ? Number((part * 10000n) / total) / 100 : 0;
  const fill = h('div', { class: 'q-bar-fill' });
  fill.style.width = `${Math.min(100, pct)}%`; // CSSOM, allowed by the CSP
  return fill;
}

function append(el, ...c) { for (const x of c) if (x) el.append(x); return el; }
