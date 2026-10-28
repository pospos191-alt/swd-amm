**English** | [ภาษาไทย](README.th.md)

# ZETAPHY Saphan: real USDC from Noble into the ZETAPHY chain via IBC (testnet first)

**ZETAPHY Saphan** ("bridge" in Thai) is ZETAPHY's cross-chain system; its first route is Noble over IBC.
People use it from the **Saphan** tab at app.sawasdeecoin.com:
- **Out:** from MetaMask through the ICS-20 precompile (`0x…0802`), no Keplr needed
- **In:** from a wallet on the other chain (e.g. Keplr on Noble) to the `zetaphy1…` address
- The tab reads the open channels from the chain itself: a new channel shows up there with no site change

**Google Cloud (e2-micro):** for steps 1–2 below use the VM's **SSH** button instead of Oracle's Cloud Shell,
and fetch the scripts straight from the repo:
```bash
curl -fsSLO https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-chain/ibc/setup-relayer.sh
curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/zetaphy-chain/gov.sh | sudo install -m 755 /dev/stdin /usr/local/bin/gov.sh
```
The relayer is capped at 300 MB of memory (`MemoryMax`): if it ever grows, the system restarts the relayer, not the node.

### Osmosis testnet route (instead of Noble, e.g. while Circle's faucet is down)
Give `ROUTE=osmosis` once; the script remembers it, later commands stay the same:
```bash
sudo ROUTE=osmosis bash setup-relayer.sh          # prints 0x… (ZETAPHY) and osmo1…
```
1. Send 10 ZETAPHY from MetaMask to the relayer's `0x…`
2. Open **faucet.testnet.osmosis.zone**, paste the `osmo1…` address, ask for OSMO (gas on Osmosis)
3. `sudo bash setup-relayer.sh balances` → `create-channel` → `start`
4. First transfer in: `sudo bash setup-relayer.sh send-usdc <your 0x…> 1000000` (on this route: 1 OSMO)

Values from chain-registry (`testnets/osmosistestnet`): chain `osmo-test-5`, RPC `rpc.osmotest5.osmosis.zone`,
gas in `uosmo` priced by the fee market (`dynamic_gas_price`). `ROUTE=noble` switches back.

