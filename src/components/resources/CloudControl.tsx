/**
 * CloudControl — a Library resource's cloud state and its next step, in the detail pane's title
 * row (Oct 23 2026). One button follows the state; a small menu holds the rest:
 *
 *   not connected    ☁ Connect to sync          (opens Connection)
 *   not synced       Save to cloud               (the AASC-62 review, in place)
 *   synced           ☁ Synced · v3 ▾            Stop syncing on this Mac · Remove from cloud…
 *   changed here     Upload changes ▾            one-resource Sync now
 *   newer in cloud   Get v4 from cloud ▾         installs with a backup
 *   both changed     Resolve… ▾                  Keep mine / Use cloud's
 *   can't sync       the reason ▾
 *   stopped          Sync again ▾
 *   removed          Removed from cloud ▾        Forget it on this Mac (then Save to cloud again)
 *
 * Memory asks for an OK before it moves (the sync dialog). Types the cloud cannot carry (hooks,
 * MCP servers, plugins, settings) and resources the user does not own show nothing.
 */
import type { ResourceSummary } from '@/types/resources';
import type { SyncItem } from '@/types/cloudResources';
import { SYNC_STATE_INFO, canSaveToCloud } from '@/lib/cloudSyncStates';
import Button from '@/components/ui/Button';
import Menu, { type MenuItem } from '@/components/ui/Menu';
import { MoreActionsIcon } from '@/components/ui/icons';
import CloudStateGlyph from './CloudStateGlyph';
import { cacheKey } from './cloud/cloudCache';
import { useCloudSession } from './cloud/cloudSession';
import { openCloudDialog, useCloudSyncActions } from './cloud/cloudActions';
import { useSyncStatus } from './cloud/syncStatusStore';
import RefusalReason from './cloud/RefusalReason';
import styles from '@/styles/modules/CloudSync.module.css';

interface CloudControlProps {
  summary: ResourceSummary;
  /** Opens the Connection tab. */
  onConnect: () => void;
}

export default function CloudControl({ summary, onConnect }: CloudControlProps) {
  const session = useCloudSession();
  const sync = useSyncStatus(cacheKey(session.status.connection));
  const actions = useCloudSyncActions();
  const item = sync.byCatalog.get(summary.id);
  if (!session.loaded) return null;
  if (!item && !canSaveToCloud(summary)) return null;

  if (session.status.state !== 'connected') {
    if (session.status.state === 'offline')
      return <span className={styles.controlNote}>Cloud offline</span>;
    return (
      <button type="button" className={styles.summaryLink} onClick={onConnect}>
        Connect to sync
      </button>
    );
  }

  const moving = sync.moving.has(item?.resourceId ?? '') || sync.moving.has(summary.id);
  if (moving) {
    return (
      <span className={styles.control}>
        <Button
          size="sm"
          disabled
          aria-busy="true"
          icon={<CloudStateGlyph state={item?.state ?? 'synced'} moving />}
        >
          Syncing…
        </Button>
      </span>
    );
  }

  if (!item) {
    if (!sync.value && sync.loading) {
      return (
        <Button size="sm" disabled>
          Checking cloud…
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        disabled={!actions.enabled}
        onClick={() => openCloudDialog({ kind: 'save', catalogIds: [summary.id] })}
      >
        Save to cloud
      </Button>
    );
  }

  const disabled = !actions.enabled || actions.busy || sync.stale;
  const more: MenuItem[] = [];
  if (item.state === 'stopped') {
    more.push({
      kind: 'action',
      id: 'remove',
      label: 'Remove from cloud…',
      onSelect: () => openCloudDialog({ kind: 'remove', item }),
    });
  } else if (item.state === 'removed') {
    more.push({
      kind: 'action',
      id: 'forget',
      label: 'Forget it on this Mac',
      hint: 'Keeps the files; it no longer shows as synced.',
      onSelect: () => actions.control(item, 'stop'),
    });
  } else {
    more.push(
      {
        kind: 'action',
        id: 'stop',
        label: 'Stop syncing on this Mac',
        hint: 'Keeps the files and the cloud copy; nothing moves here until Sync again.',
        onSelect: () => actions.control(item, 'stop'),
      },
      {
        kind: 'action',
        id: 'remove',
        label: 'Remove from cloud…',
        onSelect: () => openCloudDialog({ kind: 'remove', item }),
      },
    );
  }
  const step = (memory: boolean) =>
    memory ? openCloudDialog({ kind: 'sync', item }) : actions.syncOne(item);

  return (
    <span className={styles.control}>
      <Primary
        item={item}
        disabled={disabled}
        onSync={() => step(item.memory)}
        onResume={() => actions.control(item, 'resume')}
      />
      <Menu
        label={`Cloud actions for ${summary.name}`}
        triggerLabel={`More cloud actions for ${summary.name}`}
        triggerIcon={<MoreActionsIcon />}
        align="end"
        sections={[{ id: 'cloud', items: more.map((m) => ({ ...m, disabled })) }]}
      />
      {actions.error && (
        <p role="alert" className={styles.controlError}>
          {actions.error}
        </p>
      )}
    </span>
  );
}

function Primary({
  item,
  disabled,
  onSync,
  onResume,
}: {
  item: SyncItem;
  disabled: boolean;
  onSync: () => void;
  onResume: () => void;
}) {
  const glyph = <CloudStateGlyph state={item.state} />;
  switch (item.state) {
    case 'local-changed':
      return (
        <Button size="sm" icon={glyph} disabled={disabled} onClick={onSync}>
          Upload changes
        </Button>
      );
    case 'cloud-newer':
    case 'cloud-only':
      return (
        <Button size="sm" icon={glyph} disabled={disabled} onClick={onSync}>
          {item.cloudVersion ? `Get v${item.cloudVersion} from cloud` : 'Get from cloud'}
        </Button>
      );
    case 'conflict':
      return (
        <Button
          size="sm"
          icon={glyph}
          disabled={disabled}
          onClick={() => openCloudDialog({ kind: 'resolve', item })}
        >
          Resolve…
        </Button>
      );
    case 'stopped':
      return (
        <Button size="sm" icon={glyph} disabled={disabled} onClick={onResume}>
          Sync again
        </Button>
      );
    case 'removed':
      return (
        <span
          className={styles.controlNote}
          title="Someone removed it from the cloud. This Mac keeps its copy."
        >
          {glyph} Removed from cloud
        </span>
      );
    case 'blocked':
      return (
        <span className={styles.controlNote}>
          {glyph} Can&apos;t sync: <RefusalReason reason={item.reason ?? 'this resource can’t sync.'} />
        </span>
      );
    case 'synced':
    default:
      return (
        <span className={styles.controlNote}>
          {glyph} {SYNC_STATE_INFO.synced.label}
          {item.cloudVersion ? ` · v${item.cloudVersion}` : ''}
        </span>
      );
  }
}
