# BZTPHY: testnet reward points, converted to real ZETAPHY at mainnet

People who help run the ZETAPHY testnet (validators and Neuro runners) earn **BZTPHY** points every day, automatically.
When mainnet launches, all points are converted to **real ZETAPHY**, placed in the mainnet genesis at the same addresses.

## How to earn (per UTC day)

| Work | Points |
|---|---|
| Validator | 100 BZTPHY a day, paid by the minute: 100 × (minutes it signed) ÷ 1,440. One block is checked each minute of the UTC day; joining at noon and staying online earns about 50, and so does stopping at noon. No minimum |
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

## How much ZETAPHY, and is it worth it?

Nobody can say yet, and nobody should promise you. What you get depends on two things:

1. **Your share of all points.** The pool is fixed (50,000,000 ZETAPHY), so the more people earn points, the smaller each share.
   Examples for a validator online every minute of the day (100 BZTPHY a day):

   | Validators earning (all at 100%) | Your share | Your ZETAPHY at mainnet |
   |---|---|---|
   | 10 | 10% | 5,000,000 |
   | 25 | 4% | 2,000,000 |
   | 50 | 2% | 1,000,000 |
   | 200 (the daily cap then shrinks everyone equally) | 0.5% | 250,000 |

   The program length does not change these shares when everyone runs the whole time; joining late or going offline lowers yours.
   Neuro runners' points come out of the same pool.
2. **What ZETAPHY will be worth.** Today it has no price and no market. It is worth something only if mainnet launches
   (after an audit, no date yet) and people want to use it. It could be worth very little.

So: on a free machine (Oracle, Google, a home PC you already own) the cost is your time and electricity, and the upside is a
share of the pool. On a paid server (about US$5-12 a month) you pay real money for something with no known value:
decide for yourself, and do not spend money you cannot lose.

## Rules

- **BZTPHY cannot be transferred, sold or approved** (the contract refuses). It records who did the work; it is not something to trade.
  Anyone offering to sell BZTPHY or "early ZETAPHY" is a scammer.
- One person, one validator. If someone runs many validators or fake runners to farm points, governance can take the points back (`revoke`).
- At most 5,000 BZTPHY can be awarded per day in total. When more was earned than that, every award that day shrinks by the same share (e.g. 60 validators at 100% get 83.33 each). If the awarding key ever leaks, the damage is limited to one day and can be revoked.
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
