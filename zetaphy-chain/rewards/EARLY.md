**English** | [ภาษาไทย](EARLY.th.md)

# ZETAPHY Early (ZEARLY): the community token of the testnet airdrop

| | |
|---|---|
| Name / symbol | ZETAPHY Early / **ZEARLY**, 18 decimals |
| Chain | ZETAPHY testnet (chain ID 77390), an ERC-20 (`zetaphy-network/contracts/ZetaphyEarly.sol`) |
| Supply | **1,000,000,000**, all created once at deploy for the airdrop wallet |
| Who can make more | Nobody: no owner, no mint, no pause, no fee |
| Address | `early-testnet.json` in this folder, once deployed |

ZEARLY shows who joined ZETAPHY early. Anyone can hold it, send it and trade it on the ZETAPHY Swap.
**It has no value, it is not ZETAPHY, and it is never converted into ZETAPHY** (unlike BZTPHY, the validators' and
runners' reward points, README.md). It is a test token on a test network; nothing here is investment advice.

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

The script: `node zetaphy-network/scripts/early.js deploy | airdrop --list <file> [--each 10000] [--send]`.
Tests: `zetaphy-network/test/early.test.js` (the token, and deploy + airdrop end to end with signed transactions).
