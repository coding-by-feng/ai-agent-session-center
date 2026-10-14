/**
 * CloudPanel — RESOURCES → Cloud: this Mac's optional AASC cloud connection,
 * skill-notes sync and cloud aliases. Lazy-loaded by ResourcesView.
 *
 * Status is read from the local server (`/api/resources/cloud/status`); the
 * device token never reaches the browser. An identity change (connect,
 * disconnect, another window) advances `epoch`, which cancels every pending
 * action so nothing completes against a different account.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CloudStatus } from '@/types/cloud';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import Button from '@/components/ui/Button';
import CloudConnection from './CloudConnection';
import { CloudContext, bindingKey, cloudError } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';

const STATUS_POLL_MS = 15_000;

export default function CloudPanel() {
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
        // Re-read status; never retry the interrupted action.
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
  return (
    <CloudContext.Provider
      value={{ status, epoch, current: () => current.current, refresh, changed }}
    >
      <div className={styles.panel}>
        <div className={`${styles.banner} ${styles.statusBar}`} role="status">
          <span>
            Cloud · {loaded ? status.state : 'checking connection'}
            {status.connection
              ? ` · ${status.connection.deviceName} · ${status.connection.accountId}`
              : ''}
          </span>
          <Button onClick={() => refresh(true)}>Refresh connection</Button>
          {changed && (
            <p>
              Connection changed. Existing reviews are no longer valid; refresh and review again.
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
        {loaded && <CloudConnection onStatus={apply} />}
      </div>
    </CloudContext.Provider>
  );
}
