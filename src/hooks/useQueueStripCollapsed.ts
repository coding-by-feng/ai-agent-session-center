/**
 * useQueueStripCollapsed — whether the queue strip under the terminal is folded to its header. DetailPanel
 * sizes the strip's row from it and QueueTab draws it, so both read it here.
 *
 * Full keeps one stored flag. Lite folds the strip while the session has nothing queued or typed, so the
 * terminal keeps its height. A click overrides that until the queue next goes from empty to non-empty or back,
 * so a strip folded by hand still opens for the next prompts. The click is not stored, because Full reads the
 * flag on the same port. When the last prompt sends with the cursor in the strip's compose box, the strip stays
 * as if opened by hand, or the box would vanish between two prompts.
 */
import { useCallback, useLayoutEffect, useRef } from 'react';
import { IS_LITE } from '@/lib/edition';
import { useQueueStore } from '@/stores/queueStore';
import { useUiStore } from '@/stores/uiStore';

function composeBoxHasFocus(sessionId: string): boolean {
  return document.activeElement?.closest('[data-queue-compose]')?.getAttribute('data-queue-compose') === sessionId;
}

export function useQueueStripCollapsed(sessionId: string): readonly [boolean, (collapsed: boolean) => void] {
  const stored = useUiStore((s) => s.queuePanelCollapsed);
  const setStored = useUiStore((s) => s.setQueuePanelCollapsed);
  const choice = useUiStore((s) => s.queueStripChoice);
  const setChoice = useUiStore((s) => s.setQueueStripChoice);
  const hasQueued = useQueueStore((s) => (s.queues.get(sessionId)?.length ?? 0) > 0);
  // A draft counts: the strip must not fold under someone typing while the last prompt sends.
  const hasDraft = useQueueStore((s) => {
    const draft = s.composeDrafts.get(sessionId);
    return Boolean(draft?.text || draft?.images.length);
  });

  const choiceIsOurs = choice?.sessionId === sessionId;
  const choiceHolds = choiceIsOurs && choice.hadQueued === hasQueued;
  // One effect, and before paint: run apart, clearing a stale click could undo the hold, and the box would blink.
  const before = useRef({ sessionId, hasQueued });
  useLayoutEffect(() => {
    const emptied = before.current.sessionId === sessionId && before.current.hasQueued && !hasQueued;
    before.current = { sessionId, hasQueued };
    if (IS_LITE && emptied && composeBoxHasFocus(sessionId)) setChoice({ sessionId, collapsed: false, hadQueued: false });
    else if (choiceIsOurs && !choiceHolds) setChoice(null);
  }, [sessionId, hasQueued, choiceIsOurs, choiceHolds, setChoice]);

  const setCollapsed = useCallback((collapsed: boolean) => {
    if (IS_LITE) setChoice({ sessionId, collapsed, hadQueued: hasQueued });
    else setStored(collapsed);
  }, [sessionId, hasQueued, setChoice, setStored]);

  if (!IS_LITE) return [stored, setCollapsed];
  return [choiceHolds ? choice.collapsed : !hasQueued && !hasDraft, setCollapsed];
}
