// ZETAPHY hub: every app on one page, one screen, explanations on hover.
//  - Overview and Stake & vote are drawn here (CometBFT RPC + Cosmos REST of the node;
//    staking / rewards / votes are sent from MetaMask to the chain's precompiles).
//  - Wallet, Swap, NFT, Explorer and Neuro are the existing apps, served from this
//    same site (/wallet/ /swap/ /nft/ /explorer/ /neuro/web/) and shown in frames;
//    hub.js gives them the hub's look (embed.css) and folds their long hints into "i" icons.
import {
  PRECOMPILES, toBech32, isEvmAddress, encodeDelegate, encodeUndelegate, encodeClaimRewards, encodeVote,
  parseZeta, formatZeta, short,
} from './chainlib.js';

const EVM_CHAIN_ID = 77390;
const DEFAULT_NODE = 'https://rpc.sawasdeecoin.com';
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ text
const TEXT = {
  th: {
    addNet: 'เพิ่มเครือข่าย', height: 'บล็อกล่าสุด', blockTime: 'เวลาต่อบล็อก', validators: 'Validator', bonded: 'ZETAPHY ที่ stake',
    startTitle: 'เริ่มใช้งาน', step1: 'เพิ่มเครือข่าย ZETAPHY ในกระเป๋า', step2: 'รับ ZETAPHY ทดลอง (ฟรี)', step3: 'ลองใช้งาน', faucetBtn: 'รับ',
    latestBlocks: 'บล็อกล่าสุด', viewAll: 'ดูทั้งหมด', colHeight: 'บล็อก', colTxs: 'ธุรกรรม', colProposer: 'ผู้สร้าง', colAge: 'เมื่อ',
    network: 'เครือข่าย', validatorsTitle: 'Validator', colName: 'ชื่อ', colPower: 'พลังโหวต', colCommission: 'ค่าธรรมเนียม',
    myStake: 'การ stake ของฉัน', proposals: 'ข้อเสนอ (โหวต)', connect: 'เชื่อมต่อ MetaMask', cancel: 'ยกเลิก', confirm: 'ยืนยัน',
    stake: 'Stake', unstake: 'ถอน', claim: 'รับรางวัล', balance: 'ยอดในกระเป๋า', staked: 'stake อยู่', rewards: 'รางวัลสะสม',
    noDelegations: 'ยังไม่ได้ stake กับ validator ไหน', noProposals: 'ยังไม่มีข้อเสนอ', yes: 'เห็นด้วย', no: 'ไม่เห็นด้วย', abstain: 'งดออกเสียง', veto: 'คัดค้าน (veto)',
    ends: 'ปิดโหวต', jailed: 'ถูกพัก', copy: 'คัดลอก', copied: 'คัดลอกแล้ว', ago: 'ที่แล้ว', s: 'วิ', m: 'นาที', h: 'ชม.',
    netUp: 'ออนไลน์', netDown: 'ติดต่อโหนดไม่ได้', stakeTitle: 'Stake กับ', unstakeTitle: 'ถอน stake จาก', available: 'ใช้ได้',
    sent: 'ส่งแล้ว รอยืนยัน…', done: 'สำเร็จ', failed: 'ไม่สำเร็จ', noWallet: 'ไม่พบ MetaMask (หรือกระเป๋า EVM) ในเบราว์เซอร์นี้',
    badAddr: 'ใส่ที่อยู่ 0x… หรือ zetaphy1…', faucetOk: 'ส่ง ZETAPHY ทดลองแล้ว', addedNet: 'เพิ่มเครือข่ายแล้ว', noKeplr: 'ไม่พบ Keplr ในเบราว์เซอร์นี้',
    badAmount: 'จำนวนไม่ถูกต้อง', tooMuch: 'มากกว่าที่มี', voted: 'ส่งโหวตแล้ว',
    endpointEvm: 'EVM RPC', endpointComet: 'CometBFT RPC', endpointRest: 'REST', endpointChain: 'Chain ID',
    tipNet: 'สถานะโหนดของเครือข่าย ZETAPHY testnet: จุดเขียว = ออนไลน์และกำลังสร้างบล็อก',
    tipTestnet: 'Testnet: เหรียญไม่มีมูลค่า สัญญายังไม่ผ่านการตรวจสอบความปลอดภัย (audit) ห้ามใช้เงินจริง',
    tipAddNet: 'เพิ่มเครือข่าย ZETAPHY (Chain ID 77390) ใน MetaMask ด้วยคลิกเดียว',
    tipHeight: 'เลขบล็อกล่าสุดที่โหนดยืนยันแล้ว เพิ่มขึ้นทุก ~5 วินาที',
    tipBlockTime: 'เวลาเฉลี่ยระหว่างบล็อก จาก 20 บล็อกล่าสุด',
    tipValidators: 'จำนวน validator ที่กำลังยืนยันบล็อก (active set)',
    tipBonded: 'ZETAPHY ทั้งหมดที่ถูก stake ค้ำประกันความปลอดภัยของเชน',
    tipStep1: 'MetaMask: เพิ่ม Chain ID 77390 และ RPC ให้อัตโนมัติ\nKeplr: เพิ่มเชนแบบ Cosmos (ที่อยู่ zetaphy1…) ใช้ stake และโหวตได้',
    tipFaucet: 'ฟรีสำหรับทดลอง: วันละครั้งต่อที่อยู่ จำนวนจำกัดต่อวัน\nเหรียญ testnet ไม่มีมูลค่า',
    tipValList: 'Validator คือเครื่องที่ยืนยันบล็อก การ stake กับ validator ช่วยความปลอดภัยของเชนและได้รางวัล\nถ้า validator ทำผิด (เช่น เซ็นซ้ำ) stake บางส่วนอาจถูกหัก',
    tipMyStake: 'stake / ถอน / รับรางวัล ส่งจาก MetaMask ผ่าน precompile ของเชน (0x…0800, 0x…0801)\nถอน stake ต้องรอช่วงปลดล็อก ก่อนเหรียญกลับเข้ากระเป๋า',
    tipProposals: 'ข้อเสนอเปลี่ยนแปลงเชน โหวตได้ตามจำนวนที่ stake (ผ่าน precompile 0x…0805)\nต้อง stake ก่อนจึงจะโหวตได้',
    unbondIn: 'ปลดล็อกใน', days: 'วัน',
  },
  en: {
    addNet: 'Add network', height: 'Latest block', blockTime: 'Block time', validators: 'Validators', bonded: 'ZETAPHY staked',
    startTitle: 'Get started', step1: 'Add ZETAPHY to your wallet', step2: 'Get test ZETAPHY (free)', step3: 'Try the apps', faucetBtn: 'Get',
    latestBlocks: 'Latest blocks', viewAll: 'View all', colHeight: 'Block', colTxs: 'Txs', colProposer: 'Proposer', colAge: 'Age',
    network: 'Network', validatorsTitle: 'Validators', colName: 'Name', colPower: 'Voting power', colCommission: 'Commission',
    myStake: 'My staking', proposals: 'Proposals (vote)', connect: 'Connect MetaMask', cancel: 'Cancel', confirm: 'Confirm',
    stake: 'Stake', unstake: 'Unstake', claim: 'Claim rewards', balance: 'Wallet balance', staked: 'Staked', rewards: 'Rewards',
    noDelegations: 'Not staking with any validator yet', noProposals: 'No proposals yet', yes: 'Yes', no: 'No', abstain: 'Abstain', veto: 'No with veto',
    ends: 'Voting ends', jailed: 'jailed', copy: 'Copy', copied: 'Copied', ago: 'ago', s: 's', m: 'm', h: 'h',
    netUp: 'online', netDown: 'node unreachable', stakeTitle: 'Stake with', unstakeTitle: 'Unstake from', available: 'Available',
    sent: 'Sent, waiting for the block…', done: 'Done', failed: 'Failed', noWallet: 'No MetaMask (or other EVM wallet) in this browser',
    badAddr: 'Enter a 0x… or zetaphy1… address', faucetOk: 'Test ZETAPHY sent', addedNet: 'Network added', noKeplr: 'No Keplr in this browser',
    badAmount: 'Invalid amount', tooMuch: 'More than you have', voted: 'Vote sent',
    endpointEvm: 'EVM RPC', endpointComet: 'CometBFT RPC', endpointRest: 'REST', endpointChain: 'Chain ID',
    tipNet: 'The ZETAPHY testnet node: green = online and making blocks',
    tipTestnet: 'Testnet: coins have no value and the contracts are not audited yet. Do not use real money.',
    tipAddNet: 'Add the ZETAPHY network (chain ID 77390) to MetaMask in one click',
    tipHeight: 'The newest block the node has committed; it grows every ~5 seconds',
    tipBlockTime: 'Average time between the last 20 blocks',
    tipValidators: 'Validators currently signing blocks (the active set)',
    tipBonded: 'All ZETAPHY staked to secure the chain',
    tipStep1: 'MetaMask: adds chain ID 77390 and the RPC for you\nKeplr: adds the Cosmos side (zetaphy1… addresses) for staking and voting',
    tipFaucet: 'Free for testing: once a day per address, a limited number per day\nTestnet coins have no value',
    tipValList: 'Validators sign the blocks. Staking with one helps secure the chain and earns rewards.\nIf a validator misbehaves (e.g. double-signs) part of the stake can be slashed.',
    tipMyStake: 'Stake / unstake / claim are sent from MetaMask to the chain\'s precompiles (0x…0800, 0x…0801)\nUnstaked coins come back after the unbonding period',
    tipProposals: 'Proposals to change the chain; your vote weighs as much as your stake (precompile 0x…0805)\nStake first to vote',
    unbondIn: 'Unbonding', days: 'days',
  },
};

