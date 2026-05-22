#!/bin/bash
# Strips the macOS quarantine flag from the app so Gatekeeper allows it to run.
# Double-click this if you see "AI Agent Session Center is damaged and can't be opened."

APP="/Applications/AI Agent Session Center.app"

if [ ! -d "$APP" ]; then
  echo "⚠  App not found at $APP"
  echo "   Please drag 'AI Agent Session Center' to your /Applications folder first,"
  echo "   then double-click this script again."
  read -rp "Press Enter to close..."
  exit 1
fi

echo "Removing quarantine flag..."
xattr -cr "$APP"
echo "✓ Done. Launching AI Agent Session Center..."
open "$APP"
