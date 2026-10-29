/**
 * CloudPanel — the RESOURCES tabs that live in the cloud (Oct 23 2026: they were one "Cloud" tab
 * with its own row of tabs): **Cloud sync** (the AASC-62 list), **Projects** (this Mac's project
 * folders and the saved GitHub projects, AASC-63) and **Connection** (pairing, skill-notes sync
 * and cloud aliases, then Remote access: this Mac's Tailscale, which needs no cloud connection).
 * Lazy-loaded by ResourcesView, which also provides the cloud session (CloudSessionProvider): the
 * Library shows cloud state too.
 *
 * A view stays mounted (hidden) once opened, so a running job, a draft or an open review survives
 * a switch to another tab and back.
 */
import { useId, useState } from 'react';
import type { ResourceCatalog } from '@/types/resources';
import Button from '@/components/ui/Button';
import SectionHeader from '@/components/ui/SectionHeader';
import CloudResources from './CloudResources';
import CloudProjects from './CloudProjects';
import CloudConnection from './CloudConnection';
import CloudRemoteAccess from './CloudRemoteAccess';
import { useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export type CloudSection = 'sync' | 'projects' | 'connection';

export default function CloudPanel({
  catalog,
  section,
  open,
  onSection,
  onLibrary,
  onShowResource,
}: {
  catalog: ResourceCatalog;
  /** The cloud tab in front (the last one shown while another RESOURCES tab is open). */
  section: CloudSection;
  /** A cloud tab is the open RESOURCES tab. */
  open: boolean;
  onSection: (section: CloudSection) => void;
  onLibrary: () => void;
  /** Open a Library resource (a Cloud sync row that is on this Mac). */
  onShowResource: (catalogId: string) => void;
}) {
  const session = useCloudSession();
  const connectionId = useId();
  const { status, loaded, error, changed } = session;
  const [visited, setVisited] = useState<ReadonlySet<CloudSection>>(() => new Set([section]));
  if (!visited.has(section)) setVisited(new Set([...visited, section]));
  // Projects is this Mac's folder list first (Oct 29 2026): the bar shows there only when the
  // connection needs you (offline, revoked, changed or unreadable).
  const quiet =
    section === 'projects' && loaded && status.state === 'connected' && !changed && !error;
  return (
    <div className={styles.panel}>
      {!quiet && (
        <div className={`${styles.banner} ${styles.statusBar}`} role="status">
          <span>
            Cloud · {loaded ? status.state : 'checking connection'}
            {status.connection
              ? ` · ${status.connection.deviceName} · ${status.connection.accountEmail ?? status.connection.accountId}`
              : ''}
          </span>
          {status.state === 'revoked' && section !== 'connection' && (
            <Button onClick={() => onSection('connection')}>Reconnect</Button>
          )}
          <Button onClick={() => session.refresh(true)}>Refresh connection</Button>
          {changed && (
            <p>
              Connection changed. Existing reviews are no longer valid; refresh and review again.
              Drafts are preserved.
            </p>
          )}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={() => session.refresh(true)}>
            Retry connection status
          </Button>
        </div>
      )}
      {loaded && (
        <>
          {visited.has('sync') && (
            <div hidden={section !== 'sync'}>
              <CloudResources
                visible={open && section === 'sync'}
                catalog={catalog}
                onLibrary={onLibrary}
                onShowResource={onShowResource}
              />
            </div>
          )}
          {visited.has('projects') && (
            <div hidden={section !== 'projects'}>
              <CloudProjects visible={open && section === 'projects'} />
            </div>
          )}
          {visited.has('connection') && (
            <div hidden={section !== 'connection'} className={lib.connection}>
              <div id={connectionId}>
                <CloudConnection onStatus={session.apply} />
              </div>
              <section aria-label="Phones away from home">
                <SectionHeader label="Phones away from home" level={2} />
                <CloudRemoteAccess
                  visible={open && section === 'connection'}
                  // Its "Open Connection" now means the card above it, in the same tab.
                  onConnection={() => document.getElementById(connectionId)?.scrollIntoView({ block: 'start' })}
                />
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
