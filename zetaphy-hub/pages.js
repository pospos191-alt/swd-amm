// The hub's data pages (like a chain explorer's): Earn, Analytics, DeFi, Leaderboard, Developers.
// Each page: render(root, ctx) draws it once; refresh(ctx) (optional) updates live numbers.
// ctx = { T, lang, ep(), cfg, getJson, evmCall, el, short, formatZeta, show, copyBtn, account(), connect(), send(to, data) }
import { formatZeta, toEvm, toBech32, bech32Decode, parseUnits, formatUnits, encodeIbcTransfer, PRECOMPILES } from './chainlib.js';

// ------------------------------------------------------------------ eth_call helpers (selectors = keccak256, checked in tests)
export const SEL = {
  allPairsLength: '0x574f2ba3', allPairs: '0x1e3dd18b', token0: '0x0dfe1681', token1: '0xd21220a7', getReserves: '0x0902f1ac',
  symbol: '0x95d89b41', decimals: '0x313ce567', workerBond: '0x299f3d98', activeWorkers: '0x3da383ca', rewardPool: '0x66666aa9',
  totalActiveBond: '0x616b8ea8', jobCount: '0x4c5d8a0f',
};
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const call = (ctx, to, data) => ctx.evmCall('eth_call', [{ to, data }, 'latest']);
const uintAt = (hex, i = 0) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);
const addrAt = (hex, i = 0) => `0x${hex.slice(2 + i * 64 + 24, 2 + (i + 1) * 64)}`;
/** ABI string (or bytes32 fallback) -> text, at most 32 printable characters. */
export function decodeString(hex) {
  const h = String(hex).replace(/^0x/, '');
  let bytes;
  if (h.length >= 128 && BigInt(`0x${h.slice(0, 64)}`) === 32n) {
    const len = Number(BigInt(`0x${h.slice(64, 128)}`));
    bytes = h.slice(128, 128 + Math.min(len, 64) * 2);
  } else bytes = h.slice(0, 64).replace(/(00)+$/, '');
  const txt = (bytes.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join('');
  return txt.replace(/[^\x20-\x7e]/g, '').slice(0, 32) || '?';
}

// ------------------------------------------------------------------ small pieces
const code = (ctx, text) => ctx.el('div', { class: 'code' }, ctx.el('pre', { class: 'mono', text }), ctx.copyBtn(text));
const tile = (ctx, label, tipKey, id) => ctx.el('div', { class: 'stat', 'data-tip-key': tipKey, tabindex: 0 },
  ctx.el('span', { class: 'k', text: ctx.T(label) }), ctx.el('span', { class: 'v mono', id, text: '–' }));
const setText = (id, t) => { const n = document.getElementById(id); if (n) n.textContent = t; };

/** A one-hue column chart in SVG, with a hover tooltip per bar (title + data-tip). */
export function columns(ctx, values, { height = 150, fmt = (v) => String(v), label = (i) => String(i) } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 600, H = height, pad = { l: 34, r: 6, t: 8, b: 18 };
  const max = Math.max(1, ...values);
  const bw = (W - pad.l - pad.r) / Math.max(1, values.length);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  const mk = (tag, attrs) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  for (const f of [0, 0.5, 1]) {
    const y = pad.t + (H - pad.t - pad.b) * (1 - f);
    svg.append(mk('line', { x1: pad.l, x2: W - pad.r, y1: y, y2: y, class: 'grid' }));
    const t = mk('text', { x: pad.l - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = fmt(max * f); svg.append(t);
  }
  values.forEach((v, i) => {
    const h = Math.max(v > 0 ? 2 : 0, (H - pad.t - pad.b) * (v / max));
    const x = pad.l + i * bw + 1, y = H - pad.b - h, w = Math.max(1, bw - 2);
    svg.append(mk('rect', { x, y: pad.t, width: w, height: H - pad.t - pad.b, class: 'hit', 'data-tip': `${label(i)}: ${fmt(v)}` }));
    svg.append(mk('path', { d: `M${x},${H - pad.b} V${y + Math.min(4, h)} q0,-${Math.min(4, h)} ${Math.min(4, w / 2)},-${Math.min(4, h)} H${x + w - Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h)} V${H - pad.b} Z`, class: 'bar', 'pointer-events': 'none' }));
  });
  return svg;
}
/** Horizontal one-hue bars with the label and value as text (no legend needed: one series). */
export function hbars(ctx, rows, { fmt = (v) => String(v) } = {}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return ctx.el('div', { class: 'hbars' }, rows.map((r) => ctx.el('div', { class: 'hbar', 'data-tip': r.tip ?? `${r.label}: ${fmt(r.value)}` },
    ctx.el('span', { class: 'hb-label', text: r.label }),
    ctx.el('span', { class: 'hb-track' }, ctx.el('span', { class: 'hb-fill', style: null, 'data-w': String(Math.round((r.value / max) * 1000) / 10) })),
    ctx.el('span', { class: 'hb-val mono', text: fmt(r.value) }))));
}
// widths are set from data-w (no inline style attribute: the CSP allows only this site's style files)
export const sizeBars = (root) => root.querySelectorAll('.hb-fill[data-w]').forEach((n) => { n.style.width = `${n.dataset.w}%`; });

// ------------------------------------------------------------------ Earn
const EARN = {
  th: {
    intro: 'ZETAPHY ไม่มีการขุดแบบใช้พลังเครื่อง (PoW) เชนใช้ระบบ stake แทน: คนที่ช่วยงานเครือข่ายได้รางวัลเป็น ZETAPHY ด้านล่างคือทุกทางที่ได้เหรียญ เรียงจากง่ายไปยาก',
    need: 'ต้องมี', get: 'ได้อะไร', time: 'ใช้เวลา',
    m: [
      { id: 'faucet', icon: 'drop', title: 'Faucet (ฟรี)', level: 'ง่ายมาก', need: 'ที่อยู่กระเป๋า', get: '10 ZETAPHY ทดลอง วันละครั้ง', time: '1 นาที',
        steps: [['เปิดหน้าภาพรวม ใส่ที่อยู่ 0x… หรือ zetaphy1… ในขั้นที่ 2 แล้วกด "รับ"'], ['หรือใช้เทอร์มินัล (เปลี่ยน 0xYOUR_ADDRESS เป็นที่อยู่ของคุณ):', 'curl -s https://RPC -H "content-type: application/json" \\\n  -d \'{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0xYOUR_ADDRESS"]}\''], ['ได้วันละครั้งต่อที่อยู่ ทั้งเครือข่ายแจกได้ 200 ครั้งต่อวัน (นับตามเวลา UTC)']] },
      { id: 'runner', icon: 'cpu', title: 'รันร่าง Neuro ด้วยเทอร์มินัล ("ขุด" แบบ ZETAPHY)', level: 'ง่าย', need: 'คอมทั่วไป (CPU) + Node.js 20 ขึ้นไป + git + เงินมัดจำ BOND', get: 'ค่าตรวจสัญญาจากงานใน NeuroJobs และรางวัลจากกองรางวัล (ปล่อยปีละ 10%)', time: '10 นาที แล้วเปิดค้างไว้',
        steps: [['ติดตั้ง Node.js 22 จาก nodejs.org และ git จาก git-scm.com (Windows ใช้ PowerShell, Mac/Linux ใช้ Terminal)'],
          ['ดาวน์โหลดโปรแกรมรันร่าง:', 'git clone https://github.com/pospos191-alt/swd-amm.git\ncd swd-amm/zetaphy-network\nnpm ci --omit=dev'],
          ['ตั้งค่าและดูที่อยู่ของเครื่อง (ครั้งแรกจะสร้างกุญแจที่ ~/.zetaphy/worker.key):', 'node cli.js node status --rpc https://RPC --jobs JOBS'],
          ['ส่ง ZETAPHY ไปที่อยู่ที่แสดง ให้พอค่ามัดจำ BOND (รับจาก Faucet หรือโอนจาก MetaMask)'],
          ['วางมัดจำ แล้วเริ่มรับงาน (เปิดหน้าต่างนี้ค้างไว้ กด Ctrl+C เพื่อหยุด):', 'node cli.js node register\nnode cli.js node start'],
          ['ดูรายได้ และถอนเข้ากระเป๋า:', 'node cli.js node status\nnode cli.js node withdraw'],
          ['เลิกรัน: ถอนมัดจำคืน (รอ 1 ชั่วโมง):', 'node cli.js node unbond\nnode cli.js node withdraw-bond'],
          ['สำคัญ: กุญแจนี้ใช้กับ testnet เท่านั้น ห้ามลบไฟล์ ~/.zetaphy/jobs-*.json ระหว่างมีงานค้าง (ถ้าเปิดคำตอบไม่ได้ จะถูกหักมัดจำ)']] },
      { id: 'validator', icon: 'server', title: 'เป็น Validator (เซิร์ฟเวอร์เปิดตลอด)', level: 'กลาง', need: 'เครื่องเซิร์ฟเวอร์ฟรี (Google Cloud e2-micro หรือ Oracle Always Free) Ubuntu 24.04', get: 'ส่วนแบ่งค่าธรรมเนียมของบล็อก (ครึ่งหนึ่งถูกเผา อีกครึ่งให้ validator) และรางวัลจากผู้ที่ stake ด้วย', time: '30–60 นาที',
        steps: [['สร้างเครื่อง Ubuntu 24.04 แล้ววางสคริปต์นี้ใน "Startup script" / "Cloud-init" ตอนสร้างเครื่อง:', '#!/bin/bash\nJOIN=HOST\ncurl -fsS "https://$JOIN/zetaphy/setup-node.sh" -o /root/zetaphy-setup-node.sh\nJOIN=$JOIN bash /root/zetaphy-setup-node.sh'],
          ['เปิดพอร์ต 26656 (ถ้าจะให้บริการ RPC เปิด 80 และ 443 ด้วย) ในหน้า Firewall ของผู้ให้บริการ'],
          ['เครื่องจะซิงก์บล็อกเองและขอ 10 ZETAPHY จาก faucet อัตโนมัติ พอซิงก์เสร็จ เข้าเครื่องผ่าน SSH ในหน้าเว็บของผู้ให้บริการ แล้วพิมพ์:', 'sudo bash /root/zetaphy-setup-node.sh --become-validator 9'],
          ['สำรองไฟล์ priv_validator_key.json และ pq_vote_key.seed ในโฟลเดอร์ config ไว้ในที่ปลอดภัย (ห้ามส่งให้ใคร)'],
          ['ข้อควรระวัง: ถ้าเซ็นบล็อกซ้ำ (รันกุญแจเดียวกันสองเครื่อง) stake จะถูกหัก']] },
      { id: 'stake', icon: 'stake', title: 'Stake ZETAPHY รับรางวัล', level: 'ง่าย', need: 'ZETAPHY + MetaMask', get: 'ส่วนแบ่งรางวัลของ validator ที่คุณ stake ด้วย', time: '2 นาที',
        steps: [['ไปที่แท็บ "Stake & โหวต" เลือก validator แล้วกด Stake'], ['รางวัลสะสมขึ้นทุกบล็อก กด "รับรางวัล" เมื่อไหร่ก็ได้'], ['ถอน stake ต้องรอช่วงปลดล็อกก่อนเหรียญกลับเข้ากระเป๋า']], tab: 'stake' },
      { id: 'lp', icon: 'swap', title: 'เพิ่มสภาพคล่องบน DEX', level: 'กลาง', need: 'เหรียญสองชนิด (เช่น ZETAPHY + tUSD)', get: 'ส่วนแบ่งค่าธรรมเนียมทุกครั้งที่มีคนแลกในพูลนั้น', time: '3 นาที',
        steps: [['ไปที่แท็บ "แลกเปลี่ยน" → "สภาพคล่อง" แล้วเลือกคู่เหรียญ'], ['ใส่จำนวนทั้งสองฝั่ง แล้วยืนยันใน MetaMask'], ['ราคาที่เปลี่ยนอาจทำให้ได้คืนน้อยกว่าที่วางไว้ (impermanent loss)']], tab: 'swap' },
    ],
    noPow: 'ทำไมไม่มีการขุดด้วยเครื่อง: การขุดแบบ PoW ใช้ไฟมากและเปิดให้คนมีเครื่องแรงคุมเชนได้ ZETAPHY จึงให้รางวัลกับงานที่มีประโยชน์ (ตรวจสัญญาด้วย Neuro) และการ stake แทน',
    warn: 'Testnet: เหรียญไม่มีมูลค่า ห้ามซื้อขายด้วยเงินจริง ระวังคนอ้างขาย ZETAPHY',
    bondLive: 'มัดจำตอนนี้', runners: 'คนรันร่างตอนนี้', pool: 'กองรางวัลงาน',
  },
  en: {
    intro: 'ZETAPHY has no proof-of-work mining. The chain uses staking: whoever helps the network earns ZETAPHY. Every way to get coins, easiest first:',
    need: 'You need', get: 'You get', time: 'Time',
    m: [
      { id: 'faucet', icon: 'drop', title: 'Faucet (free)', level: 'very easy', need: 'a wallet address', get: '10 test ZETAPHY, once a day', time: '1 minute',
        steps: [['On Overview, paste your 0x… or zetaphy1… address in step 2 and press "Get"'], ['Or from a terminal (replace 0xYOUR_ADDRESS):', 'curl -s https://RPC -H "content-type: application/json" \\\n  -d \'{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0xYOUR_ADDRESS"]}\''], ['Once a day per address; 200 grants a day across the network (UTC days)']] },
      { id: 'runner', icon: 'cpu', title: 'Run a Neuro runner from the terminal (ZETAPHY\'s "mining")', level: 'easy', need: 'any computer (CPU) + Node.js 20+ + git + a BOND bond', get: 'contract-check fees from NeuroJobs and rewards from the reward pool (10% a year)', time: '10 minutes, then leave it running',
        steps: [['Install Node.js 22 (nodejs.org) and git (git-scm.com). Windows: PowerShell; Mac/Linux: Terminal'],
          ['Get the runner:', 'git clone https://github.com/pospos191-alt/swd-amm.git\ncd swd-amm/zetaphy-network\nnpm ci --omit=dev'],
          ['Set it up and see this machine\'s address (the first run creates ~/.zetaphy/worker.key):', 'node cli.js node status --rpc https://RPC --jobs JOBS'],
          ['Send that address enough ZETAPHY for the BOND bond (faucet, or from MetaMask)'],
          ['Post the bond, then take jobs (keep the window open; Ctrl+C stops):', 'node cli.js node register\nnode cli.js node start'],
          ['Earnings, and moving them to the wallet:', 'node cli.js node status\nnode cli.js node withdraw'],
          ['Stop for good: get the bond back (1-hour wait):', 'node cli.js node unbond\nnode cli.js node withdraw-bond'],
          ['Important: this key is for the testnet only. Do not delete ~/.zetaphy/jobs-*.json while jobs are pending (an answer you cannot reveal costs the bond)']] },
      { id: 'validator', icon: 'server', title: 'Become a validator (a server that stays on)', level: 'medium', need: 'a free server (Google Cloud e2-micro or Oracle Always Free), Ubuntu 24.04', get: 'a share of block fees (half is burned, half goes to validators) and rewards from people who stake with you', time: '30–60 minutes',
        steps: [['Create an Ubuntu 24.04 machine and paste this as its startup script / cloud-init:', '#!/bin/bash\nJOIN=HOST\ncurl -fsS "https://$JOIN/zetaphy/setup-node.sh" -o /root/zetaphy-setup-node.sh\nJOIN=$JOIN bash /root/zetaphy-setup-node.sh'],
          ['Open port 26656 (and 80, 443 to serve RPC) in the provider\'s firewall'],
          ['The machine syncs and asks the faucet for 10 ZETAPHY by itself. Once synced, open SSH from the provider\'s web console and run:', 'sudo bash /root/zetaphy-setup-node.sh --become-validator 9'],
          ['Back up priv_validator_key.json and pq_vote_key.seed (config folder) somewhere safe; never share them'],
          ['Careful: signing twice (the same key on two machines) gets the stake slashed']] },
      { id: 'stake', icon: 'stake', title: 'Stake ZETAPHY for rewards', level: 'easy', need: 'ZETAPHY + MetaMask', get: 'a share of the rewards of the validator you stake with', time: '2 minutes',
        steps: [['Open "Stake & vote", pick a validator, press Stake'], ['Rewards grow every block; press "Claim rewards" any time'], ['Unstaked coins come back after the unbonding period']], tab: 'stake' },
      { id: 'lp', icon: 'swap', title: 'Provide liquidity on the DEX', level: 'medium', need: 'two tokens (e.g. ZETAPHY + tUSD)', get: 'a share of the fee on every swap in that pool', time: '3 minutes',
        steps: [['Open "Swap" → "Pool" and pick a pair'], ['Enter both amounts and confirm in MetaMask'], ['Price moves can return less than you put in (impermanent loss)']], tab: 'swap' },
    ],
    noPow: 'Why no machine mining: proof-of-work burns power and lets whoever has the biggest machines control the chain. ZETAPHY rewards useful work (Neuro contract checks) and staking instead.',
    warn: 'Testnet: the coins have no value. Never trade them for real money; beware of anyone selling ZETAPHY.',
    bondLive: 'Bond now', runners: 'Runners now', pool: 'Job reward pool',
  },
};
const EARN_ICONS = {
  drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  stake: '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  swap: '<path d="M7 7h12l-3-3"/><path d="M17 17H5l3 3"/>',
};
let earnSel = 'runner', bondText = 'BOND';
function earnFill(ctx, s) {
  const host = new URL(ctx.ep().evm).host;
  return s.replaceAll('https://RPC', ctx.ep().evm).replaceAll('JOBS', ctx.cfg.contracts?.neuroJobs ?? '0x…').replaceAll('HOST', host).replaceAll('BOND', bondText);
}
function earnDetail(ctx, root) {
  const L = EARN[ctx.lang];
  const m = L.m.find((x) => x.id === earnSel) ?? L.m[0];
  const box = root.querySelector('.earn-detail');
  box.replaceChildren(
    ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: earnFill(ctx, m.title) }), ctx.el('span', { class: 'pill', text: m.level })),
    ctx.el('dl', { class: 'kv3' },
      ctx.el('dt', { text: L.need }), ctx.el('dd', { text: earnFill(ctx, m.need) }),
      ctx.el('dt', { text: L.get }), ctx.el('dd', { text: m.get }),
      ctx.el('dt', { text: L.time }), ctx.el('dd', { text: m.time })),
    ctx.el('ol', { class: 'howto' }, m.steps.map(([text, cmd]) => ctx.el('li', {}, ctx.el('p', { text: earnFill(ctx, text) }), cmd ? code(ctx, earnFill(ctx, cmd)) : null))),
    ...(m.tab ? [ctx.el('button', { type: 'button', class: 'btn', text: ctx.lang === 'th' ? 'เปิดหน้านี้ →' : 'Open it →', onclick: () => ctx.show(m.tab) })] : []));
  root.querySelectorAll('.earn-item').forEach((n) => n.setAttribute('aria-selected', String(n.dataset.id === m.id)));
}
const earn = {
  render(root, ctx) {
    const L = EARN[ctx.lang];
    const svg = (k) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.innerHTML = EARN_ICONS[k]; return s; };
    root.replaceChildren(
      ctx.el('div', { class: 'stats three' }, tile(ctx, 'earnBond', 'tipEarnBond', 'e-bond'), tile(ctx, 'earnRunners', 'tipEarnRunners', 'e-runners'), tile(ctx, 'earnPool', 'tipEarnPool', 'e-pool')),
      ctx.el('div', { class: 'earn-grid' },
        ctx.el('div', { class: 'card earn-list' },
          ctx.el('p', { class: 'dim small', text: L.intro }),
          ctx.el('div', { class: 'list' }, L.m.map((m) => ctx.el('button', { type: 'button', class: 'earn-item', 'data-id': m.id, onclick: () => { earnSel = m.id; earnDetail(ctx, root); } },
            svg(m.icon), ctx.el('span', {}, ctx.el('b', { text: m.title }), ctx.el('small', { class: 'dim', text: m.get })), ctx.el('span', { class: 'pill', text: m.level })))),
          ctx.el('p', { class: 'note', 'data-tip': L.noPow, tabindex: 0, text: `⛏ ${ctx.lang === 'th' ? 'ทำไมไม่มีการขุด PoW?' : 'Why no PoW mining?'}` }),
          ctx.el('p', { class: 'warnline small', text: L.warn })),
        ctx.el('div', { class: 'card earn-detail scroll-y' })));
    earnDetail(ctx, root);
  },
  async refresh(root, ctx) {
    const jobs = ctx.cfg.contracts?.neuroJobs;
    if (!jobs) return;
    try {
      const [b, w, p] = await Promise.all([SEL.workerBond, SEL.activeWorkers, SEL.rewardPool].map((s) => call(ctx, jobs, s)));
      bondText = `${formatZeta(uintAt(b), 2)} ZETAPHY`;
      setText('e-bond', formatZeta(uintAt(b), 2)); setText('e-runners', uintAt(w).toString()); setText('e-pool', formatZeta(uintAt(p), 2));
      earnDetail(ctx, root);
    } catch { /* node unreachable: the steps still show */ }
  },
};

