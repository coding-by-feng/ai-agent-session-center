/**
 * CloudSummaryLink — the Library summary row's cloud line (Oct 23 2026): "214 synced · 3 to sync"
 * opening Cloud sync, "Connect to sync" opening Connection, or nothing before the first status.
 */
import { MOVING_STATES } from '@/lib/cloudSyncStates';
import CloudStateGlyph from './CloudStateGlyph';
import { cacheKey } from './cloud/cloudCache';
import { useCloudSession } from './cloud/cloudSession';
import { useSyncStatus } from './cloud/syncStatusStore';
import styles from '@/styles/modules/CloudSync.module.css';

export default function CloudSummaryLink({
  onSync,
  onConnect,
}: {
  onSync: () => void;
  onConnect: () => void;
}) {
  const session = useCloudSession();
  const sync = useSyncStatus(cacheKey(session.status.connection));
  if (!session.loaded) return null;
  if (session.status.state !== 'connected') {
    return (
      <button type="button" className={styles.summaryLink} onClick={onConnect}>
        {session.status.state === 'offline' ? 'Cloud offline' : 'Connect to sync'}
      </button>
    );
  }
  if (!sync.value) return null;
  const synced = sync.value.items.filter((i) => i.state === 'synced').length;
  const waiting = sync.value.items.filter((i) => MOVING_STATES.includes(i.state)).length;
  return (
    <button
      type="button"
      className={styles.summaryLink}
      onClick={onSync}
      aria-label={`Cloud: ${synced} synced, ${waiting} to sync. Open Cloud sync.`}
    >
      {/* The cloud mark, not an arrow: "↑ 2 synced" read as "uploaded 2". */}
      <CloudStateGlyph state="synced" />
      <span>{synced} synced</span>
      {waiting > 0 && <span className={styles.summaryWaiting}>· {waiting} to sync</span>}
      <span aria-hidden="true">›</span>
    </button>
  );
}
