// Usage stats page: users this month vs the plan's 1,000-users gate.
const $ = (id) => document.getElementById(id);
const UI = {
  th: { subtitle: 'ผู้ใช้ต่อเดือน เทียบกับเป้าก่อนเริ่มขั้น 2', usersLabel: 'ผู้ใช้เดือนนี้ (โดยประมาณ)', goal: 'เป้า',
    checks: 'จำนวนครั้งที่ตรวจสัญญา', last: 'ผู้ใช้เดือนก่อน', privacy: 'นับแบบไม่เก็บ IP หรือข้อมูลส่วนตัว ตัวเลขเป็นค่าประมาณ',
    back: 'กลับไปหน้าตรวจสัญญา', off: 'ตัวนับยังไม่เปิด: ต้องเพิ่ม Redis (Upstash) และ USAGE_SALT ในโปรเจกต์ Vercel',
    error: 'โหลดสถิติไม่สำเร็จ', month: 'เดือน', locale: 'th-TH' },
  en: { subtitle: 'Monthly users vs the goal before step 2', usersLabel: 'Users this month (approx.)', goal: 'Goal',
    checks: 'Contract checks', last: 'Users last month', privacy: 'Counted without storing IPs or personal data. Numbers are approximate.',
    back: 'Back to contract checker', off: 'Counter is off: add Redis (Upstash) and USAGE_SALT to the Vercel project',
    error: 'Could not load stats', month: 'Month', locale: 'en-US' },
};
let lang = 'th';
try { lang = localStorage.getItem('neuro-lang') === 'en' ? 'en' : 'th'; } catch { /* storage blocked */ }
let data = null;

const prevMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`;
};

function render() {
  const t = UI[lang];
  document.documentElement.lang = lang;
  $('lang').textContent = lang === 'th' ? 'EN' : 'ไทย';
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t[el.dataset.i18n];
  if (!data) return;
  const n = new Intl.NumberFormat(t.locale);
  const { cur, prev } = data;
  $('monthLabel').textContent = `${t.month} ${cur.month}`;
  $('goal').textContent = n.format(cur.goal);
  if (!cur.enabled) { $('status').textContent = t.off; return; }
  const pct = Math.min(100, Math.round((cur.users / cur.goal) * 100));
  $('users').textContent = n.format(cur.users);
  $('checks').textContent = n.format(cur.checks);
  $('prev').textContent = prev?.enabled ? n.format(prev.users) : '–';
  $('pct').textContent = `${pct}%`;
  $('bar').style.width = `${pct}%`;
  $('meter').setAttribute('aria-valuenow', String(pct));
}

async function load() {
  try {
    const cur = await (await fetch('/api/usage')).json();
    const prev = cur.enabled ? await (await fetch(`/api/usage?month=${prevMonth(cur.month)}`)).json() : null;
    data = { cur, prev };
  } catch {
    $('status').textContent = UI[lang].error;
  }
  render();
}

$('lang').addEventListener('click', () => {
  lang = lang === 'th' ? 'en' : 'th';
  try { localStorage.setItem('neuro-lang', lang); } catch { /* storage blocked */ }
  render();
});
render();
load();
