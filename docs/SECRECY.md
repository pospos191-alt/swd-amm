**English** | [ภาษาไทย](SECRECY.th.md)

# What can be open, and what must be hidden (ZETAPHY)

Principle: **the system must be secure even if attackers know everything about how it works** (Kerckhoffs's principle)
The only things that can really be hidden are "keys" and "information that is valuable because nobody knows it yet". How the chain and contracts work must be open,
because on-chain bytecode is readable anyway, every validator needs the program to run it, and auditors / the bug bounty need to read the code

## 1. Can be disclosed (open on purpose)

| What | Why it is still secure when open |
|---|---|
| Chain code (Cosmos EVM patch), all contracts, web apps, wallet, Snap | Security comes from keys, ML-DSA signatures and deposits, not from the code being secret |
| The Neuro rules runners vote on (skills in `zetaphy-neuro/src`) | Every runner must run the same code so results can be re-checked (skill id = hash of the file) |
| The lottery for choosing judges | Uses the blockhash after the request; the rules are known but cannot be predicted in advance |
| Bridge caps, timelock, quarantine, independent-lane thresholds | Already on chain, and designed so that "knowing them still does not let you break in" |
| Scheduling in ZetaphyTimelock (contract, function, data, time it becomes executable) | Meant to be visible to everyone 48 hours before taking effect (the monitor alerts); this is the purpose of the timelock |
| ZetaphyOracle guard values (TWAP window, deviation between price sources, change cap) | Already readable from on-chain storage, so public documents do not give the numbers or attack reasoning |
| Contract addresses (launch state) | Already on chain |

## 2. Must be hidden, and where it is kept

| What | Kept in | Who sees it |
|---|---|---|
| Deploy key | GitHub Secret `ZETAPHY_DEPLOYER_KEY` | Nobody can read it back (the workflow masks it in logs and deletes the file after use) |
| Validator keys (`priv_validator_key.json`, `pq_vote_key.seed`) | On the node machine only + offline backup | The machine's owner |
| Faucet / relayer keys | On the node machine (created on the machine, never printed out) | The machine's owner |
| Multisig owners (guardian / governance) | Each person's hardware wallet | Each person |
| The bridge monitor's marker key | GitHub Secret `BRIDGE_MARKER_KEY` | Nobody (low privilege: can only mark, cannot move funds) |
| The list of watched contracts (watch list) | GitHub Secret `BRIDGE_WATCHLIST` | Nobody (reports/issues/logs do not show these addresses) |
| The bridge's real alert thresholds | GitHub Secret `BRIDGE_MONITOR_THRESHOLDS` (the file in the repo has the defaults) | Nobody |
| Live alerts | Private Telegram / Discord, or issues in a private repo | The team |
| Pyth price relayer key (`ZetaphyPythRelay`) | On the machine running `zetaphy oracle relay-pyth` (rights: submit prices only; the oracle cross-checks against the TWAP) | The machine's owner |
| Security details (reasons for guard values, remaining weaknesses, attack analysis, review results) | Private repo `zetaphy-private/security/` (e.g. `timelock-oracle.md`) | The team |
| New Neuro rules during the embargo period | Private repo `zetaphy-private/rules/pack.json` → the Neuro server reads it with a read-only token | The team (users see only the warning results, not the rules) |
| Vulnerabilities not yet fixed | GitHub Private vulnerability reporting / Security advisory (draft) | The team, until fixed and announced |
| Service tokens (Vercel, Upstash, `NEURO_RULES_TOKEN`) | Vercel / GitHub secret variables | Nobody |

## 3. Limitations

Everything on chain is public; hiding can only mean "not labelled". Security details are kept separately for the team (`zetaphy-private/security/`)

## 4. Before switching the repo to Public (checklist)

Secret scan of the full history (21 Oct 2026, gitleaks + a crypto-specific scan): **no keys or tokens found**; what was found were public test values / feature names
Commit authors' emails will be visible (to turn this off for new commits: GitHub → Settings → Emails → Keep my email addresses private)

After pressing **Settings → Danger Zone → Change visibility → Public**, set the following (all free):
1. **Settings → Code security**: turn on **Private vulnerability reporting**, **Secret scanning** + **Push protection**, **Dependabot alerts**
2. **Settings → Actions → General**: Fork pull request workflows → **Require approval for all external contributors**; Workflow permissions → **Read repository contents** (the read-only default)
3. **Settings → Branches → Add rule** for `main`: Require a pull request + Require status checks (CI)
4. **Before switching**, delete old artifacts named `bridge-monitor-report` in Actions (while private they kept alert details for 14 days); if bridge-monitor has never run, you can skip this
5. The bridge-monitor schedule can be turned on for free once there is a real bridge (`*/15`)

## 5. Maintenance cycle

- After a watched contract has been called: change the entries in `BRIDGE_WATCHLIST` (one that has been called is considered disclosed)
- Neuro rules whose embargo period has ended: a workflow in `zetaphy-private` opens an issue to move them to the public repo, then vote in the new skill
- Rotate `BRIDGE_MARKER_KEY` and the various tokens every 6 months, or immediately if a leak is suspected
  - Changing the marker: governance votes `setMarker(new, true)` then `setMarker(old, false)`
  - After changing the watch list / marker key / thresholds, the monitor starts a fresh memory (its state is encrypted with these values), but it does not need to rescan old blocks
- After governance `untrip`s held entries, the runner releases them by itself in the next run (they are not dropped)
- Marker leaked: the guardian calls `emergencyRemoveMarker(that address)` immediately. It can no longer add marks, but the marks it already made stay in effect until governance decides through the timelock: `setMarker(that address, false)` revokes all of its marks, or `untrip` one address at a time
- After the handover, changing a marker, guardian, price relayer, or the owners of a multisig that is a proposer all goes through the timelock (48-hour wait); plan ahead
- Price relayer leaked: the guardian `pauseFeed`s immediately, then schedules `setRelayer(that address, false)` through the timelock
