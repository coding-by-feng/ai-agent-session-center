/**
 * useAccountDirectory — the computers on this computer's AASC Cloud account, as the devices switcher shows them
 * (plan 18 stage 2). It asks Electron's main process (`remotes.accountMachines`), which asks this computer's own
 * server; nothing here talks to AASC Cloud.
 *
 * Read when the switcher opens and every 60 s while it stays open, and again when the switcher asks (`refresh`:
 * after a Connect, a Dismiss or a Remove, and on Retry). Never two reads at once: a round that comes due while one
 * is out is skipped, and a `refresh` asked meanwhile runs once the read lands. Nothing is read, and nothing is set,
 * after the switcher closes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountMachine, RemoteComputersAPI } from '@/types/electron';

/**
 * Said when a call to the app's main process is rejected, in place of Electron's own words for it ("Error invoking
 * remote method 'remote:…': Error: …"). An answer the main process gives (`{ ok: false, error }`) is shown as given.
 */
export const APP_UNREACHABLE = 'Couldn’t reach the AASC app on this computer. Try again.';

/** How often the directory is read again while the switcher stays open. */
const READ_EVERY_MS = 60_000;

export type DirectoryView =
  /** The first read has not answered yet. */
  | { state: 'loading' }
  | { state: 'ok'; machines: AccountMachine[] }
  | { state: 'signed-out' | 'needs-sign-in' | 'unsupported' | 'unreachable' }
  /** The read itself failed; `error` is ready to show. */
  | { state: 'failed'; error: string };

export interface AccountDirectoryState {
  view: DirectoryView;
  /** A read the person asked for (Retry) is out right now. */
  retrying: boolean;
  /** Read again now, or once the read that is out lands. */
  refresh: () => void;
  /** `refresh`, for the Retry button: `retrying` is true until it lands. */
  retry: () => void;
}

async function ask(api: RemoteComputersAPI): Promise<DirectoryView> {
  try {
    const res = await api.accountMachines?.();
    if (!res) return { state: 'failed', error: 'Connecting through an AASC Cloud account isn’t available here.' };
    if (!res.ok) return { state: 'failed', error: res.error };
    return res.data.state === 'ok' ? { state: 'ok', machines: res.data.machines } : { state: res.data.state };
  } catch {
    return { state: 'failed', error: APP_UNREACHABLE };
  }
}

export function useAccountDirectory(api: RemoteComputersAPI): AccountDirectoryState {
  const [view, setView] = useState<DirectoryView>({ state: 'loading' });
  const [retrying, setRetrying] = useState(false);
  /** Asks the open switcher's reader for one more read; does nothing once it has closed. */
  const request = useRef<() => void>(() => {});

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    let again = false;
    const read = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      do {
        again = false;
        const next = await ask(api);
        if (!alive) return;
        setView(next);
      } while (again);
      inFlight = false;
      setRetrying(false);
    };
    request.current = () => {
      if (inFlight) again = true;
      else void read();
    };
    void read();
    const timer = setInterval(() => void read(), READ_EVERY_MS);
    return () => {
      alive = false;
      request.current = () => {};
      clearInterval(timer);
    };
  }, [api]);

  const refresh = useCallback(() => request.current(), []);

  const retry = useCallback(() => {
    setRetrying(true);
    request.current();
  }, []);

  return { view, retrying, refresh, retry };
}
