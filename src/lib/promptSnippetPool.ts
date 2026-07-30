/**
 * Pooling maths for the prompt-snippet picker's RECENT tab.
 *
 * RECENT is a read-only view over prompt history across EVERY session — the
 * pool the user 🔖s from. It writes nothing; only an explicit keep promotes a
 * row into `promptSnippetStore`.
 *
 * Split out of the component so the rules are unit-testable without a DOM or a
 * populated session store, and so the component file only exports components
 * (react-refresh/only-export-components).
 */

/** Default cap on the RECENT list. Above roughly this many rows the list stops
 *  being scannable and the user is better served by the filter box. */
export const RECENT_LIMIT = 40;

/** The only fields pooling reads off a session. */
export interface RecentPromptSource {
  /** Breadcrumb shown at the row's right edge (project name, or a fallback). */
  sessionLabel: string;
  promptHistory: ReadonlyArray<{ text: string; timestamp: number }>;
}

export interface RecentPrompt {
  /** Trimmed prompt text. */
  text: string;
  /** Timestamp of the NEWEST occurrence of this text. */
  timestamp: number;
  /** Session the newest occurrence came from. */
  sessionLabel: string;
}

/**
 * Flatten every session's prompt history into one newest-first list.
 *
 * Deduped on exact trimmed text, keeping the **newest** occurrence — pooling
 * across sessions means common prompts (`/compact`, `/retouch-current-prompt`)
 * appear in many histories, and without this the list is mostly duplicates.
 * Keeping the newest is what makes the breadcrumb meaningful: it names the
 * session that used the prompt most recently, not an arbitrary one.
 *
 * Blank / whitespace-only entries are dropped — they're unusable as snippets
 * and would render as empty rows.
 */
export function poolRecentPrompts(
  sources: ReadonlyArray<RecentPromptSource>,
  limit: number = RECENT_LIMIT,
): RecentPrompt[] {
  const newestByText = new Map<string, RecentPrompt>();

  for (const source of sources) {
    for (const entry of source.promptHistory) {
      const text = entry.text?.trim();
      if (!text) continue;
      const prev = newestByText.get(text);
      if (prev && prev.timestamp >= entry.timestamp) continue;
      newestByText.set(text, {
        text,
        timestamp: entry.timestamp,
        sessionLabel: source.sessionLabel,
      });
    }
  }

  return Array.from(newestByText.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, limit));
}
