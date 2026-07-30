/**
 * The single rule for how a picked snippet lands in a prompt box.
 *
 * Shared by every call site (queue compose row, MAIN prompt, chain steps) so
 * "insert" means exactly one thing everywhere. Kept pure and DOM-free: caret
 * position is deliberately NOT consulted, so no call site needs an imperative
 * handle on the shared `AutocompleteTextarea`.
 */

/**
 * Append `snippet` to `current`, separated by a single newline.
 *
 * - An empty (or whitespace-only) box is replaced outright, so the common
 *   "insert into a blank input" case produces no leading blank line.
 * - Existing trailing whitespace is trimmed before the separator, so appending
 *   twice can't accumulate blank lines.
 * - A blank snippet is a no-op and returns `current` unchanged.
 */
export function appendSnippet(current: string, snippet: string): string {
  const addition = snippet.trim();
  if (!addition) return current;
  const base = current.trimEnd();
  return base ? `${base}\n${addition}` : addition;
}
