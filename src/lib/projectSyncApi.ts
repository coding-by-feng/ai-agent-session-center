import type {
  SyncAction,
  SyncChange,
  SyncEntryFilter,
  SyncEntryPage,
  SyncGroupDecision,
  SyncLink,
  SyncLinkInput,
  SyncOverview,
  SyncRun,
} from '@/types/projectSync';

/** A refusal the UI can act on (e.g. `live-sessions` → ask, then retry with confirmation). */
export class SyncRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

async function request<T>(path = '', body?: unknown): Promise<T> {
  const res = await fetch(
    `/api/resources/sync${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  let result: { success?: boolean; data?: T; error?: string; code?: string };
  try {
    result = await res.json();
  } catch {
    throw new SyncRequestError('Project sync is available only on the machine that runs AASC.');
  }
  if (!res.ok || !result.success)
    throw new SyncRequestError(
      result.error || 'Could not complete the project sync request.',
      result.code,
    );
  return result.data as T;
}
const enc = encodeURIComponent;

export const projectSyncApi = {
  overview: () => request<SyncOverview>(),
  createLink: (input: SyncLinkInput) => request<SyncLink>('/links', input),
  updateLink: (id: string, patch: { name?: string; excludes?: string[] }) =>
    request<SyncLink>(`/links/${enc(id)}/update`, patch),
  removeLink: (id: string) => request<null>(`/links/${enc(id)}/remove`, {}),
  compare: (id: string) => request<SyncRun>(`/links/${enc(id)}/compare`, {}),
  run: (id: string) => request<SyncRun>(`/runs/${enc(id)}`),
  entries: (
    id: string,
    q: { filter: SyncEntryFilter; group?: string; offset: number; limit: number },
  ) => {
    const p = new URLSearchParams({
      filter: q.filter,
      offset: String(q.offset),
      limit: String(q.limit),
    });
    if (q.group !== undefined) p.set('group', q.group);
    return request<SyncEntryPage>(`/runs/${enc(id)}/entries?${p}`);
  },
  diff: (id: string, entryId: string) =>
    request<{ patch: string | null; note?: string }>(
      `/runs/${enc(id)}/entries/${enc(entryId)}/diff`,
    ),
  decide: (
    id: string,
    body: {
      entries?: Record<string, SyncAction>;
      groups?: Record<string, SyncGroupDecision>;
      bulk?: { change: SyncChange; action: SyncAction };
    },
  ) => request<SyncRun>(`/runs/${enc(id)}/decisions`, body),
  start: (id: string, confirmLiveSessions = false) =>
    request<SyncRun>(`/runs/${enc(id)}/run`, { confirmLiveSessions }),
  cancel: (id: string) => request<SyncRun>(`/runs/${enc(id)}/cancel`, {}),
  undo: (id: string) =>
    request<{ run: SyncRun; restored: number; skipped: number }>(`/runs/${enc(id)}/undo`, {}),
};