// ------------------------------------------------------------------ Analytics
const analytics = {
  render(root, ctx) {
    root.replaceChildren(
      ctx.el('div', { class: 'stats' }, tile(ctx, 'anSupply', 'tipAnSupply', 'a-supply'), tile(ctx, 'anAvgTime', 'tipBlockTime', 'a-time'),
        tile(ctx, 'anTxs', 'tipAnTxs', 'a-txs'), tile(ctx, 'anBondedPct', 'tipAnBondedPct', 'a-bonded')),
      ctx.el('div', { class: 'grid2' },
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anTxsChart') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnTxsChart', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-c1', class: 'chart-box' })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anTimeChart') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnTimeChart', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-c2', class: 'chart-box' })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anAlloc') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnAlloc', tabindex: 0, text: 'i' })),
          hbars(ctx, [[ctx.T('alRewards'), 50], [ctx.T('alSwd'), 20], [ctx.T('alCommunity'), 15], [ctx.T('alLiquidity'), 10], [ctx.T('alTeam'), 5]].map(([label, value]) => ({ label, value })), { fmt: (v) => `${v}%` })),
        ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('anPower') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipAnPower', tabindex: 0, text: 'i' })), ctx.el('div', { id: 'a-power' }))));
    sizeBars(root);
  },
  async refresh(root, ctx) {
    try {
      const st = await ctx.getJson(`${ctx.ep().comet}/status`);
      const h = Number(st.result.sync_info.latest_block_height);
      const pages = await Promise.all([0, 1, 2].map((k) => ctx.getJson(`${ctx.ep().comet}/blockchain?minHeight=${Math.max(1, h - 20 * k - 19)}&maxHeight=${h - 20 * k}`).catch(() => null)));
      const metas = pages.flatMap((p) => p?.result?.block_metas ?? []).sort((a, b) => Number(a.header.height) - Number(b.header.height));
      if (metas.length > 1) {
        const txs = metas.map((m) => Number(m.num_txs));
        const times = metas.slice(1).map((m, i) => (Date.parse(m.header.time) - Date.parse(metas[i].header.time)) / 1000);
        const span = (Date.parse(metas.at(-1).header.time) - Date.parse(metas[0].header.time)) / 60000 || 1;
        setText('a-time', `${(times.reduce((s, x) => s + x, 0) / times.length).toFixed(1)}s`);
        setText('a-txs', (txs.reduce((s, x) => s + x, 0) / span).toFixed(2));
        const hs = metas.map((m) => Number(m.header.height));
        document.getElementById('a-c1')?.replaceChildren(columns(ctx, txs, { label: (i) => `#${hs[i]}`, fmt: (v) => String(Math.round(v)) }));
        document.getElementById('a-c2')?.replaceChildren(columns(ctx, times, { label: (i) => `#${hs[i + 1]}`, fmt: (v) => `${v.toFixed(1)}s` }));
      }
      const [sup, pool, vals] = await Promise.all([
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/pool`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200`)]);
      const supply = BigInt(sup.amount.amount), bonded = BigInt(pool.pool.bonded_tokens);
      setText('a-supply', formatZeta(supply, 0));
      setText('a-bonded', `${(Number((bonded * 10000n) / (supply || 1n)) / 100).toFixed(2)}%`);
      const total = vals.validators.reduce((s, v) => s + BigInt(v.tokens), 0n) || 1n;
      const rows = vals.validators.map((v) => ({ label: v.description?.moniker || ctx.short(v.operator_address), value: Number((BigInt(v.tokens) * 10000n) / total) / 100 }))
        .sort((a, b) => b.value - a.value).slice(0, 10);
      const box = document.getElementById('a-power');
      if (box) { box.replaceChildren(hbars(ctx, rows, { fmt: (v) => `${v.toFixed(2)}%` })); sizeBars(box); }
    } catch { /* keep the last numbers */ }
  },
};

