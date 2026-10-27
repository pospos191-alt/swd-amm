# tests-10k: 10,000 unique cases for Neuro and ZETAPHY

A seeded property / differential / invariant suite: **10,000 cases, every one distinct**, 5,000 for
Neuro (`zetaphy-neuro`) and 5,000 for ZETAPHY (DEX contracts and page libs, hub, explorer,
post-quantum finality verifier). This file is written by the runner after a full run.

```
node tests-10k/run.mjs                # everything, prints the table, writes SUMMARY.md and results.json
node tests-10k/run.mjs --only neuro/  # one part (writes nothing)
```

Needs the packages' own dev dependencies (`npm ci` in `zetaphy-neuro`, `zetaphy-dex` and
`zetaphy-network`); no network, no chain node, no Foundry. The EVM cases run the committed
artifacts in `zetaphy-dex/artifacts` on `@ethereumjs/evm` (the harness of `zetaphy-dex/test`).

## How "unique" is enforced

Each case is a plain input object drawn from a seeded PRNG (xoshiro128**, one seed per area). Its
identity is `sha256(area name + canonical JSON of its inputs)` (sorted keys; BigInt and bytes encoded
explicitly). A case whose hash was already drawn **anywhere in the suite** is re-drawn
(17 re-draws in 10,017 draws this run), and the run fails unless the final set holds exactly
10,000 distinct hashes. Case-set fingerprint (sha256 of the sorted case hashes): `7d7a82b7be2f8f71`;
it is the same on every run, so the same 10,000 cases are replayed everywhere.

## Results (Node v22.22.0, 11.11 s in total)

| area | cases | passed | failed | unique-check | time |
|---|---:|---:|---:|---|---:|
| neuro/scanBytecode-random | 610 | 610 | 0 | 610/610 | 0.10 s |
| neuro/scanBytecode-planted | 500 | 500 | 0 | 500/500 | 0.05 s |
| neuro/scam-vs-benign | 600 | 600 | 0 | 600/600 | 0.09 s |
| neuro/analyze-invariants | 600 | 600 | 0 | 600/600 (13 re-drawn) | 0.10 s |
| neuro/explain-9-languages | 540 | 540 | 0 | 540/540 (2 re-drawn) | 0.08 s |
| neuro/verdict | 400 | 400 | 0 | 400/400 | 0.32 s |
| neuro/early-warning-opcodes | 400 | 400 | 0 | 400/400 | 0.02 s |
| neuro/abi-hex-keccak-tax | 250 | 250 | 0 | 250/250 | 0.06 s |
| neuro/clientKeyOf | 400 | 400 | 0 | 400/400 | 0.02 s |
| neuro/cors-clientIp | 400 | 400 | 0 | 400/400 | 0.03 s |
| neuro/rate-limiters | 150 | 150 | 0 | 150/150 | 0.20 s |
| neuro/usage-counter | 150 | 150 | 0 | 150/150 | 0.64 s |
| zetaphy/amm-math | 900 | 900 | 0 | 900/900 | 0.03 s |
| zetaphy/dlmm-web-lib | 500 | 500 | 0 | 500/500 (2 re-drawn) | 0.13 s |
| zetaphy/dex-abi-amounts | 500 | 500 | 0 | 500/500 | 0.10 s |
| zetaphy/router-vs-js (EVM) | 500 | 500 | 0 | 500/500 | 1.22 s |
| zetaphy/pair-swaps (EVM) | 300 | 300 | 0 | 300/300 | 5.28 s |
| zetaphy/dlmm-math (EVM) | 500 | 500 | 0 | 500/500 | 0.59 s |
| zetaphy/hub-walletbar | 600 | 600 | 0 | 600/600 | 0.14 s |
| zetaphy/hub-chainlib-bech32 | 300 | 300 | 0 | 300/300 | 0.05 s |
| zetaphy/explorer-decoders | 600 | 600 | 0 | 600/600 | 0.37 s |
| zetaphy/pq-cert-mutations | 300 | 300 | 0 | 300/300 | 1.47 s |
| **Neuro total** | **5,000** | **5,000** | **0** | 5,000/5,000 | 1.71 s |
| **ZETAPHY total** | **5,000** | **5,000** | **0** | 5,000/5,000 | 9.39 s |
| **ALL** | **10,000** | **10,000** | **0** | **10,000/10,000 OK** | 11.11 s |

## Bugs found (input -> expected vs got), both fixed in this branch

