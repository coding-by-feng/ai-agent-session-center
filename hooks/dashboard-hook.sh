#!/bin/bash
# Claude Session Command Center - Hook relay (macOS / Linux)
# Reads hook JSON from stdin, enriches with process/env info, POSTs to dashboard server
# Runs in background, fails silently if server is not running

INPUT=$(cat)

# Get TTY: the hook's stdin is piped (JSON), so `tty` won't work.
# Instead, get the TTY of the parent process (Claude) via ps.
# macOS `ps -o tty=` returns "ttys003" — prepend /dev/ to get "/dev/ttys003".
# Linux `ps -o tty=` returns "pts/0" — prepend /dev/ to get "/dev/pts/0".
HOOK_TTY=""
if [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  RAW_TTY=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
  if [ -n "$RAW_TTY" ] && [ "$RAW_TTY" != "??" ] && [ "$RAW_TTY" != "?" ]; then
    HOOK_TTY="/dev/${RAW_TTY}"
  fi
fi

# Enrich the JSON with environment info for accurate session & tab detection.
# The hook runs as a child of the Claude process, so $PPID = Claude PID.
# Terminal emulators set identifiable env vars we can capture.
ENRICHED=$(echo "$INPUT" | jq -c \
  --arg pid "$PPID" \
  --arg tty "$HOOK_TTY" \
  --arg term_program "${TERM_PROGRAM:-}" \
  --arg term_program_version "${TERM_PROGRAM_VERSION:-}" \
  --arg vscode_pid "${VSCODE_PID:-}" \
  --arg term "${TERM:-}" \
  --arg iterm_session "${ITERM_SESSION_ID:-}" \
  --arg term_session "${TERM_SESSION_ID:-}" \
  --arg kitty_window "${KITTY_WINDOW_ID:-}" \
  --arg kitty_pid "${KITTY_PID:-}" \
  --arg warp_session "${WARP_SESSION_ID:-}" \
  --arg windowid "${WINDOWID:-}" \
  --arg ghostty_resources "${GHOSTTY_RESOURCES_DIR:-}" \
  --arg wezterm_pane "${WEZTERM_PANE:-}" \
  --arg tmux "${TMUX:-}" \
  --arg tmux_pane "${TMUX_PANE:-}" \
  '. + {
    claude_pid: ($pid | tonumber),
    tty_path: (if $tty != "" then $tty else null end),
    term_program: (if $term_program != "" then $term_program else null end),
    term_program_version: (if $term_program_version != "" then $term_program_version else null end),
    vscode_pid: (if $vscode_pid != "" then ($vscode_pid | tonumber) else null end),
    term: (if $term != "" then $term else null end),
    tab_id: (
      if $iterm_session != "" then $iterm_session
      elif $kitty_window != "" then ("kitty:" + $kitty_window)
      elif $warp_session != "" then ("warp:" + $warp_session)
      elif $wezterm_pane != "" then ("wezterm:" + $wezterm_pane)
      elif $term_session != "" then $term_session
      else null end
    ),
    window_id: (if $windowid != "" then ($windowid | tonumber) else null end),
    tmux: (if $tmux != "" then {session: $tmux, pane: $tmux_pane} else null end),
    is_ghostty: (if $ghostty_resources != "" then true else null end),
    kitty_pid: (if $kitty_pid != "" then ($kitty_pid | tonumber) else null end)
  }' 2>/dev/null || echo "$INPUT")

# ---- Tab title management ----
# Keep the terminal tab title set to "Claude: <project>" so the dashboard can find and focus it.
# On SessionStart: resolve the project name and cache it in /tmp for fast access on later events.
# On every other event: read the cached name and refresh the title (tools/commands may overwrite it).
# Uses OSC escape sequences (Ghostty, iTerm2, Kitty, WezTerm, Warp, VS Code, JetBrains, most terminals).
# Works in all terminals including VS Code and JetBrains integrated terminals.
EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TTY_PATH="$HOOK_TTY"
CACHE_DIR="/tmp/claude-tab-titles"

if [ -n "$TTY_PATH" ] && [ -n "$SESSION_ID" ]; then
  CACHE_FILE="$CACHE_DIR/$SESSION_ID"

  if [ "$EVENT" = "SessionStart" ]; then
    # Resolve project name from hook JSON cwd or Claude process cwd
    PROJECT=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null | xargs basename 2>/dev/null)
    if [ -z "$PROJECT" ] && [ -n "$PPID" ]; then
      PROJECT=$(lsof -a -d cwd -p "$PPID" -Fn 2>/dev/null | grep '^n/' | head -1 | sed 's|^n||' | xargs basename 2>/dev/null)
    fi
    # Cache the project name for this session
    if [ -n "$PROJECT" ]; then
      mkdir -p "$CACHE_DIR" 2>/dev/null
      echo "$PROJECT" > "$CACHE_FILE" 2>/dev/null
    fi
  elif [ "$EVENT" = "SessionEnd" ]; then
    # Clean up cache file when session ends
    rm -f "$CACHE_FILE" 2>/dev/null
  else
    # Read cached project name (fast — no lsof needed)
    PROJECT=""
    [ -f "$CACHE_FILE" ] && PROJECT=$(cat "$CACHE_FILE" 2>/dev/null)
  fi

  # Set/refresh the tab title on every event (except SessionEnd)
  if [ "$EVENT" != "SessionEnd" ] && [ -n "$PROJECT" ]; then
    printf '\033]0;Claude: %s\007' "$PROJECT" > "$TTY_PATH" 2>/dev/null
  fi
fi

echo "$ENRICHED" | curl -s -m 5 -X POST \
  -H "Content-Type: application/json" \
  --data-binary @- \
  http://localhost:3333/api/hooks &>/dev/null &
exit 0