**Noble** is a Cosmos chain where Circle issues USDC itself directly (native USDC, not a bridge's wrapped coin)
We connect ZETAPHY to Noble with **IBC**: the two chains verify each other with light clients
A **relayer** (the Hermes program) carries messages between the two chains. The relayer runs on the same Oracle machine as the node

```
Noble (uusdc) ──IBC transfer/channel──▶ ZETAPHY: coin ibc/<hash>
                                          └─ ERC-20 at 0x… (MetaMask sees it as USDC)
                                          └─ x/ratelimit cap (e.g. 1% per 24 hours)
```

- Free: Hermes is open software, gas on Noble testnet is paid with USDC from the faucet, and ZETAPHY testnet coins have no value
- **Nothing runs on your computer**: every step is done in the browser (Oracle Cloud Shell, the faucet page, MetaMask)
- **No secrets for you to hold**: the relayer's keys are created on the node machine and are never printed. You only see the (public) addresses to top up gas
- **testnet first.** mainnet is possible only after the audit conditions are met (section "Path to mainnet")

Files in this folder:

| File | What it does |
|---|---|
| `setup-relayer.sh` | Installs Hermes (pinned version and SHA-256), the `relayer` user, keys, config, opens the channel, service |
| `test-ibc.sh` | Proves the whole system on 2 test chains (no real Noble needed) |
| `../gov.sh` | `ibc-usdc-*` commands: coin name, ERC-20, cap (through a vote) |

---

## Noble testnet values used (and their sources)

| Value | Used | Source / status |
|---|---|---|
| Chain ID | `grand-1` | ✅ `noble-assets/noble` file `upgrade/constants.go` (`TestnetChainID = "grand-1"`) and cosmos/chain-registry `testnets/nobletestnet/chain.json` |
| RPC | `https://noble-testnet-rpc.polkachu.com:443` (backup `https://rpc.testnet.noble.strange.love:443`) | chain-registry (commit `05d3261`, 20 Oct 2026) ⚠️ TODO: not yet tried for real (the test machine cannot reach Noble over the network) |
| Websocket | `wss://noble-testnet-rpc.polkachu.com/websocket` | Derived from RPC ⚠️ TODO: if it cannot connect, use `NOBLE_EVENTS=pull` |
| gRPC | `http://noble-testnet-grpc.polkachu.com:21590` | chain-registry lists `noble-testnet-grpc.polkachu.com:21590` ⚠️ TODO: it does not say whether it is TLS. Unencrypted (`http://`) is used for now; if `status` reports an error, try `https://` |
| USDC coin | `uusdc` (6 decimals: 1 USDC = 1,000,000 uusdc) | ✅ chain-registry `testnets/nobletestnet/assetlist.json` |
| Gas on Noble | paid in `uusdc`, set to `0.1` uusdc/gas | chain-registry testnet: low 0.01 / average 0.025 / high 0.03 (fixed min 0); mainnet: 0.1. We use 0.1 because it works for both (slightly more expensive) ⚠️ TODO: confirm the current minimum from a real node |
| Address | starts with `noble1…`, coin type 118, secp256k1 key | ✅ chain-registry |
| Unbonding | 21 days → set `trusting_period = 14days` | ✅ chain-registry (`lock_duration 1814400s`) |
| Faucet | **faucet.circle.com** → choose **Noble Testnet** → get test USDC | ⚠️ TODO: from web search results (the Circle page says the Public Faucet supports Noble Testnet). The page could not be opened directly from the test machine. chain-registry has no faucet entry for Noble testnet. See the faucet page for the amount per request / frequency |
| Explorer | `https://mintscan.io/noble-testnet`, `https://explore.strange.love/grand-1` | chain-registry |

ZETAPHY-side values match `setup-node.sh`: `zetaphy_77390-1`, RPC `127.0.0.1:26657`, gRPC `127.0.0.1:9090` (local machine only), gas price 2 gwei (`2000000000azetaphy`), key `eth_secp256k1`

Every value can be changed with variables, e.g. `sudo NOBLE_RPC=https://… NOBLE_GRPC=http://… bash setup-relayer.sh config`. The script remembers the values in `/home/relayer/.hermes/settings.env`, so you do not need to type them again next time

---

## Steps (all in the browser)

Before you start: the ZETAPHY chain is running (`docs/LAUNCH.md` items 1–2) and you have MetaMask connected to ZETAPHY testnet

### 1. Log in to the node machine
Oracle page → **Cloud Shell** icon `>_` at the top right → ⚙ → **Upload** the private key file you saved when creating the machine, then:
```bash
chmod 600 ssh-key-*.key && ssh -i ssh-key-*.key ubuntu@<Public IP>
```

### 2. Put the script on the machine
On GitHub, open `zetaphy-chain/ibc/setup-relayer.sh` → **Raw** → copy all, then in the machine's window:
```bash
cat > setup-relayer.sh      # paste, then press Ctrl-D
```
(If the repo is public, you can use `curl -fsSLO https://raw.githubusercontent.com/<owner>/swd-amm/main/zetaphy-chain/ibc/setup-relayer.sh` instead)
Do the same for `zetaphy-chain/gov.sh` if it is not on the machine yet (`sudo install -m 755 gov.sh /usr/local/bin/gov.sh`)

### 3. Install the relayer
```bash
sudo bash setup-relayer.sh
```
- Downloads Hermes v1.13.3 from GitHub and checks the pinned SHA-256 (x86_64, and aarch64 for Ampere). No match = not installed
- Creates the `relayer` user (no password, no sudo rights) and the config at `/home/relayer/.hermes/config.toml`
- Creates 2 keys: ZETAPHY (`eth_secp256k1`, path `m/44'/60'/0'/0/0` like MetaMask) and Noble (`m/44'/118'/0'/0/0`)
  Created from the machine's entropy and stored where only the `relayer` user can read them. The temporary seed file is destroyed with `shred`
- Prints **only the addresses**, e.g.
  ```
  ZETAPHY (zetaphy_77390-1):  zetaphy1…
                               0x…  (the same account in MetaMask)
  Noble   (grand-1):  noble1…
  ```
Can be re-run: things that already exist (Hermes, user, keys) are not created again

### 4. Top up gas
1. **ZETAPHY**: in MetaMask, send **10 ZTPHY** to the relayer's `0x…` address (enough for several months)
2. **Noble**: open **faucet.circle.com** → choose **USDC** and **Noble Testnet** → paste the `noble1…` address → request
   This USDC is used both as gas on Noble and as the USDC to transfer into ZETAPHY
3. Check: `sudo bash setup-relayer.sh balances`

### 5. Open the IBC channel
```bash
sudo bash setup-relayer.sh create-channel
```
Creates light clients on both sides, a connection and a `transfer` channel (takes a few minutes), then prints for example
```
ZETAPHY_CHANNEL=channel-0
NOBLE_CHANNEL=channel-123
```
**Note the ZETAPHY-side channel number** (`channel-0`); it is used with `gov.sh` below. Can be re-run: if the channel is already open, a new one is not created
After this, the relayer relays only this channel (packet filter)

### 6. Start the relayer
```bash
sudo bash setup-relayer.sh start      # service named hermes-relayer, starts by itself after reboot
sudo bash setup-relayer.sh status
```

### 7. Transfer the first USDC into ZETAPHY
```bash
sudo bash setup-relayer.sh send-usdc <MetaMask address 0x…> 1000000     # 1 USDC
```
Sent from the relayer's Noble address (funded from the faucet). Within about a minute the USDC arrives in ZETAPHY
This first transfer automatically turns USDC into an ERC-20 on the chain, and it is required before setting the cap (item 9)
You can also transfer from Keplr on Noble testnet (IBC transfer with a custom channel → channel `NOBLE_CHANNEL`)

### 8. USDC as ERC-20 (MetaMask, explorer, DEX)
On the machine, as the `zetaphy` user:
```bash
sudo -iu zetaphy
gov.sh ibc-usdc-denom channel-0        # ibc/<hash> and the ERC-20 address (no chain connection needed)
gov.sh ibc-usdc-erc20 channel-0        # the actual on-chain address + token list entry (JSON)
```
- Cosmos EVM v0.7.3 **has no proposal for registering IBC coins**: the erc20 module registers every `ibc/…` coin by itself when the first coin arrives
  (IBC middleware, "STRv2" style). The ERC-20 address = the last 20 bytes of the coin's hash, and it works right away with `balanceOf`, `transfer`, `approve`
- `MsgRegisterERC20` in v0.7.3 is only for existing ERC-20 contracts (not this case)
- If a vote has disabled this ERC-20, `ibc-usdc-erc20` will propose `MsgToggleConversion` to turn it back on; if the whole module is off, it will propose `MsgUpdateParams` (`enable_erc20: true`)
- MetaMask: **Import tokens** → paste the ERC-20 address
- Use the printed JSON in the token lists of explorers, wallets and DEXes (`symbol USDC`, `decimals 6`)

**⚠️ About decimals on the current testnet:** ibc-go v11 writes the IBC coin's metadata by itself when the first coin arrives, with defaults
(symbol `UUSDC`, a single unit with 0 decimals). This makes the ERC-20's `decimals()` return **0** and `symbol()` return `UUSDC`
Wallets that read from the contract will show the balance in uusdc (1 USDC shows as 1,000,000). `gov.sh ibc-usdc-erc20` warns when this is the case
- In v0.7.3/SDK v0.54 no governance message can change metadata; it must be fixed with a **chain upgrade** (a handler that sets it according to `gov.sh ibc-usdc-metadata channel-0`)
- New chains (e.g. mainnet): put the output of `gov.sh ibc-usdc-metadata <channel it will get>` in `app_state.bank.denom_metadata` of the genesis.
  ibc-go will not overwrite it, and the ERC-20 will return `USDC` / 6 decimals (`test-ibc.sh` proves both cases)
  The first channel opened on a new chain is `channel-0`, so the number can be predicted, but the channel to Noble must really be the first one opened

### 9. Set the USDC cap (vote)
```bash
gov.sh ibc-usdc-ratelimit channel-0            # low default: out 1% / in 1% per 24 hours
gov.sh vote <number> yes
gov.sh ratelimits                               # after the vote passes (10 minutes on testnet)
```
- The cap is a **% of all USDC on ZETAPHY** (counted at the start of the window), not a fixed amount, and it is counted net (in − out)
  - If there are 100 USDC on the chain, a 1% cap = 1 USDC per day; if there is only 1 USDC = 0.01 USDC per day
  - So there must be USDC on the chain first (item 7), otherwise the module rejects it (`gov.sh` tells you to do item 7 first)
  - At the start, if the cap is so tight that transfers fail, transfer more in first or vote to raise the cap
- Run the same command with new values to **change** the cap (proposes `MsgUpdateRateLimit`; the counter restarts), e.g. `gov.sh ibc-usdc-ratelimit channel-0 10 10 24`
- Transfers over the cap: inbound → Noble refunds the sender; outbound → the transaction fails. No funds are lost either way

---

## Sending ZETAPHY and tokens made on ZETAPHY out over IBC
On the node, as the node user (`FROM` picks the key that pays; `NODE_HOME`/`KEYS_DIR` as for every gov.sh command):
```bash
gov.sh ibc-send channel-1 ZETAPHY 1000000000000000000 osmo1…     # 1 ZETAPHY (18 decimals) to Osmosis
gov.sh erc20-register 0x<token>                                  # once per ERC-20 made on ZETAPHY (a vote, or a plain tx
                                                                 #   when registration is permissionless)
gov.sh ibc-send channel-1 0x<token> <amount> osmo1…              # the ERC-20 is converted to its coin erc20/0x<token> first
```
On the other chain the coin arrives as `ibc/<hash>`; sending it back through the same channel returns the original.
A timeout (no relayer for 10 minutes) refunds the sender here.

## Looking after the relayer

| View | Command (on the machine) |
|---|---|
| Overview: running or not, channel, health check, gas balances, latest log | `sudo bash setup-relayer.sh status` |
| Gas balances on both sides | `sudo bash setup-relayer.sh balances` |
| Live log | `journalctl -u hermes-relayer -f` |
| Metrics (Prometheus, local machine only) | `curl -s 127.0.0.1:3001/metrics \| grep -E 'wallet_balance\|tx_latency\|send_packet'` |
| Stop / start | `sudo bash setup-relayer.sh stop` / `start` |

- Check at least once a week: `status` must show `relayer: running` and the Noble balance must not run out (top up from the faucet when low)
- The relayer updates the light clients by itself every ~4.7 days (1/3 of 14 days) even if no one transfers. **Do not let it stop for more than 14 days** (see risks)
- `WARN … SDK module at version '0.54.3' does not meet compatibility requirements >=0.46, <0.54` in the ZETAPHY-side health check
  is just a Hermes 1.13 warning (it does not know SDK v0.54 yet). Tests on a live chain pass every item
- `account sequence mismatch … retrying` in the log is normal; Hermes retries by itself

## Costs

| What | How much |
|---|---|
| Hermes, machine | Free (the same Oracle machine, uses about a hundred-odd MB of RAM) |
| Gas on the ZETAPHY side | About 0.0005 ZETAPHY per message (gas ~250,000 × 2 gwei). testnet coins have no value |
| Gas on the Noble testnet side | About 0.02–0.03 USDC per transaction (gas ~200,000–300,000 × 0.1 uusdc), paid with free USDC from the faucet |
| Per transfer | Noble → ZETAPHY: receive on the ZETAPHY side + acknowledgement back on the Noble side; plus periodic client updates |

The figures are estimates from gas seen in the `test-ibc.sh` tests (not real Noble)

## Risks

- **Relayer down = slow, not lost funds (liveness only):** the relayer only carries proofs between chains; it cannot forge or steal,
  because each chain verifies proofs with its own light client of the other side. Pending messages are delivered when the relayer comes back (`clear_on_start`)
  Transfers that time out (10 minutes for `send-usdc`) refund the sender. Anyone can run an extra relayer for this channel
- **Relayer keys** hold only gas money. If leaked, only gas money is lost (no rights over the funds in the channel)
- **Light client expiry:** if there is no update for longer than `trusting_period` (14 days), the channel cannot be used until the client is recovered by a governance vote.
  The Noble side needs a Noble governance vote, which we do not control → the relayer must keep running; funds stay safe but are stuck
- **Not quantum-resistant:** IBC light clients (both Noble's, which verifies us, and ours, which verifies Noble) check validator signatures with ed25519,
  which a future quantum computer could forge. ZETAPHY's ML-DSA certificates (stage 5) are not yet checked by any light client.
  Meanwhile the `x/ratelimit` cap limits the damage per window
- **USDC belongs to Circle:** Circle can freeze/block addresses on Noble. USDC on ZETAPHY has value because of the USDC locked in the channel on Noble
- **Noble's public RPCs** (Polkachu, Strangelove) are free but have no service agreement; they may rate-limit or change address. Change them with `NOBLE_RPC`/`NOBLE_GRPC`
- **Noble testnet may reset or upgrade.** If `grand-1` changes chain id, a new channel must be opened (delete `channel.env`, then `create-channel`) ⚠️ TODO
- **ERC-20 decimals** on testnet (item 8)

## Path to mainnet (`noble-1`)

**Only after the audit conditions are met** (`docs/LAUNCH.md` item 14, `docs/MAINNET_RUNBOOK.md`): the chain and the `x/ratelimit` module pass an independent audit,
every finding of medium severity or higher is fixed, independent validators, multisig/HSM keys as the main README requires

Noble mainnet values (cosmos/chain-registry `noble/chain.json`): chain id `noble-1` (also confirmed with `upgrade/constants.go`),
gas price `0.1` uusdc (fixed min), RPC e.g. `https://noble-rpc.polkachu.com:443`, gRPC `noble-grpc.polkachu.com:21590`
```bash
sudo NOBLE_CHAIN_ID=noble-1 NOBLE_RPC=https://noble-rpc.polkachu.com:443 NOBLE_GRPC=http://noble-grpc.polkachu.com:21590 \
  ZETAPHY_CHAIN_ID=<mainnet chain id> bash setup-relayer.sh
```
Additional requirements:
- USDC metadata in genesis (`gov.sh ibc-usdc-metadata channel-0`) so the ERC-20 has 6 decimals from the start
- The cap is set before the announcement and starts low (`ibc-usdc-ratelimit` default 1%)
- At least 2 relayers on machines in different places + alerts when gas is low or a relayer stops
- ⚠️ TODO: check with the Noble team whether opening a channel to `noble-1` needs permission or any registration, and list the channel in cosmos/chain-registry `_IBC/` so wallets can see it

## Tests (no Noble needed)

`test-ibc.sh` starts 2 ZETAPHY test chains (`zetaphy_77390-1`, and `zetaphy_77391-1`, which stands in for Noble and has `uusdc`)
It uses the real `setup-relayer.sh` to set up Hermes (the "Noble" side points to the second chain), then checks: the channel opens, re-runs do not create new things,
the coin hash matches the chain, USDC arrives and becomes an ERC-20 that `eth_call balanceOf` can read, metadata in genesis gives 6 decimals,
disabling/enabling the ERC-20 by vote, a 1% cap passed by vote then blocks over-cap transfers both inbound (refund) and outbound (transaction fails), changing the cap by vote
```bash
ZETAPHYD=/path/to/zetaphyd flock /tmp/ci-test/devnet.lock npm --prefix zetaphy-network run test:devnet:ibc
npm --prefix zetaphy-network test      # includes test/ibc.test.js: hash, vote messages, Hermes config (no chain needed)
```
If Hermes cannot be downloaded, the on-chain test will SKIP and say why (you can set `HERMES_TARBALL` to an already-downloaded file)
