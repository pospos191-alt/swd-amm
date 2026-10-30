// The contract card of the address and token pages: verified source (Sourcify) or
// what else we know, proxy and implementation, creator, and Read / Write contract.
// Reads are eth_call through the node's queue; writes go through the visitor's own
// injected wallet (window.ethereum) after the chain id check and the wallet-safety
// confirmation that the other ZETAPHY sites use. No keys ever touch this page.
import { readable, writable, readFunction, SOURCIFY_REPO } from './contract.js';
import { parseInput, encodeCall } from './abi.js';
import { decodeRevertWith } from './txdeep.js';
import { sourceBadge, argsTable, revertView } from './txview.js';
import { safeText, groupDigits } from './format.js';

const AUTO_READ = 40; // zero-argument views read when the Read tab opens
const EVM_CHAIN_HEX = (id) => '0x' + Number(id).toString(16);

/** The status line: verified (full / partial match), known (this repo's contract), guessed, or not verified. */
function statusView(ui, info) {
  const { t, h, badge } = ui;
  const parts = [];
  if (info.source === 'verified' && info.sourcify) {
    parts.push(badge(info.sourcify.match === 'full' ? t('xcFullMatch') : t('xcPartialMatch'), 'ok'), ' ', t('xcOnSourcify'));
  } else if (!info.abi && info.impl?.abi) {
    parts.push(badge(t('xcNotVerified'), 'warn'), ' ', t('xcProxyStatus'));
  } else if (info.source === 'known') {
    parts.push(sourceBadge(ui, 'known'), ' ', t(`xcMatched_${info.matchedBy}`, { name: safeText(info.name, 60) }));
  } else if (info.source === 'guessed' && info.matchedBy === 'selectors') {
    parts.push(sourceBadge(ui, 'guessed'), ' ', t('xcMatched_selectors', { name: safeText(info.name, 60) }));
  } else {
    parts.push(badge(t('xcNotVerified'), 'warn'));
    if (info.abi && info.matchedBy === 'bytecode') parts.push(' ', t('xcGuessedAbi'));
  }
  return h('p', { class: 'contract-status', 'data-source': info.source ?? 'none' }, parts);
}

/** The contract card for `address` (a contract): tabs Code / Read / Write. */
export function contractCard(ui, address) {
  const { t, h, card, slot } = ui;
  return card(t('xcTitle'), slot(ui.resolver().resolve(address), (info) => contractBody(ui, info)));
}

function contractBody(ui, info) {
  const { t, h, kv, note, addrLink, hashLink, blockLink } = ui;
  const abi = info.fullAbi;
  const head = [statusView(ui, info)];
  if (info.sourcifyError && info.source !== 'verified') head.push(note(t('xcSourcifyDown', { e: safeText(info.sourcifyError, 120) }), 'warn'));
  const rows = [
    info.name ? [t('xcName'), safeText(info.name, 80)] : null,
    info.label ? [t('xcLabel'), safeText(info.label, 80)] : null,
    info.sourcify?.compiler ? [t('xcCompiler'), h('span', { class: 'mono' }, `${safeText(info.sourcify.language ?? '', 20)} ${info.sourcify.compiler}`)] : null,
    info.sourcify?.deployment?.deployer ? [t('xcCreator'), h('span', null, addrLink(info.sourcify.deployment.deployer), info.sourcify.deployment.txHash ? h('span', null, ` ${t('xcAtTx')} `, hashLink(info.sourcify.deployment.txHash)) : null,
      info.sourcify.deployment.block ? h('span', null, ` · ${t('block')} `, blockLink(info.sourcify.deployment.block)) : null)] : null,
  ];
  if (info.proxy) {
    rows.push([t('xcProxy'), h('span', null, ui.badge(t(`xcProxy_${info.proxy.kind}`), 'pq'))]);
    if (info.proxy.implementation) rows.push([t('xcImplementation'), h('span', null, addrLink(info.proxy.implementation, { full: true }), info.impl ? h('span', null, ' ', info.impl.source ? sourceBadge(ui, info.impl.source) : ui.badge(t('xcNotVerified'), 'warn'), info.impl.name ? ` ${safeText(info.impl.name, 60)}` : '') : null)]);
    if (info.proxy.admin) rows.push([t('xcAdmin'), addrLink(info.proxy.admin, { full: true })]);
    if (info.proxy.beacon) rows.push([t('xcBeacon'), addrLink(info.proxy.beacon, { full: true })]);
  }
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel' });
  const tabs = [['code', t('xcTabCode')], ['read', t('xcTabRead', { n: readable(abi).length })], ['write', t('xcTabWrite', { n: writable(abi).length })]];
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const show = (id) => {
    for (const b of bar.children) b.setAttribute('aria-selected', String(b.dataset.tab === id));
    ui.fill(panel, id === 'code' ? codeTab(ui, info) : id === 'read' ? readTab(ui, info) : writeTab(ui, info));
  };
  for (const [id, label] of tabs) bar.append(h('button', { type: 'button', role: 'tab', class: 'tab', data: { tab: id }, 'aria-selected': 'false', on: { click: () => show(id) } }, label));
  show('code');
  return h('div', { class: 'contract' }, head, kv(rows.filter(Boolean)), info.proxy ? note(t('xcProxyNote'), 'info') : null, bar, panel);
}

