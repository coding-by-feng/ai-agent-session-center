/**
 * useCloudRead — one read of the phone's AASC Cloud view (AASC-51): loads on
 * mount, refreshes on demand (pull to refresh, the Refresh button), and keeps
 * the last answer on screen when a refresh fails, so a failure never blanks
 * what the phone already shows. `read` must be stable (useCallback).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudFetchError } from '@/lib/chat/cloudBrowseApi';

export interface CloudRead<T> {
  data: T | null;
  /** The last read's failure, cleared by the next good one. */
  error: CloudFetchError | null;
  /** A first answer (or failure) has arrived. */
  loaded: boolean;
  refresh: () => Promise<void>;
}

type Reader<T> = (options: { refresh: boolean; signal: AbortSignal }) => Promise<T>;

const asFetchError = (err: unknown): CloudFetchError =>
  err instanceof CloudFetchError ? err : new CloudFetchError('unreachable');

export function useCloudRead<T>(read: Reader<T>): CloudRead<T> {
  const [state, setState] = useState<Omit<CloudRead<T>, 'refresh'>>({ data: null, error: null, loaded: false });
  /** Aborted when the screen goes away, so a late answer never lands. */
  const alive = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = controller;
    read({ refresh: false, signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setState({ data, error: null, loaded: true }); })
      .catch((err: unknown) => { if (!controller.signal.aborted) setState((s) => ({ ...s, error: asFetchError(err), loaded: true })); });
    return () => controller.abort();
  }, [read]);

  const refresh = useCallback(async () => {
    const signal = alive.current?.signal;
    if (!signal || signal.aborted) return;
    try {
      const data = await read({ refresh: true, signal });
      if (!signal.aborted) setState({ data, error: null, loaded: true });
    } catch (err) {
      if (!signal.aborted) setState((s) => ({ ...s, error: asFetchError(err), loaded: true }));
    }
  }, [read]);

  return { ...state, refresh };
}
