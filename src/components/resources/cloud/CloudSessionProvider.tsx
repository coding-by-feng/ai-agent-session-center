/**
 * CloudSessionProvider — this Mac's AASC cloud connection for the whole RESOURCES tab (Oct 23
 * 2026; until then it lived inside the lazy Cloud section). Library rows and the detail pane show
 * each resource's cloud state, so they need the connection as much as the Cloud sync, Projects
 * and Connection tabs do; the heavy views stay lazy.
 *
 * Status is read from the local server (`/api/resources/cloud/status`) at mount and every 15 s;
 * the device token never reaches the browser. An identity change (connect, disconnect, another
 * window) advances `epoch`, which cancels every pending action so nothing completes against a
 * different account.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CloudStatus } from '@/types/cloud';
import { cloudApi } from '@/lib/cloudApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import { CloudContext, bindingKey, cloudError, type CloudSession } from './cloudSession';

const STATUS_POLL_MS = 15_000;

export default function CloudSessionProvider({ children }: { children: ReactNode }) {
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
  const value = useMemo<CloudSession>(
    () => ({
      status,
      epoch,
      current: () => current.current,
      refresh,
      changed,
      apply,
      loaded,
      error,
    }),
    [status, epoch, refresh, changed, apply, loaded, error],
  );
  return <CloudContext.Provider value={value}>{children}</CloudContext.Provider>;
}