function codeTab(ui, info) {
  const { t, h, note } = ui;
  const sv = info.sourcify;
  if (!sv) {
    return h('div', null,
      note(info.source === 'known' ? t('xcKnownNoSource', { name: safeText(info.name ?? '', 60), repo: safeText(info.repo ?? '', 40) }) : t('xcNoSource'), info.source === 'known' ? 'info' : 'warn'),
      note(t('xcHowVerify')),
      info.code ? h('details', null, h('summary', null, t('xcBytecode', { n: groupDigits((info.code.length - 2) / 2) })), h('div', { class: 'mono small break bytecode' }, info.code.slice(0, 24578) + (info.code.length > 24578 ? '…' : ''))) : null);
  }
  const view = h('pre', { class: 'source', tabindex: '0' });
  const list = h('div', { class: 'files', role: 'list' });
  const open = (f) => {
    view.textContent = f.content; // text only, never markup
    for (const b of list.children) b.classList.toggle('active', b.dataset.path === f.path);
  };
  for (const f of sv.files) list.append(h('button', { type: 'button', class: 'file secondary', role: 'listitem', data: { path: f.path }, on: { click: () => open(f) } }, f.path));
  const main = sv.files.find((f) => sv.name && new RegExp(`(^|/)${sv.name.replace(/[^\w$]/g, '')}\\.(sol|vy)$`).test(f.path)) ?? sv.files[0];
  if (main) open(main);
  return h('div', null,
    h('p', null, h('a', { href: `${SOURCIFY_REPO}/${ui.cfg.evmChainId}/${info.address}`, target: '_blank', rel: 'noopener noreferrer' }, t('xcOpenSourcify')), ` · ${t('xcFiles', { n: sv.files.length })}`),
    list, view);
}

