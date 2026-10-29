# Secrets hardening: keys only through GitHub Environments

[ภาษาไทย](SECRETS-HARDENING.th.md)

Every GitHub Actions job that uses a private key or token now reads it from a **GitHub Environment**,
not from repository-level secrets. A repository secret can be read by any workflow on any branch that
anyone with write access pushes. An environment secret is only handed to a job that names the
environment, and only after the environment's rules pass: which branches may use it, and (for the
signing environments) an approval click from the owner.

> **The rule: testnet only.** These environments hold **testnet** keys. For mainnet, never put a
> deployer, admin or upgrade key in CI at all, not in an environment either. Mainnet deploys and admin
> calls are signed by a **Safe multisig with hardware wallets** (or a hardware wallet directly). CI may
> prepare the transaction (calldata, a Safe Transaction Builder JSON, a gov proposal), and people sign it.

Nothing in this document, and nothing in the workflows, contains a secret value. Never paste one into an
issue, a pull request, a chat or a log.

## 1. Inventory

Triggers: `PR` = pull_request, `push`, `sched` = schedule, `manual` = workflow_dispatch.
No workflow uses `pull_request_target` or `workflow_run` (checked; see section 5).

| Secret | What it is | Workflow → job | Triggers of the workflow | Job runs on PRs? | Environment |
|---|---|---|---|---|---|
| `ZETAPHY_DEPLOYER_KEY` | testnet deployer EVM key (`0x6af5…a245`); also BZTPHY minter, relayer signer fallback | `bridge-testnet` → `deploy` | PR, manual | no (manual `deploy` only) | `testnet-deploy` |
| | | `hyperlane-core` → `deploy` | manual | no | `testnet-deploy` |
| | | `launch-testnet` → `launch` | manual | no | `testnet-deploy` |
| | | `rewards` → `deploy` | PR, sched, manual | no (manual `deploy` only) | `testnet-deploy` |
| | | `saphan-route` → `deploy` | PR, manual | no (manual `deploy` only) | `testnet-deploy` |
| | | `neuro-oracle` → `deploy` | PR, manual | no (manual `deploy` only) | `testnet-deploy` |
| | | `timelock` → `execute` | manual | no | `testnet-deploy` |
| | | `neuro-fl` → `deploy` (FederatedRounds, closed, owned by the timelock; `mode: deploy` only) | sched, PR, manual | no (manual `deploy` only; the weekly `aggregate` and `propose` jobs use no stored secret) | `testnet-deploy` |
| | | `rewards` → `award` | PR, sched, manual | no (daily schedule, manual `award`) | `testnet-automation` |
| | | `hyperlane-relayer` → `relay` (fallback signer) | sched, manual | no | `testnet-automation` |
| `ZETAPHY_RELAYER_KEY` (new, optional) | dedicated relayer signer; used instead of the deployer key when set | `hyperlane-relayer` → `relay` | sched, manual | no | `testnet-automation` |
| `USEFUL_WORK_FEEDER_KEY` (new, optional) | the useful-work job feeder (posts scan jobs and canaries, reveals, settles; a governance-named feeder with a little testnet ZETAPHY, never the deployer) | `useful-work` → `feed` | sched, manual | no | `testnet-automation` |
| | | `useful-work` → `deploy` uses `ZETAPHY_DEPLOYER_KEY` (above) | manual | no | `testnet-deploy` |
| `MARKETS_KEY` (optional) | testnet key that owns the detector organisms (commits / reveals forecasts, registers children) | `markets` → `detectors` | sched, manual | no | `testnet-automation` |
| `ZETAPHY_VALIDATOR_KEY` | our Hyperlane validator key (signs ZETAPHY checkpoints) | `hyperlane-relayer` → `relay` | sched, manual | no | `testnet-automation` |
| | | `saphan-route` → `validator-address` (prints the address only) | PR, manual | no (manual `check` / `deploy`) | `testnet-automation` |
| `BRIDGE_MARKER_KEY` | private key of an airlock *marker* (marks callers, moves no funds) | `bridge-monitor` → `monitor` | manual (schedule commented out, planned) | no | `monitoring` |
| `BRIDGE_WATCHLIST`, `BRIDGE_MONITOR_THRESHOLDS` | private monitor config | `bridge-monitor` → `monitor` | manual (sched planned) | no | `monitoring` |
| `PRIVATE_ALERTS_TOKEN` | fine-grained PAT, Issues on the private alerts repo | `bridge-monitor` → `monitor` | manual (sched planned) | no | `monitoring` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` | alert channels | `bridge-monitor` → `monitor` | manual (sched planned) | no | `monitoring` |
| `ETHERSCAN_API_KEY` | explorer API key (verifies source) | `zetaphy-verify` → `verify` | sched, push to main, manual | no | `explorer-verify` |
| `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR` | Solana **devnet** deployer + program keypair | `CI` (security.yml) → `deploy-devnet` | push, PR, sched, manual | no (manual with `deploy_devnet` only) | `devnet` (already existed) |
| `MAINNET_RPC_URL` | Solana RPC URL (may embed a provider API key); read only, signs nothing | `CI` (security.yml) → `program` | push, PR, sched, manual | **yes** | none, stays a repository secret (see below) |
| `GITHUB_TOKEN` (built in) | per-run token | many | | | not a stored secret; scoped by `permissions:` |

**Why `MAINNET_RPC_URL` stays a repository secret.** The `program` job runs the Anchor tests on every pull
request. An environment with a branch rule would block PR branches and a reviewer would put a click on
every PR. It signs nothing and moves no funds: the worst case is someone using the RPC quota. GitHub
never passes it to pull requests from forks. Keep it a low-value key: a free-tier or rate-limited
endpoint, origin-restricted if the provider allows, and rotate it if in doubt.

`NPM_TOKEN` (docs/LAUNCH.md) is not used by any workflow today. If a publishing workflow is added, give it the
`release` environment.

## 2. The environments

| Environment | Secrets | Deployment branches | Required reviewers | Why |
|---|---|---|---|---|
| `testnet-deploy` | `ZETAPHY_DEPLOYER_KEY` | `main` only | **owner** | manual deploys and timelock execute: a person approves every run |
| `testnet-automation` | `ZETAPHY_VALIDATOR_KEY`, `ZETAPHY_DEPLOYER_KEY` (BZTPHY minter; relayer fallback), `ZETAPHY_RELAYER_KEY` (optional), `USEFUL_WORK_FEEDER_KEY` (optional), `MARKETS_KEY` (optional) | `main` only | **none** | scheduled (relayer every 15 min, daily awards): a reviewer would hold every scheduled run |
| `monitoring` | `BRIDGE_*`, `TELEGRAM_*`, `DISCORD_WEBHOOK_URL`, `PRIVATE_ALERTS_TOKEN` | `main` only | **none** | will run on a schedule |
| `explorer-verify` | `ETHERSCAN_API_KEY` | `main` only | **none** | daily schedule |
| `devnet` | `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR` | `main` only | **owner** | manual Solana devnet deploy |
| `release` | none (gates publishing with `GITHUB_TOKEN`: `release-zetaphyd`, `oracle-stack` release jobs) | `main` only | owner, recommended (optional) | a person approves each published release; leave reviewers off if the automatic publish on push to main should not wait |

**Scheduled runs and reviewers.** A required reviewer pauses the job until someone clicks *Approve*, and a
scheduled run would wait (and expire after 30 days). So the scheduled environments (`testnet-automation`,
`monitoring`, `explorer-verify`) use **only the branch rule**. Their protection is: only code that is on
`main` can read them, so keep `main` protected (pull request + review before merge, no force push), or
the branch rule protects nothing.

**The deployer key sits in two environments** (`testnet-deploy` with a reviewer, `testnet-automation` without)
because it is still the BZTPHY minter (daily awards) and the relayer's signer. Until that is split, the key's
real protection is `main`'s branch protection. To remove it from `testnet-automation`:
1. Make a new key for the relayer, fund it with a little testnet ETH on each source chain, and add it as
   `ZETAPHY_RELAYER_KEY` in `testnet-automation` (the relayer already prefers it).
2. Through the timelock, grant the BZTPHY minter role to a new dedicated awards key, revoke it from the
   deployer, and change `DEPLOYER` in the `award` job of `rewards.yml` to the new address (or add a separate
   secret for it).
3. Then delete `ZETAPHY_DEPLOYER_KEY` from `testnet-automation`: it lives only behind the reviewer.

## 3. What the owner clicks (GitHub → repo `swd-amm`)

Do this once. It takes about 10 minutes. Keep two browser tabs open: **Settings → Environments** and
**Settings → Secrets and variables → Actions**.

### 3.1 Protect `main` first

**Settings → Branches** (or **Rules → Rulesets**) → a rule for `main`: *Require a pull request before
merging*, *Block force pushes*, *Restrict deletions*. Without it, "main only" means "anyone who can push to main".

### 3.2 Create each environment

For each of `testnet-deploy`, `testnet-automation`, `monitoring`, `explorer-verify`, `devnet`
(it may exist already: open it), `release`:

1. **Settings → Environments → New environment** → Name exactly as in the table (lowercase, with the dash) →
   **Configure environment**.
2. **Deployment protection rules**:
   - `testnet-deploy`, `devnet` (and `release` if you want to approve releases): tick **Required reviewers** →
     add yourself (the owner) → leave *Prevent self-review* **off** (you are the only reviewer, and you start the run) →
     **Save protection rules**.
   - `testnet-automation`, `monitoring`, `explorer-verify`: leave **Required reviewers off** and *Wait timer* at 0.
   - Untick **Allow administrators to bypass configured protection rules**, if shown.
3. **Deployment branches and tags** → change *No restriction* to **Selected branches and tags** →
   **Add deployment branch or tag rule** → Ref type *Branch*, Name pattern `main` → **Add rule**.
4. Do not add *Environment variables*: none are needed.

### 3.3 Move each secret into its environment, then delete the repository copy

GitHub never shows a secret's value again, so "moving" means: add it to the environment from your own copy (the
password manager, MetaMask "Show private key", the provider's dashboard), then delete the repository-level one.

For each row of the table in section 2:

1. **Settings → Environments → `<environment>` → Environment secrets → Add environment secret** →
   Name exactly as listed (e.g. `ZETAPHY_DEPLOYER_KEY`) → paste the value → **Add secret**. Clear the clipboard.
   - `ZETAPHY_DEPLOYER_KEY`: add it to **both** `testnet-deploy` and `testnet-automation` (section 2 says why
     and how to stop needing the second copy).
   - If you do not have a value any more (e.g. a token you never saved), make a new one at its source
     (new Telegram bot token with @BotFather `/revoke`, a new fine-grained PAT, a new Etherscan key) and revoke the old one.
2. When every secret is in its environment: **Settings → Secrets and variables → Actions → Repository secrets** →
   delete each of these with the 🗑 icon:
   `ZETAPHY_DEPLOYER_KEY`, `ZETAPHY_VALIDATOR_KEY`, `BRIDGE_MARKER_KEY`, `BRIDGE_WATCHLIST`,
   `BRIDGE_MONITOR_THRESHOLDS`, `PRIVATE_ALERTS_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `DISCORD_WEBHOOK_URL`, `ETHERSCAN_API_KEY`, `DEVNET_DEPLOYER_KEYPAIR`, `PROGRAM_KEYPAIR`.
   **Keep** `MAINNET_RPC_URL` (section 1). Also check **Organization secrets** shown on that page: none should
   be a signing key.