// The tabs: native panels and the apps (with their own explanations as hover text).
const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/><path d="M3 9h15a3 3 0 0 0-3-3H6"/>',
  swap: '<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>',
  stake: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  nft: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="M21 16l-5-5-9 9"/>',
  explorer: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  neuro: '<path d="M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 2 5v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-2 5v1a3 3 0 0 1-6 0"/>',
};
const TABS = [
  { id: 'home', th: 'ภาพรวม', en: 'Overview', titleTh: 'ภาพรวมเครือข่าย ZETAPHY', titleEn: 'ZETAPHY network overview',
    tipTh: 'สถานะเชน บล็อกล่าสุด และขั้นตอนเริ่มต้น', tipEn: 'Chain status, latest blocks and how to start' },
  { id: 'wallet', src: 'wallet/', th: 'กระเป๋า', en: 'Wallet', titleTh: 'กระเป๋าต้านควอนตัม', titleEn: 'Post-quantum wallet',
    tipTh: 'กระเป๋า ML-DSA-44 (FIPS 204) ไม่มีกุญแจ ECDSA\nseed เก็บในเบราว์เซอร์นี้เท่านั้น เข้ารหัสด้วยรหัสผ่านของคุณ',
    tipEn: 'An ML-DSA-44 (FIPS 204) wallet with no ECDSA key\nThe seed stays in this browser, encrypted with your password' },
  { id: 'swap', src: 'swap/', th: 'แลกเปลี่ยน', en: 'Swap', titleTh: 'แลกเปลี่ยนและสภาพคล่อง', titleEn: 'Swap and liquidity',
    tipTh: 'DEX แบบ AMM และ DLMM: แลกเหรียญ เพิ่ม/ถอนสภาพคล่อง\nNeuro ตรวจโค้ดเหรียญก่อนแลกทุกครั้ง', tipEn: 'AMM and DLMM DEX: swap, add or remove liquidity\nNeuro checks each token\'s code before you trade' },
  { id: 'stake', th: 'Stake & โหวต', en: 'Stake & vote', titleTh: 'Stake และโหวต', titleEn: 'Stake and vote', fresh: true,
    tipTh: 'stake ZETAPHY กับ validator รับรางวัล และโหวตข้อเสนอของเชน จาก MetaMask', tipEn: 'Stake ZETAPHY with validators, earn rewards and vote on proposals from MetaMask' },
  { id: 'nft', src: 'nft/', th: 'NFT', en: 'NFT', titleTh: 'ตลาด NFT', titleEn: 'NFT marketplace',
    tipTh: 'สร้างคอลเลกชัน มินต์ ซื้อขาย NFT บน ZETAPHY', tipEn: 'Create collections, mint, buy and sell NFTs on ZETAPHY' },
  { id: 'explorer', src: 'explorer/', th: 'Explorer', en: 'Explorer', titleTh: 'สำรวจบล็อกและธุรกรรม', titleEn: 'Blocks and transactions',
    tipTh: 'ค้นหาบล็อก ธุรกรรม ที่อยู่ validator และใบรับรองบล็อกต้านควอนตัม', tipEn: 'Search blocks, transactions, addresses, validators and post-quantum block certificates' },
  { id: 'neuro', src: 'neuro/web/', th: 'Neuro', en: 'Neuro', titleTh: 'Neuro ตรวจสัญญา', titleEn: 'Neuro contract check',
    tipTh: 'AI อ่านและอธิบายสัญญาบนหลายเชน จับเหรียญปลอม/โค้ดอันตราย (อ่านอย่างเดียว)', tipEn: 'AI that reads and explains contracts on many chains and spots fakes (read-only)' },
];
const APP_HOSTS = { 'wallet.sawasdeecoin.com': 'wallet', 'swap.sawasdeecoin.com': 'swap', 'nft.sawasdeecoin.com': 'nft', 'explorer.sawasdeecoin.com': 'explorer', 'neuro.sawasdeecoin.com': 'neuro' };
// Each app's own language setting, so a language change here reaches them.
const APP_LANG = [['zetaphy-wallet:lang', (l) => l], ['zetaphy-dex:lang', (l) => l], ['zn.lang', (l) => JSON.stringify(l)], ['zetaphy-explorer:lang', (l) => l], ['neuro-lang', (l) => l]];
const APP_THEME = [['zetaphy-dex:theme', 'dark'], ['zn.theme', '"dark"'], ['zetaphy-explorer:theme', 'dark']];

