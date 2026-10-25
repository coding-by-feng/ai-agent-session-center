/**
 * CloudSyncPanel — Resources → Cloud sync (plan 16): each resource saved to AASC Cloud and where
 * it stands on the Mac, in the desktop's groups and words (cloudSyncStates.ts).
 *
 *   NEEDS YOU · 1
 *   tdd                                                    ›
 *   [Changed in both places]
 *   Claude skill · v3 here · v4 in cloud
 *   WAITING · 2
 *   SYNCED · 21                  Show 21                  (folded, as on the desktop)
 *
 * A row opens its Library resource, or, when it is only in the cloud, its versions. P1 reads
 * only: Sync now and the row actions run on the Mac for now.
 */
import { useEffect, useState } from 'react';
import { Banner, Button, EmptyState, ListRow, ListSection } from '../../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useClock } from '@/lib/chat/clock';
import { fetchPhoneSync } from '@/lib/chat/phoneResourcesApi';
import { cloudResourcePath, resourceItemPath } from '@/lib/chat/phoneRoutes';
import { syncMeta, syncSections, syncStateWords } from '@/lib/chat/phoneResourcesModel';
import { CLOUD_CONNECT_HINT, CLOUD_RECONNECT_HINT, agoWords } from '@/lib/chat/cloudBrowseModel';
import { cloudCount } from '@/lib/cloudFormat';
import type { SyncGroup } from '@/lib/cloudSyncStates';
import type { SyncItem } from '@/types/cloudResources';
import type { PhoneSync } from '@/types/phoneResources';
import type { RegisterRefresh } from '../ResourcesScreen';
import { useCloudRead } from '../useCloudRead';
import styles from '@/styles/modules/mobile/Resources.module.css';

const readSync = ({ refresh, signal }: { refresh: boolean; signal: AbortSignal }) => fetchPhoneSync({ refresh, signal });

/** Open at first, as on the desktop; the rest fold. */
const OPEN_GROUPS: readonly SyncGroup[] = ['needs-you', 'waiting'];

export const SYNC_READ_ONLY_NOTE = 'Sync now, Keep mine or Use cloud’s, and Remove from cloud run on your Mac: RESOURCES → Cloud sync.';

function SyncRow({ item }: { item: SyncItem }) {
  const push = usePhoneNavStore((s) => s.push);
  const state = syncStateWords(item);
  return (
    <ListRow
      tall
      title={item.name}
      subtitle={
        <>
          <span className={styles.line}><span className={styles.tag} data-tone={state.tone}>{state.label}</span></span>
          <span className={styles.line}>{syncMeta(item)}</span>
          {item.reason && <span className={styles.line}>{item.reason}</span>}
        </>
      }
      chevron
      onClick={() => push(item.catalogId ? resourceItemPath(item.catalogId) : cloudResourcePath(item.resourceId))}
      testId="sync-row"
    />
  );
}

export default function CloudSyncPanel({ register }: { register: RegisterRefresh }) {
  const now = useClock();
  const read = useCloudRead<PhoneSync>(readSync);
  const [opened, setOpened] = useState<ReadonlySet<SyncGroup>>(new Set(OPEN_GROUPS));
  const { refresh } = read;
  useEffect(() => {
    register(refresh);
    return () => register(null);
  }, [register, refresh]);

  const data = read.data;
  if (!read.loaded) return <EmptyState live title="Loading Cloud sync…" message="Your Mac is reading AASC Cloud for this phone." />;
  if (!data) {
    return (
      <EmptyState
        title="Couldn’t load Cloud sync"
        message={read.error?.message}
        action={<Button variant="primary" onClick={() => void refresh()}>Try again</Button>}
      />
    );
  }
  if (!data.connected) {
    return (
      <EmptyState
        title={data.state === 'revoked' ? 'This Mac’s cloud device was revoked' : 'This Mac isn’t connected to AASC Cloud'}
        message={data.state === 'revoked' ? CLOUD_RECONNECT_HINT : CLOUD_CONNECT_HINT}
      />
    );
  }

  // Nothing read yet (the Mac is scanning, or its first read failed): say why, not "nothing saved".
  if (data.readAt === null && data.problem && data.items.length === 0) {
    return (
      <EmptyState
        title="Cloud sync isn’t ready yet"
        message={data.problem}
        action={<Button variant="secondary" onClick={() => void refresh()}>Try again</Button>}
      />
    );
  }
  const sections = syncSections(data.items);
  const banner = read.error
    ? <Banner tone="error" title="Couldn’t refresh">{read.error.message}</Banner>
    : data.problem ? <Banner tone="warning" title="Couldn’t sync just now">{data.problem}</Banner> : null;
  return (
    <>
      {banner && <div className={styles.note}>{banner}</div>}
      {sections.length === 0 ? (
        <EmptyState title="Nothing saved to cloud yet" message="Save skills, commands and rules from your Mac’s Library: RESOURCES → Library." />
      ) : (
        sections.map((section) => {
          const open = opened.has(section.id);
          return (
            <ListSection key={section.id} header={`${section.label} · ${section.items.length}`}>
              {open ? section.items.map((item) => <SyncRow key={item.resourceId} item={item} />) : (
                <ListRow
                  title={`Show ${cloudCount(section.items.length, 'resource')}`}
                  onClick={() => setOpened((s) => new Set([...s, section.id]))}
                  testId="sync-group-show"
                />
              )}
            </ListSection>
          );
        })
      )}
      <p className={styles.note}>
        {data.readAt ? `Read ${agoWords(data.readAt, now)}. ` : ''}{SYNC_READ_ONLY_NOTE}
      </p>
    </>
  );
}
