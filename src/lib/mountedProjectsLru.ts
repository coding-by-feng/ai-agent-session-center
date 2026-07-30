/**
 * LRU bookkeeping for the set of sessions whose ProjectTabContainers stay
 * mounted in DetailPanel.
 *
 * Mounted containers are expensive — a react-arborist file tree, a file-content
 * cache, rendered markdown, and for PDFs an <iframe> that costs a whole
 * Chromium pdf-renderer process — so only the most recently visited handful are
 * kept alive. Extracted from DetailPanel so the ordering and eviction rules are
 * unit-testable without mounting the panel.
 */

/**
 * Mark `sessionId` as most-recently-used, then evict least-recently-used
 * entries until at most `max` remain.
 *
 * Iteration order of the returned Map is least- → most-recently-used, which is
 * what makes the first key the next eviction candidate.
 *
 * Two entries are never evicted:
 *  - `sessionId` itself, which was just visited and is on screen;
 *  - any session `isPinned` reports as busy — in practice one holding unsaved
 *    editor state, since unmounting would silently discard it.
 *
 * If pinning keeps the map above `max`, the map is allowed to exceed the cap
 * rather than dropping a user's unsaved work. It shrinks back on the next visit
 * once those editors are saved or cancelled.
 *
 * @returns A new Map; the input is not mutated.
 */
export function retainRecentProjects<T>(
  mounted: Map<string, T>,
  sessionId: string,
  entry: T,
  max: number,
  isPinned: (sessionId: string) => boolean = () => false,
): Map<string, T> {
  const next = new Map(mounted);

  // Delete-then-set moves this session to the end of the insertion order.
  next.delete(sessionId);
  next.set(sessionId, entry);

  for (const candidate of Array.from(next.keys())) {
    if (next.size <= max) break;
    if (candidate === sessionId || isPinned(candidate)) continue;
    next.delete(candidate);
  }

  return next;
}

/**
 * True when `sessionId` is already the most-recently-used entry, so the caller
 * can skip the state update entirely and avoid re-rendering every container.
 */
export function isMostRecentProject(mounted: Map<string, unknown>, sessionId: string): boolean {
  let last: string | undefined;
  for (const key of mounted.keys()) last = key;
  return last === sessionId;
}
