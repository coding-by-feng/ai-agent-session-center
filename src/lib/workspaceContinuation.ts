import type { ContinuationDraft, WorkspaceContinuation } from '@/types/workspaceContinuation';
export function mergeContinuation(
  current: Map<string, ContinuationDraft>,
  records: WorkspaceContinuation[],
  visible: Set<string>,
  preferredSourceId?: string,
) {
  const drafts = new Map(current);
  const conflicts: WorkspaceContinuation['drafts'] = [];
  const adopt: Array<{ sourceId: string; revision: number }> = [];
  let selectedSessionId: string | null = null;
  const preferred = records.find((record) => record.sourceId === preferredSourceId);
  const ordered = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  if (preferred) ordered.splice(ordered.indexOf(preferred), 1);
  for (const record of preferred ? [preferred, ...ordered] : ordered) {
    const canRestore = !preferred || record === preferred;
    if (
      canRestore &&
      !selectedSessionId &&
      record.selectedSessionId &&
      visible.has(record.selectedSessionId)
    )
      selectedSessionId = record.selectedSessionId;
    let copied = canRestore;
    for (const item of record.drafts) {
      if (!visible.has(item.sessionId)) {
        copied = false;
        continue;
      }
      const existing = drafts.get(item.sessionId);
      // A switching window's empty draft is intentional. Other windows remain
      // available as alternatives, but must not refill it or change selection.
      if (canRestore && (!existing || !hasContinuationDraft(existing)))
        drafts.set(item.sessionId, item.draft);
      else if (JSON.stringify(existing) !== JSON.stringify(item.draft)) {
        if (
          !conflicts.some(
            (conflict) =>
              conflict.sessionId === item.sessionId &&
              JSON.stringify(conflict.draft) === JSON.stringify(item.draft),
          )
        )
          conflicts.push(item);
        copied = false;
      }
    }
    if (copied) adopt.push({ sourceId: record.sourceId, revision: record.revision });
  }
  return { drafts, conflicts, adopt, selectedSessionId };
}

export function hasContinuationDraft(draft: ContinuationDraft): boolean {
  return Boolean(draft.text || draft.images.length || draft.runAt || draft.type !== 'once');
}
