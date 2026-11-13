/**
 * CloudPanel — RESOURCES › Projects: this Mac's project folders and the GitHub projects saved to
 * AASC Cloud (AASC-63). Until Nov 13 2026 it also held Cloud sync (removed) and Connection (now the
 * cloud account dialog, CloudAccountButton). Lazy-loaded by ResourcesView, which provides the cloud
 * session (CloudSessionProvider).
 *
 * It stays mounted (hidden) once opened, so a running job or a draft survives a switch to another
 * tab and back.
 */
import type { ResourceCatalog } from '@/types/resources';
import CloudProjects from './CloudProjects';
import CloudStatusBar from './CloudStatusBar';
import { useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';

export default function CloudPanel({
  catalog,
  open,
}: {
  catalog: ResourceCatalog;
  /** Projects is the open RESOURCES tab. */
  open: boolean;
}) {
  const { status, loaded, error, changed } = useCloudSession();
  // Projects is this Mac's folder list first (Oct 29 2026): the bar shows only when the
  // connection needs you (offline, revoked, changed or unreadable).
  const quiet = loaded && status.state === 'connected' && !changed && !error;
  return (
    <div className={styles.panel}>
      <CloudStatusBar quiet={quiet} />
      {loaded && <CloudProjects visible={open} catalog={catalog} />}
    </div>
  );
}