let lang = store.get('zetaphy-hub:lang') === 'en' ? 'en' : 'th';
const T = (k) => TEXT[lang][k] ?? TEXT.en[k] ?? k;
let NODE = DEFAULT_NODE;
const ep = () => ({ evm: NODE, comet: `${NODE}/rpc`, rest: `${NODE}/rest`, files: `${NODE}/zetaphy` });
let current = null;
const frames = new Map();

// ------------------------------------------------------------------ helpers
async function getJson(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12_000);
  try {
    const r = await fetch(url, { cache: 'no-store', credentials: 'omit', ...init, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function evmCall(method, params = []) {
  const j = await getJson(ep().evm, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (j.error) throw new Error(j.error.message || 'RPC error');
  return j.result;
}
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c);
  return e;
};
const svg = (name) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s; };
function age(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}${T('s')}`;
  if (s < 5400) return `${Math.round(s / 60)}${T('m')}`;
  return `${Math.round(s / 3600)}${T('h')}`;
}
const msg = (node, text, cls = '') => { node.textContent = text; node.className = `msg ${cls}`; };

// ------------------------------------------------------------------ tooltip (here and inside the apps)
function tipText(target, doc) {
  if (target.dataset.tip) return target.dataset.tip;
  if (target.dataset.tipKey) return T(target.dataset.tipKey);
  if (target.classList.contains('hub-i')) return target._src?.textContent?.trim() || '';
  return '';
}
function bindTips(doc, tip) {
  const sel = '[data-tip], [data-tip-key], .hub-i';
  const show = (e) => {
    const t = e.target.closest?.(sel);
    if (!t) return;
    const text = tipText(t, doc);
    if (!text) return;
    tip.textContent = text;
    tip.hidden = false;
    const r = t.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    const w = tip.offsetWidth, hgt = tip.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), vw - w - 8);
    let y = r.bottom + 8;
    if (y + hgt > vh - 8) y = Math.max(8, r.top - hgt - 8);
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const hide = (e) => { if (!e.relatedTarget || !e.relatedTarget.closest?.(sel)) tip.hidden = true; };
  doc.addEventListener('mouseover', show);
  doc.addEventListener('focusin', show);
  doc.addEventListener('mouseout', hide);
  doc.addEventListener('focusout', () => { tip.hidden = true; });
  doc.addEventListener('scroll', () => { tip.hidden = true; }, true);
  doc.addEventListener('keydown', (e) => { if (e.key === 'Escape') tip.hidden = true; });
}

// ------------------------------------------------------------------ tabs and frames
function buildTabs() {
  const nav = $('tabs');
  nav.replaceChildren(...TABS.map((t) => el('a', { class: 'tab', href: `?tab=${t.id}`, 'data-tab': t.id, 'data-tip': t[lang === 'th' ? 'tipTh' : 'tipEn'] },
    svg(t.id), el('span', { text: t[lang] }), t.fresh ? el('span', { class: 'new', text: 'new' }) : null)));
  const quick = $('quick');
  quick.replaceChildren(...TABS.filter((t) => t.id !== 'home').map((t) => el('a', { class: 'chip', href: `?tab=${t.id}`, 'data-tab': t.id, 'data-tip': t[lang === 'th' ? 'tipTh' : 'tipEn'] }, svg(t.id), el('span', { text: t[lang] }))));
}

function show(id, { hash, push = true } = {}) {
  const tab = TABS.find((t) => t.id === id) ?? TABS[0];
  current = tab.id;
  $('tip').hidden = true;
  document.querySelectorAll('.tab').forEach((a) => { if (a.dataset.tab === tab.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  $('page-title').textContent = tab[lang === 'th' ? 'titleTh' : 'titleEn'];
  $('page-info').dataset.tip = tab[lang === 'th' ? 'tipTh' : 'tipEn'];
  document.title = `${tab[lang]} · ZETAPHY`;
  $('panel-home').hidden = tab.id !== 'home';
  $('panel-stake').hidden = tab.id !== 'stake';
  for (const [fid, f] of frames) f.hidden = fid !== tab.id;
  if (tab.src) {
    let f = frames.get(tab.id);
    if (!f) {
      f = el('iframe', { title: tab.en, src: tab.src + (hash ?? ''), allow: 'clipboard-write' });
      f.style.visibility = 'hidden'; // shown once the hub look is in (no flash of the app's own colours)
      f.addEventListener('load', () => embed(f, tab.id));
      $('frames').append(f);
      frames.set(tab.id, f);
    } else if (hash) {
      try { f.contentWindow.location.hash = hash; } catch { f.src = tab.src + hash; }
    }
  }
  if (tab.id === 'stake') loadStake();
  if (push) {
    const u = new URL(location.href);
    u.searchParams.set('tab', tab.id);
    if (u.href !== location.href) history.pushState({ tab: tab.id }, '', u);
  }
}

// Inside an app: the hub look, folded hints, hover text, and links to the other apps stay in the hub.
const FOLD = {
  wallet: '.hint',
  swap: '.hint',
  neuro: '.disclaimer',
};
function fold(doc, app) {
  const sel = FOLD[app];
  if (!sel) return;
  for (const n of doc.querySelectorAll(sel)) {
    if (n._hubFolded || n.id || n.closest('footer, .footer, dialog, [role="status"], [aria-live]')) continue;
    if (n.querySelector('a, button, input, select, textarea') || !n.textContent.trim()) continue;
    n._hubFolded = true;
    const i = doc.createElement('span');
    i.className = 'hub-i'; i.textContent = 'i'; i.tabIndex = 0; i.setAttribute('role', 'note');
    i._src = n;
    const prev = n.previousElementSibling;
    if (prev && /^(LABEL|H2|H3|H4|LEGEND|SUMMARY|STRONG|B)$/.test(prev.tagName)) prev.append(i); else n.before(i);
    n.classList.add('hub-folded');
  }
}
function embed(frame, app) {
  let doc;
  try { doc = frame.contentDocument; } catch { frame.style.visibility = ''; return; }
  if (!doc?.documentElement || doc._hub) { frame.style.visibility = ''; return; }
  doc._hub = true;
  doc.documentElement.classList.add('hub-embed');
  doc.documentElement.dataset.app = app;
  const link = doc.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('embed.css', location.href).href;
  const reveal = () => { frame.style.visibility = ''; };
  link.addEventListener('load', reveal); link.addEventListener('error', reveal);
  setTimeout(reveal, 3000);
  doc.head.append(link);
  const tip = doc.createElement('div');
  tip.className = 'hub-tip'; tip.hidden = true; tip.setAttribute('role', 'tooltip');
  doc.body.append(tip);
  bindTips(doc, tip);
  fold(doc, app);
  let pending = 0;
  new MutationObserver(() => { if (!pending) pending = setTimeout(() => { pending = 0; fold(doc, app); }, 150); })
    .observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    let u;
    try { u = new URL(a.href); } catch { return; }
    const to = APP_HOSTS[u.host];
    if (!to) return;
    e.preventDefault();
    show(to, { hash: u.hash || undefined });
  }, true);
}

// ------------------------------------------------------------------ language
function applyLang() {
  document.documentElement.lang = lang;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = T(n.dataset.i18n);
  $('lang').textContent = lang === 'th' ? 'EN' : 'ไทย';
  buildTabs();
  renderEndpoints();
  show(current ?? 'home', { push: false });
}
function syncApps() {
  for (const [k, f] of APP_LANG) store.set(k, f(lang));
  for (const [k, v] of APP_THEME) store.set(k, v);
}

// ------------------------------------------------------------------ overview
function renderEndpoints() {
  const e = ep();
  const rows = [[T('endpointChain'), `${EVM_CHAIN_ID} · zetaphy_77390-1`], [T('endpointEvm'), e.evm], [T('endpointComet'), e.comet], [T('endpointRest'), e.rest]];
  $('endpoints').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v, title: v }),
    el('button', { type: 'button', class: 'copy', text: T('copy'), onclick: async (ev) => {
      try { await navigator.clipboard.writeText(v.split(' · ')[0]); ev.target.textContent = T('copied'); setTimeout(() => { ev.target.textContent = T('copy'); }, 1200); } catch { /* blocked */ }
    } })]));
}
let lastHeight = 0, validatorsCache = null, bondedCache = null;
async function refresh() {
  const net = $('net');
  try {
    const st = await getJson(`${ep().comet}/status`);
    const h = Number(st.result.sync_info.latest_block_height);
    lastHeight = h;
    net.className = 'net up';
    $('net-text').textContent = `#${h.toLocaleString('en-US')}`;
    $('s-height').textContent = h.toLocaleString('en-US');
    if (current === 'home') {
      const bc = await getJson(`${ep().comet}/blockchain?minHeight=${Math.max(1, h - 19)}&maxHeight=${h}`);
      const metas = bc.result.block_metas;
      if (metas.length > 1) {
        const t0 = Date.parse(metas[metas.length - 1].header.time), t1 = Date.parse(metas[0].header.time);
        $('s-time').textContent = `${((t1 - t0) / 1000 / (metas.length - 1)).toFixed(1)}s`;
      }
      const names = await validatorNames();
      $('blocks').replaceChildren(...metas.slice(0, 8).map((m) => {
        const height = m.header.height;
        return el('tr', { class: 'link', onclick: () => show('explorer', { hash: `#/block/${height}` }) },
          el('td', { class: 'num', text: Number(height).toLocaleString('en-US') }), el('td', { class: 'num', text: m.num_txs }),
          el('td', { text: names.get(m.header.proposer_address) ?? short(m.header.proposer_address, 6, 4) }), el('td', { class: 'dim', text: `${age(m.header.time)} ${T('ago')}` }));
      }));
    }
  } catch {
    net.className = 'net down';
    $('net-text').textContent = T('netDown');
  }
  try {
    const [vals, pool] = await Promise.all([bondedValidators(true), getJson(`${ep().rest}/cosmos/staking/v1beta1/pool`)]);
    bondedCache = pool.pool.bonded_tokens;
    $('s-vals').textContent = String(vals.length);
    $('s-bonded').textContent = formatZeta(bondedCache, 0);
  } catch { /* REST may be closed on some nodes */ }
}
async function bondedValidators(force = false) {
  if (validatorsCache && !force) return validatorsCache;
  const j = await getJson(`${ep().rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`);
  validatorsCache = j.validators.sort((a, b) => (BigInt(b.tokens) > BigInt(a.tokens) ? 1 : -1));
  return validatorsCache;
}
// CometBFT proposer address (hex of the consensus key's sha256[:20]) -> moniker
let proposerNames = null;
async function validatorNames() {
  if (proposerNames) return proposerNames;
  proposerNames = new Map();
  try {
    const [vals, cv] = await Promise.all([bondedValidators(), getJson(`${ep().comet}/validators?per_page=100`)]);
    const byKey = new Map(vals.map((v) => [v.consensus_pubkey?.key, v.description?.moniker]));
    for (const v of cv.result.validators) if (byKey.has(v.pub_key?.value)) proposerNames.set(v.address, byKey.get(v.pub_key.value));
  } catch { /* names are only a nicety */ }
  return proposerNames;
}

