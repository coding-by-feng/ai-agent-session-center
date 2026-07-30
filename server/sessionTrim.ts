/**
 * Bounds on the per-session text the server keeps in memory.
 *
 * The entry-count caps (50 prompts, 200 tool calls, 50 events) were never the
 * problem — the *contents* were unbounded. Measured on a live instance: 49
 * sessions serialized to 1.74 MB, but one alone was 1,120,984 bytes, of which
 * `promptHistory` was 1,062,567 across 50 entries (~21 KB per prompt — a session
 * where large files had been pasted into prompts). A second session spent
 * 261,323 bytes in `previousSessions` for four entries.
 *
 * Nothing here is the source of truth for prompt text, which is what makes the
 * caps safe:
 *  - `db.insertFullPrompt()` writes every prompt to SQLite at FULL length
 *    *before* the trimmed copy is pushed. That ordering matters: `upsertSession`
 *    re-inserts prompts from the capped in-memory copy, and `insertPrompt` is
 *    `INSERT OR IGNORE` against `UNIQUE(session_id, timestamp)`, so the full row
 *    written first wins and the truncated re-insert is discarded.
 *  - ConversationView reads the Claude Code JSONL transcript for untruncated
 *    fidelity and only falls back to `promptHistory`.
 *
 * The restore path (`dbGetPrompts` on SessionStart) replays through `pushPrompt`
 * for the same reason — the DB rows are full length and would otherwise
 * reintroduce the very history these caps bound.
 */

import type { PromptEntry, ArchivedSession, Session } from '../src/types/session.js';

/**
 * Longest prompt text retained per history entry (~4 000 words). Beyond this a
 * prompt is a paste, and the full text is still in SQLite + the JSONL transcript.
 */
export const MAX_PROMPT_CHARS = 16_000;

/** Total characters `promptHistory` may hold before the oldest entries are dropped. */
export const MAX_PROMPT_HISTORY_CHARS = 200_000;

/** Entry-count cap on `promptHistory` (pre-existing behaviour, kept). */
export const MAX_PROMPT_HISTORY_ENTRIES = 50;

/**
 * Cap on `currentPrompt`. It is display-only — the 3D robot speech bubble is its
 * sole consumer and truncates to 60 chars — but it rides along on every session
 * broadcast, so an unbounded copy costs both memory and WebSocket bandwidth.
 */
export const MAX_CURRENT_PROMPT_CHARS = 2_000;

/** Appended to any text this module shortens, so the UI never lies by omission. */
export const TRUNCATION_MARKER = '\n\n[… truncated — full prompt kept in the session transcript]';

/** Shorten `text` to `maxChars`, appending a marker. Returns it unchanged if it fits. */
export function truncateText(text: string, maxChars: number): string {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** Cap the always-broadcast `currentPrompt`. */
export function trimCurrentPrompt(text: string): string {
  return truncateText(text, MAX_CURRENT_PROMPT_CHARS);
}

/**
 * Append a prompt to `history`, enforcing both the entry-count cap and a total
 * character budget (oldest dropped first).
 *
 * The byte budget is what actually bounds this: 50 entries is meaningless when a
 * single entry can be a megabyte. At least one entry always survives, so the
 * newest prompt is never dropped — it is truncated by `MAX_PROMPT_CHARS` instead.
 *
 * Mutates `history` in place to match the existing push/shift call sites.
 */
export function pushPrompt(history: PromptEntry[], entry: PromptEntry): PromptEntry[] {
  history.push({ ...entry, text: truncateText(entry.text, MAX_PROMPT_CHARS) });

  while (history.length > MAX_PROMPT_HISTORY_ENTRIES) history.shift();

  let total = 0;
  for (const p of history) total += p.text?.length ?? 0;
  while (history.length > 1 && total > MAX_PROMPT_HISTORY_CHARS) {
    const dropped = history.shift();
    total -= dropped?.text?.length ?? 0;
  }

  return history;
}

/**
 * Snapshot a session for `previousSessions`.
 *
 * Carries ONLY what the UI reads. `PrevSessionSection` (ConversationView)
 * renders `startedAt`, `endedAt` and `promptHistory`; `workspaceSnapshot` reads
 * `sessionId`. The archive used to also deep-copy `toolLog`, `responseLog`,
 * `events`, `toolUsage` and `totalToolCalls` — written at three call sites and
 * read at none, ~46 KB of the ~65 KB measured per archived entry, kept five
 * deep. Dropping them is invisible to the UI.
 *
 * If you add a field here, add a consumer too, or it is dead weight again.
 */
export function toArchivedSession(session: Session): ArchivedSession {
  return {
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    promptHistory: session.promptHistory.map((p) => ({
      ...p,
      text: truncateText(p.text, MAX_PROMPT_CHARS),
    })),
  };
}
