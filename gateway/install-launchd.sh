#!/usr/bin/env bash
#
# Install the Persado Assist gateway as a per-user launchd agent so it starts at
# login and stays alive (auto-restarts if it crashes). macOS only, no hosting.
#
# Credentials are read from ~/.persado/gateway.env (chmod 600, never committed
# and never seen by the client) — it is NOT baked into the plist.
#
#   ./gateway/install-launchd.sh          # install + load
#   launchctl unload ~/Library/LaunchAgents/dev.persado.gateway.plist   # stop/disable
#
# OWN LABEL, OWN PORT: dev.persado.gateway on 8788, separate from Loupe's
# gateway on 8787. The env file is ~/.persado/gateway.env (0.12.0+). Model-provider
# keys (OPENAI_API_KEY etc.) are no longer read by this gateway.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.persado.gateway"
PORT="${PERSADO_GATEWAY_PORT:-8788}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$HOME/.persado/gateway.env"
# Existing installs kept credentials in ~/.loupe/gateway.env; keep using it until moved.
if [ ! -f "$ENV_FILE" ] && [ -f "$HOME/.loupe/gateway.env" ]; then
  ENV_FILE="$HOME/.loupe/gateway.env"
  echo "→ Using legacy $ENV_FILE. Move it to ~/.persado/gateway.env when convenient."
fi
LOG_DIR="$HOME/.persado/logs"
NODE_BIN="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$HOME/.persado"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Persado Assist gateway environment — gateway-side ONLY, never read by the extension.
# Fill these in, then re-run install-launchd.sh:
# PERSADO_API_KEY=...
# PERSADO_PROXY_TOKEN=...            # openssl rand -hex 32; paste into the extension's Settings
# MAILCHIMP_API_KEY=...              # optional
# MAILCHIMP_SERVER_PREFIX=us21       # optional override of the key suffix
# PERSADO_EXTENSION_IDS=             # optional allowlist of extension ids
EOF
  chmod 600 "$ENV_FILE"
  echo "→ Created $ENV_FILE — add your credentials, then re-run this script."
  exit 0
fi

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>set -a; . "$ENV_FILE"; set +a; export PERSADO_GATEWAY_PORT=$PORT; exec "$NODE_BIN" "$REPO/gateway/server.mjs"</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/gateway.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/gateway.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "→ Loaded $LABEL (starts at login, auto-restarts)."
echo "  Logs:   $LOG_DIR/gateway.{out,err}.log"
echo "  Verify: curl -s http://127.0.0.1:$PORT/health"
