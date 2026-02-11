#!/bin/bash
# AI Agent Session Center - Gemini CLI hook relay (macOS / Linux)
# Receives Gemini event name as $1, reads hook JSON from stdin.
# Maps Gemini events to dashboard-compatible format, enriches with env info,
# and delivers to the dashboard server via file-based MQ or HTTP.
#
# Key difference from Claude hook:
# - Gemini hooks are SYNCHRONOUS — must print response to stdout immediately
# - Event name comes as $1 argument (registered per-event in settings.json)
# - Session ID from GEMINI_SESSION_ID env var
# - CWD from GEMINI_CWD env var

GEMINI_EVENT="${1:-unknown}"
SENT_AT=$(date +%s)
INPUT=$(cat)

# Gemini hooks are blocking — respond immediately to allow execution
echo '{"decision":"allow"}'

# --- Everything below runs in background so the hook returns instantly ---
{

# ── Map Gemini events to dashboard-compatible event names ──
case "$GEMINI_EVENT" in
  SessionStart)   MAPPED_EVENT="SessionStart" ;;
  BeforeAgent)    MAPPED_EVENT="UserPromptSubmit" ;;
  BeforeTool)     MAPPED_EVENT="PreToolUse" ;;
  AfterTool)      MAPPED_EVENT="PostToolUse" ;;
  AfterAgent)     MAPPED_EVENT="Stop" ;;
  SessionEnd)     MAPPED_EVENT="SessionEnd" ;;
  Notification)   MAPPED_EVENT="Notification" ;;
  *)              MAPPED_EVENT="$GEMINI_EVENT" ;;
esac

# ── Session/CWD from Gemini env vars ──
SESSION_ID="${GEMINI_SESSION_ID:-}"
CWD="${GEMINI_CWD:-$(pwd)}"

# ── TTY detection (cached per PID) ──
HOOK_TTY=""
if [ -n "$PPID" ] && [ "$PPID" != "0" ]; then
  TTY_CACHE="/tmp/gemini-tty-cache"
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

# ── Single jq pass: build enriched JSON ──
ENRICHED=$(echo "$INPUT" | jq -c \
  --arg event "$MAPPED_EVENT" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg pid "$PPID" \
  --arg tty "$HOOK_TTY" \
  --arg sent_at "$SENT_AT" \
  --arg agent_terminal_id "${AGENT_MANAGER_TERMINAL_ID:-}" \
  --arg gemini_event "$GEMINI_EVENT" \
  '
  {
    hook_event_name: $event,
    session_id: (if $session_id != "" then $session_id else (.session_id // null) end),
    cwd: (if $cwd != "" then $cwd else (.cwd // null) end),
    claude_pid: ($pid | tonumber),
    hook_sent_at: (($sent_at | tonumber) * 1000),
    tty_path: (if $tty != "" then $tty else null end),
    agent_terminal_id: (if $agent_terminal_id != "" then $agent_terminal_id else null end),
    tool_name: (.tool_name // null),
    tool_input: (.tool_input // null),
    prompt: (.prompt // .llm_request // null),
    response: (.response // .llm_response // .prompt_response // null),
    model: (.model // null),
    source: "gemini",
    gemini_event: $gemini_event
  }
  ' 2>/dev/null)

[ -z "$ENRICHED" ] && ENRICHED="{\"hook_event_name\":\"$MAPPED_EVENT\",\"session_id\":\"$SESSION_ID\",\"cwd\":\"$CWD\",\"source\":\"gemini\"}"

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
