/**
 * CloudActionDialogs — the cloud actions the Library and the Cloud sync tab start (Oct 23 2026):
 * Save to cloud (the AASC-62 review), Sync a memory file (it needs an OK), Resolve a resource changed
 * in both places, and Remove from cloud (every version; the exact name typed first).
 *
 * The VIEW renders them, outside the detail pane, which remounts whenever a scan lands (usually the
 * one a sync's install started); a dialog inside it would vanish mid-review. A surface asks for one
 * with `openCloudDialog` (cloudActions.ts, which also carries the actions that need no dialog).
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { PublicationPlan, SyncItem } from '@/types/cloudResources';
import type { ResourceCatalog } from '@/types/resources';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount } from '@/lib/cloudFormat';
import { showToast } from '@/components/ui/ToastContainer';
import { useUiStore } from '@/stores/uiStore';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import CloudDialog, { CLOUD_DIALOG_ID } from './CloudDialog';
import CloudReview from './CloudReview';
import { useCloudAction, useCloudSession } from './cloudSession';
import { followJobs, reloadSyncStatus } from './syncStatusStore';
import { closeCloudDialog, useCloudDialog, type CloudDialogRequest } from './cloudActions';
import RefusalReason from './RefusalReason';
import styles from '@/styles/modules/CloudSync.module.css';

export default function CloudActionDialogs({ catalog }: { catalog: ResourceCatalog }) {
  const request = useCloudDialog((s) => s.request);
  const session = useCloudSession();
  // A dialog never outlives the account it was opened for, nor the view that shows it.
  const epoch = useRef(session.epoch);
  useEffect(() => {
    if (epoch.current === session.epoch) return;
    epoch.current = session.epoch;
    closeCloudDialog();
  }, [session.epoch]);
  useEffect(() => () => closeCloudDialog(), []);
  if (!request) return null;
  switch (request.kind) {
    case 'save':
      return <SaveDialog key={request.catalogIds.join('\n')} request={request} catalog={catalog} />;
    case 'sync':
      return <SyncMemoryDialog key={request.item.resourceId} item={request.item} />;
    case 'resolve':
      return <ResolveDialog key={request.item.resourceId} item={request.item} />;
    case 'remove':
      return <RemoveDialog key={request.item.resourceId} item={request.item} />;
  }
}

function SaveDialog({
  request,
  catalog,
}: {
  request: Extract<CloudDialogRequest, { kind: 'save' }>;
  catalog: ResourceCatalog;
}) {
  const session = useCloudSession();
  const action = useCloudAction();
  const [plan, setPlan] = useState<PublicationPlan | null>(null);
  // Once per mount. StrictMode (npm run dev) mounts twice and aborts the first request with the
  // first mount, so a one-shot guard here left the dialog "Checking…" for good.
  useEffect(() => {
    action.run(
      (b, s) =>
        cloudApi.buildPublicationPlan(
          request.catalogIds.map((resourceId) => ({ resourceId, include: true })),
          b,
          s,
        ),
      setPlan,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the host keys the dialog by its catalog ids
  }, []);
  const save = () => {
    if (!plan) return;
    const binding = session.status.connection;
    action.run(
      (b, s) => cloudApi.publishPlan(plan.id, b, s, { skipBlocked: plan.blocked.length > 0 }),
      (job) => {
        if (binding)
          followJobs([job], binding, [
            ...plan.items.map((i) => i.manifest.resourceId),
            ...plan.items.map((i) => i.catalogId),
          ]);
        request.onSaved?.();
        closeCloudDialog();
      },
    );
  };
  return (
    <CloudDialog
      title="Save to cloud"
      onClose={closeCloudDialog}
      returnFocus={action.origin.current}
    >
      <div className={styles.dialogBody}>
        {!plan && !action.error && <EmptyState compact busy title="Checking what will be saved…" />}
        {plan && (
          <CloudReview
            publication={plan}
            resourceName={(id) => catalog.resources.find((r) => r.id === id)?.name}
            onClose={closeCloudDialog}
            onConfirm={save}
            busy={action.busy}
            disabled={!action.enabled}
          />
        )}
        {plan && (
          <p className={styles.muted}>
            Saved resources stay in step on every Mac you sync. Nothing syncs by itself: you press
            Sync now.
          </p>
        )}
        {action.error && (
          <p role="alert" className={styles.error}>
            <RefusalReason reason={action.error} />
          </p>
        )}
        {action.error && !plan && (
          <div className={styles.dialogActions}>
            <Button onClick={closeCloudDialog}>Close</Button>
          </div>
        )}
      </div>
    </CloudDialog>
  );
}

function direction(item: SyncItem): string {
  if (item.state === 'local-changed') return "uploads this Mac's copy as the cloud's next version";
  if (item.state === 'cloud-newer' || item.state === 'cloud-only')
    return "installs the cloud's copy here and keeps a backup of the one it replaces";
  return 'moves it as you choose below';
}

function SyncMemoryDialog({ item }: { item: SyncItem }) {
  const session = useCloudSession();
  const action = useCloudAction();
  const [ok, setOk] = useState(false);
  const sync = () => {
    const binding = session.status.connection;
    action.run(
      (b, s) => cloudApi.syncNow({ only: [item.resourceId], memory: [item.resourceId] }, b, s),
      (result) => {
        if (binding) followJobs(result.jobs, binding, [item.resourceId]);
        const left = result.skipped.find((x) => x.resourceId === item.resourceId);
        if (left) action.setError(left.reason);
        else closeCloudDialog();
      },
    );
  };
  return (
    <CloudDialog
      title={`Sync “${item.name}”?`}
      onClose={closeCloudDialog}
      returnFocus={action.origin.current}
    >
      <div className={styles.dialogBody}>
        <p>This is a memory file. Syncing it {direction(item)}.</p>
        <label className={styles.check}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          OK to sync this memory file
        </label>
        {action.error && (
          <p role="alert" className={styles.error}>
            <RefusalReason reason={action.error} />
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={closeCloudDialog}>Cancel</Button>
          <Button variant="primary" disabled={!ok || action.busy || !action.enabled} onClick={sync}>
            Sync now
          </Button>
        </div>
      </div>
    </CloudDialog>
  );
}

function ResolveDialog({ item }: { item: SyncItem }) {
  const session = useCloudSession();
  const action = useCloudAction();
  const [choice, setChoice] = useState<'mine' | 'cloud' | null>(null);
  const [ok, setOk] = useState(false);
  const groupId = useId();
  const sync = () => {
    if (!choice) return;
    const binding = session.status.connection;
    action.run(
      (b, s) =>
        cloudApi.syncNow(
          {
            only: [item.resourceId],
            choices: { [item.resourceId]: choice },
            ...(item.memory ? { memory: [item.resourceId] } : {}),
          },
          b,
          s,
        ),
      (result) => {
        if (binding) followJobs(result.jobs, binding, [item.resourceId]);
        const left = result.skipped.find((x) => x.resourceId === item.resourceId);
        if (left) action.setError(left.reason);
        else closeCloudDialog();
      },
    );
  };
  return (
    <CloudDialog
      title={`“${item.name}” changed in both places`}
      onClose={closeCloudDialog}
      returnFocus={action.origin.current}
    >
      <div className={styles.dialogBody}>
        <p>This Mac and the cloud each have their own change. Which copy should both keep?</p>
        <div className={styles.choiceRow} role="group" aria-labelledby={groupId}>
          <span id={groupId} className={styles.muted}>
            Keep
          </span>
          <Button pressed={choice === 'mine'} onClick={() => setChoice('mine')}>
            Keep mine
          </Button>
          <Button pressed={choice === 'cloud'} onClick={() => setChoice('cloud')}>
            Use cloud’s
          </Button>
        </div>
        <p className={styles.muted}>
          {choice === 'cloud'
            ? "Replaces this Mac's copy with the cloud's and keeps a backup you can restore from Cloud sync → Activity."
            : choice === 'mine'
              ? "Saves this Mac's copy as the cloud's next version. The cloud keeps the other one in its history."
              : 'Nothing changes until you choose.'}
        </p>
        {item.memory && (
          <label className={styles.check}>
            <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
            OK to sync this memory file
          </label>
        )}
        {action.error && (
          <p role="alert" className={styles.error}>
            <RefusalReason reason={action.error} />
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button onClick={closeCloudDialog}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!choice || (item.memory && !ok) || action.busy || !action.enabled}
            onClick={sync}
          >
            Sync now
          </Button>
        </div>
      </div>
    </CloudDialog>
  );
}

function RemoveDialog({ item }: { item: SyncItem }) {
  const session = useCloudSession();
  const action = useCloudAction();
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const versions = item.cloudVersion
    ? item.cloudVersion === 1
      ? 'its one version'
      : `all ${item.cloudVersion} versions`
    : 'every version';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed !== item.name) return;
    const binding = session.status.connection;
    action.run(
      (b, s) => cloudApi.syncControl({ resourceId: item.resourceId, action: 'remove' }, b, s),
      (result) => {
        if (binding) void reloadSyncStatus(binding);
        closeCloudDialog();
        showToast(
          `Removed ${item.name} from the cloud${result.removedVersions ? ` (${cloudCount(result.removedVersions, 'version')})` : ''}.`,
          'success',
        );
      },
    );
  };
  // The Mac keeps deleting whatever this window does, and only this dialog reads the list again
  // and reports when it is done. So while it removes, Cancel waits and ✕ / Escape only hide the
  // dialog (the shared Modal closes itself): it stays mounted, the toast still comes, and a refusal
  // brings it back with the reason.
  const close = () => {
    if (!action.busy) closeCloudDialog();
  };
  useEffect(() => {
    if (action.error) useUiStore.getState().openModal(CLOUD_DIALOG_ID);
  }, [action.error]);
  return (
    <CloudDialog
      title={`Remove “${item.name}” from the cloud?`}
      onClose={close}
      returnFocus={action.origin.current}
    >
      <form className={styles.dialogBody} onSubmit={submit}>
        <p>Deletes {versions} from AASC Cloud.</p>
        <p>
          This Mac keeps its copy and stops syncing it. Other Macs keep theirs and show it as
          “Removed from cloud”; their Sync now never saves it back.
        </p>
        <p className={styles.muted}>
          AASC can&apos;t undo this. To have it in the cloud again, save it again.
        </p>
        <label htmlFor={inputId} className={styles.confirmLabel}>
          Type <code className={styles.confirmName}>{item.name}</code> to confirm
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className={styles.confirmInput}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
        />
        {action.error && (
          <p role="alert" className={styles.error}>
            <RefusalReason reason={action.error} />
          </p>
        )}
        <div className={styles.dialogActions}>
          <Button disabled={action.busy} onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="danger"
            disabled={typed !== item.name || action.busy || !action.enabled}
          >
            {action.busy ? 'Removing…' : 'Remove from cloud'}
          </Button>
        </div>
      </form>
    </CloudDialog>
  );
}
