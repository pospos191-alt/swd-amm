# ZETAPHY on Oracle Cloud (free)

One button gives you one Always Free machine with ZETAPHY installed automatically. No commands to type, no cost.

[![Deploy to Oracle Cloud](https://oci-resourcemanager-plugin.plugins.oci.oraclecloud.com/latest/deploy-to-oracle-cloud.svg)](https://cloud.oracle.com/resourcemanager/stacks/create?zipUrl=https://github.com/pospos191-alt/swd-amm/releases/download/oracle-stack/zetaphy-oracle-stack.zip)

## Just 4 steps

1. Click **Deploy to Oracle Cloud** above and sign in to Oracle
2. Tick **I have reviewed and accept the Oracle Terms of Use**, then click **Next**
3. Choose **Machine size** (`VM.Standard.A1.Flex` recommended) and **What to install**
   (`runner`, `agents`, `validator`, or a combination), then click **Next**
4. Tick **Run apply** and click **Create**

Wait about 5 minutes; the install finishes by itself.

## See the runner or validator address

- Open the Stack > latest Job > **Outputs** to see `public_ip`
- Go to Compute > Instances > `zetaphy-node` > **Run command** and run `sudo zetaphy-runner address`
  (runner) or `sudo zetaphy-validator status` (validator), then read the output

## New chain: ZETAPHY EVOLVE (Evolve rollup on Celestia)

Pick **What to install** = `evolve` (it needs `VM.Standard.A1.Flex`; the stack gives it 2 CPU / 12 GB,
still Always Free). It starts a **new chain** (chain id `77392`, coin ZEVO) — the ZETAPHY chain is not touched.

1. After Apply, open Compute > Instances > `zetaphy-node` > **Run command** and run `sudo zetaphy-evolve status`
2. Send free Mocha TIA to the `celestia1…` address it prints
   ([mocha.celenium.io/faucet](https://mocha.celenium.io/faucet) or
   [faucet.noders.services/celestia](https://faucet.noders.services/celestia))
3. About 20–40 minutes later `sudo zetaphy-evolve status` shows the chain height and the MetaMask RPC
   (`https://<ip-with-dashes>.sslip.io`). Details: [`zetaphy-evolve/README.md`](../../zetaphy-evolve/README.md)

## If it says "Out of host capacity"

Oracle has no free machine available right now. **Nothing is broken and nothing is charged.**
Click **Apply** again later (for example in a few hours), or click **Edit** and choose `VM.Standard.E2.1.Micro` instead.

## Remove it

Stack page > **Destroy** > confirm. The machine and network are deleted (then **Delete stack** if you like).

Everything stays inside the Always Free quota, so there is no cost.
