/**
 * CloudPanel — RESOURCES → Cloud: this Mac's optional AASC cloud connection
 * and the three cloud views that replaced SSH Transfers and Project Sync —
 * Resources (reviewed publication, download and installation), Projects
 * (GitHub project records) and Connection (pairing, skill-notes sync and cloud
 * aliases). Lazy-loaded by ResourcesView; the open view is `?cloudTab=`.
 *
 * Status is read from the local server (`/api/resources/cloud/status`); the
 * device token never reaches the browser. An identity change (connect,
 * disconnect, another window) advances `epoch`, which cancels every pending
 * action so nothing completes against a different account.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ResourceCatalog } from '@/types/resources';
import type { ResourceSelection } from '@/types/resourceSelection';
import type { CloudStatus } from '@/types/cloud';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import Button from '@/components/ui/Button';
import CloudResources from './CloudResources';
import CloudProjects from './CloudProjects';
import CloudConnection from './CloudConnection';
import { CloudContext, bindingKey, cloudError } from './cloudSession';
import resourceStyles from '@/styles/modules/Resources.module.css';
import styles from '@/styles/modules/CloudResources.module.css';

const STATUS_POLL_MS = 15_000;
const CLOUD_TABS = ['resources', 'projects', 'connection'] as const;
type CloudTab = (typeof CLOUD_TABS)[number];
const TAB_LABELS: Record<CloudTab, string> = {
  resources: 'Resources',
  projects: 'Projects',
  connection: 'Connection',
};
const isCloudTab = (value: string | null): value is CloudTab =>
  (CLOUD_TABS as readonly string[]).includes(value ?? '');

export default function CloudPanel({
  catalog,
  selection,
  onSelection,
}: {
  catalog: ResourceCatalog;
  selection: ResourceSelection;
  onSelection: (s: ResourceSelection) => void;
}) {
  const baseId = useId();
  const [params, setParams] = useSearchParams();
  const requested = params.get('cloudTab');
  const tab: CloudTab = isCloudTab(requested) ? requested : 'resources';
  const sectionOpen = params.get('section') === 'cloud';
  const [status, setStatus] = useState<CloudStatus>({
      connection: null,
      state: 'disconnected',
      lastError: null,
    }),
    [epoch, setEpoch] = useState(0),
    [changed, setChanged] = useState(false),
    [error, setError] = useState<string | null>(null),
    [loaded, setLoaded] = useState(false);
  const current = useRef(0),
    observed = useRef<CloudStatus>(status),
    request = useRef<AbortController | null>(null);
  // A view stays mounted (hidden) once opened, so a running job and its draft survive a tab switch.
  const [visited, setVisited] = useState<ReadonlySet<CloudTab>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const apply = useCallback((next: CloudStatus) => {
    request.current?.abort();
    if (bindingKey(next.connection) !== bindingKey(observed.current.connection)) {
      current.current++;
      setEpoch(current.current);
    }
    observed.current = next;
    setStatus(next);
    setChanged(false);
    setLoaded(true);
    setError(null);
  }, []);
  const refresh = useCallback(
    (recheck = false) => {
      request.current?.abort();
      const c = new AbortController();
      request.current = c;
      const binding = observed.current.connection;
      void (recheck && binding ? cloudApi.recheck(binding, c.signal) : cloudApi.status(c.signal))
        .then((next) => {
          if (!c.signal.aborted) apply(next);
        })
        .catch((e) => {
          if (!c.signal.aborted) {
            setError(cloudError(e));
            setLoaded(true);
            setStatus((old) => ({ ...old, state: old.connection ? 'offline' : 'disconnected' }));
          }
        });
    },
    [apply],
  );
  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), STATUS_POLL_MS);
    const unsub = useSkillNotesStore.subscribe((next, prev) => {
      if (bindingKey(next.connection) !== bindingKey(prev.connection)) {
        current.current++;
        setEpoch(current.current);
        setChanged(bindingKey(next.connection) !== bindingKey(observed.current.connection));
        // Re-read status; never retry the interrupted resource, project or notes action.
        refresh();
      }
    });
    return () => {
      request.current?.abort();
      // The numeric epoch intentionally advances when this mount ends.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      current.current++;
      clearInterval(timer);
      unsub();
    };
  }, [refresh]);
  const choose = (value: CloudTab) =>
    setParams((old) => {
      const p = new URLSearchParams(old);
      p.set('cloudTab', value);
      return p;
    });
  const tabId = (t: CloudTab) => `${baseId}-tab-${t}`;
  const panelId = (t: CloudTab) => `${baseId}-panel-${t}`;
  return (
    <CloudContext.Provider
      value={{ status, epoch, current: () => current.current, refresh, changed }}
    >
      <div className={styles.panel}>
        <div className={resourceStyles.detailTabs} role="tablist" aria-label="Cloud views">
          {CLOUD_TABS.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={tabId(t)}
              aria-selected={tab === t}
              aria-controls={panelId(t)}
              className={
                tab === t ? `${resourceStyles.tab} ${resourceStyles.tabActive}` : resourceStyles.tab
              }
              onClick={() => choose(t)}
            >
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div className={`${styles.banner} ${styles.statusBar}`} role="status">
          <span>
            Cloud · {loaded ? status.state : 'checking connection'}
            {status.connection
              ? ` · ${status.connection.deviceName} · ${status.connection.accountId}`
              : ''}
          </span>
          {status.state === 'revoked' && tab !== 'connection' && (
            <Button onClick={() => choose('connection')}>Reconnect</Button>
          )}
          <Button onClick={() => refresh(true)}>Refresh connection</Button>
          {changed && (
            <p>
              Connection changed. Existing reviews are no longer valid; refresh and review again.
              Drafts are preserved.
            </p>
          )}
        </div>
        {error && (
          <div className={styles.error} role="alert">
            <span>{error}</span>
            <Button size="sm" onClick={() => refresh(true)}>
              Retry connection status
            </Button>
          </div>
        )}
        {loaded && (
          <>
            {visited.has('resources') && (
              <div
                hidden={tab !== 'resources'}
                id={panelId('resources')}
                role="tabpanel"
                aria-labelledby={tabId('resources')}
              >
                <CloudResources
                  visible={tab === 'resources' && sectionOpen}
                  catalog={catalog}
                  selection={selection}
                  onSelection={onSelection}
                  onProjects={() => choose('projects')}
                />
              </div>
            )}
            {visited.has('projects') && (
              <div
                hidden={tab !== 'projects'}
                id={panelId('projects')}
                role="tabpanel"
                aria-labelledby={tabId('projects')}
              >
                <CloudProjects catalog={catalog} visible={tab === 'projects' && sectionOpen} />
              </div>
            )}
            {visited.has('connection') && (
              <div
                hidden={tab !== 'connection'}
                id={panelId('connection')}
                role="tabpanel"
                aria-labelledby={tabId('connection')}
              >
                <CloudConnection onStatus={apply} />
              </div>
            )}
          </>
        )}
      </div>
    </CloudContext.Provider>
  );
}
