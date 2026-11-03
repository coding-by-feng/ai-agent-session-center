/**
 * ClientHome — a Client edition's own page: the pairing link on first launch, the paired computers after that.
 * Pairing, checking and opening are all RemoteComputers and the main process, as in the desktop's devices panel.
 *
 * `?start=1` is set only on the first home of a launch (electron/clientMain.ts). Without that rule, closing a
 * dashboard would bring this page back, and it would reopen the same dashboard at once. It is dropped once read, because
 * a reload of this window, by hand or after a renderer crash, is not a new launch.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import RemoteComputers, { type RemoteComputersClient } from '@/components/layout/RemoteComputers';
import ToastContainer from '@/components/ui/ToastContainer';
import type { RemoteComputer, RemoteComputersAPI } from '@/types/electron';
import styles from '@/styles/modules/ClientHome.module.css';
import { pickStartComputer } from './startComputer';

export const LAST_COMPUTER_KEY = 'aasc-client-last-computer';

type Phase =
  | { kind: 'loading' }
  | { kind: 'opening'; name: string }
  | { kind: 'ready'; nothingPaired: boolean };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readLastComputer(): string | null {
  try {
    return localStorage.getItem(LAST_COMPUTER_KEY);
  } catch {
    return null;
  }
}

function rememberComputer(id: string): void {
  try {
    localStorage.setItem(LAST_COMPUTER_KEY, id);
  } catch {
    // Storage refused: the next launch asks which one, which is only one click.
  }
}

/**
 * Offline, revoked and pending each have their own words in the computer's row, which stay true as the row re-checks.
 * A message above the list would repeat them, then stay up after the computer came back.
 */
async function rowExplains(api: RemoteComputersAPI, id: string): Promise<boolean> {
  const check = await api.check(id);
  return !check.ok || check.data.state !== 'online';
}

export default function ClientHome() {
  const api = window.electronAPI?.remotes;
  if (!api) return null;
  return <Home api={api} />;
}

function Home({ api }: { api: RemoteComputersAPI }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [openError, setOpenError] = useState<string | null>(null);

  const openComputer = useCallback(async (id: string): Promise<boolean> => {
    setOpenError(null);
    try {
      const res = await api.open(id);
      if (!res.ok) {
        // Not awaited: the list can show now, and each silent address costs seconds a second time.
        void rowExplains(api, id).then(
          (explained) => setOpenError(explained ? null : res.error),
          () => setOpenError(res.error),
        );
        return false;
      }
      rememberComputer(id);
      return true;
    } catch (err) {
      setOpenError(errorText(err));
      return false;
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    const begin = async () => {
      let computers: RemoteComputer[] = [];
      try {
        computers = await api.list();
      } catch (err) {
        if (alive) setOpenError(errorText(err));
      }
      if (!alive) return;
      const wantsStart = new URLSearchParams(window.location.search).has('start');
      if (wantsStart) window.history.replaceState(null, '', window.location.pathname);
      const target = wantsStart ? pickStartComputer(computers, readLastComputer()) : null;
      if (target) {
        setPhase({ kind: 'opening', name: target.name });
        await openComputer(target.id);
        if (!alive) return;
      }
      setPhase({ kind: 'ready', nothingPaired: computers.length === 0 });
    };
    void begin();
    return () => {
      alive = false;
    };
  }, [api, openComputer]);

  const nothingPaired = phase.kind === 'ready' && phase.nothingPaired;
  const client = useMemo<RemoteComputersClient>(() => ({
    startAdding: nothingPaired,
    onShown: window.electronAPI?.onHomeShown,
    onAllowed: (id) => {
      setPhase({ kind: 'ready', nothingPaired: false });
      void openComputer(id);
    },
    onOpened: (id) => {
      setOpenError(null);
      rememberComputer(id);
    },
  }), [nothingPaired, openComputer]);

  return (
    <main className={styles.home}>
      <div className={styles.panel}>
        {phase.kind === 'loading' && <p className={styles.status} role="status">Loading…</p>}
        {phase.kind === 'opening' && <p className={styles.status} role="status">Opening {phase.name}…</p>}
        {phase.kind === 'ready' && (
          <>
            <h1 className={styles.heading}>{phase.nothingPaired ? 'Connect to your AASC' : 'Your computers'}</h1>
            {openError && <p className={styles.error} role="alert">{openError}</p>}
            <RemoteComputers client={client} />
          </>
        )}
      </div>
      <ToastContainer />
    </main>
  );
}
