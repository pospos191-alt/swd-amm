# ZETAPHY chain — audit scope

What an auditor of the ZETAPHY chain needs to look at. The base is the
published Cosmos EVM `v0.7.3` (commit `c3ae9067a7eadcdea55a5192226916deb44c71c4`,
Cosmos SDK v0.54, ibc-go v11, CometBFT). ZETAPHY adds the patches embedded at
the end of `zetaphy-chain/setup-node.sh`; nothing else in the node differs
from upstream except the bech32 prefix (`zetaphy`).

Reproduce the exact source:

```bash
git clone --depth 1 --branch v0.7.3 https://github.com/cosmos/evm.git src
bash zetaphy-chain/setup-node.sh --patch-source "$PWD/src"
cp -r zetaphy-chain/fork-tests/. src/          # the patches' tests
```

## In scope (ZETAPHY code, ~1,800 lines)

| Area | Files (in the patched tree) | What to check |
|---|---|---|
| ML-DSA-44 account keys | `crypto/mldsa44/*`, `crypto/codec/*.go`, `ante/sigverify.go` | signature verification (pure ML-DSA, empty context, over SIGN_MODE_DIRECT bytes); address = sha256("zetaphy/mldsa44\0" ‖ key)[:20] and collisions with other key types; hand-written protobuf (`keys.pb.go`, runtime descriptor); gas per verification (30,000) vs CPU |
| Public JSON-RPC methods | `evmd/zetaphy_rpc.go` | `zetaphy_pqAccount`, `zetaphy_sendCosmosTx` (64 KB cap, decode before broadcast), `zetaphy_faucet` (key file, rate limits, nonce handling) on the public port 8545 |
| PQ accounts calling the EVM | `evmd/zetaphy_pqcall.go` (`MsgEVMCall`, registered in `evmd/app.go`) | signer = `sender` via the runtime descriptor; `msg.sender` = the signer's 0x address (or a locked owner, `as_owner`); the account sequence is not bumped twice on contract creation; value transfer and state undone on revert; EVM gas charged to the Cosmos gas meter (not internal: normal refund cap and minimum gas); 10M gas cap; interaction with authz `MsgExec` |
| Quantum lock | `evmd/zetaphy_pqguard.go` (`pqLockAnte` after the upstream ante chain, `pqTxSigners` incl. fee payer, EVM post-tx hook on `0x…5051`, `MsgQuantumLock`, genesis export), `as_owner` in `zetaphy_pqcall.go`, `mempool/zetaphy_lock.go` (refusal at submission), panic recovery in `mempool/recheck_pool.go`, ecrecover also on the state-override path | every path a locked ECDSA key could still act through (EVM txs, Cosmos txs, authz `MsgExec`, fee grants, ICA/IBC); controller must be an on-chain ML-DSA-44 account; hook only on successful top-level txs; contract creation nonce handling |
| PQ vote certificates and evidence switch | `evmd/zetaphy_pqcert.go` (`MsgPQCertificate` as tx[0], `pqBuildCert`, `pqCheckCert` in ProcessProposal and PreBlocker, `pqFilterEvidence`, `MsgSetPQEvidence` (gov authority only)), proposal handler wrapping in `evmd/mempool.go` and `app.go` | liveness of the > 2/3·T − U rule (key changes in the certified block use the previous key; `pqVoteKeyAt`), the certificate tx skips the ante chain only in FinalizeBlock, PreBlocker halts a node fed an uncertified chain, MaxTxBytes accounting, canonical certificates (sorted, every entry valid); from the v2 activation height a keyed proposer that is a validator of the certified block must include its own entry (it signs one at proposal time if its precommit brought none, `pqOwnEntry`) — liveness: only that proposer's round fails if its key is wrong, and the stricter "non-empty certificate whenever any key is registered" was rejected because one offline keyed validator under 1/3 power would halt the chain; one vote-key change per block, jailed reset only via a quantum-locked operator, evidence filtering through `ctx.WithCometInfo` |
| ML-DSA vote signatures | `setPQVoteHandlers`, `MsgPQVoteKey`, `PQVoteKeyCmd` in `zetaphy_pqguard.go`; `vote_extensions_enable_height` in genesis | liveness (a rejected precommit can stall a height: the node exits instead of signing with an unregistered key); key replacement needs the old key's signature unless the validator is jailed; `validator_owner` for a locked operator; extensions of validators without a key must be empty or signature-sized; registrations at the initial height race with optimistic execution (not handled; validators register after start); message binds chain id, height, block hash; validators without a key are not checked; blocksync and light clients do not check ML-DSA |
| Fee burn and dEaD burn | `evmd/zetaphy_feeburn.go` (`burnFees`, `burnDead`), wiring in `BeginBlocker` (`evmd/app.go`) | burns 50% of the fee collector every block; from the v2 activation height, burns the *spendable* native-denom (azetaphy) balance of `0x…dEaD` every block through the EVM module account (Burner), so total supply drops — spendable, because anyone can make dEaD a vesting / permanently locked account before the first burn and moving the full balance would then fail every block (the locked part stays; later deposits are still burned); other denoms at dEaD untouched; missing account / zero balance; each burn all-or-nothing in a cached context and logged, never a panic that would halt the chain |
| `block.prevrandao` and `BLOCKHASH` | `evmd/zetaphy_random.go` (`PrevRandao`, `setPrevRandao` called from `pqPreBlock`, `prevRandao`, `ensureBlockHashHistory`), `pqVerifiedCert` in `evmd/zetaphy_pqcert.go`, `x/vm/keeper/zetaphy_random.go` + `Random:` in `x/vm/keeper/state_transition.go`, `SetRandomFn` in `evmd/app.go`; `SetHeaderHash` moved from BeginBlock to EndBlock in `x/vm/keeper/abci.go`, `DefaultHistoryServeWindow` = 8191 in `x/vm/types/params.go`; KV key `0x07` of the `zetaphypq` store (not exported to genesis) | below the v2 activation height: upstream behaviour (Random = 0xff…ff, nothing stored, no install). From it: value of block N = sha256("zetaphy.prevrandao.v1" ‖ 0 ‖ chain-id ‖ 0 ‖ N ‖ 0x01 ‖ cert height ‖ attestations) of the *verified* certificate in tx[0] (never an unchecked one: with vote extensions off or no stored hash of N-1 the cert is ignored), else fallback sha256(… ‖ 0x00 ‖ hash of N-1); written in PreBlocker so every DeliverTx, BeginBlock and EndBlock EVM call of N sees the same value; eth_call / estimateGas / CheckTx see the latest committed block's value; a context at a height without a stored value (e.g. tracing a block on its parent state) gets a fallback without the parent hash, so such traces can differ from the real execution; the store is read without gas so EVM gas use is unchanged. **Known bias — PREVRANDAO is unpredictable to users but biasable by the proposer, and must not be the sole randomness source for high-value lotteries:** ML-DSA signatures are not unique, so the proposer can re-sign its own entry and choose the subset above 2/3, and every signer can choose its own signature before precommitting (the proposer-entry rule in the certificate row only removes the "no certificate / fallback" choice; NeuroJobs' lottery draws from `blockhash(startBlock+1)` instead); vote extensions are gossiped with precommits, so watchers can usually compute N's value during timeout_commit, and contracts must draw from a block after the one that fixed the bet. BLOCKHASH: the EIP-2935 history contract is missing from a `zetaphyd init` genesis; from the activation height it is installed at the start of the first block without it (existing account balance kept). Its code (geth's) serves `get(n)` from slot `n % 8191` for the last 8191 blocks; upstream's keeper wrote `n % 8192` (wrong hashes from direct calls past block 8191) and wrote block N's hash at BeginBlock (overwriting N-8191 while N runs). Now 8191 and EndBlock, exactly EIP-2935; BLOCKHASH (last 256, via `GetHashFn`) is unaffected. The `history_serve_window` param must stay 8191 while the contract is installed (governance could change it) |
| v2 activation height | `evmd/zetaphy_upgrade.go` (`zetaphyV2`, KV key `0x08` of `zetaphypq`, `pqGenesisBasic` default genesis, `registerZetaphyUpgrades` / upgrade `zetaphy-v2`), gates in `burnDead`, `ensureBlockHashHistory`, `setPrevRandao`, `prevRandao`, `pqVerifiedCert`, `pqOwnEntry` | below the height (or unset) every block runs exactly as before the v2 features, so replaying an existing chain does not diverge; `zetaphyd init` and `setup-node.sh` set 1 for a new chain; the `zetaphy-v2` handler (runs in the upgrade module's PreBlocker at H, after prevrandao of H was fixed) sets H+1 and `history_serve_window` = 8191; its `StoreUpgrades` must list stores the running binary lacks; genesis export keeps the height (1 once active); the read is gas-free so EVM gas is unchanged |
| ML-DSA precompile | `precompiles/mldsa/*`, `precompiles/types/*`, `x/vm/types/precompiles.go` | input parsing, gas vs CPU, read-only, no panics |
| IBC rate limits | `x/ratelimit/*` (ibc-apps rate-limiting v10.7.0, hash-pinned) + `ZETAPHY_RL_PATCH`; wiring in `evmd/app.go` | the ibc-go v11 port (middleware setters, pointer receivers, ack/timeout of non-ICS-20 packets passed through, no x/params); both IBC v1 and v2 stacks and the ICS-20 precompile send path go through it |

## Node setup (operational, also in scope)

`zetaphy-chain/setup-node.sh`: genesis allocation (1,000,000,000 ZETAPHY, no
inflation), key handling (genesis mnemonics and the faucet key stay on the
node), public ports (8545, 26656, 80/443 via Caddy), JSON-RPC limits, JOIN
mode (genesis and peer fetched over https from another node) and
`--become-validator`.

## Out of scope

Upstream Cosmos SDK / CometBFT / Cosmos EVM / ibc-go code that ZETAPHY does
not modify, and the EVM contracts in `zetaphy-network/contracts` (separate
scope, see that folder's README and `docs/BUG_BOUNTY.md`: they include the
governance `ZetaphyTimelock`, built from OpenZeppelin Contracts 5.4.0 files
pinned by sha256 in `zetaphy-network/vendor/openzeppelin-contracts.json`, and
the `ZetaphyOracle` price feed). The chain-side touch point is `MsgEVMCall`
from the gov module, which is how a vote schedules a call in that timelock.

## Already done (free)

- Unit and fuzz tests (`zetaphy-chain/fork-tests`), the full ibc-go transfer
  test suite with the rate limiter in the stack, and real-chain devnet tests
  (`zetaphy-network/test/devnet.pq.integration.js`) in CI on every change;
  `zetaphy-network/test/devnet.chainrand.integration.js` (prevrandao,
  BLOCKHASH, direct calls to the EIP-2935 contract, dEaD burn) on a real
  chain; `fork-tests/evmd/zetaphy_v2_test.go` (both sides of the
  activation height, the `zetaphy-v2` handler, the 8191 ring across its
  wrap, a vesting account at dEaD, the proposer-entry rule).
- gosec on the ZETAPHY packages in CI; govulncheck and an upstream-drift
  build weekly (`.github/workflows/zetaphy-chain-upstream.yml`).
- Internal adversarial reviews (October 2026), the second one of the
  quantum lock and vote signatures: a fee-payer bypass and a node crash on
  malformed txs were found and fixed, with regression tests in
  `fork-tests/evmd/zetaphy_pqguard_test.go`. Not a substitute for an
  independent audit.

## ZETAPHY DEX — DLMM contracts (UNAUDITED, separate EVM scope)

Not part of the chain audit above, listed here so the scope is complete.
The DLMM (discrete liquidity bins) is a Solidity port of our own Solana
design (`programs/swd_amm/src/dlmm.rs`, volatility fee from `swdmm_math.rs`),
written from scratch (MIT, no third-party code). **Unaudited; testnet only.**
Solidity 0.8.26, optimizer 200, evm `cancun`; build and tests:
`cd zetaphy-dex && npm run build && npm test`.

| Area | Files | What to check |
|---|---|---|
| Fixed-point math | `zetaphy-dex/contracts/dlmm/DlmmMath.sol` (`DlmmMath`, `DlmmBinTree`) | bin price (1 + binStep/10⁴)^id as 128.128 via the inverted base (every product < 2²⁵⁶), its range [2⁻⁹⁶, 2⁹⁶] and monotonicity; 512-bit `mulDiv` / `mulDivUp`; rounding direction of each conversion; the three-level bitmap (`below` / `above` at word and level boundaries) |
| Pair | `zetaphy-dex/contracts/dlmm/ZetaphyDlmmPair.sol` (`ZetaphyDlmmPair`, `ZetaphyDlmmPairDeployer`) | swap loop (bins crossed, `MAX_BINS_CROSSED`, exact drains, rounding always for the pool), consistency of `getSwapOut` / `getSwapIn` with `swap`; share minting (first deposit = x·price + y·2¹²⁸, later deposits in the bin's own ratio) and burning; single-sided rule around the active bin; internal accounting vs. token balances (donations, `skim`, `BalanceBelowReserves`); volatility fee (reference, decay, cap); protocol fee accrual and `collectProtocolFees`; reentrancy lock and the order of state writes vs. transfers; `setActiveIdWhileEmpty` |
| Factory | `zetaphy-dex/contracts/dlmm/ZetaphyDlmmFactory.sol` | one `governance` role for every admin function (two-step handover, e.g. to a TimelockController); preset validation; protocol-share cap; CREATE2 addressing through the pair deployer; registry check on `setThreatRegistry` |
| Router | `zetaphy-dex/contracts/dlmm/ZetaphyDlmmRouter.sol` | slippage (`amountOutMin` / `amountInMax`, `amountXMin` / `amountYMin`, `activeIdDesired` + `idSlippage`), deadlines, multi-hop, native wrapping with WZETAPHY and with the native ERC-20 precompile, refunds, fee-on-transfer refusal, Neuro `TokenEnforced` / fail-closed `RegistryUnavailable` (same rules as `ZetaphyRouter`) |

Already done (free): unit, property (randomized, seeded) and regression tests
in `zetaphy-dex/test/dlmm*.test.js` (including every case of the Solana
DLMM's regression suite, ported to the EVM), and a
real-chain test `zetaphy-dex/test/devnet.dlmm.integration.js`
(`npm run test:devnet:dlmm`). Not a substitute for an independent audit.

## Security core (Q-day, threat gate, IBC large-transfer hold) — new scope

> สรุป (ไทย): ขอบเขตใหม่สำหรับผู้ตรวจ คือกติกาความปลอดภัยในแกนกลางของเชน 3 อย่าง (Q-day + การย้ายแบบ commit–reveal,
> threat gate + ความยินยอมผ่าน precompile 0x…0901, การพักการโอนเข้า IBC ก้อนใหญ่) ทั้งหมดปิดจนกว่าจะโหวต
> คำถามหลัก: ไม่มีเส้นทางให้ ECDSA ผ่านหลัง Q-day, ผลเหมือนกันทุกโหนด, งานต่อบล็อก/ต่อธุรกรรมมีเพดาน,
> และไม่มีกติกาใดทำให้การถอนเงินจากสัญญาของโปรโตคอลค้าง

Part of the same `ZETAPHY_PQ_PATCH` in `zetaphy-chain/setup-node.sh` (~1,400 lines of Go; user guide in Thai:
[`docs/SECURITY-CORE.md`](SECURITY-CORE.md)). Every rule is off until a governance vote sets it.

| File | What to look at |
|---|---|
| `evmd/zetaphy_security.go` | store layout (zetaphypq keys 0x0F–0x1B), activation height 0x0F, EVM-storage mirrors at `0x…5051`, BeginBlock work |
| `evmd/zetaphy_qday.go` | `MsgSetQDay` (gov only), the Q-day ante rule (every signer ML-DSA-44; no `MsgEthereumTx`; authz inner messages), commit–reveal migration (`QDayCommitment`, EIP-191 reveal text, low-s check, commitment age, "oldest commitment wins" while pending, finalize queue bounded per block), exposure test |
| `x/vm/keeper/zetaphy_ecrecover.go` | ecrecover returns nothing from Q-day; exposure marks written from inside the precompile (also under STATICCALL) |
| `mempool/zetaphy_lock.go` | submission-time refusal (Q-day, quantum lock) and the app hook (threat gate on a query context) |
| `evmd/zetaphy_threatgate.go` | registry static call (gas cap, fail-open, throw-away cache context), consent records, exemptions (system addresses, the registry, governance), ante coverage of `MsgEthereumTx` and `MsgEVMCall` (also in authz) |
| `evmd/zetaphy_secprecompile.go` | precompile `0x…0901`: consent only from `msg.sender == tx.origin`, no value, write protection under STATICCALL/DELEGATECALL, guardian-only `cancelIBCHold`, activation by height |
| `evmd/zetaphy_ibchold.go` | v1 middleware on top of the transfer stack (async acknowledgement; release in BeginBlock through the rest of the stack in a cache context with panic recovery; error-ack cancel; local-denom computation for both directions), v2 refusal, parameter bounds |
| `evmd/zetaphy_rpc.go` | read-only JSON-RPC (`zetaphy_securityStatus`, `zetaphy_migration`, `zetaphy_qdayCommitment`, `zetaphy_consent`, `zetaphy_ibcHolds`) |
| `evmd/zetaphy_upgrade.go` | genesis allow-list, export, the `zetaphy-v3` upgrade handler |

Questions for the auditor: determinism of the registry call inside the ante handler and the mempool hook;
whether any path lets an ECDSA-authorized action through after Q-day; consensus safety of async
acknowledgements written in BeginBlock; bounded work per block and per tx; that no rule can stop
withdrawals from the protocol's own contracts. Tests: `fork-tests/evmd/zetaphy_security_test.go`,
`fork-tests/evmd/tests/ibc/zetaphy_ibchold_test.go`, `zetaphy-network/test/devnet.security.integration.js`,
`zetaphy-chain/ibc/test-ibc.sh` part 4. Known limits and the developers' own findings are kept separately for the team.
