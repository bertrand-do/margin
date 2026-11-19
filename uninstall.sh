#!/bin/zsh
launchctl bootout gui/$(id -u)/com.margin.bridge 2>/dev/null; rm -f ~/Library/LaunchAgents/com.margin.bridge.plist; echo "Margin bridge removed."