// ------------------------------------------------------------------ DeFi
const defi = {
  render(root, ctx) {
    root.replaceChildren(
      ctx.el('div', { class: 'stats three' }, tile(ctx, 'dfPools', 'tipDfPools', 'd-pools'), tile(ctx, 'dfDlmm', 'tipDfDlmm', 'd-dlmm'), tile(ctx, 'dfJobs', 'tipDfJobs', 'd-jobs')),
      ctx.el('div', { class: 'card grow' },
        ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('dfPoolList') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipDfPoolList', tabindex: 0, text: 'i' })),
        ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' },
          ctx.el('thead', {}, ctx.el('tr', {}, ['#', ctx.T('dfPair'), ctx.T('dfReserves'), ctx.T('dfPrice'), ''].map((t) => ctx.el('th', { text: t })))),
          ctx.el('tbody', { id: 'd-rows' }, ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: '…' })))))),
      ctx.el('div', { class: 'grid3' }, ['swap', 'nft', 'neuro'].map((t) => ctx.el('button', { type: 'button', class: 'card app-card', onclick: () => ctx.show(t), 'data-tip-key': `tipApp_${t}` },
        ctx.el('b', { text: ctx.T(`app_${t}`) }), ctx.el('span', { class: 'dim small', text: ctx.T(`appSub_${t}`) })))));
  },
  async refresh(root, ctx) {
    const d = ctx.cfg.dex;
    if (!d?.factory) return;
    try {
      const n = Number(uintAt(await call(ctx, d.factory, SEL.allPairsLength)));
      setText('d-pools', String(n));
      if (d.dlmmFactory) call(ctx, d.dlmmFactory, SEL.allPairsLength).then((x) => setText('d-dlmm', uintAt(x).toString())).catch(() => {});
      if (ctx.cfg.contracts?.neuroJobs) call(ctx, ctx.cfg.contracts.neuroJobs, SEL.jobCount).then((x) => setText('d-jobs', uintAt(x).toString())).catch(() => {});
      const sym = new Map(), dec = new Map();
      const token = async (a) => {
        if (!sym.has(a)) {
          const [s, de] = await Promise.all([call(ctx, a, SEL.symbol).catch(() => '0x'), call(ctx, a, SEL.decimals).catch(() => '0x12')]);
          sym.set(a, decodeString(s)); dec.set(a, Number(uintAt(de)) || 18);
        }
        return { symbol: sym.get(a), decimals: dec.get(a) };
      };
      const rows = [];
      for (let i = 0; i < Math.min(n, 30); i++) {
        const pair = addrAt(await call(ctx, d.factory, SEL.allPairs + word(i)));
        const [t0, t1, r] = await Promise.all([call(ctx, pair, SEL.token0), call(ctx, pair, SEL.token1), call(ctx, pair, SEL.getReserves)]);
        const [a, b] = await Promise.all([token(addrAt(t0)), token(addrAt(t1))]);
        const r0 = uintAt(r, 0), r1 = uintAt(r, 1);
        const fmt = (v, dp) => formatZeta(v * 10n ** BigInt(18 - Math.min(18, dp)), 2);
        const price = r0 > 0n ? Number((r1 * 10n ** BigInt(a.decimals) * 1000000n) / (r0 * 10n ** BigInt(b.decimals))) / 1e6 : 0;
        rows.push(ctx.el('tr', {},
          ctx.el('td', { class: 'dim', text: String(i + 1) }),
          ctx.el('td', { 'data-tip': pair }, ctx.el('b', { text: `${a.symbol} / ${b.symbol}` })),
          ctx.el('td', { class: 'num', text: `${fmt(r0, a.decimals)} ${a.symbol} · ${fmt(r1, b.decimals)} ${b.symbol}` }),
          ctx.el('td', { class: 'num', text: price ? `1 ${a.symbol} = ${price.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${b.symbol}` : '–' }),
          ctx.el('td', {}, ctx.el('button', { type: 'button', class: 'btn ghost sm', text: ctx.T('dfTrade'), onclick: () => ctx.show('swap') }))));
      }
      document.getElementById('d-rows')?.replaceChildren(...(rows.length ? rows : [ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: ctx.T('dfNone') }))]));
    } catch (e) { document.getElementById('d-rows')?.replaceChildren(ctx.el('tr', {}, ctx.el('td', { colspan: 5, class: 'dim', text: e.message }))); }
  },
};

