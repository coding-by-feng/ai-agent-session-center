import { useEffect, useState } from 'react';
import type { AppUpdateState } from '@/types/electron';
import styles from '@/styles/modules/UpdateReadyBanner.module.css';

/**
 * Desktop app only: "version X is ready" once the Mac updater has staged an update (electron/autoUpdate.ts).
 * The update installs on the next quit by itself; Restart Now asks first, because restarting ends every
 * agent terminal. Later hides the card for this version until the window reloads.
 */
export default function UpdateReadyBanner() {
  const [state, setState] = useState<AppUpdateState | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    const updates = window.electronAPI?.updates;
    if (!updates) return;
    let live = true;
    updates.getState().then((s) => { if (live) setState(s); }, () => {});
    const off = updates.onState((s) => setState(s));
    return () => { live = false; off(); };
  }, []);

  if (state?.status !== 'ready' || !state.version || dismissed === state.version) return null;
  const version = state.version;

  return (
    <aside className={styles.card} role="status" aria-label="Update ready">
      <p className={styles.title}>Version {version} is ready</p>
      <p className={styles.body}>It installs the next time you quit. Running agents keep going until then.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={() => { void window.electronAPI?.updates?.install(); }}>
          Restart Now
        </button>
        <button type="button" className={styles.secondary} onClick={() => setDismissed(version)}>
          Later
        </button>
      </div>
    </aside>
  );
}
