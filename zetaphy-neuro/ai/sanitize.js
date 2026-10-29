// Text hygiene for the AI analyst (ai/). Everything that comes from a
// contract (token names, verified source, comments, labels) is written by a
// stranger, and so is everything a model writes back after reading it. Both
// pass through here before they reach a prompt or the page.
//
// Not in src/: the LLM layer is advisory and never part of a verdict, so it
// is not part of the Neuro skill id (zetaphy-network/src/skill.js hashes src/).

// C0/C1 controls except tab and newline, bidi overrides/isolates, zero-width
// and other invisible format characters, BOM, line/paragraph separators.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2028\u2029\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

/** Our own data fences: text that imitates them is rewritten so it can never close or open one. */
const FENCE = /<{2,}\s*\/?\s*(?:END[-_ ]?)?UNTRUSTED[^>]*>{0,}/gi;

/** Removes invisible/control characters and normalises Unicode (NFKC folds look-alike forms). */
export function stripInvisible(s) {
  return String(s ?? '').normalize('NFKC').replace(INVISIBLE, '');
}

/** "https://x.y/z" -> "https[:]//x.y/z": still readable, never a clickable or fetchable link. */
export function defang(s) {
  return String(s ?? '').replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\//gi, '$1[:]//');
}

/** Cuts to at most `max` characters (whole code points), marking the cut. */
export function cap(s, max) {
  const chars = Array.from(String(s ?? ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

/**
 * Untrusted text going INTO a prompt: invisible characters stripped, fence
 * look-alikes neutralised, links defanged, length capped.
 */
export function untrusted(s, max = 200) {
  return cap(defang(stripInvisible(s).replace(FENCE, '[fence removed]')), max);
}

/**
 * Text coming OUT of a model, before it is shown: same cleaning, plus no
 * markup survives (the page uses textContent anyway; this keeps logs and
 * the runner's signed files clean too).
 */
export function modelText(s, max = 600) {
  return cap(defang(stripInvisible(s)).replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).trim(), max);
}

/**
 * Solidity/Vyper/Yul source -> lines with comments removed (comments are the
 * easiest place to hide instructions to a model, and carry no behaviour).
 * Keeps the original line numbering: a removed comment leaves an empty line.
 * Strings are kept (a "//" inside a string is not a comment).
 */
export function stripComments(src, { vyper = false } = {}) {
  const s = String(src ?? '');
  let out = '';
  let i = 0;
  let quote = null;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < s.length) { out += n; i += 2; continue; }
      if (c === quote || c === '\n') quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; i++; continue; }
    if (!vyper && c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (!vyper && c === '/' && n === '*') {
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { if (s[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (vyper && c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Phrases that try to steer a model; used to flag (not to trust) text, and in tests. */
export const INJECTION_HINT = /(ignore|disregard|forget)\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)|you\s+are\s+now|system\s*prompt|mark\s+(this|it|the\s+contract)?\s*(as\s+)?safe|new\s+instructions/i;

/** True when text looks like it addresses a model rather than describing code. */
export const looksLikeInjection = (s) => INJECTION_HINT.test(stripInvisible(s));