function functionForm(ui, f, { onSubmit, button, payable = false, auto = false }) {
  const { t, h } = ui;
  const fields = f.inputs.map((p, i) => h('label', { class: 'fn-field' }, h('span', { class: 'small' }, `${p.name ? safeText(p.name, 40) : `#${i}`} `, h('span', { class: 'mono dim' }, p.type.startsWith('tuple') ? `tuple${p.type.slice(5)}` : p.type)),
    h('input', { name: `a${i}`, spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', placeholder: /\[|tuple/.test(p.type) ? '["…", "…"]' : p.type })));
  const value = payable ? h('label', { class: 'fn-field' }, h('span', { class: 'small' }, t('xcPayValue')), h('input', { name: 'value', inputmode: 'decimal', placeholder: '0.0' })) : null;
  const out = h('div', { class: 'fn-out', 'aria-live': 'polite' });
  const form = h('form', { class: 'fn-form', on: { submit: (e) => { e.preventDefault(); run(); } } }, fields, value, h('button', { type: 'submit', class: 'secondary' }, button), out);
  async function run() {
    let args;
    try { args = f.inputs.map((p, i) => parseInput(p, form.elements[`a${i}`].value)); } catch (e) { ui.fill(out, h('p', { class: 'error' }, safeText(e.message, 200))); return; }
    ui.fill(out, h('p', { class: 'loading' }, t('loading')));
    try { ui.fill(out, await onSubmit(args, value ? form.elements.value.value : '')); } catch (e) { ui.fill(out, h('p', { class: 'error' }, safeText(e?.message ?? e, 300))); }
  }
  if (auto && !f.inputs.length) run();
  return h('details', { class: 'fn', open: auto && !f.inputs.length ? '' : null, data: { fn: f.name } },
    h('summary', null, h('span', { class: 'mono' }, `${f.name}(${f.inputs.map((p) => p.type).join(',')})`), f.mutability === 'payable' ? h('span', null, ' ', ui.badge('payable', 'warn')) : null),
    form);
}

function readTab(ui, info) {
  const { t, h, note } = ui;
  const fns = readable(info.fullAbi);
  if (!fns.length) return note(info.abi || info.impl ? t('xcNoReads') : t('xcNoAbi'), 'warn');
  let auto = 0;
  return h('div', null,
    abiNote(ui, info),
    fns.map((f) => functionForm(ui, f, {
      button: t('xcQuery'),
      auto: !f.inputs.length && auto++ < AUTO_READ,
      onSubmit: async (args) => {
        const r = await readFunction((to, data) => ui.evm('eth_call', [{ to, data }, 'latest'], 4000), info.address, f, args);
        if (r.values) return f.outputs.length ? argsTable(ui, f.outputs, r.values) : note(t('xcNoOutputs'));
        if (r.raw) return h('p', { class: 'mono small break' }, safeText(r.raw, 600), r.error ? ` (${safeText(r.error, 100)})` : '');
        const db = await ui.resolver().sigdb();
        return h('div', null, h('p', { class: 'error' }, t('xcReverted')), revertView(ui, { r: r.revert ? decodeRevertWith(r.revert, info, db) : { kind: 'text', message: safeText(r.error, 300) }, how: 'trace' }));
      },
    })));
}

function abiNote(ui, info) {
  const { t, note } = ui;
  const s = info.source ?? info.impl?.source;
  const via = !info.abi && info.impl ? ` ${t('srcViaProxy')}` : '';
  if (s === 'verified') return note(t('xcAbiVerified') + via, 'info');
  if (s === 'known') return note(t('xcAbiKnown', { name: safeText(info.name ?? info.impl?.name ?? '', 60) }) + via, 'info');
  return note(t('xcAbiGuessed') + via, 'warn');
}

/** "1.5" ZETAPHY -> azetaphy (BigInt); throws on anything else. */
export function parseZeta(s) {
  const v = String(s ?? '').trim();
  if (!v) return 0n;
  const m = /^(\d{1,30})(?:\.(\d{1,18}))?$/.exec(v);
  if (!m) throw new Error('amount: a number like 1.5 expected');
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0') || '0');
}

function writeTab(ui, info) {
  const { t, h, note } = ui;
  const fns = writable(info.fullAbi);
  if (!fns.length) return note(info.abi || info.impl ? t('xcNoWrites') : t('xcNoAbi'), 'warn');
  const eth = ui.wallet();
  const status = h('p', { class: 'wallet-line', 'aria-live': 'polite' });
  let account = null;
  const chainId = ui.cfg.evmChainId;
  async function connect() {
    if (!eth) throw new Error(t('xcNoWallet'));
    const accs = await eth.request({ method: 'eth_requestAccounts' });
    account = Array.isArray(accs) && /^0x[0-9a-fA-F]{40}$/.test(accs[0] ?? '') ? accs[0] : null;
    if (!account) throw new Error(t('xcNoAccount'));
    await ensureChain();
    ui.fill(status, t('xcConnected'), ' ', ui.addrLink(account));
  }
  async function ensureChain() {
    let cid = Number(BigInt(await eth.request({ method: 'eth_chainId' })));
    if (cid !== chainId) {
      try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: EVM_CHAIN_HEX(chainId) }] }); } catch { /* checked below */ }
      cid = Number(BigInt(await eth.request({ method: 'eth_chainId' })));
    }
    if (cid !== chainId) throw new Error(t('xcWrongChain', { want: chainId, got: cid }));
  }
  const connectBtn = h('button', { type: 'button', on: { click: () => connect().catch((e) => ui.fill(status, h('span', { class: 'error' }, safeText(e?.message ?? e, 200)))) } }, t('xcConnect'));
  ui.fill(status, eth ? t('xcNotConnected') : t('xcNoWallet'));
  return h('div', null,
    abiNote(ui, info),
    note(t('xcWriteNote'), 'warn'),
    h('div', { class: 'row' }, eth ? connectBtn : null), status,
    fns.map((f) => functionForm(ui, f, {
      button: t('xcWrite'),
      payable: f.mutability === 'payable',
      onSubmit: async (args, valueText) => {
        if (!account) await connect();
        const value = f.mutability === 'payable' ? parseZeta(valueText) : 0n;
        const data = encodeCall(f, args);
        const call = { from: account, to: info.address, data, ...(value ? { value: '0x' + value.toString(16) } : {}) };
        // a dry run on the node first: a revert is explained before the wallet opens
        try { await ui.evm('eth_call', [call, 'latest'], 0); } catch (e) {
          const hex = /0x[0-9a-fA-F]{8,}/.exec(String(e?.message ?? ''))?.[0];
          const db = await ui.resolver().sigdb();
          return h('div', null, h('p', { class: 'error' }, t('xcWouldRevert')), revertView(ui, { r: hex ? decodeRevertWith(hex, info, db) : { kind: 'text', message: safeText(e?.message ?? e, 300) }, how: 'trace' }));
        }
        await ensureChain(); // asked again right before signing: the wallet may have switched
        const sent = await ui.sf.confirmTx({ network: `${ui.cfg.chainName ?? 'ZETAPHY'} (${chainId})`, from: account, to: info.address, toLabel: info.label ?? info.name ?? undefined,
          value, symbol: 'ZETAPHY', data, action: `${f.name}(${f.inputs.map((p) => p.type).join(',')})` });
        if (sent == null) return note(t('xcCancelled'));
        const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ ...call, data: sent, chainId: EVM_CHAIN_HEX(chainId) }] });
        if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('the wallet returned no transaction hash');
        return h('p', null, ui.badge(t('xcSent'), 'ok'), ' ', ui.hashLink(hash, { full: true }));
      },
    })));
}