// ------------------------------------------------------------------ Leaderboard
const leaderboard = {
  render(root, ctx) {
    const table = (id, heads) => ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' },
      ctx.el('thead', {}, ctx.el('tr', {}, heads.map((t) => ctx.el('th', { text: t })))), ctx.el('tbody', { id }, ctx.el('tr', {}, ctx.el('td', { colspan: heads.length, class: 'dim', text: '…' })))));
    root.replaceChildren(ctx.el('div', { class: 'grid2 tall' },
      ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('lbHolders') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipLbHolders', tabindex: 0, text: 'i' })),
        table('l-holders', ['#', ctx.T('lbAccount'), ctx.T('lbBalance'), '%'])),
      ctx.el('div', { class: 'card' }, ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('lbValidators') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipLbValidators', tabindex: 0, text: 'i' })),
        table('l-vals', ['#', ctx.T('colName'), ctx.T('lbStake'), ctx.T('colCommission')]))));
  },
  async refresh(root, ctx) {
    try {
      const [own, sup, mods] = await Promise.all([
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/denom_owners/azetaphy?pagination.limit=1000`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy`),
        ctx.getJson(`${ctx.ep().rest}/cosmos/auth/v1beta1/module_accounts`).catch(() => ({ accounts: [] }))]);
      const names = new Map((mods.accounts ?? []).map((a) => [a.base_account?.address ?? a.address, a.name]));
      const supply = BigInt(sup.amount.amount) || 1n;
      const top = own.denom_owners.map((o) => ({ a: o.address, v: BigInt(o.balance.amount) })).sort((x, y) => (y.v > x.v ? 1 : -1)).slice(0, 25);
      document.getElementById('l-holders')?.replaceChildren(...top.map((o, i) => ctx.el('tr', { class: 'link', onclick: () => { let hex; try { hex = toEvm(o.a); } catch { return; } ctx.show('explorer', { hash: `#/address/${hex}` }); } },
        ctx.el('td', { class: 'dim', text: String(i + 1) }),
        ctx.el('td', { 'data-tip': o.a }, names.has(o.a) ? ctx.el('span', { class: 'pill', text: names.get(o.a) }) : null, ` ${ctx.short(o.a, 12, 6)}`),
        ctx.el('td', { class: 'num', text: formatZeta(o.v, 0) }),
        ctx.el('td', { class: 'num', text: (Number((o.v * 10000n) / supply) / 100).toFixed(2) }))));
    } catch (e) { document.getElementById('l-holders')?.replaceChildren(ctx.el('tr', {}, ctx.el('td', { colspan: 4, class: 'dim', text: e.message }))); }
    try {
      const vals = await ctx.getJson(`${ctx.ep().rest}/cosmos/staking/v1beta1/validators?pagination.limit=200`);
      const list = vals.validators.sort((a, b) => (BigInt(b.tokens) > BigInt(a.tokens) ? 1 : -1));
      document.getElementById('l-vals')?.replaceChildren(...list.map((v, i) => ctx.el('tr', {},
        ctx.el('td', { class: 'dim', text: String(i + 1) }),
        ctx.el('td', { 'data-tip': v.operator_address }, ctx.el('b', { text: v.description?.moniker || ctx.short(v.operator_address) }),
          v.status !== 'BOND_STATUS_BONDED' ? ctx.el('span', { class: 'pill', text: v.jailed ? ctx.T('jailed') : 'inactive' }) : null),
        ctx.el('td', { class: 'num', text: formatZeta(v.tokens, 0) }),
        ctx.el('td', { class: 'num', text: `${(Number(v.commission?.commission_rates?.rate ?? 0) * 100).toFixed(1)}%` }))));
    } catch { /* keep */ }
  },
};

