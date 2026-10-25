/**
 * cloudActions — what a Library surface or the Cloud sync tab asks of the cloud (Oct 23 2026): the
 * dialog request the view's CloudActionDialogs shows (`openCloudDialog`), and the actions that need
 * no dialog (`useCloudSyncActions`: sync one resource, stop, Sync again) under the cloud session's
 * epoch guard. A module of its own so the dialogs file exports components only.
 */
import { create } from 'zustand';
import type { SyncItem } from '@/types/cloudResources';
import { cloudApi } from '@/lib/cloudApi';
import { useCloudAction, useCloudSession } from './cloudSession';
import { followJobs, reloadSyncStatus } from './syncStatusStore';

export type CloudDialogRequest =
  /** Save these Library resources (catalog ids); `onSaved` runs once the save started. */
  | { kind: 'save'; catalogIds: readonly string[]; onSaved?: () => void }
  | { kind: 'sync'; item: SyncItem }
  | { kind: 'resolve'; item: SyncItem }
  | { kind: 'remove'; item: SyncItem };

export const useCloudDialog = create<{ request: CloudDialogRequest | null }>(() => ({
  request: null,
}));
export const openCloudDialog = (request: CloudDialogRequest) =>
  useCloudDialog.setState({ request });
export const closeCloudDialog = () => useCloudDialog.setState({ request: null });

/** One resource's sync, stop and Sync again, run under the cloud session's epoch guard. */
export function useCloudSyncActions() {
  const session = useCloudSession();
  const action = useCloudAction();
  const binding = session.status.connection;
  return {
    enabled: action.enabled,
    busy: action.busy,
    error: action.error,
    clearError: () => action.setError(null),
    /** Sync now for one resource (not memory: that asks first, in the sync dialog). */
    syncOne(item: SyncItem) {
      action.run(
        (b, s) => cloudApi.syncNow({ only: [item.resourceId] }, b, s),
        (result) => {
          const left = result.skipped.find((x) => x.resourceId === item.resourceId);
          if (left) action.setError(left.reason);
          if (binding) followJobs(result.jobs, binding, [item.resourceId]);
        },
      );
    },
    control(item: SyncItem, act: 'stop' | 'resume') {
      action.run(
        (b, s) => cloudApi.syncControl({ resourceId: item.resourceId, action: act }, b, s),
        () => {
          if (binding) void reloadSyncStatus(binding);
        },
      );
    },
  };
}
