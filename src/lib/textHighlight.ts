/**
 * textHighlight — pure, dependency-free helpers for case-insensitive substring
 * search + highlight segmentation.
 *
 * Kept apart from any component so the matching rule is defined ONCE and shared
 * by every surface that highlights a user query (conversation search, the
 * global prompt trace). Two callers with two slightly different `includes`
 * checks is how a "7 matches" counter ends up disagreeing with what is lit up
 * on screen.
 *
 * Import-free by design: consumed from both 2D list views and row renderers.
 */

/** One run of text, flagged as a query match or not. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Normalize a raw query for matching: lowercased and trimmed.
 * An all-whitespace query is treated as no query at all — otherwise a stray
 * space matches every entry and "filter to matches" silently becomes a no-op.
 */
export function normalizeQuery(query: string | undefined | null): string {
  return (query ?? '').trim().toLowerCase();
}

/**
 * True when `text` contains `normalizedQuery` (which MUST already be lowercased
 * — pass the output of `normalizeQuery`). An empty query matches nothing, so
 * callers can use this directly as a filter predicate without special-casing.
 */
export function matchesQuery(text: string | undefined | null, normalizedQuery: string): boolean {
  if (!normalizedQuery) return false;
  return (text ?? '').toLowerCase().includes(normalizedQuery);
}

/**
 * Split `text` into alternating non-match / match segments.
 *
 * Returns a single non-match segment when there is no query or no hit, so the
 * caller can always render the same way. Matching is case-insensitive but the
 * ORIGINAL casing is preserved in the returned segments — highlighting must
 * never rewrite the text it highlights.
 */
export function splitHighlight(text: string, normalizedQuery: string): HighlightSegment[] {
  if (!normalizedQuery || !text) return [{ text, match: false }];

  const haystack = text.toLowerCase();
  const segments: HighlightSegment[] = [];
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(normalizedQuery, from);
    if (at === -1) break;
    if (at > from) segments.push({ text: text.slice(from, at), match: false });
    segments.push({ text: text.slice(at, at + normalizedQuery.length), match: true });
    from = at + normalizedQuery.length;
  }

  if (segments.length === 0) return [{ text, match: false }];
  if (from < text.length) segments.push({ text: text.slice(from), match: false });
  return segments;
}

/**
 * Clip a long body of text to a window around its first match so a 40 KB pasted
 * prompt doesn't render 40 KB to show one hit. Returns the original text
 * (unclipped) when there is no query, no match, or the text already fits.
 *
 * `leading`/`trailing` are character budgets either side of the match; ellipses
 * mark whichever side was cut.
 */
export function clipToMatch(
  text: string,
  normalizedQuery: string,
  { leading = 120, trailing = 400 }: { leading?: number; trailing?: number } = {},
): string {
  if (!normalizedQuery || !text) return text;
  const at = text.toLowerCase().indexOf(normalizedQuery);
  if (at === -1) return text;

  const start = Math.max(0, at - leading);
  const end = Math.min(text.length, at + normalizedQuery.length + trailing);
  if (start === 0 && end === text.length) return text;

  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}
