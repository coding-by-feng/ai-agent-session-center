/**
 * Tracks which sessions currently hold unsaved editor state inside their
 * PROJECT tab — a markdown draft or a new-file buffer.
 *
 * DetailPanel keeps only the N most-recently-visited ProjectTabContainers
 * mounted and unmounts the rest to bound renderer memory. Unmounting throws
 * away component-local state, and neither draft is persisted anywhere, so a
 * session that is mid-edit must never be evicted. This registry is the signal
 * the eviction loop consults.
 *
 * Deliberately a plain module-level Map rather than a Zustand store: eviction
 * reads it imperatively at the instant it evicts, so no component needs to
 * re-render when it changes.
 *
 * Keyed session → editor ids because one session can host several sub-tabs
 * (ProjectTabContainer renders one ProjectTab per sub-tab), and any one of them
 * being dirty must pin the whole container.
 */
const editorsBySession = new Map<string, Set<string>>();

/**
 * Mark (or clear) one editor as having unsaved changes.
 *
 * @param sessionId Owning session; no-op when undefined (floating/preview tabs
 *                  that DetailPanel does not manage).
 * @param editorId  Stable per-sub-tab id, so two sub-tabs can't clear each other.
 */
export function setProjectEditing(
  sessionId: string | undefined,
  editorId: string,
  editing: boolean,
): void {
  if (!sessionId) return;
  const editors = editorsBySession.get(sessionId);
  if (editing) {
    if (editors) editors.add(editorId);
    else editorsBySession.set(sessionId, new Set([editorId]));
    return;
  }
  if (!editors) return;
  editors.delete(editorId);
  if (editors.size === 0) editorsBySession.delete(sessionId);
}

/** True while any of a session's PROJECT sub-tabs has unsaved editor state. */
export function isProjectEditing(sessionId: string): boolean {
  return (editorsBySession.get(sessionId)?.size ?? 0) > 0;
}

/** Test hook — drops all tracked state. */
export function resetProjectEditing(): void {
  editorsBySession.clear();
}
