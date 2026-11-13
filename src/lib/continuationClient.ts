import { hasUnsavedProjectEdits } from './hostedSwitch';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import { hasContinuationDraft, mergeContinuation } from './workspaceContinuation';
import type { ContinuationWrite, WorkspaceContinuation } from '@/types/workspaceContinuation';

type State = { error?: string; conflicts?: WorkspaceContinuation['drafts'] };
export interface ContinuationController {
  flush: () => Promise<void>;
  prepareSwitch: () => Promise<void>;
  stop: () => void;
}
const endpoint = '/api/workspace/continuation';
const resumeKey = 'aasc.workspace-continuation.resume';

export async function startContinuation(
  signal: AbortSignal,
  onChange: (state: State) => void,
): Promise<ContinuationController | null> {
  const response = await fetch(endpoint, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
    credentials: 'same-origin',
  });
  // Clients may still connect to older/non-hosted servers.
  if (
    response.status === 404 ||
    !response.headers.get('content-type')?.includes('application/json')
  )
    return null;
  if (!response.ok) throw new Error('无法读取接续信息，请保留当前窗口并重试。');
  const data = (await response.json()) as { records: WorkspaceContinuation[] };
  if (!Array.isArray(data.records)) throw new Error('接续信息格式无效。');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  const sessions = useSessionStore.getState();
  let resumeSourceId: string | undefined;
  try {
    const saved = sessionStorage.getItem(resumeKey);
    if (data.records.some((record) => record.sourceId === saved)) resumeSourceId = saved!;
  } catch {
    /* Ordinary startup also works when browser storage is disabled. */
  }
  const merged = mergeContinuation(
    useQueueStore.getState().composeDrafts,
    data.records,
    new Set(sessions.sessions.keys()),
    resumeSourceId,
  );
  for (const [id, draft] of merged.drafts) useQueueStore.getState().setComposeDraft(id, draft);
  if (!sessions.selectedSessionId && merged.selectedSessionId)
    sessions.selectSession(merged.selectedSessionId);
  onChange({ conflicts: merged.conflicts, error: '' });

  const sourceId = crypto.randomUUID();
  let revision = 0,
    dirty = true,
    stopped = false;
  let adopt = merged.adopt;
  let handoff = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<void> | null = null;
  const capture = (): ContinuationWrite => {
    const state = useSessionStore.getState();
    const selected = state.selectedSessionId ?? state.lastSelectedSessionId;
    return {
      sourceId,
      revision,
      selectedSessionId: selected && state.sessions.has(selected) ? selected : null,
      drafts: [...useQueueStore.getState().composeDrafts]
        .filter(([id, draft]) => state.sessions.has(id) && hasContinuationDraft(draft))
        .map(([sessionId, draft]) => ({ sessionId, draft })),
      adopt,
      ...(handoff ? { handoff: true } : {}),
      ...(resumeSourceId ? { resumeSourceId } : {}),
    };
  };
  const flush = (): Promise<void> => {
    clearTimeout(timer);
    if (stopped || signal.aborted) return Promise.reject(new Error('工作区连接已关闭。'));
    if (inflight) return inflight;
    inflight = (async () => {
      while (dirty) {
        const body = JSON.stringify(capture());
        dirty = false;
        try {
          const saved = await fetch(endpoint, {
            method: 'PUT',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body,
            signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
            keepalive: body.length < 60000,
          });
          if (!saved.ok) throw new Error('草稿尚未保存，请保留当前窗口并重试。');
          const result = (await saved.json()) as { revision: number };
          if (!Number.isSafeInteger(result.revision)) throw new Error('保存确认无效。');
          revision = result.revision;
          adopt = [];
          if (resumeSourceId) {
            try {
              if (sessionStorage.getItem(resumeKey) === resumeSourceId)
                sessionStorage.removeItem(resumeKey);
            } catch {
              /* The durable save succeeded; storage cleanup is optional. */
            }
            resumeSourceId = undefined;
          }
          if (!stopped) onChange({ error: '' });
        } catch (error) {
          dirty = true;
          if (!stopped)
            onChange({ error: error instanceof Error ? error.message : '草稿尚未保存。' });
          throw error;
        }
      }
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  };
  const schedule = () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 300);
  };
  const unsubscribeSession = useSessionStore.subscribe((next, previous) => {
    if (
      next.selectedSessionId !== previous.selectedSessionId ||
      next.lastSelectedSessionId !== previous.lastSelectedSessionId
    )
      schedule();
  });
  const unsubscribeDraft = useQueueStore.subscribe((next, previous) => {
    if (next.composeDrafts !== previous.composeDrafts) schedule();
  });
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (dirty || inflight || hasUnsavedProjectEdits()) {
      void flush().catch(() => {});
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', beforeUnload);
  schedule();
  return {
    flush,
    prepareSwitch: async () => {
      // Even a clean window may have been overtaken or adopted by another one.
      // Refresh its own record and protect it until the destination takes over.
      handoff = true;
      dirty = true;
      try {
        await flush();
        sessionStorage.setItem(resumeKey, sourceId);
      } finally {
        handoff = false;
      }
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribeSession();
      unsubscribeDraft();
      window.removeEventListener('beforeunload', beforeUnload);
    },
  };
}
