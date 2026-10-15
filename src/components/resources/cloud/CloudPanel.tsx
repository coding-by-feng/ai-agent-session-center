import { useCallback, useEffect, useRef, useState } from 'react';
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
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudPanel({
  catalog,
  selection,
  onSelection,
}: {
  catalog: ResourceCatalog;
  selection: ResourceSelection;
  onSelection: (s: ResourceSelection) => void;
}) {
  const [params, setParams] = useSearchParams();
  const tab = ['resources', 'projects', 'connection'].includes(params.get('cloudTab') ?? '')
    ? params.get('cloudTab')!
    : 'resources';
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
  const [visited, setVisited] = useState(() => new Set([tab]));
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
  const refresh = useCallback((recheck = false) => {
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
  }, [apply]);
  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), 15000);
    const unsub = useSkillNotesStore.subscribe((next, prev) => {
      if (bindingKey(next.connection) !== bindingKey(prev.connection)) {
        current.current++;
        setEpoch(current.current);
        setChanged(bindingKey(next.connection) !== bindingKey(observed.current.connection));
        // Re-read status, never retry the interrupted resource/project action.
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
  const choose = (value: string) =>
    setParams((old) => {
      const p = new URLSearchParams(old);
      p.set('cloudTab', value);
      return p;
    });
  return (
    <CloudContext.Provider
      value={{ status, epoch, current: () => current.current, refresh, changed }}
    >
      <div className={styles.panel}>
        <div className={styles.tabs} role="tablist" aria-label="Cloud views">
          {(['resources', 'projects', 'connection'] as const).map((t) => (
            <Button
              key={t}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`cloud-${t}`}
              id={`cloud-tab-${t}`}
              onClick={() => choose(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </Button>
          ))}
        </div>
        <div className={styles.banner} role="status">
          Cloud · {loaded ? status.state : 'checking connection'}
          {status.connection
            ? ` · ${status.connection.deviceName} · ${status.connection.accountId}`
            : ''}
          {status.state === 'revoked' && (
            <Button onClick={() => choose('connection')}>Reconnect</Button>
          )}
          {<Button onClick={() => refresh(true)}>Refresh connection</Button>}
          {changed && (
            <p>
              Connection changed. Existing reviews are no longer valid; refresh and compare again.
              Drafts are preserved.
            </p>
          )}
        </div>
        {error && (
          <p className={styles.error} role="alert">
            {error}
            <Button onClick={() => refresh(true)}>Retry connection status</Button>
          </p>
        )}
        {loaded && (
          <>
            {visited.has('resources') && (
              <div
                hidden={tab !== 'resources'}
                id="cloud-resources"
                role="tabpanel"
                aria-labelledby="cloud-tab-resources"
              >
                <CloudResources
                  visible={tab === 'resources' && params.get('section') === 'cloud'}
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
                id="cloud-projects"
                role="tabpanel"
                aria-labelledby="cloud-tab-projects"
              >
                <CloudProjects
                  catalog={catalog}
                  visible={tab === 'projects' && params.get('section') === 'cloud'}
                />
              </div>
            )}
            {visited.has('connection') && (
              <div
                hidden={tab !== 'connection'}
                id="cloud-connection"
                role="tabpanel"
                aria-labelledby="cloud-tab-connection"
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
