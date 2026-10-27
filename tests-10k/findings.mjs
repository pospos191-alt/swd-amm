// Hand-written part of SUMMARY.md: what the suite found and what was changed.
// run.mjs writes SUMMARY.md from the run's numbers plus this text.

export const FINDINGS = `## Bugs found (input -> expected vs got), both fixed in this branch

On the code as it was at \`156dec3\`, the same 10,000 cases gave **9,991 passed, 9 failed**
(4 in \`zetaphy/amm-math\`, 5 in \`zetaphy/hub-walletbar\`). After the two fixes below: 10,000 / 10,000.

1. **\`zetaphy-dex/web/lib/amm.js\`: \`sqrt(2n)\` returns \`2n\`** (expected \`1n\`).
   The Babylonian loop starts at \`x = y/2 + 1 = 2 = z\` for \`y = 2\` and never iterates.
   \`ZetaphyPair._sqrt\` treats \`y <= 3\` separately and returns 1; the JS port did not.
   Found by \`zetaphy/amm-math\` (\`s*s <= y < (s+1)^2\`), 4 cases with \`sq = 2n\`.
   Impact: low (the page uses it only for \`sqrt(a*b) - 1000\` of a first deposit), but wrong.
   Fix: \`if (y < 4n) return y === 0n ? 0n : 1n;\`, as the contract does. The same one-line copy in
   \`zetaphy-dex/test/helpers/dex.js\` (the reference of the DEX fuzz test) got the same fix.

2. **\`zetaphy-hub/walletbar.js\`: \`decodeString\` can return a broken character.**
   Input: the ABI string \`"AAAAAAAAAAA\\u{1D400}"\` (11 x \`A\` + MATHEMATICAL BOLD CAPITAL A, a letter
   outside the BMP), i.e. \`0x…0020 …000f 4141414141414141414141f09d9080…\`.
   Expected: at most 12 letters/digits/space/\`._-\`, no broken character.
   Got: \`"AAAAAAAAAAA\\ud835"\`: \`.slice(0, 12)\` counts UTF-16 units and cuts the surrogate pair in half,
   leaving a lone surrogate (drawn as U+FFFD in the wallet bar). The bytes32 path had the same cut.
   Found by \`zetaphy/hub-walletbar\`, 5 cases. Impact: cosmetic.
   Fix: after the 12-unit cut, a trailing lone high surrogate is dropped (\`plainShort\` in walletbar.js).

The touched packages' own tests still pass (\`zetaphy-dex\` web-lib + amm 35/35, fuzz 4/4;
\`zetaphy-hub\` walletbar + build 8/8).

### Checked, by design (the generators were adjusted, not the code)

- \`zetaphy-neuro/src/abi.js\` \`decodeString\` drops one leading U+FEFF (TextDecoder's BOM handling);
  \`cleanText\` removes it anyway.
- The PQ certificate's \`signer\` string is not covered by the ML-DSA signatures: flipping its bits
  must leave the verdict unchanged, and does.
- \`priceImpactBps\` is not monotonic when the output is a few wei (the integer rounding of the
  output dominates); monotonicity is checked from 10^6 wei of output up.
- \`clientKeyOf\` is given zone ids inside the brackets (\`[fe80::1%eth0]\`), the only real form.

## Not covered here

Solidity fuzzing with Foundry (\`forge\` is not installed where this was written), the Go chain node,
the wallet/NFT browser bundles (e2e only), and the live-RPC parts of Neuro (\`reader.js\`, the
\`honeypot.js\` simulation, \`sourcify.js\`), which need a node.
`;