On the code as it was at `156dec3`, the same 10,000 cases gave **9,991 passed, 9 failed**
(4 in `zetaphy/amm-math`, 5 in `zetaphy/hub-walletbar`). After the two fixes below: 10,000 / 10,000.

1. **`zetaphy-dex/web/lib/amm.js`: `sqrt(2n)` returns `2n`** (expected `1n`).
   The Babylonian loop starts at `x = y/2 + 1 = 2 = z` for `y = 2` and never iterates.
   `ZetaphyPair._sqrt` treats `y <= 3` separately and returns 1; the JS port did not.
   Found by `zetaphy/amm-math` (`s*s <= y < (s+1)^2`), 4 cases with `sq = 2n`.
   Impact: low (the page uses it only for `sqrt(a*b) - 1000` of a first deposit), but wrong.
   Fix: `if (y < 4n) return y === 0n ? 0n : 1n;`, as the contract does. The same one-line copy in
   `zetaphy-dex/test/helpers/dex.js` (the reference of the DEX fuzz test) got the same fix.

2. **`zetaphy-hub/walletbar.js`: `decodeString` can return a broken character.**
   Input: the ABI string `"AAAAAAAAAAA\u{1D400}"` (11 x `A` + MATHEMATICAL BOLD CAPITAL A, a letter
   outside the BMP), i.e. `0x…0020 …000f 4141414141414141414141f09d9080…`.
   Expected: at most 12 letters/digits/space/`._-`, no broken character.
   Got: `"AAAAAAAAAAA\ud835"`: `.slice(0, 12)` counts UTF-16 units and cuts the surrogate pair in half,
   leaving a lone surrogate (drawn as U+FFFD in the wallet bar). The bytes32 path had the same cut.
   Found by `zetaphy/hub-walletbar`, 5 cases. Impact: cosmetic.
   Fix: after the 12-unit cut, a trailing lone high surrogate is dropped (`plainShort` in walletbar.js).

The touched packages' own tests still pass (`zetaphy-dex` web-lib + amm 35/35, fuzz 4/4;
`zetaphy-hub` walletbar + build 8/8).

### Checked, by design (the generators were adjusted, not the code)

