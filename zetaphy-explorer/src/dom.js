// DOM building without HTML parsing: every string becomes a text node, links are
// either internal routes (#/…) or https URLs, and nothing else is ever set as
// markup. Chain data is passed through format.js safeText before it gets here.

/** Only internal routes and https links; anything else becomes '#'. */
export function safeHref(v) {
  const s = String(v ?? '');
  if (s.startsWith('#/') || s === '#') return s;
  try { const u = new URL(s); return u.protocol === 'https:' ? u.href : '#'; } catch { return '#'; }
}

/** append(el, child, [children], …): nodes as they are, anything else as text. */
export function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/**
 * h('a', { class, href, title, on: { click }, data: { x } }, ...children)
 * Attributes are set with setAttribute (never as markup); children are nodes or text.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'data') for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = String(dv);
    else if (/^on/i.test(k) || k === 'style' || k === 'srcdoc') throw new Error(`refusing attribute ${k}`);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  return append(el, children);
}

export const $ = (id) => document.getElementById(id);

/** Replaces an element's content with these children. */
export const fill = (el, ...children) => { el.replaceChildren(); return append(el, ...children); };
