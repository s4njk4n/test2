#!/usr/bin/env bash
# XDC ShopBot installer / updater.
#
#   Install:  curl -fsSL https://raw.githubusercontent.com/s4njk4n/XDC_ShopBot/main/install.sh | bash
#   Update:   shopbot update
#
# Installs everything into ~/xdc-shopbot (its own copy of Node.js included), asks a few setup
# questions, and runs the shop as a background service that starts on boot.
# Everything happens inside main(), so a partly downloaded script never runs.
set -euo pipefail

main() {
  local APP_DIR="${SHOPBOT_DIR:-$HOME/xdc-shopbot}"
  local REPO="${SHOPBOT_REPO:-s4njk4n/XDC_ShopBot}"
  local BRANCH="${SHOPBOT_BRANCH:-main}"
  local NODE_MAJOR="${SHOPBOT_NODE_MAJOR:-24}"
  local NODE_DIST="${SHOPBOT_NODE_DIST:-https://nodejs.org/dist}"
  local CODELOAD="${SHOPBOT_CODELOAD:-https://codeload.github.com}"
  local RAW="${SHOPBOT_RAW:-https://raw.githubusercontent.com}"
  local UPDATE="${SHOPBOT_UPDATE:-0}"
  local SERVICE=xdc-shopbot

  b() { printf '\033[1m%s\033[0m\n' "$*"; }
  ok() { printf '\033[32m✓\033[0m %s\n' "$*"; }
  warn() { printf '\033[33m!\033[0m %s\n' "$*"; }
  die() { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
  ask_yn() { local a; read -r -p "$1 (Y/n) " a </dev/tty || a=""; [[ ! "$a" =~ ^[Nn] ]]; }

  [ "$(uname -s)" = "Linux" ] || die "XDC ShopBot runs on Linux servers (Ubuntu or Debian recommended)."
  local ARCH
  case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "Unsupported processor: $(uname -m). Use a 64-bit Intel/AMD or ARM server." ;; esac
  local SUDO=""
  if [ "$(id -u)" -ne 0 ]; then command -v sudo >/dev/null || die "Run this as root, or install sudo first."; SUDO="sudo"; fi

  echo
  if [ "$UPDATE" = "1" ]; then b "Updating XDC ShopBot in $APP_DIR"; else b "Installing XDC ShopBot into $APP_DIR"; fi
  echo

  # --- system tools ---
  local need=()
  for t in curl tar xz sha256sum; do command -v "$t" >/dev/null || need+=("$t"); done
  if [ ${#need[@]} -gt 0 ]; then
    command -v apt-get >/dev/null || die "Please install: ${need[*]}"
    echo "Installing system tools (${need[*]})…"
    $SUDO apt-get update -qq && $SUDO apt-get install -y -qq curl tar xz-utils coreutils ca-certificates >/dev/null
  fi

  mkdir -p "$APP_DIR"
  TMP="$(mktemp -d)"; trap 'rm -rf "${TMP:-}"' EXIT

  # --- back up before updating ---
  if [ "$UPDATE" = "1" ] && [ -f "$APP_DIR/data/shop.db" ] && [ -x "$APP_DIR/runtime/node/bin/node" ]; then
    (cd "$APP_DIR" && ./runtime/node/bin/node --no-warnings src/cli.js backup >/dev/null) && ok "Backed up your shop data"
  fi

  # --- app files (data/, .env, runtime/ and fonts you already have are kept) ---
  echo "Downloading XDC ShopBot…"
  curl -fsSL "$CODELOAD/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/app.tgz" || die "Couldn't download XDC ShopBot from GitHub."
  mkdir -p "$TMP/app" && tar -xzf "$TMP/app.tgz" -C "$TMP/app" --strip-components=1
  [ -f "$TMP/app/src/index.js" ] || die "The download doesn't look like XDC ShopBot v2."
  rm -rf "$APP_DIR/src" "$APP_DIR/bin"
  cp -R "$TMP/app/src" "$TMP/app/bin" "$APP_DIR/"
  cp "$TMP/app/package.json" "$TMP/app/package-lock.json" "$TMP/app/install.sh" "$APP_DIR/"
  [ -f "$TMP/app/README.md" ] && cp "$TMP/app/README.md" "$APP_DIR/"
  [ -f "$TMP/app/LICENSE" ] && cp "$TMP/app/LICENSE" "$APP_DIR/"
  mkdir -p "$APP_DIR/fonts" && cp -n "$TMP/app/fonts/"* "$APP_DIR/fonts/" 2>/dev/null || true
  chmod +x "$APP_DIR/bin/shopbot" "$APP_DIR/install.sh"
  ok "App files"

  # --- Node.js (private copy, doesn't touch the system) ---
  local NODE="$APP_DIR/runtime/node/bin/node" have=0
  if [ -x "$NODE" ]; then have="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi
  if [ "$have" -lt 22 ] || [ "${SHOPBOT_REFRESH_NODE:-0}" = "1" ]; then
    echo "Downloading Node.js $NODE_MAJOR…"
    curl -fsSL "$NODE_DIST/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || die "Couldn't reach nodejs.org."
    local FILE; FILE="$(grep -oE "node-v[0-9.]+-linux-$ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
    [ -n "$FILE" ] || die "No Node.js build found for linux-$ARCH."
    curl -fsSL "$NODE_DIST/latest-v$NODE_MAJOR.x/$FILE" -o "$TMP/$FILE" || die "Node.js download failed."
    (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js download failed its checksum. Try again."
    rm -rf "$APP_DIR/runtime/node" && mkdir -p "$APP_DIR/runtime/node"
    tar -xJf "$TMP/$FILE" -C "$APP_DIR/runtime/node" --strip-components=1
    ok "Node.js $("$NODE" -v) (private to ShopBot)"
  else
    ok "Node.js $("$NODE" -v) already installed"
  fi

  # --- dependencies (pure JavaScript, nothing to compile) ---
  echo "Installing libraries…"
  (cd "$APP_DIR" && PATH="$APP_DIR/runtime/node/bin:$PATH" npm_config_update_notifier=false npm ci --omit=dev --omit=optional --no-audit --no-fund --loglevel=error >/dev/null) || die "Installing libraries failed."
  ok "Libraries"

  # --- fonts for Japanese, Korean and Chinese receipts (optional, ~22 MB) ---
  local f
  for f in NotoSansJP-Regular.ttf NotoSansKR-Regular.ttf NotoSansSC-Regular.ttf; do
    [ -s "$APP_DIR/fonts/$f" ] || curl -fsSL "$RAW/s4njk4n/XDC_Proof/main/vendor/fonts/$f" -o "$APP_DIR/fonts/$f" 2>/dev/null || { rm -f "$APP_DIR/fonts/$f"; warn "Couldn't download $f (receipts in that language will show ? marks)"; }
  done
  ok "Receipt fonts"

  # --- shopbot command ---
  $SUDO ln -sf "$APP_DIR/bin/shopbot" /usr/local/bin/shopbot && ok "Added the 'shopbot' command"

  # --- setup questions (first install, or if never completed) ---
  local fresh=0
  if [ "$UPDATE" != "1" ] || [ ! -f "$APP_DIR/.env" ]; then
    fresh=1
    (cd "$APP_DIR" && "$NODE" --no-warnings src/cli.js setup --no-claim </dev/tty) || die "Setup didn't finish. Run 'shopbot setup' to try again."
    if [ -f "$HOME/XDC_ShopBot/items.csv" ] && ask_yn "Import your products from XDC ShopBot v1 (~/XDC_ShopBot)?"; then
      (cd "$APP_DIR" && "$NODE" --no-warnings src/cli.js import-v1 "$HOME/XDC_ShopBot")
    fi
    if systemctl list-unit-files 2>/dev/null | grep -q '^xdc-shopbot-bot.service'; then
      warn "XDC ShopBot v1 is installed as a service. Two copies can't share one bot."
      if ask_yn "Stop and disable the v1 services now?"; then $SUDO systemctl disable --now xdc-shopbot-bot.service xdc-shopbot-monitor.service >/dev/null 2>&1 || true; ok "v1 stopped"; fi
    elif pgrep -f 'monitor\.sh|bot\.sh' >/dev/null 2>&1; then
      warn "If XDC ShopBot v1 is still running with the same bot, stop it with: cd ~/XDC_ShopBot && ./stop.sh"
    fi
  fi

  # --- background service ---
  if command -v systemctl >/dev/null && [ -d /run/systemd/system ]; then
    $SUDO tee /etc/systemd/system/$SERVICE.service >/dev/null <<EOF
[Unit]
Description=XDC ShopBot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/runtime/node/bin/node --no-warnings src/index.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable $SERVICE >/dev/null 2>&1
    $SUDO systemctl restart $SERVICE
    sleep 3
    if systemctl is-active --quiet $SERVICE; then ok "ShopBot is running and will start automatically after reboots"; else warn "ShopBot didn't start. See what happened with: shopbot logs"; fi
  else
    warn "systemd isn't available here, so ShopBot can't run as a service. Start it with: cd $APP_DIR && ./runtime/node/bin/node --no-warnings src/index.js"
  fi

  echo
  if [ "$UPDATE" = "1" ] && [ "$fresh" = "0" ]; then
    b "Updated to XDC ShopBot $("$NODE" -p "require('$APP_DIR/package.json').version")."
  else
    (cd "$APP_DIR" && "$NODE" --no-warnings src/cli.js claim)
    b "Everyday commands:"
    echo "  shopbot status    what the shop is doing"
    echo "  shopbot logs      live log"
    echo "  shopbot update    update to the latest version"
    echo "  shopbot backup    save a backup of products, orders and settings"
    echo
  fi
}

main "$@"
