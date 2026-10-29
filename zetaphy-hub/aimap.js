// The AI map tab: all 35 AI features (docs/future/*.md) as picture cards, grouped, each with its status and a
// button that opens it where it lives (a hub tab, a page of this site) or its doc. A row of status chips on
// top counts them and filters the cards.
import { withFallback, TAB_TEXT } from './i18n.js';
import { AIMAP } from './flow-i18n.js';
import { GROUPS, ITEMS, STATUS_ICON, icon, docUrl } from './flow.js';

const ORDER = ['live', 'practice', 'notDeployed', 'chain', 'cli'];
let filter = 'all';

/** Counts per status (a test checks they add up to 35). */
export function statusCounts() {
  const n = Object.fromEntries(ORDER.map((s) => [s, 0]));
  for (const it of Object.values(ITEMS)) n[it.s]++;
  return n;
}

/** Where an item opens, in words: the hint, the tab's name, or the page's name. */
export function whereText(it, lang, L) {
  if (it.hint) return L.hint[it.hint];
  if (it.tab) return (TAB_TEXT[lang]?.[it.tab] ?? TAB_TEXT.en[it.tab])[0];
  if (it.page) return it.page.replace(/#.*$/, '');
  return '';
}

function open(ctx, it) {
  if (it.tab) {
    ctx.show(it.tab);
    if (it.mode) window.dispatchEvent(new CustomEvent('hub:mine-mode', { detail: it.mode }));
  } else if (it.page) location.href = it.page;
}

const aimap = {
  render(root, ctx) {
    const L = withFallback(AIMAP, ctx.lang);
    const el = ctx.el;
    const counts = statusCounts();
    const cards = [];
    const chip = (s, n) => el('button', { type: 'button', class: `am-chip st-${s}${filter === s ? ' on' : ''}`, 'data-s': s, onclick: () => setFilter(s) },
      s === 'all' ? icon('grid', 'fl-ic sm') : icon(STATUS_ICON[s], 'fl-ic sm'), el('span', { text: s === 'all' ? L.all : L.status[s] }), el('b', { text: String(n) }));
    const setFilter = (s) => {
      filter = s;
      for (const c of root.querySelectorAll('.am-chip')) c.classList.toggle('on', c.dataset.s === s);
      for (const c of cards) c.hidden = s !== 'all' && c.dataset.s !== s;
      for (const g of root.querySelectorAll('.am-group')) g.hidden = ![...g.querySelectorAll('.am-card')].some((c) => !c.hidden);
    };
    const card = (n) => {
      const it = ITEMS[n];
      const [name, what] = L.items[n];
      const where = whereText(it, ctx.lang, L);
      const c = el('article', { class: `am-card st-${it.s}`, 'data-s': it.s, id: `ai-${n}` },
        el('div', { class: 'am-top' },
          el('span', { class: 'am-pic' }, icon(it.i, 'fl-ic big')),
          el('span', { class: 'am-num mono', text: `#${n}` })),
        el('h3', { text: name }),
        el('p', { class: 'small', text: what }),
        el('span', { class: `am-st st-${it.s}` }, icon(STATUS_ICON[it.s], 'fl-ic sm'), el('span', { text: L.status[it.s] })),
        where ? el('p', { class: 'am-where small dim' }, icon('map', 'fl-ic sm'), el('span', { text: where })) : null,
        el('div', { class: 'am-actions' },
          it.tab || it.page ? el('button', { type: 'button', class: 'btn sm', text: L.open, onclick: () => open(ctx, it) }) : null,
          el('a', { class: 'btn ghost sm', href: docUrl(it.doc, ctx.lang), target: '_blank', rel: 'noopener', text: L.docs })));
      cards.push(c);
      return c;
    };
    root.replaceChildren(
      el('div', { class: 'am-head' },
        el('span', { class: 'am-hero' }, icon('brain', 'fl-ic hero')),
        el('div', {}, el('h2', { text: L.title }), el('p', { class: 'small', text: L.intro }))),
      el('div', { class: 'am-chips', role: 'toolbar' }, chip('all', 35), ...ORDER.map((s) => chip(s, counts[s]))),
      ...GROUPS.map(([g, gi, nums]) => el('section', { class: 'am-group' },
        el('h2', { class: 'am-gh' }, icon(gi, 'fl-ic'), el('span', { text: L.groups[g] }), el('b', { class: 'mono', text: String(nums.length) })),
        el('div', { class: 'am-grid' }, ...nums.map(card)))));
    setFilter(filter);
  },
};

export default aimap;
