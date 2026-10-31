// Visitor counting with Vercel Web Analytics (no cookies; Vercel keeps no IP address). It runs only on the
// production site, and never on a device whose owner pressed "Don't count this device" (count.html).
(() => {
  let off = false;
  try { off = localStorage.getItem('zp-nocount') === '1'; } catch { /* storage blocked: count as usual */ }
  if (off || !/(^|\.)sawasdeecoin\.com$/.test(location.hostname)) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = '/_vercel/insights/script.js';
  document.head.appendChild(s);
})();
