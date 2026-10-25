/**
 * commandUsage — how often each /command or skill appears in your prompts
 * (Oct 21 2026), so the phone's `/` lists can put the ones you use first.
 *
 * Counted from the prompt history (`prompts`), not from picks in a list: most
 * skills are typed, and many ride at the END of a prompt ("… /raab"), so a token
 * counts wherever it stands as its own word, once per prompt. A path never counts
 * (`/tmp/x.png` is followed by another `/`). Built-in commands such as `/compact`
 * fire no prompt hook, so they rarely reach the history and rank as before.
 *
 * The window is the last USAGE_WINDOW_MS: current habits, not a command used
 * hundreds of times months ago. A remote device counts only the sessions it can
 * see now: history across sessions is host-only (apiRouter `requireSharedHistory`),
 * and a count is derived from that history.
 *
 * Pure apart from the injected reader (`db.getPromptTextsSince` in apiRouter), so
 * the tests never open the database.
 */
import { filterVisibleSessions, type VisibilityCandidate } from './sessionVisibility.js';
import log from './logger.js';

/** How far back the count reaches: 90 days. */
export const USAGE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** How long one scope's count is kept before the history is read again. */
export const USAGE_CACHE_MS = 60_000;
/** At most this many scopes (the Mac's, plus one per distinct set of shared sessions) are kept. */
const MAX_SCOPES = 8;

/**
 * A `/name` or `$name` standing as its own word: at the start or after a space, "(",
 * a quote or a backtick, and followed by a space, the end, or only punctuation
 * ("/review.", "`/review`", "/krt-work:"). The name is word segments joined by `:` or
 * `.` (`/commit-commands:commit`), each segment non-empty, so a separator can never be
 * read both as part of the name and as the punctuation after it: the match stays linear
 * on a pasted log's run of dots (a lazy `[\w:.]*?` took 6 s on 60k dots, Oct 21 2026).
 * Codex's composer records a picked skill as a Markdown link, `[$raab](/…/raab/SKILL.md)`,
 * so a `[` before and a `](` after count too (Oct 23 2026).
 */
const TOKEN_RE = /(?:^|[\s("'`[])([/$][A-Za-z0-9][\w-]*(?:[:.][\w-]+)*)(?=[.,;:!?)\]"'`]*(?:\s|$)|\]\()/g;

/** The tokens one prompt uses, each once. */
export function promptTokens(text: string): Set<string> {
  const seen = new Set<string>();
  for (const m of text.matchAll(TOKEN_RE)) seen.add(m[1]);
  return seen;
}

/** How many of `texts` use each token, each prompt counting a token once. */
export function countCommandTokens(texts: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of promptTokens(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * The counts whose name is a listed command or skill (a plugin one by
 * `plugin:name`), keyed by the token as typed. The client puts each on its entry
 * by the one sigil rule (`entryToken` in src/lib/commandIndex.ts).
 */
export function usageForEntries(
  counts: ReadonlyMap<string, number>,
  entries: readonly { name: string; pluginName?: string }[],
): Record<string, number> {
  const names = new Set<string>();
  for (const e of entries) {
    names.add(e.name);
    if (e.pluginName) names.add(`${e.pluginName}:${e.name}`);
  }
  const out: Record<string, number> = {};
  for (const [token, n] of counts) {
    if (names.has(token.slice(1))) out[token] = n;
  }
  return out;
}

/** Whose prompts count: every session for the Mac (null), the visible ones for another device. */
export function usageScope(
  isLocalClient: boolean,
  sessions: Record<string, VisibilityCandidate>,
): string[] | null {
  if (isLocalClient) return null;
  return Object.keys(filterVisibleSessions(false, sessions));
}

/** Reads the text of the prompts since `sinceMs`, of `sessionIds` only when given. */
export type PromptTextReader = (sinceMs: number, sessionIds: string[] | null) => string[];

export interface CommandUsage {
  /** Token → prompts using it, for a scope from `usageScope`. Never throws. */
  counts(sessionIds: readonly string[] | null): Map<string, number>;
}

export function createCommandUsage(read: PromptTextReader, now: () => number = Date.now): CommandUsage {
  const cache = new Map<string, { at: number; counts: Map<string, number> }>();
  return {
    counts(sessionIds) {
      if (sessionIds && sessionIds.length === 0) return new Map();
      const ids = sessionIds ? [...sessionIds].sort() : null;
      const key = ids ? ids.join('\n') : '*';
      const t = now();
      const hit = cache.get(key);
      if (hit && t - hit.at < USAGE_CACHE_MS) return hit.counts;
      let counts: Map<string, number>;
      try {
        counts = countCommandTokens(read(t - USAGE_WINDOW_MS, ids));
      } catch (err: unknown) {
        // The list still works without counts; a failure is not kept, so the next asks again.
        log.warn('command-usage', `reading the prompt history failed: ${err instanceof Error ? err.message : String(err)}`);
        return new Map();
      }
      cache.delete(key);
      if (cache.size >= MAX_SCOPES) cache.delete(cache.keys().next().value as string);
      cache.set(key, { at: t, counts });
      return counts;
    },
  };
}