async function faucet(e) {
  e.preventDefault();
  const out = $('faucet-msg');
  const a = $('faucet-addr').value.trim();
  if (!isEvmAddress(a) && !/^zetaphy1[02-9ac-hj-np-z]{38}$/.test(a)) { msg(out, T('badAddr'), 'bad'); return; }
  msg(out, '…');
  try {
    const r = await evmCall('zetaphy_faucet', [a]);
    msg(out, `${T('faucetOk')}${r?.txHash ? ` · ${short(r.txHash, 10, 6)}` : ''}`, 'ok');
  } catch (err) { msg(out, err.message, 'bad'); }
}

// ------------------------------------------------------------------ wallet (MetaMask / any EIP-1193)
const eth = () => window.ethereum;
const CHAIN_PARAMS = () => ({
  chainId: `0x${EVM_CHAIN_ID.toString(16)}`, chainName: 'ZETAPHY Testnet', nativeCurrency: { name: 'ZETAPHY', symbol: 'ZTPHY', decimals: 18 },
  rpcUrls: [ep().evm], blockExplorerUrls: [new URL('?tab=explorer', location.href).href],
});
async function addNetwork() {
  if (!eth()) throw new Error(T('noWallet'));
  try { await eth().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN_PARAMS().chainId }] }); }
  catch (e) {
    if (e?.code !== 4902 && e?.code !== -32603) throw e;
    await eth().request({ method: 'wallet_addEthereumChain', params: [CHAIN_PARAMS()] });
  }
}
async function addKeplr() {
  if (!window.keplr) throw new Error(T('noKeplr'));
  const info = await getJson(`${ep().files}/keplr.json`);
  await window.keplr.experimentalSuggestChain(info);
  await window.keplr.enable(info.chainId);
}
let account = null;
async function connect() {
  if (!eth()) throw new Error(T('noWallet'));
  await addNetwork();
  [account] = await eth().request({ method: 'eth_requestAccounts' });
  return account;
}
async function send(to, data) {
  await addNetwork();
  const hash = await eth().request({ method: 'eth_sendTransaction', params: [{ from: account, to, data, value: '0x0' }] });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const rc = await evmCall('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (rc) { if (rc.status !== '0x1') throw new Error(`${T('failed')} · ${short(hash, 10, 6)}`); return hash; }
  }
  return hash;
}