3. Repository-level secrets are what a malicious branch could read. After step 2 the only one left should be
   `MAINNET_RPC_URL`.

### 3.4 Actions settings for pull requests

**Settings → Actions → General**:
- *Fork pull request workflows from outside collaborators*: **Require approval for all external contributors**
  (or *first-time contributors* at least).
- If the repository is private: *Fork pull request workflows in private repositories*: leave **Send secrets and
  variables to workflows from fork pull requests** and **Send write tokens to workflows from fork pull requests**
  **off**.
- *Workflow permissions*: **Read repository contents and packages permissions** (the workflows ask for write
  where they need it). Keep *Allow GitHub Actions to create and approve pull requests* as you have it
  (`launch-testnet` / `hyperlane-core` open PRs; they print the link otherwise).

### 3.5 Check that it works

- Actions → **saphan-route** → Run workflow on `main`, `mode = check`: the `route` job runs at once, the
  `validator-address` job reads `ZETAPHY_VALIDATOR_KEY` from `testnet-automation` and prints its address.
- Actions → **hyperlane-relayer** → Run workflow on `main`: it starts without waiting for approval.
- Actions → **timelock** → `action = status`: runs at once (no key). `action = execute`: shows
  *Waiting for review: testnet-deploy* → **Review deployments** → tick `testnet-deploy` → **Approve and deploy**.
