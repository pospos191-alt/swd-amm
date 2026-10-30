**English** | [ภาษาไทย](EARLY.th.md)

# ZETAPHY Early (ZEARLY): the community token of the testnet airdrop

| | |
|---|---|
| Name / symbol | ZETAPHY Early / **ZEARLY**, 18 decimals |
| Chain | ZETAPHY testnet (chain ID 77390), an ERC-20 (`zetaphy-network/contracts/ZetaphyEarly.sol`) |
| Supply | **1,000,000,000**, all created once at deploy for the airdrop wallet |
| Who can make more | Nobody: no owner, no mint, no pause, no fee |
| Address | `early-testnet.json` in this folder, once deployed |
| Logo | `logo/zearly.svg`, `logo/zearly-512.png`, `-256`, `-64` (a white Z with a gold stroke and a gold dot, on a dark coin); wallets show it via the hub's "Add to wallet" and `app.sawasdeecoin.com/tokenlist.json` |

ZEARLY shows who joined ZETAPHY early. Anyone can hold it, send it and trade it on the ZETAPHY Swap.
**It has no value, it is not ZETAPHY, and it is never converted into ZETAPHY** (unlike BZTPHY, the validators' and
runners' reward points, README.md). It is a test token on a test network; nothing here is investment advice.

## What ZEARLY can do (more than a meme coin; no web page of its own)

| | Contract | How people use it |
|---|---|---|
| Swap | ZEARLY/ZETAPHY pool on the ZETAPHY Swap | swap.sawasdeecoin.com: ZEARLY is in its token list |
| Early Pass | `ZetaphyEarlyPass` (ZEPASS) | an NFT bought with 1,000 ZEARLY (burned); one per wallet; for the first 14 days only wallets holding 10,000 ZEARLY; picture drawn on chain; shows on the NFT market like any ERC-721 |
| Quests | `ZetaphyQuests` | paid by themselves every day: first swap 1,000; liquidity in the pool 5,000; an Early Pass 2,000; staking ZETAPHY 2,000. Each wallet once per quest, recorded on chain |
| Farm | `ZetaphyEarlyFarm` | stake the pool's LP, earn ZEARLY (50,000,000 over 90 days); withdraw any time |
| Polls | `ZetaphyEarlyPolls` | opinion polls weighted by ZEARLY locked until the end (1,000 ZEARLY deposit to open one, given back) |
| Cross-chain | Saphan token routes | to Sepolia, Base Sepolia, Arbitrum Sepolia as zZEARLY (added after deploy, opened by both timelocks) |

None of this changes what ZEARLY is: a fixed supply nobody can add to, no owner, no value.
The Early Pass, the farm and polls are contract calls (approve, then `mint` / `stake` / `vote`), for now from a tool
that can call a contract; quests and the Swap need nothing special.

**Maintainers, in order (Actions → `early-token`):** `deploy` → merge `rewards/early` → `pool` → merge → `extras`
→ merge. Quests then run every day by themselves (`quests` by hand for a dry run).

## How people get it

1. They send `/claim <their 0x… or zetaphy1…>` to the Telegram bot **@awasdeebot** (one wallet per Telegram
   account; members of @ZETAPHYOfficial). Each wallet gets **10,000 ZEARLY** and 100 test ZETAPHY.
2. They see it in MetaMask: add the ZETAPHY network (app.sawasdeecoin.com, "Add network"), then **Import token**
   with the ZEARLY address.

With 10,000 people that is 100,000,000 ZEARLY (10%); the rest stays in the airdrop wallet for later rounds.

## For maintainers

1. **Deploy (once):** Actions → `early-token` → mode `deploy`. Merge the `rewards/early` branch it pushes
   (it adds `early-testnet.json`). The deployer key (`ZETAPHY_DEPLOYER_KEY`) holds all of it: the airdrop wallet.
2. **Tell the bot:** in Vercel, project `swd-amm-zetaphy-neuro`, set `AIRDROP_EARLY` = `10000` and
   `EARLY_TOKEN` = the address, then redeploy. `/claim` then mentions ZEARLY and the address to import.
3. **Send a round:**
   - in the bot, `/export` (admins): `airdrop.txt`;
   - on GitHub, upload it as `zetaphy-chain/rewards/early-airdrop.txt` (Add file → Upload, in a pull request);
   - Actions → `early-token` → mode `airdrop`, `send` unticked: a dry run (how many, how much, balance);
   - the same with `send` ticked. Wallets paid before are skipped (read from the chain), so the next round
     pays only new ones.
   - the 100 test ZETAPHY of the same list: `gov.sh airdrop airdrop.txt 100` on the genesis node (README.md
     of zetaphy-chain, "Testnet airdrop").

**The chain's own users first:** Actions → `early-token` → mode `collect` (`max` 1000) lists the wallets that already
used ZETAPHY (faucet, mining, transfers, swaps, staking; contracts, module accounts and big funds left out) and pushes
`early-users.txt` to the branch `rewards/early-users`. Merge it, then mode `airdrop` with list =
`zetaphy-chain/rewards/early-users.txt`.

The script: `node zetaphy-network/scripts/early.js deploy | airdrop --list <file> [--each 10000] [--send] | collect [--max 1000]`.
Tests: `zetaphy-network/test/early.test.js` (the token, and deploy + airdrop end to end with signed transactions).
