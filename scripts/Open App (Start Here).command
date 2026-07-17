#!/bin/bash
# Guided first-run helper for "AI Agent Session Center".
#
# macOS flags brand-new apps downloaded from the internet with a "quarantine"
# attribute. For an unsigned/un-notarized app this shows up as:
#     "AI Agent Session Center is damaged and can't be opened."
# The app is NOT damaged — this is Apple's Gatekeeper. Because the app can't
# launch while flagged, the guidance can't live inside the app itself, so this
# script walks the user through the fix using native macOS popup windows.
#
# Double-click this file on first use. You only need to do it once.

set -uo pipefail

APP_NAME="AI Agent Session Center"
TITLE="$APP_NAME — First-Run Setup"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Candidate install locations, in priority order.
CANDIDATES=(
  "/Applications/$APP_NAME.app"
  "$HOME/Applications/$APP_NAME.app"
  "$SCRIPT_DIR/$APP_NAME.app"
)

# --- popup helpers ----------------------------------------------------------

# Escape a string for use inside an AppleScript double-quoted literal.
as_escape() {
  local s="$1"
  s=${s//\\/\\\\}   # backslash  ->  \\
  s=${s//\"/\\\"}   # quote      ->  \"
  printf '%s' "$s"
}

# popup MESSAGE BUTTONS DEFAULT [ICON]
#   BUTTONS  e.g.  '{"Quit","Continue"}'
#   DEFAULT  e.g.  '"Continue"'
#   ICON     note | caution | stop   (default: note)
# Prints the clicked button text on stdout; exits 0. If the user dismisses the
# dialog (Cancel/Esc), prints nothing and returns non-zero so callers can stop.
popup() {
  local msg buttons="$2" defbtn="$3" icon="${4:-note}"
  msg="$(as_escape "$1")"
  osascript <<OSA 2>/dev/null
button returned of (display dialog "$msg" with title "$TITLE" buttons $buttons default button $defbtn with icon $icon)
OSA
}

fail_box() {
  local msg
  msg="$(as_escape "$1")"
  osascript >/dev/null 2>&1 <<OSA
display dialog "$msg" with title "$TITLE" buttons {"OK"} default button "OK" with icon caution
OSA
}

# --- Step 0: Welcome --------------------------------------------------------
choice=$(popup "👋 Welcome to $APP_NAME!

macOS marks brand-new apps downloaded from the internet as 'damaged' for security — but the app is fine. This is Apple's Gatekeeper.

This helper will safely unlock the app in 3 quick steps. You only need to do this once." '{"Quit","Start"}' '"Start"')
if [ "$choice" != "Start" ]; then
  exit 0
fi

# --- Step 1: Locate the app -------------------------------------------------
APP=""
for c in "${CANDIDATES[@]}"; do
  if [ -d "$c" ]; then APP="$c"; break; fi
done

if [ -z "$APP" ]; then
  popup "Step 1 of 3 — Move the app

Drag the '$APP_NAME' icon onto the Applications shortcut in this window.

Then double-click this helper again to continue." '{"OK"}' '"OK"' >/dev/null
  exit 0
fi

# --- Step 2: Remove the quarantine flag -------------------------------------
choice=$(popup "Step 2 of 3 — Unlock the app

Found it at:
$APP

Click Unlock to remove the macOS security flag so the app can open. (No admin password needed.)" '{"Quit","Unlock"}' '"Unlock"')
if [ "$choice" != "Unlock" ]; then
  exit 0
fi

if ! xattr -cr "$APP" 2>/dev/null; then
  # Retry with elevated permissions in case some files are root-owned.
  if ! /usr/bin/sudo -n xattr -cr "$APP" 2>/dev/null; then
    fail_box "Couldn't remove the flag automatically.

Open the Terminal app and paste this command, then press Return:

xattr -cr \"$APP\""
    exit 1
  fi
fi

# --- Step 3: Launch ---------------------------------------------------------
if ! open "$APP" 2>/dev/null; then
  fail_box "Unlocked successfully, but couldn't launch the app automatically.

Open it from your Applications folder or Launchpad."
  exit 1
fi

popup "Step 3 of 3 — All set! 🎉

$APP_NAME is unlocked and starting now.

Next time, just open it normally from Applications or Launchpad — you won't need this helper again." '{"Great"}' '"Great"' >/dev/null
exit 0
