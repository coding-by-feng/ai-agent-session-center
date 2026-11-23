#!/bin/bash
# AI Agent Session Center - Google Antigravity CLI (`agy`) lifecycle hook relay (macOS / Linux)
#
# Registered in ~/.gemini/config/hooks.json under the named hook "aasc-dashboard", one entry per event, with the
# event as the first argument. agy runs each hook through `sh -c` in the folder that holds hooks.json, with
# camelCase JSON on stdin (conversationId, cwd, lastUserInput, toolCall, terminationReason, ...).
# Verified against agy 1.5.14 (Nov 23 2026):
#   - the hook's parent process is agy itself (sh execs the command), on agy's tty;
#   - PreToolUse MUST print nothing: a `{}` (no "decision") DENIES the tool. An empty reply leaves agy's own
#     permission rules in charge. Every other event gets `{}`, its documented "no change" answer;
#   - there is no prompt event: the first PreInvocation of a turn (invocationNum 0) carries lastUserInput;
#   - Stop carries no reply text: it is the last MODEL line of transcript_full.jsonl.
# Events are mapped onto the Claude names the server knows, tagged cli_source "antigravity".

EVENT="${1:-}"
SENT_AT=$(date +%s)
if [ -t 0 ]; then INPUT=""; else INPUT=$(cat); fi
[ -z "$INPUT" ] && INPUT='{}'

# Answer agy first: it waits for stdout (30 s default timeout) before going on.
[ "$EVENT" = "PreToolUse" ] || printf '{}\n'

# Only these become dashboard events. A later model call in the same turn is not a new prompt.
case "$EVENT" in
  SessionStart|PreToolUse|PostToolUse|Stop) ;;
  PreInvocation)
    INVOCATION_RE='"invocationNum"[[:space:]]*:[[:space:]]*([0-9]+)'
    if [[ "$INPUT" =~ $INVOCATION_RE ]] && [ "${BASH_REMATCH[1]}" != "0" ]; then exit 0; fi
    ;;
  *) exit 0 ;;
esac

# Per-session lite hooks (the AASC "Automation" mark): lifecycle events only. Keep in step with
# LITE_HOOK_EVENTS (server/sessionHookLevel.ts).
if [ "${AASC_HOOK_LEVEL:-}" = "lite" ]; then
  case "$EVENT" in PreToolUse|PostToolUse) exit 0 ;; esac
fi

{

AGY_PID="$PPID"
HOOK_TTY=""
PERMISSION_MODE=""
STARTUP_CMD=""
if [ -n "$AGY_PID" ] && [ "$AGY_PID" != "0" ]; then
  # tty and launch line, cached per agy pid in a per-user 0700 directory (only if it really is ours).
  CACHE_DIR="/tmp/agy-hook-cache-${EUID:-$(id -u)}"
  [ -d "$CACHE_DIR" ] || mkdir -m 700 "$CACHE_DIR" 2>/dev/null
  CACHE_FILE=""
  if [ -d "$CACHE_DIR" ] && [ ! -L "$CACHE_DIR" ] && [ -O "$CACHE_DIR" ]; then CACHE_FILE="$CACHE_DIR/$AGY_PID"; fi
  if [ "$EVENT" != "SessionStart" ] && [ -n "$CACHE_FILE" ] && [ -f "$CACHE_FILE" ]; then
    HOOK_TTY=$(sed -n 1p "$CACHE_FILE" 2>/dev/null)
    STARTUP_CMD=$(sed -n 2p "$CACHE_FILE" 2>/dev/null)
  else
    RAW_TTY=$(ps -o tty= -p "$AGY_PID" 2>/dev/null | tr -d ' ')
    if [ -n "$RAW_TTY" ] && [ "$RAW_TTY" != "??" ] && [ "$RAW_TTY" != "?" ]; then HOOK_TTY="/dev/${RAW_TTY}"; fi
    STARTUP_CMD=$(ps -p "$AGY_PID" -o args= 2>/dev/null | head -1 | sed 's/^[[:space:]]*//')
    [ -n "$CACHE_FILE" ] && printf '%s\n%s\n' "$HOOK_TTY" "$STARTUP_CMD" > "$CACHE_FILE" 2>/dev/null
  fi
  # The approval timer is off when agy never asks (server approvalDetector NEVER_PROMPTS_MODES).
  case " $STARTUP_CMD " in
    *" --dangerously-skip-permissions "*) PERMISSION_MODE="bypassPermissions" ;;
    *" --mode auto "*|*" --mode=auto "*) PERMISSION_MODE="auto" ;;
  esac
fi

# Stop: the reply is the last MODEL line with text in the transcript agy names.
RESPONSE=""
if [ "$EVENT" = "Stop" ]; then
  TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcriptPath // empty' 2>/dev/null)
  if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
    RESPONSE=$(tail -n 200 "$TRANSCRIPT" 2>/dev/null | jq -rs \
      'map(select(.source == "MODEL" and .type == "PLANNER_RESPONSE" and (.content | type) == "string" and .content != "")) | last | .content // empty' 2>/dev/null)
  fi
fi

