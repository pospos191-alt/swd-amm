// Neuro's skill id: which exact Neuro code a runner runs. Governance votes a
// skill id in (NeuroControl.approveSkill + setActiveSkill); each job records
// the active one, and a runner only works on jobs whose skill is its own.
//
// Definition: in zetaphy-neuro/, take every file under src/ whose name ends
// in .js, plus every file in src/lang/; sort their paths (relative to
// zetaphy-neuro/, "/" separators, byte order); the id is sha256 of the text
// "<sha256 hex of the file>  <path>\n" for each file in that order. It is
// exactly what this prints:
//   cd zetaphy-neuro && find src -type f \( -name '*.js' -o -path 'src/lang/*' \) | LC_ALL=C sort | xargs sha256sum | sha256sum
// Any change to Neuro's code (a new rule, a new language) is a new skill.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const NEURO_DIR = fileURLToPath(new URL('../../zetaphy-neuro/', import.meta.url));

function walk(dir, rel, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else if (e.isFile() && (e.name.endsWith('.js') || rel === 'src/lang')) out.push(r);
  }
  return out;
}

/** The files a skill id covers, sorted. */
export function skillFiles(root = NEURO_DIR) {
  return walk(join(root, 'src'), 'src', []).sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
}

/** 0x-prefixed bytes32 skill id of the Neuro code in `root`. */
export function skillId(root = NEURO_DIR) {
  const sha = (b) => createHash('sha256').update(b).digest('hex');
  const list = skillFiles(root).map((f) => `${sha(readFileSync(join(root, f)))}  ${f}\n`).join('');
  return '0x' + sha(list);
}
