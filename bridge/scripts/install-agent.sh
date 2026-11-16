#!/bin/zsh
# Runs the Diel bridge as a macOS login agent: starts at login, restarts if it
# exits. Logs go to ~/.diel/bridge.log.
#   ./scripts/install-agent.sh            install or update, and start
#   ./scripts/install-agent.sh uninstall  stop and remove
set -euo pipefail

LABEL=dev.diel.bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/.diel" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>src/main.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.diel/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/.diel/bridge.log</string>
</dict>
</plist>
PLIST

launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Installed $LABEL (logs: ~/.diel/bridge.log)"
