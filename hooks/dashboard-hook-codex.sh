#!/bin/bash
# AI Agent Session Center - Codex CLI hook relay (macOS / Linux)
# Codex CLI passes JSON as a command-line argument ($1), NOT via stdin.
# Only one event type: agent-turn-complete → mapped to "Stop".
# The notify command is inherently fire-and-forget (async).

SENT_AT=$(date +%s)
INPUT="${1:-{}}"

# --- Everything runs in background so the hook returns instantly ---
{

# ── Parse JSON fields from the notify payload ──
# Codex provides: type, thread-id, cwd, input-messages, last-assistant-message
SESSION_ID=$(echo "$INPUT" | jq -r '.["thread-id"] // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
EVENT_TYPE=$(echo "$INPUT" | jq -r '.type // "agent-turn-complete"' 2>/dev/null)

# ── Map Codex events to dashboard-compatible event names ──
case "$EVENT_TYPE" in
  agent-turn-complete) MAPPED_EVENT="Stop" ;;
  *)                   MAPPED_EVENT="Stop" ;;
esac

# ── Build enriched JSON ──
ENRICHED=$(echo "$INPUT" | jq -c \
  --arg event "$MAPPED_EVENT" \
  --arg session_id "$SESSION_ID" \
  --arg cwd "$CWD" \
  --arg pid "$PPID" \
  --arg sent_at "$SENT_AT" \
  --arg agent_terminal_id "${AGENT_MANAGER_TERMINAL_ID:-}" \
  --arg codex_event "$EVENT_TYPE" \
  '
  {
    hook_event_name: $event,
    session_id: (if $session_id != "" then $session_id else null end),
    cwd: (if $cwd != "" then $cwd else null end),
    claude_pid: ($pid | tonumber),
    hook_sent_at: (($sent_at | tonumber) * 1000),
    agent_terminal_id: (if $agent_terminal_id != "" then $agent_terminal_id else null end),
    response: (.["last-assistant-message"] // null),
    prompt: (if .["input-messages"] then (.["input-messages"] | last | .content // null) else null end),
    model: (.model // null),
    source: "codex",
    codex_event: $codex_event
  }
  ' 2>/dev/null)

[ -z "$ENRICHED" ] && ENRICHED="{\"hook_event_name\":\"$MAPPED_EVENT\",\"session_id\":\"$SESSION_ID\",\"cwd\":\"$CWD\",\"source\":\"codex\"}"

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
