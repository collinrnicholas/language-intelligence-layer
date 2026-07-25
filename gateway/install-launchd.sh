#!/usr/bin/env bash
#
# Install the Persado Demo gateway as a per-user launchd agent so it starts at
# login and stays alive (auto-restarts if it crashes). macOS only, no hosting.
#
# The provider key is read from ~/.loupe/gateway.env (chmod 600, never committed
# and never seen by the client) — it is NOT baked into the plist.
#
#   ./gateway/install-launchd.sh          # install + load
#   launchctl unload ~/Library/LaunchAgents/dev.loupe.gateway.plist   # stop/disable
#
# DELIBERATELY UNRENAMED: the launchd label and the ~/.loupe paths below. The
# label identifies an agent that may already be installed on this machine —
# changing it orphans the old plist and can leave two gateways contending for
# port 8787. ~/.loupe holds live data the inherited CLI reads. See CLAUDE.md §1.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="dev.loupe.gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ENV_FILE="$HOME/.loupe/gateway.env"
LOG_DIR="$HOME/.loupe/logs"
NODE_BIN="$(command -v node)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR" "$HOME/.loupe"

if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<'EOF'
# Persado Demo gateway environment — gateway-side ONLY, never read by the client.
# Fill in a provider key, then re-run install-launchd.sh:
# OPENAI_API_KEY=sk-...
#
# Optional model routing. PERSADO_* are the current names; the LOUPE_*
# equivalents still work if you already have them set.
# PERSADO_MODEL_PREMIUM=gpt-4o
# PERSADO_MODEL_STANDARD=gpt-4o-mini
# PERSADO_GATEWAY_PORT=8787
# PERSADO_GATEWAY_HOST=127.0.0.1
EOF
  chmod 600 "$ENV_FILE"
  echo "→ Created $ENV_FILE — add your provider key, then re-run this script."
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
    <string>set -a; . "$ENV_FILE"; set +a; exec "$NODE_BIN" "$REPO/gateway/server.mjs"</string>
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
echo "  Verify: curl -s http://127.0.0.1:8787/health"
