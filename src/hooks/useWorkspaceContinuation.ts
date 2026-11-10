import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useWsStore } from '@/stores/wsStore';
import { startContinuation, type ContinuationController } from '@/lib/continuationClient';
import type { WorkspaceContinuation } from '@/types/workspaceContinuation';

export const useContinuationState = create<{
  ready: boolean;
  error: string;
  conflicts: WorkspaceContinuation['drafts'];
  controller: ContinuationController | null;
}>(() => ({ ready: false, error: '', conflicts: [], controller: null }));

export async function flushWorkspaceContinuation(): Promise<void> {
  const state = useContinuationState.getState();
  if (!state.ready || !state.controller) throw new Error('工作区接续尚未就绪，请稍后重试。');
  await state.controller.prepareSwitch();
}
export function useWorkspaceContinuation() {
  const connected = useWsStore((s) => s.connected && s.snapshotReceived);
  const [attempt, setAttempt] = useState(0);
  const [hasSnapshot, setHasSnapshot] = useState(connected);
  // A transient socket disconnect must not remove the unsaved-draft guard.
  if (connected && !hasSnapshot) setHasSnapshot(true);
  useEffect(() => {
    if (!hasSnapshot) return;
    const abort = new AbortController();
    let controller: ContinuationController | null = null;
    useContinuationState.setState({ ready: false, error: '', controller: null, conflicts: [] });
    void startContinuation(abort.signal, (state) => {
      if (!abort.signal.aborted) useContinuationState.setState(state);
    })
      .then((result) => {
        controller = result;
        if (abort.signal.aborted) {
          result?.stop();
          return;
        }
        useContinuationState.setState({ ready: true, controller: result });
      })
      .catch((error) => {
        if (!abort.signal.aborted) useContinuationState.setState({ error: error.message });
      });
    return () => {
      controller?.stop();
      abort.abort();
      useContinuationState.setState({ ready: false, controller: null });
    };
  }, [hasSnapshot, attempt]);
  return () => setAttempt((n) => n + 1);
}
