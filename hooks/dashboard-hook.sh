#!/bin/bash
# AI Agent Session Center - Hook relay (macOS / Linux)
# Reads hook JSON from stdin, enriches with process/env info, POSTs to dashboard server
#
# Performance notes:
# - stdin read (cat) is synchronous; everything else runs in a background subshell
# - Single jq invocation for all JSON parsing + enrichment
# - TTY lookup cached per PID in /tmp to avoid `ps` on every event
# - Tab title only refreshed on state-changing events, not rapid tool calls
# - curl fails fast (1s connect timeout) so dead server doesn't pile up processes
# - hook_sent_at timestamp lets the server measure delivery latency

SENT_AT=$(date +%s)
INPUT=$(cat)

# --- Everything below runs in background so the hook returns instantly ---
{

# ── TTY detection (cached per Claude PID) ──
HOOK_TTY=""
if [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  TTY_CACHE="/tmp/claude-tty-cache"
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

# ── Single jq pass: enrich JSON + extract event/session_id/cwd ──
JQ_OUT=$(echo "$INPUT" | jq -c \
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
  --arg claude_project_dir "${CLAUDE_PROJECT_DIR:-}" \
  --arg cc_parent_session "${CLAUDE_CODE_PARENT_SESSION_ID:-}" \
  --arg cc_team_name "${CLAUDE_CODE_TEAM_NAME:-}" \
  --arg cc_agent_name "${CLAUDE_CODE_AGENT_NAME:-}" \
  --arg cc_agent_type "${CLAUDE_CODE_AGENT_TYPE:-}" \
  --arg cc_agent_id "${CLAUDE_CODE_AGENT_ID:-}" \
  --arg cc_agent_color "${CLAUDE_CODE_AGENT_COLOR:-}" \
  '
  (. + {
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
    claude_project_dir: (if $claude_project_dir != "" then $claude_project_dir else null end),
    parent_session_id: (if $cc_parent_session != "" then $cc_parent_session else null end),
    team_name: (if $cc_team_name != "" then $cc_team_name else null end),
    agent_name: (if $cc_agent_name != "" then $cc_agent_name else null end),
    agent_type: (if $cc_agent_type != "" then $cc_agent_type else null end),
    agent_id: (if $cc_agent_id != "" then $cc_agent_id else null end),
    agent_color: (if $cc_agent_color != "" then $cc_agent_color else null end)
  }),
  "\(.hook_event_name // "")",
  "\(.session_id // "")",
  "\(.cwd // "")"
  ' 2>/dev/null)

ENRICHED=$(echo "$JQ_OUT" | head -1)
EVENT=$(echo "$JQ_OUT" | sed -n '2p' | tr -d '"')
SESSION_ID=$(echo "$JQ_OUT" | sed -n '3p' | tr -d '"')
CWD=$(echo "$JQ_OUT" | sed -n '4p' | tr -d '"')

[ -z "$ENRICHED" ] && ENRICHED="$INPUT"

# ── Tab title management ──
# Only refresh on state-changing events — skip rapid PreToolUse/PostToolUse
CACHE_DIR="/tmp/claude-tab-titles"

if [ -n "$HOOK_TTY" ] && [ -n "$SESSION_ID" ]; then
  CACHE_FILE="$CACHE_DIR/$SESSION_ID"

  case "$EVENT" in
    SessionStart)
      PROJECT=""
      [ -n "$CWD" ] && PROJECT=$(basename "$CWD" 2>/dev/null)
      if [ -z "$PROJECT" ] && [ -n "$PPID" ]; then
        PROJECT=$(lsof -a -d cwd -p "$PPID" -Fn 2>/dev/null | grep '^n/' | head -1 | sed 's|^n||' | xargs basename 2>/dev/null)
      fi
      if [ -n "$PROJECT" ]; then
        mkdir -p "$CACHE_DIR" 2>/dev/null
        echo "$PROJECT" > "$CACHE_FILE" 2>/dev/null
        printf '\033]0;Claude: %s\007' "$PROJECT" > "$HOOK_TTY" 2>/dev/null
      fi
      ;;
    SessionEnd)
      rm -f "$CACHE_FILE" 2>/dev/null
      ;;
    UserPromptSubmit|PermissionRequest|Stop|Notification)
      PROJECT=""
      [ -f "$CACHE_FILE" ] && PROJECT=$(cat "$CACHE_FILE" 2>/dev/null)
      [ -n "$PROJECT" ] && printf '\033]0;Claude: %s\007' "$PROJECT" > "$HOOK_TTY" 2>/dev/null
      ;;
  esac
fi

# ── Deliver to dashboard via file-based MQ (primary) or HTTP (fallback) ──
MQ_DIR="/tmp/claude-session-center"
MQ_FILE="$MQ_DIR/queue.jsonl"

if [ -d "$MQ_DIR" ]; then
  # Atomic append: POSIX guarantees atomicity for writes <= PIPE_BUF (4096 bytes).
  # Our enriched JSON is typically 300-800 bytes — no process spawn, ~0.1ms.
  echo "$ENRICHED" >> "$MQ_FILE" 2>/dev/null
else
  # Fallback: HTTP POST when MQ dir doesn't exist (server not started yet)
  echo "$ENRICHED" | curl -s --connect-timeout 1 -m 3 -X POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    http://localhost:3333/api/hooks &>/dev/null
fi

} &>/dev/null &
disown
exit 0
