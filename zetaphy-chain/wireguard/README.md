**English** | [ภาษาไทย](README.th.md)

# Validator ↔ sentry links with a post-quantum pre-shared key (optional)

CometBFT connects peers with SecretConnection: an X25519 key exchange and Ed25519 node keys. Both fall to a large
quantum computer, and traffic recorded today could be decrypted then ("harvest now, decrypt later"). On a public
network that traffic is mostly public blocks, but a validator's link to its sentry also shows when and what the
validator signs and which transactions it sees first. CometBFT has no post-quantum handshake yet.

`pq-link.sh` puts the validator ↔ sentry link inside **WireGuard with a pre-shared key (PSK)**. WireGuard mixes the
32-byte PSK into its handshake, so:

- recorded tunnel traffic stays secret even to someone who can later break X25519, as long as the PSK stays secret;
- nobody can pose as the validator or the sentry on the tunnel without the PSK.

The PSK is random (`wg genpsk`, 256 bits) and is copied to the other machine **only over SSH limited to a
post-quantum hybrid key exchange** (`mlkem768x25519-sha256`, OpenSSH 9.9+, or `sntrup761x25519-sha512`, OpenSSH 8.5+;
Ubuntu 24.04 has the latter). If the two machines cannot agree on one of those, nothing is sent. CometBFT's
SecretConnection keeps running inside the tunnel, unchanged.

**What it does not do**

- No forward secrecy against a quantum attacker who later steals the PSK (from a machine's disk). Rotate it now and
  then (below), or run [Rosenpass](https://rosenpass.eu), which puts a fresh post-quantum PSK into the same WireGuard
  interface every two minutes.
- The sentry's links to the public network are still plain SecretConnection.
- The SSH host keys that authenticate the PSK transfer are classical: copy the PSK before Q-day, from a machine you
  trust, to a host key you have checked.
- It is off by default; nothing changes on a node that does not run it.

## Steps

Example: validator `10.77.0.1`, sentry `10.77.0.2`, UDP 51820 open **only** between the two machines. As root:

```bash
apt-get install -y wireguard-tools
S=zetaphy-chain/wireguard/pq-link.sh

# both machines
$S init 10.77.0.1/24          # on the validator (prints its public key)
$S init 10.77.0.2/24          # on the sentry

# on the validator: a PSK for the link, sent to the sentry over post-quantum SSH
$S psk sentry-1
$S send-psk sentry-1 root@<sentry address> validator-0
$S peer sentry-1 <sentry public key> 10.77.0.2 <sentry address>:51820
$S up

# on the sentry (the PSK arrived as zetaphy-pq-validator-0.psk)
$S peer validator-0 <validator public key> 10.77.0.1
$S up
$S status                      # "latest handshake" and "preshared key: (hidden)"

# CometBFT over the tunnel (backs up config.toml first), then restart zetaphyd on both
$S comet-validator <sentry node id>@10.77.0.2     # on the validator: only this peer, no PEX, no seeds
$S comet-sentry <validator node id>               # on the sentry: keep the validator private and connected
```

The node id is `zetaphyd comet show-node-id --home /home/zetaphy/.zetaphy`. After the restart, close 26656 on the
validator to everything except the tunnel. `send-psk` uses `sudo` on the other side: use `root@`, or an account with
passwordless sudo. Several sentries: repeat `psk` / `send-psk` / `peer` with another name and tunnel address.

**Rotating the PSK:** on the validator `psk sentry-1`, `send-psk sentry-1 root@<sentry> validator-0`,
`peer sentry-1 …` (same arguments), `up`; on the sentry `peer validator-0 …`, `up`. `up` reloads a running tunnel
(`wg syncconf`) without dropping it; until both sides have the new key, handshakes fail and CometBFT reconnects.

Settings: `WG_DIR` (default `/etc/wireguard`), `IFACE` (`zetaphy-pq`), `NODE_HOME` (`/home/zetaphy/.zetaphy`).
Tests: `zetaphy-network/test/pqlink.test.js`. Inventory row: `p2p-transport` in
[`docs/future/quantum-safe-settlement.md`](../../docs/future/quantum-safe-settlement.md).
