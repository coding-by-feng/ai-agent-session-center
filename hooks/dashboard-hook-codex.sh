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

# ── TTY detection (cached per Codex PID) ──
HOOK_TTY=""
if [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  TTY_CACHE="/tmp/codex-tty-cache"
  TTY_CACHE_FILE="$TTY_CACHE/$PPID"
  if [ -f "$TTY_CACHE_FILE" ]; then
    HOOK_TTY=$(cat "$TTY_CACHE_FILE" 2>/dev/null)
  else
    RAW_TTY=$(ps -o tty= -p "$PPID" 2>/dev/null | tr -d ' ')
    if [ -n "$RAW_TTY" ] && [ "$RAW_TTY" != "??" ] && [ "$RAW_TTY" != "?" ]; then
      HOOK_TTY="/dev/${RAW_TTY}"
      mkdir -p "$TTY_CACHE" 2>/dev/null
      echo "$HOOK_TTY" > "$TTY_CACHE_FILE" 2>/dev/null
    fi
  fi
fi

# ── Startup command capture (SessionStart only) ──
STARTUP_CMD=""
EVENT_CHECK=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)
if [ -z "$EVENT_CHECK" ]; then
  LEGACY_TYPE=$(echo "$INPUT" | jq -r '.type // empty' 2>/dev/null)
  [ "$LEGACY_TYPE" = "agent-turn-complete" ] && EVENT_CHECK="Stop"
fi
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
