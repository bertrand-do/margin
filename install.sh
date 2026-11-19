#!/bin/zsh
# Installs the Margin bridge as a login agent (starts at login, restarts if it crashes).
set -e
DIR=${0:A:h}
cd "$DIR/bridge" && npm install --silent
PLIST=~/Library/LaunchAgents/com.margin.bridge.plist
cat > $PLIST <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.margin.bridge</string>
  <key>ProgramArguments</key><array><string>$(which node)</string><string>$DIR/bridge/server.mjs</string></array>
  <key>WorkingDirectory</key><string>$DIR/bridge</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/margin-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/margin-bridge.log</string>
</dict></plist>
P
launchctl bootout gui/$(id -u)/com.margin.bridge 2>/dev/null || true
launchctl bootstrap gui/$(id -u) $PLIST
sleep 2 && curl -s 127.0.0.1:5250/health && echo "  Margin bridge running."
