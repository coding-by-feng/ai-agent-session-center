/**
 * BulkBar — what a Library multi-selection can do, pinned under the rows (Oct 23 2026). Replaces
 * the old path (Select resources → Save selected to cloud → the Cloud tab → Save to cloud): the
 * review opens here, over the Library.
 *
 *   3 selected      [Save to cloud]  [Stop syncing]  [Clear]
 *
 * Save to cloud takes the selected resources the cloud can carry. Stop syncing applies to the
 * selected ones that sync (one request each). Without a cloud connection the bar says so.
 */
import { useState } from 'react';
import type { ResourceSummary } from '@/types/resources';
import type { SyncItem } from '@/types/cloudResources';
import { canSaveToCloud } from '@/lib/cloudSyncStates';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount } from '@/lib/cloudFormat';
import Button from '@/components/ui/Button';
import { cacheKey } from './cloud/cloudCache';
import { useCloudAction, useCloudSession } from './cloud/cloudSession';
import { openCloudDialog } from './cloud/cloudActions';
import { reloadSyncStatus, useSyncStatus } from './cloud/syncStatusStore';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export default function BulkBar({
  selected,
  onClear,
  onConnect,
}: {
  /** The checked Library resources (in any type, under any filter). */
  selected: readonly ResourceSummary[];
  onClear: () => void;
  onConnect: () => void;
}) {
  const session = useCloudSession();
  const sync = useSyncStatus(cacheKey(session.status.connection));
  const action = useCloudAction();
  const [note, setNote] = useState<string | null>(null);
  const connected = session.status.state === 'connected' && !session.changed;
  const savable = selected.filter(canSaveToCloud);
  const syncing = selected
    .map((r) => sync.byCatalog.get(r.id))
    .filter((i): i is SyncItem => !!i && i.state !== 'stopped' && i.state !== 'removed');

  const stopAll = () => {
    const binding = session.status.connection;
    const ids = syncing.map((i) => i.resourceId);
    action.run(
      async (b, s) => {
        let stopped = 0;
        try {
          for (const resourceId of ids) {
            await cloudApi.syncControl({ resourceId, action: 'stop' }, b, s);
            stopped++;
          }
        } finally {
          // Also when one fails part-way: the ones already stopped must show as stopped.
          if (stopped && binding) void reloadSyncStatus(binding);
        }
        return stopped;
      },
      (n) =>
        setNote(
          `Stopped syncing ${cloudCount(n, 'resource')} on this Mac. Files and cloud copies stay.`,
        ),
    );
  };

  return (
    <div className={lib.bulkBar} role="region" aria-label="Selected resources">
      {/* Two deliberate lines: the list column is narrow, and a free wrap left Clear alone on a
          line of its own. */}
      <div className={lib.bulkTop}>
        <span className={lib.bulkCount} aria-live="polite">
          {selected.length} selected
        </span>
        <Button size="sm" variant="quiet" onClick={onClear}>
          Clear
        </Button>
      </div>
      <div className={lib.bulkActions}>
        {connected ? (
          <>
            <Button
              size="sm"
              variant="primary"
              disabled={!savable.length || action.busy}
              title={
                savable.length < selected.length
                  ? `${selected.length - savable.length} of them can't be saved to the cloud (plugin, system or linked resources, or a type the cloud can't carry).`
                  : undefined
              }
              onClick={() => {
                setNote(null);
                openCloudDialog({
                  kind: 'save',
                  catalogIds: savable.map((r) => r.id),
                  onSaved: onClear,
                });
              }}
            >
              {savable.length && savable.length < selected.length
                ? `Save ${savable.length} to cloud`
                : 'Save to cloud'}
            </Button>
            <Button size="sm" disabled={!syncing.length || action.busy} onClick={stopAll}>
              {syncing.length ? `Stop syncing ${syncing.length}` : 'Stop syncing'}
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={onConnect}>
            Connect to save to cloud
          </Button>
        )}
      </div>
      {(note || action.error) && (
        <p className={lib.bulkNote} role={action.error ? 'alert' : 'status'}>
          {action.error ?? note}
        </p>
      )}
    </div>
  );
}
