#!/bin/bash
# ZETAPHY Neuro runner in one command (Ubuntu/Debian server, x86_64 or arm64), with sudo:
#
#   curl -fsSL https://raw.githubusercontent.com/pospos191-alt/swd-amm/main/install.sh | sudo bash -s -- runner
#
# Installs Node.js (official build, SHA-256 checked), the ZETAPHY code, a runner key made on this
# machine, and a service that starts by itself (also after a reboot). It prints the runner's
# address: send 100.1 ZETAPHY testnet there and the runner registers its bond by itself and
# starts taking Neuro jobs. Nothing secret is printed or sent anywhere.
#
#   sudo zetaphy-runner status      address, wallet, bond, earnings, network
#   sudo zetaphy-runner address     the address to fund
#   sudo zetaphy-runner withdraw    move earnings to the runner's wallet
#   sudo zetaphy-runner logs        last log lines
#   sudo zetaphy-runner update      newest code, then restart
#   sudo zetaphy-runner stop|start
#   sudo zetaphy-runner uninstall   remove the service and code (the key stays in /var/lib/zetaphy-runner)
#
# Testnet only: never put a key holding real money here.
set -euo pipefail

NODE_VERSION="v22.22.0"
REPO="pospos191-alt/swd-amm"
REF="${REF:-main}"
RPC="${ZETAPHY_RPC:-https://rpc.sawasdeecoin.com}"
JOBS="${ZETAPHY_JOBS:-0x698dC17df6a34b02263b295d101BE39F3F3B433B}"     # NeuroJobs (zetaphy-launch/state/77390.json)
VAULT="${ZETAPHY_VAULT:-0x6a26055803556ff891CAB11CF47aB363aC1D0Ed8}"   # RewardVault
USER_NAME=zetaphy-runner
HOME_DIR=/var/lib/zetaphy-runner
CODE=/opt/zetaphy
BIN=/usr/local/bin/zetaphy-runner

say() { printf '\n== %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run with sudo"

node_ok() { command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 20 ]; }

install_node() {
  node_ok && return 0
  local arch; case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
  local f="node-$NODE_VERSION-linux-$arch.tar.xz" t; t=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$f" -o "$t/$f"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$t/SHASUMS256.txt"
  (cd "$t" && grep " $f\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "Node.js download does not match its SHA-256: refused"
  mkdir -p /usr/local/lib/nodejs && tar -xJf "$t/$f" -C /usr/local/lib/nodejs
  ln -sf "/usr/local/lib/nodejs/node-$NODE_VERSION-linux-$arch/bin/node" /usr/local/bin/node
  ln -sf "/usr/local/lib/nodejs/node-$NODE_VERSION-linux-$arch/bin/npm" /usr/local/bin/npm
  rm -rf "$t"; node_ok || die "Node.js did not install"
}

fetch_code() {
  local t; t=$(mktemp -d)
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$REF" -o "$t/code.tgz"
  tar -xzf "$t/code.tgz" -C "$t"
  local src; src=$(find "$t" -maxdepth 1 -mindepth 1 -type d | head -1)
  rm -rf "$CODE.new"; mkdir -p "$CODE.new"
  cp -a "$src/zetaphy-network" "$src/zetaphy-neuro" "$CODE.new/"
  (cd "$CODE.new/zetaphy-network" && npm ci --omit=dev --no-audit --no-fund --silent)
  (cd "$CODE.new/zetaphy-neuro" && npm ci --omit=dev --no-audit --no-fund --silent)
  rm -rf "$CODE.old"; [ -d "$CODE" ] && mv "$CODE" "$CODE.old"; mv "$CODE.new" "$CODE"; rm -rf "$CODE.old" "$t"
  chown -R root:root "$CODE"; chmod -R a+rX "$CODE"
}

zcli() { sudo -u "$USER_NAME" env ZETAPHY_HOME="$HOME_DIR" node "$CODE/zetaphy-network/cli.js" "$@" --rpc "$RPC" --jobs "$JOBS"; }

write_service() {
  cat > /etc/systemd/system/zetaphy-runner.service <<EOF
[Unit]
Description=ZETAPHY Neuro runner
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
Environment=ZETAPHY_HOME=$HOME_DIR
ExecStart=/usr/local/bin/node $CODE/zetaphy-network/cli.js node start --auto-register --rpc $RPC --jobs $JOBS --vault $VAULT
Restart=always
RestartSec=30
MemoryMax=700M
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$HOME_DIR
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

install_all() {
  say "packages"
  command -v apt-get >/dev/null || die "this installer needs Ubuntu or Debian (apt-get)"
  need=(); for p in curl ca-certificates xz-utils sudo; do dpkg -s "$p" >/dev/null 2>&1 || need+=("$p"); done
  [ ${#need[@]} -eq 0 ] || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}"; }
  say "Node.js $NODE_VERSION"; install_node
  say "ZETAPHY code ($REPO@$REF)"; fetch_code
  say "runner user and key (made here, never printed)"
  id "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$HOME_DIR" --shell /usr/sbin/nologin "$USER_NAME"
  install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$HOME_DIR"
  zcli node status >/dev/null
  install -m 755 "$0" "$BIN" 2>/dev/null || curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/zetaphy-network/setup-runner.sh" -o "$BIN"
  chmod 755 "$BIN"
  write_service
  systemctl enable --now zetaphy-runner >/dev/null 2>&1
  systemctl restart zetaphy-runner
  say "done"
  zcli node status | sed -n '1,3p'
  cat <<EOF

Next: send 100.1 ZETAPHY testnet (or more) to the runner address above.
The runner registers its bond by itself within a minute and starts taking jobs.
  sudo zetaphy-runner status    see the bond and earnings
  sudo zetaphy-runner logs      see what it is doing
EOF
}

case "${1:-install}" in
  install|runner) install_all ;;
  status) zcli node status ;;
  address) zcli node status | sed -n '1p' ;;
  withdraw) zcli node withdraw ;;
  logs) journalctl -u zetaphy-runner -n "${2:-40}" --no-pager ;;
  update) fetch_code; write_service; systemctl restart zetaphy-runner; echo "updated and restarted" ;;
  stop) systemctl stop zetaphy-runner; echo stopped ;;
  start) systemctl start zetaphy-runner; echo started ;;
  uninstall)
    systemctl disable --now zetaphy-runner 2>/dev/null || true
    rm -f /etc/systemd/system/zetaphy-runner.service "$BIN"; systemctl daemon-reload; rm -rf "$CODE"
    echo "removed; the runner key is kept in $HOME_DIR (delete it yourself only after withdrawing the bond and earnings)" ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
