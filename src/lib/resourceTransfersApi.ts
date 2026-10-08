import type {
  TransferAction,
  TransferDevice,
  TransferDeviceInput,
  TransferDraft,
  TransferOverview,
  TransferTask,
} from '@/types/resourceTransfers';

async function request<T>(path = '', body?: unknown): Promise<T> {
  const res = await fetch(
    `/api/resources/transfers${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
  const result = await res.json();
  if (!res.ok || !result.success)
    throw new Error(result.error || 'Could not complete the transfer request.');
  return result.data as T;
}
export const transfersApi = {
  overview: () => request<TransferOverview>(),
  addDevice: (device: TransferDeviceInput) => request<TransferDevice>('/devices', device),
  removeDevice: (id: string) => request<null>(`/devices/${encodeURIComponent(id)}/remove`, {}),
  saveDraft: (draft: TransferDraft) => request<TransferTask>('/tasks', draft),
  compare: (id: string) => request<TransferTask>(`/tasks/${encodeURIComponent(id)}/compare`, {}),
  run: (id: string, actions: Record<string, TransferAction>) =>
    request<TransferTask>(`/tasks/${encodeURIComponent(id)}/run`, { actions }),
  cancel: (id: string) => request<TransferTask>(`/tasks/${encodeURIComponent(id)}/cancel`, {}),
  repeat: (id: string) => request<TransferTask>(`/tasks/${encodeURIComponent(id)}/repeat`, {}),
  restore: (id: string, itemId: string) =>
    request<TransferTask>(
      `/tasks/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}/restore`,
      {},
    ),
};