// ------------------------------------------------------------------ Developers
const dev = {
  render(root, ctx) {
    const e = ctx.ep();
    const c = ctx.cfg.contracts ?? {}, d = ctx.cfg.dex ?? {}, n = ctx.cfg.nft ?? {};
    const rows = [['NeuroJobs', c.neuroJobs], ['NeuroControl', c.neuroControl], ['ThreatRegistry', c.threatRegistry], ['RewardVault', c.rewardVault],
      ['StableGateway', c.stableGateway], ['ZetaphyOracle', c.oracle], ['DEX factory', d.factory], ['DEX router', d.router], ['DLMM factory', d.dlmmFactory],
      ['NFT marketplace', n.marketplace], ['Staking precompile', '0x0000000000000000000000000000000000000800'], ['Distribution precompile', '0x0000000000000000000000000000000000000801'],
      ['Gov precompile', '0x0000000000000000000000000000000000000805'], ['ML-DSA verify precompile', '0x0000000000000000000000000000000000000900']].filter(([, a]) => a);
    root.replaceChildren(ctx.el('div', { class: 'grid2 tall' },
      ctx.el('div', { class: 'card scroll-y' },
        ctx.el('h2', { text: ctx.T('devApi') }),
        ctx.el('p', { class: 'dim small', text: ctx.T('devApiSub') }),
        ...[['EVM JSON-RPC', `curl -s ${e.evm} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`],
          ['WebSocket (eth_subscribe)', `npx wscat -c ${e.ws}\n> {"jsonrpc":"2.0","id":1,"method":"eth_subscribe","params":["newHeads"]}`],
          ['CometBFT RPC', `curl -s ${e.comet}/status`],
          ['Cosmos REST', `curl -s "${e.rest}/cosmos/bank/v1beta1/supply/by_denom?denom=azetaphy"`],
          [ctx.T('devFaucet'), `curl -s ${e.evm} -H "content-type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"zetaphy_faucet","params":["0xYOUR_ADDRESS"]}'`],
          [ctx.T('devRegistry'), `curl -s ${e.files}/keplr.json\ncurl -s ${e.files}/evm-chain.json`],
          [ctx.T('devCli'), 'git clone https://github.com/pospos191-alt/swd-amm.git\ncd swd-amm/zetaphy-network && npm ci --omit=dev\nnode cli.js --help']]
          .flatMap(([t, cmd]) => [ctx.el('h3', { text: t }), code(ctx, cmd)]),
        ctx.el('p', { class: 'small' }, ctx.el('a', { href: 'https://github.com/pospos191-alt/swd-amm', target: '_blank', rel: 'noopener noreferrer', text: 'GitHub ↗' }))),
      ctx.el('div', { class: 'card' },
        ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: ctx.T('devContracts') }), ctx.el('span', { class: 'info', 'data-tip-key': 'tipDevContracts', tabindex: 0, text: 'i' })),
        ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' }, ctx.el('tbody', {}, rows.map(([k, a]) => ctx.el('tr', {},
          ctx.el('td', { text: k }), ctx.el('td', { class: 'num' }, ctx.el('a', { href: '#', 'data-tip': a, text: ctx.short(a, 10, 6), onclick: (ev) => { ev.preventDefault(); ctx.show('explorer', { hash: `#/address/${a}` }); } })),
          ctx.el('td', {}, ctx.copyBtn(a))))))))));
  },
};


