// stopHooksState.ts — is Claude still running its Stop hooks? (the phone's "Finishing up")
//
// Claude fires Stop to every Stop hook at once, AASC's own among them, so the card turns
// "ready" the moment the answer is written. The turn is not over until the slowest hook
// returns (claude-mem's summarize hook: median 2.4 s, p90 39 s, max 124 s over 1,412 turns,
// Nov 2026), and a prompt sent in that window is held by Claude with no hook at all: it
// fires UserPromptSubmit only when the hooks finish. Seen from the phone, the prompt
// vanished. A hook that blocks the stop is worse: Claude goes on working on its feedback
// and the held prompt waits for that turn too (54 s for one `/build`).
//
// Claude writes a `stop_hook_summary` line when the hooks are done (1,462 of 1,466 finished
// turns), so `stopHooksSince` runs from Stop until the transcript has one after the answer.
// The status is left alone on purpose, as with compaction: display only. Codex's rollout has
// no such line, so the mark is Claude's only.

import { EVENT_TYPES } from './constants.js';

/** Events that start a new phase of the session: the Stop hooks are behind it. */
const ENDS_STOP_HOOKS: ReadonlySet<string> = new Set([
  EVENT_TYPES.USER_PROMPT_SUBMIT,
  EVENT_TYPES.PRE_TOOL_USE,
  EVENT_TYPES.PERMISSION_REQUEST,
  EVENT_TYPES.SESSION_START,
  EVENT_TYPES.SESSION_END,
  EVENT_TYPES.PRE_COMPACT,
]);

/** The session's `stopHooksSince` after this hook: `now`, null, or `prev` unchanged. */
export function nextStopHooksSince(
  prev: number | null,
  eventName: string,
  cli: string,
  now: number,
): number | null {
  if (eventName === EVENT_TYPES.STOP) return cli === 'claude' ? now : null;
  if (prev !== null && ENDS_STOP_HOOKS.has(eventName)) return null;
  return prev;
}

interface Entry {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  attachment?: { type?: unknown; hookEvent?: unknown } | null;
}

/**
 * Have this turn's Stop hooks finished? Read from the end of the transcript: a
 * `stop_hook_summary` after the newest main-thread answer, with no Stop hook blocking in
 * between. A tail with no answer in it says only whether it holds a summary: prompts queued
 * during the hold write `queue-operation` lines of up to ~650 KB, which push the answer out
 * of a 64 KB tail while Claude still holds them (5 of 666 real turns). Failing closed there
 * is bounded by the phone's `STOP_HOOKS_STALE_MS`.
 */
export function stopHooksSettled(lines: readonly string[]): boolean {
  let summarized = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    // Only three kinds of line matter; skip parsing the rest (tool output can be large).
    if (!raw.includes('"assistant"') && !raw.includes('stop_hook_summary') && !raw.includes('hook_blocking_error')) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(raw) as Entry;
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || entry.isSidechain === true) continue;
    if (entry.type === 'assistant') return summarized;
    if (entry.type === 'system' && entry.subtype === 'stop_hook_summary') summarized = true;
    else if (entry.type === 'attachment' && entry.attachment?.type === 'hook_blocking_error' && entry.attachment.hookEvent === 'Stop') {
      return false;
    }
  }
  return summarized;
}