- Run any of these on a branch other than `main`: the environment job fails with "branch is not allowed to deploy",
  which is the point.

## 4. What changed in the workflows

- **Split jobs** so that pull requests, `check` and `dry_run` never touch a key or an environment, and PR CI
  keeps working without approvals (also for fork PRs, which get no secrets anyway):
  `bridge-testnet` (`bridge` | `deploy`), `rewards` (`dry-run` | `deploy` | `award`), `saphan-route`
  (`route` | `validator-address` | `deploy`), `hyperlane-core` (`dry-run` | `deploy`), `timelock`
  (`timelock` for status/schedule/cancel | `execute`), `neuro-oracle` (`oracle` for check/dry_run/verify | `deploy`).
- `environment:` added to exactly the jobs that read a key (section 1). Every one of them is conditioned on
  `workflow_dispatch` or `schedule`, never `pull_request`.
- `launch-testnet`: its dry run also reads the key (it checks the deployer's address and balance), so the whole
  job is behind `testnet-deploy`: approve the dry run too.
- **Least privilege**: every workflow's top-level `permissions:` is `contents: read`; `contents: write` /
  `pull-requests: write` only on the jobs that push a branch or open a PR (the deploy jobs, the release jobs).
- `actions/checkout` with `persist-credentials: false` everywhere except the jobs that `git push` or
  `git fetch` afterwards (the deploy jobs of `bridge-testnet`, `rewards`, `saphan-route`, `neuro-oracle`, `hyperlane-core`,
  `launch-testnet`, and both `timelock` jobs).
- `hyperlane-relayer` signs with `ZETAPHY_RELAYER_KEY` when it is set, else `ZETAPHY_DEPLOYER_KEY`.
- Third-party actions were already pinned by commit SHA (`foundry-rs/foundry-toolchain`, `hashicorp/setup-terraform`,
  `dtolnay/rust-toolchain`, `Swatinem/rust-cache`, `taiki-e/install-action`, `actions/attest-build-provenance`).
  GitHub's own `actions/*` are on major tags; pinning them by SHA too (e.g. with Dependabot for `github-actions`)
  is a reasonable next step.

## 5. Dangerous patterns checked

- `pull_request_target`: **not used**. (It runs with secrets and a write token in the base repository's context;
  combined with a checkout of the PR head it lets any fork run code with your keys. Do not add it.)
- `workflow_run` chains: **not used**.
- Secrets in PR-triggered jobs: before this change the key-reading steps were in the same job as the PR dry
  runs, guarded only by step-level `if:` on `workflow_dispatch`. A same-repo PR branch could edit that `if:`
  and receive the repository secret. Now the keys are environment secrets and the environments only allow
  `main`, so a PR branch, even one that rewrites the workflow, cannot read them.
- Same-repo PR branches still receive `MAINNET_RPC_URL` (read-only, low value; section 1).
- Keys are written to `$RUNNER_TEMP` with `umask 077`, masked (`::add-mask::`), checked against the expected
  address before use and deleted in an `if: always()` step; unchanged.

## 6. Mainnet

- No mainnet key in GitHub: not as a repository secret, not in an environment, not in a self-hosted runner.
- Mainnet contracts are deployed and administered from a **Safe multisig** whose owners are **hardware wallets**
  (Ledger/Trezor/Keystone), with a timelock in front of admin functions. CI's job is to build and verify what
  is signed: compiled artifacts, deterministic addresses, calldata, a Safe Transaction Builder batch, a
  governance proposal.
- Solana mainnet: the program's upgrade authority is a Squads multisig of hardware wallets; CI never holds it.
- A testnet key must never be reused on mainnet, and a mainnet key never on testnet.
