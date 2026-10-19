// Web page for Neuro ZETAPHY tier 1. Everything shown from the chain goes
// through textContent, never innerHTML: token names are written by strangers.
import { readContract, isAddress } from '../src/reader.js';
import { explain } from '../src/explain.js';
import { CHAINS } from '../src/chains.js';

const $ = (id) => document.getElementById(id);
const UI = {
  th: { subtitle: 'อ่านและอธิบายสัญญา · ชั้น 1 อ่านอย่างเดียว', chain: 'เชน', address: 'ที่อยู่สัญญา', check: 'ตรวจสัญญา',
    details: 'รายละเอียด', reading: 'กำลังอ่านสัญญาจากเชน…', badAddress: 'ที่อยู่ไม่ถูกต้อง ต้องขึ้นต้นด้วย 0x และยาว 42 ตัวอักษร',
    failed: 'อ่านไม่สำเร็จ: ', footer: 'ไม่ขอเชื่อมกระเป๋า ไม่ส่งธุรกรรม อ่านข้อมูลจากเชนผ่าน RPC สาธารณะเท่านั้น ผลตรวจไม่ใช่คำแนะนำการลงทุน',
    m: { chain: 'เชน', address: 'ที่อยู่', proxy: 'Proxy', implementation: 'โค้ดหลัก', owner: 'เจ้าของ', functions: 'ฟังก์ชันที่รู้จัก', report: 'รหัสรายงาน', explorer: 'ดูบน explorer' } },
  en: { subtitle: 'Reads and explains contracts · tier 1, read-only', chain: 'Chain', address: 'Contract address', check: 'Check contract',
    details: 'Details', reading: 'Reading the contract from the chain…', badAddress: 'Invalid address: it must start with 0x and be 42 characters long',
    failed: 'Could not read: ', footer: 'Never asks to connect a wallet and never sends a transaction. Reads public chain data only. Not investment advice.',
    m: { chain: 'Chain', address: 'Address', proxy: 'Proxy', implementation: 'Implementation', owner: 'Owner', functions: 'Known functions', report: 'Report ID', explorer: 'Open in explorer' } },
};

let lang = 'th';
let last = null;
try { lang = localStorage.getItem('neuro-lang') === 'en' ? 'en' : 'th'; } catch { /* storage blocked */ }

for (const [key, c] of Object.entries(CHAINS)) $('chain').add(new Option(c.name, key));

function applyLang() {
  document.documentElement.lang = lang;
  $('lang').textContent = lang === 'th' ? 'EN' : 'ไทย';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = UI[lang][el.dataset.i18n];
  if (last) render(last);
}

function status(text, isError = false) {
  $('status').textContent = text;
  $('status').className = isError ? 'error' : '';
}

function render(report) {
  const out = explain(report, lang);
  const m = UI[lang].m;
  $('verdict').className = `verdict ${out.level}`;
  $('title').textContent = out.title;
  const list = $('findings');
  list.replaceChildren(...out.lines.map((l) => {
    const li = document.createElement('li');
    li.className = l.severity;
    li.textContent = l.text;
    return li;
  }));
  const rows = [[m.chain, CHAINS[report.chain].name], [m.address, report.address]];
  if (report.proxy?.kind) rows.push([m.proxy, report.proxy.kind]);
  if (report.proxy?.implementation) rows.push([m.implementation, report.proxy.implementation]);
  if (report.owner) rows.push([m.owner, report.owner]);
  if (report.functions) rows.push([m.functions, String(report.functions.length)]);
  rows.push([m.report, report.reportHash]);
  const dl = $('meta');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
  const dt = document.createElement('dt'); dt.textContent = m.explorer;
  const dd = document.createElement('dd');
  const a = document.createElement('a');
  a.href = CHAINS[report.chain].explorer + report.address; // address already validated
  a.target = '_blank'; a.rel = 'noopener noreferrer';
  a.textContent = new URL(a.href).hostname;
  dd.append(a); dl.append(dt, dd);
  $('result').hidden = false;
}

async function run(chain, address) {
  if (!isAddress(address)) { status(UI[lang].badAddress, true); return; }
  $('go').disabled = true;
  $('result').hidden = true;
  status(UI[lang].reading);
  try {
    last = await readContract(chain, address);
    render(last);
    status('');
    const u = new URL(location.href);
    u.searchParams.set('chain', chain); u.searchParams.set('address', address);
    history.replaceState(null, '', u);
  } catch (e) {
    status(UI[lang].failed + e.message, true);
  } finally {
    $('go').disabled = false;
  }
}

$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  run($('chain').value, $('address').value.trim());
});
$('lang').addEventListener('click', () => {
  lang = lang === 'th' ? 'en' : 'th';
  try { localStorage.setItem('neuro-lang', lang); } catch { /* storage blocked */ }
  applyLang();
});

applyLang();
// Shareable links: ?chain=bsc&address=0x…
const q = new URLSearchParams(location.search);
if (q.get('chain') in CHAINS) $('chain').value = q.get('chain');
if (q.get('address')) { $('address').value = q.get('address'); run($('chain').value, q.get('address').trim()); }