// ------------------------------------------------------------------ stake & vote
let unbondingDays = null;
async function loadStake() {
  try {
    const [vals, params] = await Promise.all([bondedValidators(true), unbondingDays == null ? getJson(`${ep().rest}/cosmos/staking/v1beta1/params`) : null]);
    if (params) unbondingDays = Math.round(parseInt(params.params.unbonding_time, 10) / 86400 * 10) / 10;
    const total = vals.reduce((s, v) => s + BigInt(v.tokens), 0n) || 1n;
    $('vals').replaceChildren(...vals.map((v, i) => el('tr', {},
      el('td', { class: 'dim', text: String(i + 1) }),
      el('td', { 'data-tip': `${v.operator_address}${v.description?.details ? `\n${v.description.details}` : ''}` }, el('b', { text: v.description?.moniker || short(v.operator_address) }), v.jailed ? el('span', { class: 'pill rejected', text: T('jailed') }) : null),
      el('td', { class: 'num', text: `${(Number((BigInt(v.tokens) * 10000n) / total) / 100).toFixed(2)}%`, 'data-tip': `${formatZeta(v.tokens, 2)} ZTPHY` }),
      el('td', { class: 'num', text: `${(Number(v.commission?.commission_rates?.rate ?? 0) * 100).toFixed(1)}%` }),
      el('td', {}, el('button', { type: 'button', class: 'btn sm', text: T('stake'), onclick: () => stakeDialog(v, 'delegate') })))));
  } catch (e) { $('vals').replaceChildren(el('tr', {}, el('td', { colspan: 5, class: 'dim', text: e.message }))); }
  loadProposals();
  if (account) loadMine();
}
async function loadMine() {
  const body = $('mine-body');
  if (!account) return;
  const b32 = toBech32(account);
  try {
    const [bal, dels, rew] = await Promise.all([
      evmCall('eth_getBalance', [account, 'latest']),
      getJson(`${ep().rest}/cosmos/staking/v1beta1/delegations/${b32}`).catch(() => ({ delegation_responses: [] })),
      getJson(`${ep().rest}/cosmos/distribution/v1beta1/delegators/${b32}/rewards`).catch(() => ({ total: [] })),
    ]);
    const staked = dels.delegation_responses.reduce((s, d) => s + BigInt(d.balance.amount), 0n);
    const reward = (rew.total ?? []).find((c) => c.denom === 'azetaphy')?.amount ?? '0';
    const names = new Map((validatorsCache ?? []).map((v) => [v.operator_address, v.description?.moniker]));
    body.replaceChildren(
      el('div', { class: 'dim small mono', text: `${short(account, 8, 6)} · ${short(b32, 12, 6)}`, 'data-tip': `${account}\n${b32}` }),
      el('div', { class: 'bal' },
        el('div', {}, el('span', { text: T('balance') }), el('b', { text: formatZeta(BigInt(bal)) })),
        el('div', {}, el('span', { text: T('staked') }), el('b', { text: formatZeta(staked) })),
        el('div', {}, el('span', { text: T('rewards') }), el('b', { text: formatZeta(reward) }))),
      dels.delegation_responses.length
        ? el('ul', { class: 'dl' }, dels.delegation_responses.map((d) => el('li', {},
          el('span', { text: names.get(d.delegation.validator_address) ?? short(d.delegation.validator_address), 'data-tip': d.delegation.validator_address }),
          el('span', { class: 'mono', text: formatZeta(d.balance.amount, 2) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('unstake'), onclick: () => stakeDialog({ operator_address: d.delegation.validator_address, description: { moniker: names.get(d.delegation.validator_address) }, delegated: d.balance.amount }, 'undelegate') }))))
        : el('p', { class: 'dim small', text: T('noDelegations') }),
      el('div', { class: 'row' }, el('button', { type: 'button', class: 'btn', text: T('claim'), disabled: reward === '0' || !dels.delegation_responses.length, onclick: async (e) => {
        const out = $('mine-msg');
        e.target.disabled = true;
        try { msg(out, T('sent')); await send(PRECOMPILES.distribution, encodeClaimRewards(account, 50)); msg(out, T('done'), 'ok'); loadMine(); }
        catch (err) { msg(out, err.message, 'bad'); e.target.disabled = false; }
      } })),
      el('p', { class: 'msg', id: 'mine-msg', role: 'status' }));
    body._bal = BigInt(bal);
  } catch (e) { body.replaceChildren(el('p', { class: 'msg bad', text: e.message })); }
}
async function loadProposals() {
  const list = $('props');
  try {
    const j = await getJson(`${ep().rest}/cosmos/gov/v1/proposals?pagination.reverse=true&pagination.limit=20`);
    if (!j.proposals.length) { list.replaceChildren(el('li', { class: 'dim', text: T('noProposals') })); return; }
    list.replaceChildren(...j.proposals.map((p) => {
      const status = String(p.status).replace('PROPOSAL_STATUS_', '').toLowerCase();
      const voting = status === 'voting_period';
      const out = el('p', { class: 'msg', role: 'status' });
      const vote = (opt) => async () => {
        try { if (!account) await connect(); msg(out, T('sent')); await send(PRECOMPILES.gov, encodeVote(account, BigInt(p.id), opt, '')); msg(out, T('voted'), 'ok'); }
        catch (err) { msg(out, err.message, 'bad'); }
      };
      return el('li', {},
        el('div', { class: 'p-top' }, el('span', { class: 'dim mono', text: `#${p.id}` }),
          el('span', { class: 'p-title', text: p.title || p.messages?.[0]?.['@type']?.split('.').pop() || '—', 'data-tip': p.summary || p.title || '' }),
          el('span', { class: `pill ${voting ? 'voting' : status}`, text: status.replace('_', ' ') })),
        voting ? el('div', { class: 'dim small', text: `${T('ends')} ${new Date(p.voting_end_time).toLocaleString(lang === 'th' ? 'th-TH' : 'en-GB')}` }) : null,
        voting ? el('div', { class: 'votes' },
          el('button', { type: 'button', class: 'btn sm', text: T('yes'), onclick: vote(1) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('no'), onclick: vote(3) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('abstain'), onclick: vote(2) }),
          el('button', { type: 'button', class: 'btn ghost sm', text: T('veto'), onclick: vote(4) })) : null,
        out);
    }));
  } catch (e) { list.replaceChildren(el('li', { class: 'dim', text: e.message })); }
}
function stakeDialog(v, kind) {
  const dlg = $('amount-dlg');
  const name = v.description?.moniker || short(v.operator_address);
  $('amount-title').textContent = `${T(kind === 'delegate' ? 'stakeTitle' : 'unstakeTitle')} ${name}`;
  const max = kind === 'delegate' ? $('mine-body')._bal : BigInt(v.delegated ?? 0);
  $('amount-sub').textContent = [max != null ? `${T('available')}: ${formatZeta(max)} ZTPHY` : '', kind === 'undelegate' && unbondingDays != null ? `${T('unbondIn')} ${unbondingDays} ${T('days')}` : ''].filter(Boolean).join(' · ');
  $('amount').value = '';
  msg($('amount-msg'), '');
  $('amount-ok').disabled = false;
  $('amount-form').onsubmit = async (e) => {
    e.preventDefault();
    const out = $('amount-msg');
    let amt;
    try { amt = parseZeta($('amount').value); if (amt <= 0n) throw new Error(); } catch { msg(out, T('badAmount'), 'bad'); return; }
    if (max != null && amt > max) { msg(out, T('tooMuch'), 'bad'); return; }
    $('amount-ok').disabled = true;
    try {
      if (!account) await connect();
      msg(out, T('sent'));
      const data = kind === 'delegate' ? encodeDelegate(account, v.operator_address, amt) : encodeUndelegate(account, v.operator_address, amt);
      await send(PRECOMPILES.staking, data);
      msg(out, T('done'), 'ok');
      setTimeout(() => dlg.close(), 900);
      loadMine();
    } catch (err) { msg(out, err.message, 'bad'); $('amount-ok').disabled = false; }
  };
  $('amount-cancel').onclick = () => dlg.close();
  if (!account) connect().then(loadMine).catch((err) => msg($('amount-msg'), err.message, 'bad'));
  dlg.showModal();
}

