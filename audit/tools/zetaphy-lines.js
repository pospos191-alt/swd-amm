#!/usr/bin/env node
// Which lines of the patched Cosmos EVM tree are ZETAPHY's own code.
//
// zetaphy-chain/setup-node.sh carries the chain changes as `git apply`
// patches (heredocs ZETAPHY_RL_PATCH and ZETAPHY_PQ_PATCH). The Go scanners
// run on the whole patched tree, and the audit keeps only findings on lines
// these patches ADDED: upstream Cosmos EVM / ibc-apps code is audited by its
// own maintainers, and reporting thousands of its warnings would bury ours.
//
//   node audit/tools/zetaphy-lines.js zetaphy-chain/setup-node.sh > zetaphy-lines.json
// prints {"<path in the cosmos/evm tree>": "all" | [added line numbers…]}.
// "all" = a file the patch creates. *.pb.go, go.mod and go.sum are skipped.
import { readFileSync } from 'node:fs';

export function patchedLines(script) {
  const out = {};
  for (const part of ['RL', 'PQ']) {
    const re = new RegExp(`^: <<.ZETAPHY_${part}_PATCH.$([\\s\\S]*?)^ZETAPHY_${part}_PATCH$`, 'm');
    const m = script.match(re);
    if (!m) continue;
    let file = null; let isNew = false; let line = 0; let inHunk = false;
    for (const l of m[1].split('\n')) {
      if (l.startsWith('diff --git ')) {
        file = l.split(' ')[3].replace(/^b\//, ''); isNew = false; inHunk = false; continue;
      }
      if (!file) continue;
      if (l.startsWith('new file mode')) { isNew = true; continue; }
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { line = Number(h[1]); inHunk = true; continue; }
      if (!inHunk || l.startsWith('+++') || l.startsWith('---')) continue;
      if (!/\.go$/.test(file) || /\.pb(\.gw)?\.go$/.test(file)) continue;
      if (isNew) { out[file] = 'all'; continue; }
      if (l.startsWith('+')) { (out[file] ??= []).push(line); line++; } else if (l.startsWith('-')) { /* removed: no new line */ } else if (l.startsWith('\\')) { /* no newline marker */ } else { line++; }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(patchedLines(readFileSync(process.argv[2], 'utf8')), null, 1) + '\n');
}
