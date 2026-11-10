import type { ContinuationDraft, WorkspaceContinuation } from '@/types/workspaceContinuation';
export function mergeContinuation(
  current: Map<string, ContinuationDraft>,
  records: WorkspaceContinuation[],
  visible: Set<string>,
) {
  const drafts = new Map(current);
  const conflicts: WorkspaceContinuation['drafts'] = [];
  const adopt: Array<{ sourceId: string; revision: number }> = [];
  let selectedSessionId: string | null = null;
  for (const record of [...records].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!selectedSessionId && record.selectedSessionId && visible.has(record.selectedSessionId))
      selectedSessionId = record.selectedSessionId;
    let copied = true;
    for (const item of record.drafts) {
      if (!visible.has(item.sessionId)) {
        copied = false;
        continue;
      }
      const existing = drafts.get(item.sessionId);
      if (!existing || !hasContinuationDraft(existing)) drafts.set(item.sessionId, item.draft);
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
