#!/bin/bash
# AI Agent Session Center - status-line tap (macOS / Linux)
#
# Claude Code runs this as a session's statusLine command: the status JSON arrives on stdin
# and whatever this prints IS the footer text. The dashboard passes it per launch
# (`claude --settings '{"statusLine":…}'`), so nothing is ever written to ~/.claude/settings.json.
#
# Two jobs, both invisible to the user:
#   1. Record the plan rate limits (rate_limits.five_hour / seven_day). Claude Code reports
#      them nowhere else, and only after the session's first API response. One tiny snapshot
#      per session lands in /tmp/claude-session-center/usage/<session-id>.json, which the
#      dashboard server polls (server/planUsageSources.ts).
#   2. Chain to the user's OWN status line (local project > project > user settings). This
#      tap replaces it for the sessions the dashboard launches, so without the chain a bar
#      they configured would silently vanish.
#
# Rules this script keeps:
# - It never delays or garbles the footer. The snapshot is written by a background subshell
#   with stdout/stderr discarded, and the only thing printed is the chained command's output.
# - It never fails. No jq, malformed JSON, an unwritable directory: all end in `exit 0` with
#   nothing printed (an error message here would land in the user's footer).
# - It never loops. The chained command runs with AASC_STATUSLINE_TAP=1 and a tap that
#   finds that marker (or a command that names this script) does not chain again.
# - It stores only session_id, a timestamp and rate_limits — not the cwd, transcript path
#   or model — and only when the dashboard's queue directory exists.
# - It writes only into a usage directory that is a real directory owned by the current user:
#   never through a symlink, never into someone else's directory.

INPUT=$(cat)

# jq does all the JSON work. Without it there is nothing safe to do.
command -v jq >/dev/null 2>&1 || exit 0

# AASC_USAGE_DIR only exists so tests can point the tap elsewhere; the default must stay in
# step with USAGE_DIR in server/planUsageSources.ts.
USAGE_DIR="${AASC_USAGE_DIR:-/tmp/claude-session-center/usage}"

# ── Job 1: plan-limit snapshot (background) ──
# rate_limits is absent until the first API response, so most renders skip this entirely.
case "$INPUT" in
  *'"rate_limits"'*)
    {
      [ -d "${USAGE_DIR%/*}" ] || exit 0   # the dashboard is not running: nothing is listening
      OUT=$(printf '%s' "$INPUT" | jq -r '
        select((.session_id | type) == "string" and (.session_id | length) > 0
               and (.rate_limits | type) == "object")
        | (.session_id | gsub("[^A-Za-z0-9_-]"; "_") | .[0:64]),
          ({session_id, ts: (now * 1000 | floor), rate_limits} | tojson)
      ' 2>/dev/null)
      case "$OUT" in *$'\n'*) ;; *) exit 0 ;; esac
      SID="${OUT%%$'\n'*}"
      SNAP="${OUT#*$'\n'}"
      # The id becomes a file name: keep it to safe characters even if the line above lied.
      SID="${SID//[^A-Za-z0-9_-]/_}"
      [ -n "$SID" ] && [ -n "$SNAP" ] || exit 0
      mkdir -p -m 700 "$USAGE_DIR" 2>/dev/null
      # /tmp is shared ground: anyone can pre-create this path, as a symlink that would carry
      # the snapshots somewhere else or as a directory of their own. Write only into a real
      # directory that is ours — the rule the server applies before it reads (and sweeps) it.
      [ -d "$USAGE_DIR" ] && [ ! -L "$USAGE_DIR" ] && [ -O "$USAGE_DIR" ] || exit 0
      # Temp file in the same directory + rename: the server never reads a half-written file.
      TMP="$USAGE_DIR/.$SID.$$.tmp"
      if printf '%s\n' "$SNAP" > "$TMP"; then
        mv -f "$TMP" "$USAGE_DIR/$SID.json" || rm -f "$TMP"
      else
        rm -f "$TMP"
      fi
    } &>/dev/null &
    disown
    ;;
esac

# ── Job 2: chain to the user's own status line (foreground: its stdout is the footer) ──
[ -z "${AASC_STATUSLINE_TAP:-}" ] || exit 0

PROJECT_DIR=$(printf '%s' "$INPUT" | jq -r '
  (.workspace.project_dir // .workspace.current_dir // .cwd // empty) | select(type == "string")
' 2>/dev/null)

CMD=""
for F in \
  "${PROJECT_DIR:+$PROJECT_DIR/.claude/settings.local.json}" \
  "${PROJECT_DIR:+$PROJECT_DIR/.claude/settings.json}" \
  "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"; do
  [ -n "$F" ] && [ -f "$F" ] || continue
  # Most settings files define no status line: skip them without a jq run.
  { CONTENT=$(<"$F"); } 2>/dev/null
  case "$CONTENT" in *'"statusLine"'*) ;; *) continue ;; esac
  # One file per jq run: a malformed higher-precedence file must not hide the ones below it.
  CMD=$(jq -r '(try .statusLine.command catch empty) | select(type == "string" and length > 0)' "$F" 2>/dev/null)
  [ -n "$CMD" ] && break
done

case "$CMD" in
  ''|*dashboard-statusline*) exit 0 ;;   # nothing configured, or it leads back here
esac

printf '%s' "$INPUT" | AASC_STATUSLINE_TAP=1 /bin/sh -c "$CMD"
exit 0
