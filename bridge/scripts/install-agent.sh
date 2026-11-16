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
# bootout returns before the old instance is gone; bootstrap fails until it is.
for _ in {1..50}; do
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done

if [[ "${1:-}" == "uninstall" ]]; then
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

mkdir -p "$HOME/.diel" "$HOME/Library/LaunchAgents"

# Pass DIEL_* settings through to the agent, e.g. DIEL_PORT=8792 ./scripts/install-agent.sh
ENV_XML=""
for var in DIEL_PORT DIEL_NAME DIEL_CWD DIEL_VOICE; do
  if [[ -n "${(P)var:-}" ]]; then ENV_XML+="    <key>$var</key><string>${(P)var}</string>"$'\n'; fi
done
[[ -n "$ENV_XML" ]] && ENV_XML="  <key>EnvironmentVariables</key>"$'\n'"  <dict>"$'\n'"$ENV_XML  </dict>"
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
$ENV_XML
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
