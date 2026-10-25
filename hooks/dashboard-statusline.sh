#!/bin/bash
# AI Agent Session Center - status-line tap (macOS / Linux)
#
# Claude Code runs this as a session's statusLine command: the status JSON arrives on stdin
# and whatever this prints IS the footer text. The dashboard passes it per launch
# (`claude --settings '{"statusLine":…}'`), so nothing is ever written to ~/.claude/settings.json.
#
# Three jobs, all invisible to the user:
#   0. Record the live model and effort (model.id / display_name, effort.level) and how full
#      the context window is (context_window) in
#      /tmp/claude-session-center/runtime/<session-id>.json for the session header's
#      model · effort · context chip (server/sessionRuntimeWatch.ts).
#   1. Record the plan rate limits (rate_limits.five_hour / seven_day). Claude Code reports
#      them nowhere else, and only after the session's first API response. One tiny snapshot
#      per session lands in /tmp/claude-session-center/usage/<session-id>.json, which the
#      dashboard server watches and polls (server/planUsageSources.ts).
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
# - It stores only session_id, a timestamp, rate_limits, the model/effort and the context
#   numbers (used %, window size, tokens in it, and the last reply's counts by kind) — not the cwd or
#   transcript path — and only when the dashboard's queue directory exists.
# - It writes only into a usage/runtime directory that is a real directory owned by the current user:
#   never through a symlink, never into someone else's directory.

INPUT=$(cat)

# jq does all the JSON work. Without it there is nothing safe to do.
command -v jq >/dev/null 2>&1 || exit 0

# AASC_USAGE_DIR only exists so tests can point the tap elsewhere; the default must stay in
# step with USAGE_DIR in server/planUsageSources.ts.
USAGE_DIR="${AASC_USAGE_DIR:-/tmp/claude-session-center/usage}"

# Write one JSON snapshot ($3) as <dir ($1)>/<id ($2)>.json. /tmp is shared ground: anyone
# can pre-create a path there, as a symlink that would carry the snapshots somewhere else or
# as a directory of their own. Write only into a real directory that is ours — the rule the
# server applies before it reads (and sweeps) it. Temp file in the same directory + rename:
# the server never reads a half-written file.
write_snapshot() {
  local dir="$1" sid="${2//[^A-Za-z0-9_-]/_}" snap="$3" tmp
  [ -n "$sid" ] && [ -n "$snap" ] || return 0
  mkdir -p -m 700 "$dir" 2>/dev/null
  [ -d "$dir" ] && [ ! -L "$dir" ] && [ -O "$dir" ] || return 0
  tmp="$dir/.$sid.$$.tmp"
  if printf '%s\n' "$snap" > "$tmp"; then
    mv -f "$tmp" "$dir/$sid.json" || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
}

# ── Job 0: live model + effort snapshot (background) ──
# Every render carries the model the session runs on and, when that model takes the effort
# parameter, effort.level — the live value, including the level Claude restores for a model
# after a switch. The dashboard's session header shows them (server/sessionRuntime.ts).
# Beside usage/ by default, so a test that moves usage/ moves this too.
RUNTIME_DIR="${AASC_RUNTIME_DIR:-${USAGE_DIR%/*}/runtime}"
case "$INPUT" in
  *'"model"'*)
    {
      [ -d "${RUNTIME_DIR%/*}" ] || exit 0   # the dashboard is not running: nothing is listening
      OUT=$(printf '%s' "$INPUT" | jq -r '
        select((.session_id | type) == "string" and (.session_id | length) > 0
               and (.model | type) == "object")
        | (.session_id | gsub("[^A-Za-z0-9_-]"; "_") | .[0:64]),
          ({session_id, ts: (now * 1000 | floor),
            model: {id: .model.id, display_name: .model.display_name},
            effort: (if (.effort | type) == "object" then {level: .effort.level} else null end)}
           # Only a CLI that reports context_window gets the key: its absence means "not reported".
           + (if (.context_window | type) == "object" then
                (.context_window as $c
                 | {context: ({
                     used_percentage: ($c.used_percentage | if type == "number" then . else null end),
                     size: ($c.context_window_size | if type == "number" then . else null end),
                     # The tokens IN the window: what used_percentage is computed from (output excluded).
                     tokens: (if ($c.current_usage | type) == "object" then
                                [$c.current_usage | .input_tokens, .cache_creation_input_tokens, .cache_read_input_tokens
                                 | select(type == "number")] | if length == 0 then null else add end
                              else null end)}
                     # The last reply, counted by kind: the phone shows it as the context details
                     # (Oct 21 2026). No apostrophes in here: this program sits inside single quotes.
                     + (if ($c.current_usage | type) == "object" then
                          {parts: ($c.current_usage
                                   | {input: .input_tokens, cacheWrite: .cache_creation_input_tokens,
                                      cacheRead: .cache_read_input_tokens, output: .output_tokens}
                                   | with_entries(select(.value | type == "number")))}
                        else {} end))})
              else {} end)
           | tojson)
      ' 2>/dev/null)
      case "$OUT" in *$'\n'*) ;; *) exit 0 ;; esac
      write_snapshot "$RUNTIME_DIR" "${OUT%%$'\n'*}" "${OUT#*$'\n'}"
    } &>/dev/null &
    disown
    ;;
esac

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
      write_snapshot "$USAGE_DIR" "${OUT%%$'\n'*}" "${OUT#*$'\n'}"
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