ENRICHED=$(printf '%s' "$INPUT" | jq -c \
  --arg event "$EVENT" \
  --arg pid "$AGY_PID" \
  --arg tty "$HOOK_TTY" \
  --arg sent_at "$SENT_AT" \
  --arg term_program "${TERM_PROGRAM:-}" \
  --arg term "${TERM:-}" \
  --arg iterm_session "${ITERM_SESSION_ID:-}" \
  --arg term_session "${TERM_SESSION_ID:-}" \
  --arg tmux "${TMUX:-}" \
  --arg tmux_pane "${TMUX_PANE:-}" \
  --arg agent_terminal_id "${AGENT_MANAGER_TERMINAL_ID:-}" \
  --arg startup_cmd "$STARTUP_CMD" \
  --arg permission_mode "$PERMISSION_MODE" \
  --arg response "$RESPONSE" \
  '
  def tool_name($n):
    if $n == "run_command" then "Bash"
    elif ($n == "read_file" or $n == "view_file" or $n == "view_file_outline" or $n == "view_code_item") then "Read"
    elif $n == "write_to_file" then "Write"
    elif ($n == "replace_file_content" or $n == "multi_replace_file_content" or $n == "edit_file") then "Edit"
    elif ($n == "list_dir" or $n == "find_by_name") then "Glob"
    elif ($n == "grep_search" or $n == "codebase_search") then "Grep"
    elif $n == "search_web" then "WebSearch"
    elif $n == "read_url_content" then "WebFetch"
    else ($n // "Tool") end;
  def tool_input($c):
    ($c.args // {}) as $a
    | if $c.name == "run_command" then {command: ($a.CommandLine // "")}
      else {file_path: ($a.AbsolutePath // $a.TargetFile // $a.Path // $a.File // null),
            pattern: ($a.Query // $a.Pattern // $a.SearchPattern // null),
            url: ($a.Url // null)} | with_entries(select(.value != null))
      end;
  (.toolCall // null) as $call
  | {
    hook_event_name: (
      if $event == "PreInvocation" then "UserPromptSubmit"
      elif $event == "PostToolUse" and ((.error // "") != "") then "PostToolUseFailure"
      else $event end),
    session_id: (.conversationId // ""),
    cwd: (.cwd // (.workspacePaths // [])[0] // null),
    model: (.modelName // null),
    claude_pid: (if $pid != "" then ($pid | tonumber) else null end),
    hook_sent_at: (($sent_at | tonumber) * 1000),
    tty_path: (if $tty != "" then $tty else null end),
    term_program: (if $term_program != "" then $term_program else null end),
    term: (if $term != "" then $term else null end),
    tab_id: (if $iterm_session != "" then $iterm_session elif $term_session != "" then $term_session else null end),
    tmux: (if $tmux != "" then {session: $tmux, pane: $tmux_pane} else null end),
    agent_terminal_id: (if $agent_terminal_id != "" then $agent_terminal_id else null end),
    startup_command: (if $event == "SessionStart" and $startup_cmd != "" then $startup_cmd else null end),
    permission_mode: (if $permission_mode != "" then $permission_mode else null end),
    cli_source: "antigravity",
    agent_event: $event,
    agent_transcript_path: (.transcriptPath // null)
  }
  + (if $event == "PreInvocation" then {prompt: (.lastUserInput // "")} else {} end)
  + (if $call != null then {tool_name: tool_name($call.name), tool_input: tool_input($call), agent_tool: $call.name} else {} end)
  + (if $event == "PostToolUse" and ((.error // "") != "") then {error: .error} else {} end)
  + (if $event == "Stop" then {response: (if $response != "" then $response else null end), stop_reason: (.terminationReason // null)} else {} end)
  | with_entries(select(.value != null))
  ' 2>/dev/null)

[ -z "$ENRICHED" ] && exit 0
case "$ENRICHED" in *'"session_id":""'*) exit 0 ;; esac

# One write() per line (see dashboard-hook-codex.sh): parallel hooks must never interleave a torn line.
mq_append() {
  local LC_ALL=C
  if [ "${#1}" -lt 1000 ]; then
    echo "$1" >> "$2"
  elif command -v perl >/dev/null 2>&1; then
    printf '%s\n' "$1" | env -u PERL_UNICODE -u PERL5OPT perl -e 'binmode STDIN; local $/; my $d = <STDIN>;
      open(my $f, ">>", $ARGV[0]) or exit 1; binmode $f; my $o = 0; while ($o < length $d) { my $n = syswrite($f, $d, length($d) - $o, $o); exit 1 unless defined $n; $o += $n; }' "$2"
  else
    printf '%s\n' "$1" | cat >> "$2"
  fi
}

# AASC_HOOK_MQ_DIR: tests only (test/agyHookRelay.test.ts), so a run never writes the live queue.
MQ_DIR="${AASC_HOOK_MQ_DIR:-/tmp/claude-session-center}"
MQ_FILE="$MQ_DIR/queue.jsonl"
if [ -d "$MQ_DIR" ]; then
  mq_append "$ENRICHED" "$MQ_FILE" 2>/dev/null
else
  echo "$ENRICHED" | curl -s --connect-timeout 1 -m 3 -X POST \
    -H "Content-Type: application/json" --data-binary @- \
    http://localhost:3333/api/hooks &>/dev/null
fi

} </dev/null &>/dev/null &
disown
exit 0
