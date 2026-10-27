// A client's rate-limit key: an IPv4 address, or the /64 of an IPv6 address (one
// home or phone usually holds a whole /64, so per-address limits would be easy to dodge).
export function clientKeyOf(ip) {
  let s = String(ip ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  if (!s.includes(':') || !/^[0-9a-f:.]+$/.test(s)) return s;
  const [head, tail = null] = s.split('::');
  const part = (x) => (x ? x.split(':') : []);
  const h = part(head);
  const t = tail == null ? [] : part(tail);
  const groups = tail == null ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (g.includes('.') ? g : g.replace(/^0+(?=.)/, ''))).join(':') + '::/64';
}
