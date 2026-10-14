#!/bin/bash
# AI Agent Session Center - Codex CLI lifecycle hook relay (macOS / Linux)
# Codex command hooks pass JSON on stdin. Legacy notify payloads passed one JSON
# argument, so keep a small fallback for users upgrading from older installs.

SENT_AT=$(date +%s)
if [ -t 0 ]; then
  INPUT=""
else
  INPUT=$(cat)
fi
[ -z "$INPUT" ] && INPUT="${1:-{}}"

# --- Everything runs in background so the hook returns instantly ---
{

# ── Event name (a SessionStart is where PID-keyed caches may be stale) ──
EVENT_CHECK=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
if [ -z "$EVENT_CHECK" ]; then
  LEGACY_TYPE=$(echo "$INPUT" | jq -r '.type // empty' 2>/dev/null)
  [ "$LEGACY_TYPE" = "agent-turn-complete" ] && EVENT_CHECK="Stop"
fi

# ── TTY detection (cached per Codex PID) ──
# PIDs are reused, so a cached entry can belong to an earlier process. A SessionStart is a
# process's first hook: re-read the tty then, and drop a stale entry when this process has none.
# A headless agent must report no tty, or the server cannot tell it from one in a dashboard terminal.
HOOK_TTY=""
if [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  # The cache is a per-user 0700 directory and is used only if it really is ours: a shared /tmp path
  # could be pre-created or symlinked by another account, and a SessionStart writes into it.
  TTY_CACHE="/tmp/codex-tty-cache-${EUID:-$(id -u)}"
  [ -d "$TTY_CACHE" ] || mkdir -m 700 "$TTY_CACHE" 2>/dev/null
  TTY_CACHE_FILE=""
  if [ -d "$TTY_CACHE" ] && [ ! -L "$TTY_CACHE" ] && [ -O "$TTY_CACHE" ]; then
    TTY_CACHE_FILE="$TTY_CACHE/$PPID"
  fi
  if [ "$EVENT_CHECK" != "SessionStart" ] && [ -n "$TTY_CACHE_FILE" ] && [ -f "$TTY_CACHE_FILE" ]; then
    HOOK_TTY=$(cat "$TTY_CACHE_FILE" 2>/dev/null)
  else
    RAW_TTY=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
    if [ -n "$RAW_TTY" ] && [ "$RAW_TTY" != "??" ] && [ "$RAW_TTY" != "?" ]; then
      HOOK_TTY="/dev/${RAW_TTY}"
      [ -n "$TTY_CACHE_FILE" ] && echo "$HOOK_TTY" > "$TTY_CACHE_FILE" 2>/dev/null
    elif [ -n "$TTY_CACHE_FILE" ]; then
      rm -f "$TTY_CACHE_FILE" 2>/dev/null
    fi
  fi
fi

# ── Startup command capture (SessionStart only) ──
STARTUP_CMD=""
if [ "$EVENT_CHECK" = "SessionStart" ] && [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  STARTUP_CMD=$(ps -p "$PPID" -o args= 2>/dev/null | head -1 | sed 's/^[[:space:]]*//')
fi

# ── Single jq pass: normalize Codex payload + enrich environment data ──
ENRICHED=$(echo "$INPUT" | jq -c \
  --arg pid "$PPID" \
  --arg tty "$HOOK_TTY" \
  --arg sent_at "$SENT_AT" \
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
  --arg agent_terminal_id "${AGENT_MANAGER_TERMINAL_ID:-}" \
  --arg startup_cmd "$STARTUP_CMD" \
  '
  def normalized_event:
    if .hook_event_name then .hook_event_name
    elif .type == "agent-turn-complete" then "Stop"
    else "Stop" end;

  . + {
    hook_event_name: normalized_event,
    session_id: (.session_id // .["thread-id"] // ""),
    cwd: (.cwd // null),
    claude_pid: ($pid | tonumber),
    hook_sent_at: (($sent_at | tonumber) * 1000),
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
    kitty_pid: (if $kitty_pid != "" then ($kitty_pid | tonumber) else null end),
    agent_terminal_id: (if $agent_terminal_id != "" then $agent_terminal_id else null end),
    startup_command: (if $startup_cmd != "" then $startup_cmd else null end),
    cli_source: "codex",
    codex_event: (.hook_event_name // .type // null),
    response: (
      .response
      // .last_assistant_message
      // .["last-assistant-message"]
      // null
    ),
    prompt: (
      .prompt
      // (if .["input-messages"] then (.["input-messages"] | last | .content // null) else null end)
    )
  }
  ' 2>/dev/null)

[ -z "$ENRICHED" ] && ENRICHED="$INPUT"

# ── Deliver to dashboard via file-based MQ (primary) or HTTP (fallback) ──
MQ_DIR="/tmp/claude-session-center"
MQ_FILE="$MQ_DIR/queue.jsonl"

if [ -d "$MQ_DIR" ]; then
  echo "$ENRICHED" >> "$MQ_FILE" 2>/dev/null
else
  echo "$ENRICHED" | curl -s --connect-timeout 1 -m 3 -X POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    http://localhost:3333/api/hooks &>/dev/null
fi

} &>/dev/null &
disown
exit 0
