/**
 * LiveEmptyState — the LIVE page on a desktop with the 3D scene off, before
 * there is any session: what the page is for, and three ways to get one.
 *
 * The two buttons carry the top bar's own labels and run the same actions
 * (+ NEW opens the new-session form; DIRS opens the top bar's DIRS dropdown,
 * not a copy of it), so the card also teaches where those controls live.
 * Step 3 promises `claude` only: Codex hooks are not installed by default
 * (`enabledClis` defaults to ['claude']) and the process scan finds `claude`
 * only, so an external `codex` does not show up on a fresh install.
 *
 * A device that is not this machine (a phone or a LAN browser) sees only the
 * sessions someone shared with it (server/sessionVisibility.ts), and a session
 * it starts stays hidden from it as well — so it gets a "not shared" card
 * instead, without the steps that would promise a card. It is told apart by
 * presence (`isLocal` false) or, before presence has loaded, by the snapshot's
 * `hiddenCount`; with neither known it is treated as this machine.
 */
import { useId } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { getClientId } from '@/lib/deviceIdentity';
import styles from '@/styles/modules/LiveEmptyState.module.css';

function ThreeDFooter() {
  const setScene3dEnabled = useSettingsStore((s) => s.setScene3dEnabled);
  return (
    <div className={styles.footer}>
      <span>Want the 3D office?</span>
      <button type="button" className={styles.secondary} onClick={() => setScene3dEnabled(true)}>
        Turn on 3D
      </button>
    </div>
  );
}

function NotSharedCard({ titleId, hiddenCount }: { titleId: string; hiddenCount: number }) {
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>No sessions shared with this device</h2>
      <p className={styles.lead}>
        {hiddenCount > 0
          ? `${hiddenCount} ${hiddenCount === 1 ? 'session is' : 'sessions are'} running on the host but not shared with this device.`
          : 'Nothing on the host is shared with this device yet.'}
      </p>
      <p className={styles.lead}>
        Sessions stay on the host until someone shares one from there, with the 📡 button in its session panel.
      </p>
      <ThreeDFooter />
    </section>
  );
}

export default function LiveEmptyState() {
  const titleId = useId();
  const openModal = useUiStore((s) => s.openModal);
  const setWorkdirLauncherOpen = useUiStore((s) => s.setWorkdirLauncherOpen);
  const hiddenCount = useWsStore((s) => s.hiddenCount);
  // Presence unknown (no devices yet) reads as "unknown", not as remote.
  const knownRemote = usePresenceStore((s) => s.devices.length > 0 && !isLocalDevice(s.devices, getClientId()));

  if (knownRemote || hiddenCount > 0) {
    return (
      <div className={styles.wrap}>
        <NotSharedCard titleId={titleId} hiddenCount={hiddenCount} />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <section className={styles.card} aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>No agent sessions yet</h2>
        <p className={styles.lead}>Every Claude Code or Codex session you start here gets a card on this page.</p>

        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.num} aria-hidden="true">1</span>
            <button type="button" className={styles.action} onClick={() => openModal('new-session')}>
              + NEW
            </button>
            <span className={styles.desc}>Start Claude Code or Codex in a folder you choose</span>
          </li>
          <li className={styles.step}>
            <span className={styles.num} aria-hidden="true">2</span>
            <button type="button" className={styles.action} onClick={() => setWorkdirLauncherOpen(true)}>
              DIRS
            </button>
            <span className={styles.desc}>Pick a project you have worked in before</span>
          </li>
          <li className={styles.step}>
            <span className={styles.num} aria-hidden="true">3</span>
            <span className={`${styles.desc} ${styles.descWide}`}>
              Or run <code className={styles.code}>claude</code> in any terminal. It shows up here by itself.
            </span>
          </li>
        </ol>

        <ThreeDFooter />
      </section>
    </div>
  );
}
