// count.html: turns visitor counting off (or back on) for this browser on this device. Stored only here.
const T = {
  en: { title: 'Visitor count', lede: 'The site counts visits (no cookies, no IP address stored). Owners and testers can leave their own devices out so the numbers show real visitors only.', on: 'This device is counted.', off: 'This device is NOT counted.', stop: "Don't count this device", start: 'Count this device again', note: 'Applies to this browser only. Do it once on each phone and computer you use.', back: 'Back to ZETAPHY' },
  zh: { title: '访客统计', lede: '本站统计访问量（不使用 Cookie，不保存 IP 地址）。站长和测试者可以排除自己的设备，让数字只显示真实访客。', on: '此设备会被统计。', off: '此设备不会被统计。', stop: '不统计此设备', start: '重新统计此设备', note: '只对当前浏览器有效。请在你使用的每台手机和电脑上各设置一次。', back: '返回 ZETAPHY' },
  es: { title: 'Contador de visitas', lede: 'El sitio cuenta las visitas (sin cookies, sin guardar la dirección IP). Los dueños y probadores pueden excluir sus propios dispositivos para que las cifras muestren solo visitantes reales.', on: 'Este dispositivo se cuenta.', off: 'Este dispositivo NO se cuenta.', stop: 'No contar este dispositivo', start: 'Volver a contar este dispositivo', note: 'Solo para este navegador. Hazlo una vez en cada teléfono y ordenador que uses.', back: 'Volver a ZETAPHY' },
  ko: { title: '방문자 수', lede: '이 사이트는 방문 수를 셉니다 (쿠키 없음, IP 주소 저장 안 함). 운영자와 테스터는 자신의 기기를 제외해 실제 방문자만 집계되게 할 수 있습니다.', on: '이 기기는 집계됩니다.', off: '이 기기는 집계되지 않습니다.', stop: '이 기기 집계 안 함', start: '이 기기 다시 집계', note: '이 브라우저에만 적용됩니다. 사용하는 휴대폰과 컴퓨터마다 한 번씩 설정하세요.', back: 'ZETAPHY로 돌아가기' },
  ja: { title: '訪問者カウント', lede: 'このサイトは訪問数を数えます（Cookie なし、IP アドレスは保存しません）。運営者やテスターは自分の端末を除外して、実際の訪問者だけを数えられます。', on: 'この端末はカウントされます。', off: 'この端末はカウントされません。', stop: 'この端末をカウントしない', start: 'この端末を再びカウントする', note: 'このブラウザだけに適用されます。使うスマホとパソコンごとに一度ずつ設定してください。', back: 'ZETAPHY に戻る' },
  ru: { title: 'Счётчик посетителей', lede: 'Сайт считает посещения (без cookie, IP-адрес не сохраняется). Владельцы и тестировщики могут исключить свои устройства, чтобы цифры показывали только настоящих посетителей.', on: 'Это устройство учитывается.', off: 'Это устройство НЕ учитывается.', stop: 'Не учитывать это устройство', start: 'Снова учитывать это устройство', note: 'Действует только для этого браузера. Сделайте это один раз на каждом телефоне и компьютере.', back: 'Назад в ZETAPHY' },
  vi: { title: 'Bộ đếm lượt truy cập', lede: 'Trang web đếm lượt truy cập (không cookie, không lưu địa chỉ IP). Chủ sở hữu và người thử nghiệm có thể loại thiết bị của mình để số liệu chỉ tính khách thật.', on: 'Thiết bị này đang được đếm.', off: 'Thiết bị này KHÔNG được đếm.', stop: 'Không đếm thiết bị này', start: 'Đếm lại thiết bị này', note: 'Chỉ áp dụng cho trình duyệt này. Hãy làm một lần trên mỗi điện thoại và máy tính bạn dùng.', back: 'Quay lại ZETAPHY' },
  th: { title: 'ตัวนับผู้เข้าชม', lede: 'เว็บนี้นับจำนวนผู้เข้าชม (ไม่ใช้คุกกี้ ไม่เก็บ IP) เจ้าของและผู้ทดสอบกดยกเว้นเครื่องตัวเองได้ เพื่อให้ตัวเลขนับเฉพาะผู้เข้าชมจริง', on: 'เครื่องนี้ถูกนับอยู่', off: 'เครื่องนี้ไม่ถูกนับ', stop: 'ไม่นับเครื่องนี้', start: 'กลับมานับเครื่องนี้', note: 'มีผลเฉพาะเบราว์เซอร์นี้ ทำครั้งเดียวในแต่ละมือถือและคอมพิวเตอร์ที่ใช้', back: 'กลับไป ZETAPHY' },
};
export const LANGS = Object.keys(T);
const KEY = 'zp-nocount';
const $ = (id) => document.getElementById(id);

function lang() {
  try { const s = localStorage.getItem('zp-count-lang'); if (LANGS.includes(s)) return s; } catch { /* none */ }
  const n = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return LANGS.includes(n) ? n : 'en';
}
function off() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } }

let L = lang();
function render() {
  const t = T[L];
  document.documentElement.lang = L;
  document.title = t.title;
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t[el.dataset.t];
  const o = off();
  $('state').textContent = o ? t.off : t.on;
  $('state').className = o ? 'state off' : 'state on';
  $('toggle').textContent = o ? t.start : t.stop;
  $('lang').value = L;
}
$('toggle').addEventListener('click', () => {
  try { if (off()) localStorage.removeItem(KEY); else localStorage.setItem(KEY, '1'); } catch { /* blocked */ }
  render();
});
$('lang').addEventListener('change', (e) => { L = e.target.value; try { localStorage.setItem('zp-count-lang', L); } catch { /* none */ } render(); });
render();
