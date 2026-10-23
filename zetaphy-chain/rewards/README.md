# BZTPHY: testnet reward points, converted to real ZETAPHY at mainnet

People who help run the ZETAPHY testnet (validators and Neuro runners) earn **BZTPHY** points every day, automatically.
When mainnet launches, all points are converted to **real ZETAPHY**, placed in the mainnet genesis at the same addresses.

## How to earn (per UTC day)

| Work | Points |
|---|---|
| Validator (bonded, not jailed) | 100 BZTPHY × uptime (e.g. 95% online earns 95); at least 50% uptime required |
| Neuro runner | 2 BZTPHY per job you revealed a verdict for, at most 50 a day |

- Points go to the EVM address (0x…) of the validator or runner account itself. See them in MetaMask: Import token with the BZTPHY address.
- GitHub Actions computes the awards from on-chain data and sends them every day at 00:23 UTC.
- The team's founding node (`zetaphy-validator-0`) earns nothing: the team already has its own allocation.

## Conversion to real ZETAPHY

- Reward pool: **50,000,000 ZETAPHY** (5% of the total supply), taken from the 50% rewards allocation.
- At mainnet, governance votes to `freeze` the program, and the pool is split pro rata:
  `your ZETAPHY = 50,000,000 × your points ÷ all points`
- Pro rata means the promise can never exceed the pool. Those who work longer and more reliably get more.
- Anyone can recompute it: `node zetaphy-network/scripts/points.js snapshot --pool 50000000`

## Rules

- **BZTPHY cannot be transferred, sold or approved** (the contract refuses). It records who did the work; it is not something to trade.
  Anyone offering to sell BZTPHY or "early ZETAPHY" is a scammer.
- One person, one validator. If someone runs many validators or fake runners to farm points, governance can take the points back (`revoke`).
- At most 5,000 BZTPHY can be awarded per day in total. If the awarding key ever leaks, the damage is limited to one day and can be revoked.
- The contract owner is the chain's governance (ZetaphyTimelock). Revoking, changing the cap or freezing all need a vote.
- Point rates may be changed by a vote, announced in advance.

## Please note

- Mainnet launches only after a security audit. There is no date yet.
- This page describes the project's plan. It is not a legal contract, and not an offer to sell securities or tokens.
  Before any real distribution, the team will check the applicable rules on digital assets (in Thailand, the SEC).

## For maintainers

- Start: Actions → `rewards` → Run workflow → `deploy` (the secret `ZETAPHY_DEPLOYER_KEY` becomes the minter; owner = the timelock),
  then merge the resulting `rewards/testnet` branch. Awards then run every day by themselves.
- Award a past day: `rewards` → `award` with the day number (UTC day = unix time ÷ 86400). Nothing is ever paid twice.
- Change rates: set `POINTS_CONFIG` in the workflow, e.g. `{"validatorDaily": 120}`.
