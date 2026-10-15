import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { CloudApiError, type CloudReviewBinding } from '@/lib/cloudApi';
import type { CloudStatus } from '@/types/cloud';
export const bindingKey = (b: CloudReviewBinding | null) =>
  b ? JSON.stringify([b.backendOrigin, b.accountId, b.generation]) : '';
export interface CloudSession {
  status: CloudStatus;
  epoch: number;
  current: () => number;
  refresh: () => void;
  changed: boolean;
}
export const CloudContext = createContext<CloudSession | null>(null);
export function useCloudSession() {
  const c = useContext(CloudContext);
  if (!c) throw new Error('Cloud context missing');
  return c;
}
export function cloudError(error: unknown) {
  if (error instanceof CloudApiError) {
    const messages: Record<string, string> = {
      connection_changed:
        'Connection changed. Refresh connection and review again; your draft is preserved.',
      version_conflict:
        'Cloud version changed. Your draft is preserved. Load latest for comparison before making a new edit.',
      review_required:
        'The job or files changed. Wait for active work, then create a fresh review.',
      offline:
        'Cloud is offline. Saved notes and cached records stay on this device; reconnect to sync or make changes.',
      revoked: 'Device access was revoked. Reconnect to continue.',
      unsupported: 'This operation is not supported by this backend.',
    };
    return messages[error.code] ?? error.message;
  }
  return error instanceof Error ? error.message : 'Cloud action failed.';
}
/** Commit inside the guard, never in a later caller continuation. Epoch records leave-and-return. */
export function useCloudAction() {
  const session = useCloudSession();
  const [pending, setPending] = useState({ epoch: session.epoch, value: false }),
    [error, setError] = useState<string | null>(null);
  const controllers = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  const origin = useRef<HTMLElement | null>(null);
  const setBusy = (value: boolean) => setPending({ epoch: session.epoch, value });
  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    return () => {
      mounted.current = false;
      for (const c of activeControllers) c.abort();
    };
  }, []);
  useEffect(() => {
    for (const c of controllers.current) c.abort();
    controllers.current.clear();
  }, [session.epoch]);
  function run<T>(
    work: (binding: CloudReviewBinding, signal: AbortSignal) => Promise<T>,
    commit: (result: T) => void,
    local = false,
    stillCurrent: () => boolean = () => true,
  ) {
    const epoch = session.epoch,
      binding = session.status.connection;
    if (!local && (!binding || session.status.state !== 'connected' || session.changed)) {
      setError('Reconnect or refresh the connection before reviewing this action.');
      return;
    }
    if (session.current() !== epoch) {
      setError('Connection changed. Refresh and review again.');
      return;
    }
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setError(null);
    const active = () => mounted.current && !c.signal.aborted && session.current() === epoch;
    const current = () => active() && stillCurrent();
    void work(binding!, c.signal)
      .then((result) => {
        if (current()) commit(result);
      })
      .catch((err) => {
        if (current()) setError(cloudError(err));
      })
      .finally(() => {
        controllers.current.delete(c);
        if (active()) setBusy(controllers.current.size > 0);
      });
  }
  return {
    run,
    busy: pending.epoch === session.epoch && pending.value,
    origin,
    error,
    setError,
    enabled: session.status.state === 'connected' && !session.changed,
  };
}