- `zetaphy-neuro/src/abi.js` `decodeString` drops one leading U+FEFF (TextDecoder's BOM handling);
  `cleanText` removes it anyway.
- The PQ certificate's `signer` string is not covered by the ML-DSA signatures: flipping its bits
  must leave the verdict unchanged, and does.
- `priceImpactBps` is not monotonic when the output is a few wei (the integer rounding of the
  output dominates); monotonicity is checked from 10^6 wei of output up.
- `clientKeyOf` is given zone ids inside the brackets (`[fe80::1%eth0]`), the only real form.

## Not covered here

Solidity fuzzing with Foundry (`forge` is not installed where this was written), the Go chain node,
the wallet/NFT browser bundles (e2e only), and the live-RPC parts of Neuro (`reader.js`, the
`honeypot.js` simulation, `sourcify.js`), which need a node.

## What each area checks

**Neuro**

- `neuro/scanBytecode-random` (610): scanBytecode on random / instruction-shaped bytecode: never throws, flags match an independent opcode walker, selector lists sorted/consistent, metadata tail ignored, deterministic.
- `neuro/scanBytecode-planted` (500): dispatcher entries are found (known named, unknown listed); selectors and dangerous opcodes hidden inside PUSH data are NOT reported.
- `neuro/scam-vs-benign` (600): synthesized tokens: owner-held mint/blacklist/pause, SELFDESTRUCT or a link in the name are flagged high; renounced plain ERC-20s are not; hiding the power in PUSH data, reordering the dispatcher or adding metadata are benign mutations.
- `neuro/analyze-invariants` (600): analyze() on random reader inputs: never throws; level = max finding severity; deterministic; caveat last; renounced => no power above low; selfdestruct => high; known issuer caps powers; withSimulation keeps rulesLevel.
- `neuro/explain-9-languages` (540): explain() for random analyses in all 9 languages: every line has non-empty text from a real template (no raw id, no "undefined"/"NaN"/"[object"), a title for every level, same ids/severities in every language.
- `neuro/verdict` (400): verdict hash: deterministic, 32-byte hex, independent of finding/function order, address case and simulation results; changes when a rule finding, the owner or the chain changes.
- `neuro/early-warning-opcodes` (400): early-warning opcode patterns (?, *, families) against a brute-force matcher on random opcode lists, incl. planted matches.
- `neuro/abi-hex-keccak-tax` (250): ABI string/uint/address decoders round-trip and never throw on random hex; hexToBytes round-trip and rejects junk; keccak256 = @noble/hashes; minimal-proxy round trip and 1-byte mutation; taxPercent bounds and monotonicity.
- `neuro/clientKeyOf` (400): rate-limit client key: every textual form of one IPv6 address (zero-compressed, padded, upper case, bracketed, zone id) gives the same /64 key; addresses in one /64 share it, other /64s do not; IPv4 and ::ffff:IPv4 give the IPv4.
- `neuro/cors-clientIp` (400): CORS on random/tricky Origins: allowed only for https hub hosts (no suffix/prefix/scheme/port tricks), echoes the exact origin, preflight 204/403; clientIp prefers Vercel's header, first hop, <= 64 chars.
- `neuro/rate-limiters` (150): memoryLimiter / redisLimiter (on memoryStore) under random multi-client traffic: allowed requests never exceed per-minute, per-day and global caps; a refused request names a positive retryAfter; same /64 shares a budget.
- `neuro/usage-counter` (150): handleUsage under random POST/GET sequences: counted checks per client per day <= 200, monthly counters equal the model, level/tx/zetaphy counters only for valid values, foreign origins refused, GET never writes.

**ZETAPHY**

- `zetaphy/amm-math` (900): getAmountOut/getAmountIn (0.3% fee): output < reserve, k never decreases, the pair's fee-adjusted K check holds for the quote and fails for quote+1, monotonic in input, getAmountIn overcharges by at most 1 wei; slippage bounds, price impact in [0,100%], isqrt.
- `zetaphy/dlmm-web-lib` (500): DLMM page lib: encodeArgs = ethers AbiCoder for random static/array/tuple types (signed ints too), decodeWords round trip; distribute() spends at most the totals, X only at/above and Y only at/below the active bin, active-bin ratio kept; idFromPrice(displayPrice(id)) = id.
- `zetaphy/dex-abi-amounts` (500): DEX page ABI: encodeCall = ethers for every router/pair function with random args; string/uint256[] decode of ethers-encoded data; decodeError never throws on junk; parseUnits/formatUnits round trip and formatUnits = ethers (truncated, grouped).
- `zetaphy/router-vs-js (EVM)` (500): ZetaphyRouter.getAmountOut / getAmountIn / quote on the EVM = web/lib/amm.js for random (also overflowing) inputs; the contract reverts exactly where the JS says "no quote" or a product overflows.
- `zetaphy/pair-swaps (EVM)` (300): real swaps on a ZetaphyPair (router exact-in, router exact-out, direct pair swaps): received = quote, reserves = balances, k never decreases, asking 1 wei more than the quote reverts with K.
- `zetaphy/dlmm-math (EVM)` (500): DlmmMath on the EVM vs exact BigInt: mulDiv/mulDivUp (512-bit, revert iff d=0 or overflow), mulPrice/divPrice floor and ceil, msb/lsb, bin price within 1e-9 of (1+s/1e4)^id, strictly increasing in id, refused outside [2^-96, 2^96].
- `zetaphy/hub-walletbar` (600): hub wallet bar: cleanId accepts every id the site writes (plain or JSON) and rejects any mutation outside the id grammar; balanceOfData = ethers; decodeString never throws, returns only letters/digits/space/._- (max 12, no broken surrogate pairs) and round-trips plain symbols; formatUnits = ethers (4 decimals, grouped).
- `zetaphy/hub-chainlib-bech32` (300): hub chainlib: toEvm(toBech32(a)) = a, hub and explorer bech32 agree (two implementations), any single-character change of a bech32 address is rejected; parseUnits/formatUnits and parseZeta/formatZeta round trips.
- `zetaphy/explorer-decoders` (600): explorer: decodeRawEvmTx = ethers-signed legacy/2930/1559 txs; rlpDecode round-trips ethers RLP and only throws "rlp:" errors on junk; decodeTransfer reads ethers-encoded ERC-20/721/1155 logs and returns null for wrong shapes; decodeAbiString; safeText strips control/bidi chars; formatUnits = ethers; parseQuery classifies heights/hashes/addresses.
- `zetaphy/pq-cert-mutations` (300): PQ finality certificate (ML-DSA-44, 3 validators 40/30/30): the valid one passes; any single-bit flip in a signature or signer address drops exactly that validator (ok iff the rest > 2/3); a flip in the cert height, type URL or protobuf framing, in the block hash, or in any header field makes it fail; flips in the unsigned signer string change nothing.