// ------------------------------------------------------------------ start
async function start() {
  try { const c = await getJson('./hub-config.json'); if (/^https:\/\/[^/]+$/.test(c.node ?? '')) NODE = c.node; } catch { /* default */ }
  syncApps();
  bindTips(document, $('tip'));
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-tab]');
    if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    show(a.dataset.tab);
  });
  window.addEventListener('popstate', () => show(new URL(location.href).searchParams.get('tab') ?? 'home', { push: false }));
  $('lang').addEventListener('click', () => {
    lang = lang === 'th' ? 'en' : 'th';
    store.set('zetaphy-hub:lang', lang);
    syncApps();
    for (const f of frames.values()) { f.remove(); }
    frames.clear();
    applyLang();
  });
  const report = (node) => (p) => p.then(() => msg(node, T('addedNet'), 'ok')).catch((e) => msg(node, e.message, 'bad'));
  $('add-net').addEventListener('click', () => addNetwork().catch(() => {}));
  $('add-metamask').addEventListener('click', () => report($('faucet-msg'))(addNetwork()));
  $('add-keplr').addEventListener('click', () => report($('faucet-msg'))(addKeplr()));
  $('faucet-form').addEventListener('submit', faucet);
  $('connect').addEventListener('click', () => connect().then(loadMine).catch((e) => msg($('mine-body').querySelector('.msg') ?? $('mine-body').appendChild(el('p', { class: 'msg' })), e.message, 'bad')));
  eth()?.on?.('accountsChanged', (a) => { account = a?.[0] ?? null; if (current === 'stake') loadMine(); });
  current = new URL(location.href).searchParams.get('tab') ?? 'home';
  applyLang();
  refresh();
  setInterval(() => { if (!document.hidden) refresh(); }, 6000);
}
start();