// ------------------------------------------------------------------ ZETAPHY Saphan (IBC, chain to chain)
// Routes are the open ICS-20 channels the chain reports (no config to keep in
// sync); a transfer goes out through the ICS-20 precompile (0x…0802) from
// MetaMask. Coming in, the other chain's wallet sends to this account's zetaphy1….
export const KNOWN_CHAINS = {
  'grand-1': { name: 'Noble testnet', prefix: 'noble', note: 'USDC (Circle)' },
  'noble-1': { name: 'Noble', prefix: 'noble', note: 'USDC (Circle)' },
  'osmo-test-5': { name: 'Osmosis testnet', prefix: 'osmo', note: 'DEX' },
  'osmosis-1': { name: 'Osmosis', prefix: 'osmo', note: 'DEX' },
  'cosmoshub-4': { name: 'Cosmos Hub', prefix: 'cosmos', note: 'ATOM' },
  'theta-testnet-001': { name: 'Cosmos Hub testnet', prefix: 'cosmos', note: 'ATOM' },
};
const SAPHAN = {
  th: {
    intro: 'ZETAPHY Saphan (สะพาน) ส่งเหรียญข้ามเชนด้วย IBC: ทั้งสองเชนตรวจกันเองด้วย light client ไม่มีคนกลางถือเงิน',
    routes: 'เส้นทาง', tipRoutes: 'ช่อง IBC (transfer) ที่เปิดอยู่บนเชน ZETAPHY ตอนนี้ อ่านจากเชนโดยตรง\nช่องฝั่งเรา → ช่องฝั่งเขา',
    none: 'ยังไม่มีเส้นทางเปิด: ผู้ดูแลโหนดต้องติดตั้ง relayer และเปิดช่อง IBC ก่อน (zetaphy-chain/ibc/README.th.md)',
    send: 'ส่งออกจาก ZETAPHY', tipSend: 'ส่งจาก MetaMask ผ่าน precompile ICS-20 (0x…0802)\nเหรียญถึงปลายทางในราว 1 นาที (relayer ส่งต่อ)\nถ้าไม่ถึงภายใน 10 นาที ธุรกรรมหมดเวลาและเหรียญคืนเข้ากระเป๋าคุณเอง',
    route: 'ไปเชน', asset: 'เหรียญ', amount: 'จำนวน', to: 'ที่อยู่ปลายทาง', go: 'ส่งข้ามเชน', connect: 'เชื่อมต่อ MetaMask',
    recv: 'รับเข้า ZETAPHY', tipRecv: 'จากกระเป๋าบนเชนต้นทาง (เช่น Keplr) เลือก IBC transfer ใส่ช่องฝั่งเขา และที่อยู่ zetaphy1… ของคุณ',
    recvHow: (ch, name) => `บน ${name} ส่งแบบ IBC transfer ผ่านช่อง ${ch} มาที่ที่อยู่นี้:`,
    myAddr: 'ที่อยู่ของคุณบน ZETAPHY', bal: 'ยอดคงเหลือ', limits: 'กันความเสียหาย: เชนมีเพดานโอนต่อวัน (rate limit) และพักรายการใหญ่ไว้ตรวจก่อน (IBC hold) รายการที่เกินจะถูกปฏิเสธหรือคืนเงิน',
    sent: 'ส่งแล้ว รอ relayer ส่งต่อ (ราว 1 นาที)', badTo: (p) => `ที่อยู่ปลายทางต้องขึ้นต้นด้วย ${p}1…`, noRoute: 'ยังไม่มีเส้นทาง',
  },
  en: {
    intro: 'ZETAPHY Saphan ("bridge" in Thai) moves coins chain to chain over IBC: each chain checks the other with a light client, no custodian holds the funds',
    routes: 'Routes', tipRoutes: 'The open IBC transfer channels on ZETAPHY right now, read from the chain\nour channel → their channel',
    none: 'No route is open yet: the node operator installs the relayer and opens an IBC channel first (zetaphy-chain/ibc/README.md)',
    send: 'Send out of ZETAPHY', tipSend: 'Sent from MetaMask through the ICS-20 precompile (0x…0802)\nArrives in about a minute (the relayer carries it)\nIf it does not arrive within 10 minutes it times out and the coins return to you',
    route: 'To chain', asset: 'Coin', amount: 'Amount', to: 'Receiver address', go: 'Send across', connect: 'Connect MetaMask',
    recv: 'Receive into ZETAPHY', tipRecv: 'From a wallet on the other chain (e.g. Keplr), choose IBC transfer, their channel, and your zetaphy1… address',
    recvHow: (ch, name) => `On ${name}, send an IBC transfer over ${ch} to this address:`,
    myAddr: 'Your ZETAPHY address', bal: 'Balance', limits: 'Damage limits: the chain caps daily flow (rate limit) and holds large transfers for review (IBC hold); a transfer over them is refused or refunded',
    sent: 'Sent; the relayer carries it (about a minute)', badTo: (p) => `The receiver must start with ${p}1…`, noRoute: 'No route yet',
  },
};
let routes = [], assets = [];
/** azetaphy, or an ibc/… voucher with its base denom: decimals from the base (u = 6, a = 18). */
export function assetOf(denom, base) {
  if (denom === 'azetaphy') return { denom, symbol: 'ZETAPHY', dec: 18 };
  const b = String(base || denom);
  const dec = /^u[a-z]/.test(b) ? 6 : /^a[a-z]/.test(b) ? 18 : 0;
  const symbol = (dec ? b.slice(1) : b).split('/').pop().toUpperCase().slice(0, 12) || denom.slice(0, 12);
  return { denom, symbol, dec };
}
async function loadRoutes(ctx) {
  const r = await ctx.getJson(`${ctx.ep().rest}/ibc/core/channel/v1/channels?pagination.limit=100`);
  const open = (r.channels ?? []).filter((c) => c.port_id === 'transfer' && c.state === 'STATE_OPEN');
  return Promise.all(open.map(async (c) => {
    let chainId = '';
    try {
      const cs = await ctx.getJson(`${ctx.ep().rest}/ibc/core/channel/v1/channels/${c.channel_id}/ports/transfer/client_state`);
      chainId = cs.identified_client_state?.client_state?.chain_id ?? '';
    } catch { /* unknown chain */ }
    const k = KNOWN_CHAINS[chainId] ?? {};
    return { channel: c.channel_id, their: c.counterparty?.channel_id ?? '?', chainId, name: k.name ?? (chainId || '?'), prefix: k.prefix ?? null, note: k.note ?? '' };
  }));
}
async function loadAssets(ctx, bech) {
  const out = [assetOf('azetaphy')];
  if (!bech) return out.map((a) => ({ ...a, amount: null }));
  const r = await ctx.getJson(`${ctx.ep().rest}/cosmos/bank/v1beta1/balances/${bech}?pagination.limit=100`);
  const bal = new Map((r.balances ?? []).map((b) => [b.denom, b.amount]));
  for (const d of bal.keys()) {
    if (!/^ibc\/[0-9A-F]{64}$/.test(d)) continue;
    let base = '';
    try { base = (await ctx.getJson(`${ctx.ep().rest}/ibc/apps/transfer/v1/denoms/${d.slice(4)}`)).denom?.base ?? ''; } catch { /* unknown */ }
    out.push(assetOf(d, base));
  }
  return out.map((a) => ({ ...a, amount: bal.get(a.denom) ?? '0' }));
}
function saphanForm(ctx, root) {
  const L = SAPHAN[ctx.lang];
  const acct = ctx.account();
  const sel = (id, opts) => ctx.el('select', { id, class: 'mono' }, opts.map(([v, t]) => ctx.el('option', { value: v, text: t })));
  const box = root.querySelector('#sp-send');
  if (!routes.length) { box.replaceChildren(ctx.el('p', { class: 'dim', text: L.none })); return; }
  const form = ctx.el('form', { class: 'sp-form', autocomplete: 'off' },
    ctx.el('label', { text: L.route }), sel('sp-route', routes.map((r) => [r.channel, `${r.name} · ${r.channel}`])),
    ctx.el('label', { text: L.asset }), sel('sp-asset', assets.map((a) => [a.denom, `${a.symbol}${a.amount != null ? ` · ${formatUnits(a.amount, a.dec, 4)}` : ''}`])),
    ctx.el('label', { text: L.amount }), ctx.el('input', { id: 'sp-amount', class: 'mono', inputmode: 'decimal', placeholder: '0.0' }),
    ctx.el('label', { text: L.to }), ctx.el('input', { id: 'sp-to', class: 'mono', spellcheck: 'false', placeholder: `${routes[0].prefix ?? 'addr'}1…` }),
    ctx.el('div', { class: 'row end' }, ctx.el('button', { type: 'submit', class: 'btn', id: 'sp-go', text: acct ? L.go : L.connect })),
    ctx.el('p', { class: 'msg', id: 'sp-msg', role: 'status' }));
  form.querySelector('#sp-route').addEventListener('change', (e) => {
    const r = routes.find((x) => x.channel === e.target.value);
    form.querySelector('#sp-to').placeholder = `${r?.prefix ?? 'addr'}1…`;
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = form.querySelector('#sp-msg');
    const say = (t, cls = '') => { out.textContent = t; out.className = `msg ${cls}`; };
    try {
      if (!ctx.account()) { await ctx.connect(); saphan.refresh(root, ctx); return; }
      const r = routes.find((x) => x.channel === form.querySelector('#sp-route').value);
      const a = assets.find((x) => x.denom === form.querySelector('#sp-asset').value);
      const to = form.querySelector('#sp-to').value.trim();
      const { hrp } = bech32Decode(to);
      if (r.prefix && hrp !== r.prefix) throw new Error(L.badTo(r.prefix));
      const amount = parseUnits(form.querySelector('#sp-amount').value, a.dec);
      if (a.amount != null && amount > BigInt(a.amount)) throw new Error(ctx.lang === 'th' ? 'ยอดไม่พอ' : 'Not enough balance');
      const data = encodeIbcTransfer({ channel: r.channel, denom: a.denom, amount, sender: ctx.account(), receiver: to,
        timeoutNs: BigInt(Date.now() + 10 * 60_000) * 1_000_000n, memo: 'ZETAPHY Saphan' });
      say('…');
      const hash = await ctx.send(PRECOMPILES.ics20, data);
      say(`${L.sent} · ${ctx.short(hash, 10, 6)}`, 'ok');
      saphan.refresh(root, ctx);
    } catch (err) { say(err?.message ?? String(err), 'bad'); }
  });
  box.replaceChildren(form);
}
const saphan = {
  render(root, ctx) {
    const L = SAPHAN[ctx.lang];
    const head = (t, tip) => ctx.el('div', { class: 'card-head' }, ctx.el('h2', { text: t }), ctx.el('span', { class: 'info', 'data-tip': tip, tabindex: 0, text: 'i' }));
    root.replaceChildren(
      ctx.el('p', { class: 'dim small sp-intro', text: L.intro }),
      ctx.el('div', { class: 'grid3 sp-grid' },
        ctx.el('div', { class: 'card' }, head(L.routes, L.tipRoutes), ctx.el('div', { class: 'scroll' }, ctx.el('table', { class: 'tbl' }, ctx.el('tbody', { id: 'sp-routes' }, ctx.el('tr', {}, ctx.el('td', { class: 'dim', text: '…' })))))),
        ctx.el('div', { class: 'card' }, head(L.send, L.tipSend), ctx.el('div', { id: 'sp-send' }, ctx.el('p', { class: 'dim', text: '…' }))),
        ctx.el('div', { class: 'card' }, head(L.recv, L.tipRecv), ctx.el('div', { id: 'sp-recv', class: 'small' }))),
      ctx.el('p', { class: 'warnline small', text: L.limits }));
  },
  async refresh(root, ctx) {
    const L = SAPHAN[ctx.lang];
    const acct = ctx.account();
    const bech = acct ? toBech32(acct) : null;
    try { routes = await loadRoutes(ctx); } catch { routes = []; }
    try { assets = await loadAssets(ctx, bech); } catch { assets = [{ ...assetOf('azetaphy'), amount: null }]; }
    root.querySelector('#sp-routes')?.replaceChildren(...(routes.length ? routes.map((r) => ctx.el('tr', {},
      ctx.el('td', { 'data-tip': `${r.chainId}${r.note ? ` · ${r.note}` : ''}` }, ctx.el('b', { text: r.name }),
        ctx.el('div', { class: 'dim small mono', text: `${r.channel} → ${r.their}` })),
      ctx.el('td', { class: 'num' }, ctx.el('span', { class: 'pill passed', text: 'open' }))))
      : [ctx.el('tr', {}, ctx.el('td', { class: 'dim', text: L.noRoute }))]));
    if (!root.querySelector('#sp-amount')?.value) saphanForm(ctx, root);
    const recv = root.querySelector('#sp-recv');
    if (recv) {
      recv.replaceChildren(
        ...(bech ? [ctx.el('p', { class: 'dim', text: L.myAddr }), ctx.el('div', { class: 'code' }, ctx.el('pre', { class: 'mono', text: bech }), ctx.copyBtn(bech))]
          : [ctx.el('p', { class: 'dim', text: L.connect })]),
        ...routes.map((r) => ctx.el('p', { text: L.recvHow(r.their, r.name) })),
        ...(acct ? [ctx.el('h3', { text: L.bal }), ctx.el('dl', { class: 'kv3' }, assets.flatMap((a) => [ctx.el('dt', { text: a.symbol, 'data-tip': a.denom }), ctx.el('dd', { class: 'mono', text: formatUnits(a.amount ?? '0', a.dec, 6) })]))] : []));
    }
  },
};

export const PAGES = { earn, saphan, analytics, defi, leaderboard, dev };
