/**
 * LiveEmptyState — the LIVE page on a desktop before there is any session:
 * what the page is for, and three ways to get one. It fills the flat page with
 * the 3D scene off, and sits over the empty scene (`overScene`) with it on.
 *
 * With no session there is no session panel, so none of its strip's launch
 * icons, and the top bar's + NEW / DIRS are gone (Oct 2026): this card is the
 * only place to start one. + NEW opens the new-session form; DIRS is a
 * recent-directories launcher of its own, the same component as the strip's
 * folder icon.
 * Step 3 promises `claude` only: Codex hooks are not installed by default
 * (`enabledClis` defaults to ['claude']) and the process scan finds `claude`
 * only, so an external `codex` does not show up on a fresh install.
 *
 * A device that is not this machine (a phone or a LAN browser) sees only the
 * sessions someone shared with it (server/sessionVisibility.ts), so it gets a
 * "not shared" card instead. A session it starts itself IS shared with it (the
 * server marks a remote launch `remoteVisible`), so that card keeps + NEW and
 * DIRS (Oct 29 2026); only "run claude in any terminal" is left out. How the
 * host's other sessions get shared depends on the host: a desktop shares one from
 * its session panel, a headless server (no screen) with `aasc-server
 * share-default on`. A remote device is told apart by presence (`isLocal` false)
 * or, before presence has loaded, by the snapshot's `hiddenCount`; with neither
 * known it is treated as this machine.
 */
import { useId } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePresenceStore, isLocalDevice } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { useServerHeadless } from '@/stores/serverEditionStore';
import { getClientId } from '@/lib/deviceIdentity';
import WorkdirLauncher from '@/components/layout/WorkdirLauncher';
import styles from '@/styles/modules/LiveEmptyState.module.css';

const actionClass = () => styles.action;

/** "Turn on 3D" — not offered over the scene, where 3D is already on. */
function ThreeDFooter() {
  const scene3dEnabled = useSettingsStore((s) => s.scene3dEnabled);
  const setScene3dEnabled = useSettingsStore((s) => s.setScene3dEnabled);
  if (scene3dEnabled) return null;
  return (
    <div className={styles.footer}>
      <span>Want the 3D office?</span>
      <button type="button" className={styles.secondary} onClick={() => setScene3dEnabled(true)}>
        Turn on 3D
      </button>
    </div>
  );
}

/** + NEW and DIRS: the two ways to start a session from the dashboard, on every card that offers any. */
function LaunchSteps() {
  const openModal = useUiStore((s) => s.openModal);
  return (
    <>
      <li className={styles.step}>
        <span className={styles.num} aria-hidden="true">1</span>
        <button type="button" className={styles.action} onClick={() => openModal('new-session')}>
          + NEW
        </button>
        <span className={styles.desc}>Start Claude Code or Codex in a folder you choose</span>
      </li>
      <li className={styles.step}>
        <span className={styles.num} aria-hidden="true">2</span>
        <WorkdirLauncher label="DIRS" triggerClassName={actionClass} />
        <span className={styles.desc}>Pick a project you have worked in before</span>
      </li>
    </>
  );
}

function NotSharedCard({ titleId, hiddenCount }: { titleId: string; hiddenCount: number }) {
  const headless = useServerHeadless();
  return (
    <section className={styles.card} aria-labelledby={titleId}>
      <h2 id={titleId} className={styles.title}>No sessions shared with this device</h2>
      <p className={styles.lead}>
        {hiddenCount > 0
          ? `${hiddenCount} ${hiddenCount === 1 ? 'session is' : 'sessions are'} running on the host but not shared with this device.`
          : 'Nothing on the host is shared with this device yet.'}
      </p>
      <p className={styles.lead}>Start one here: a session you start from this device is shared with it.</p>
      <ol className={styles.steps}>
        <LaunchSteps />
      </ol>
      {headless ? (
        <p className={styles.lead}>
          This server has no screen. Sessions started on it directly (over ssh, in a terminal) stay hidden
          from your devices unless its owner runs <code className={`${styles.code} ${styles.command}`}>aasc-server share-default on</code> there.
        </p>
      ) : (
        <p className={styles.lead}>
          Sessions started on the host stay there until someone shares one from there with the HOST ONLY
          button in its session panel (it then reads SHARED). Releasing control on the host does not share it.
        </p>
      )}
      <ThreeDFooter />
    </section>
  );
}

interface LiveEmptyStateProps {
  /** Over the 3D scene, shown while it has no robot: the empty area lets the
   *  pointer through, and the copy is about the office. A robot is drawn only
   *  for a session the dashboard launched, so the "run claude in any terminal"
   *  step (which never gets one) is left out. */
  overScene?: boolean;
  /** Over the scene: listed sessions the office does not show (started outside
   *  the dashboard). The LIVE tab opens them. */
  outsideCount?: number;
}

export default function LiveEmptyState({ overScene = false, outsideCount = 0 }: LiveEmptyStateProps) {
  const titleId = useId();
  const hiddenCount = useWsStore((s) => s.hiddenCount);
  // Presence unknown (no devices yet) reads as "unknown", not as remote.
  const knownRemote = usePresenceStore((s) => s.devices.length > 0 && !isLocalDevice(s.devices, getClientId()));
  const wrapClass = overScene ? `${styles.wrap} ${styles.wrapOverScene}` : styles.wrap;

  if (knownRemote || hiddenCount > 0) {
    return (
      <div className={wrapClass}>
        <NotSharedCard titleId={titleId} hiddenCount={hiddenCount} />
      </div>
    );
  }

  return (
    <div className={wrapClass}>
      <section className={styles.card} aria-labelledby={titleId}>
        {overScene ? (
          <>
            <h2 id={titleId} className={styles.title}>No sessions in the 3D office yet</h2>
            <p className={styles.lead}>Every Claude Code or Codex session you start here gets a robot in this office.</p>
          </>
        ) : (
          <>
            <h2 id={titleId} className={styles.title}>No agent sessions yet</h2>
            <p className={styles.lead}>Every Claude Code or Codex session you start here gets a card on this page.</p>
          </>
        )}

        <ol className={styles.steps}>
          <LaunchSteps />
          {!overScene && (
            <li className={styles.step}>
              <span className={styles.num} aria-hidden="true">3</span>
              <span className={`${styles.desc} ${styles.descWide}`}>
                Or run <code className={styles.code}>claude</code> in any terminal. It shows up here by itself.
              </span>
            </li>
          )}
        </ol>

        {overScene && outsideCount > 0 && (
          <p className={styles.lead}>
            {outsideCount === 1 ? '1 session is' : `${outsideCount} sessions are`} running outside the
            dashboard and get no robot here. Press LIVE to open one.
          </p>
        )}

        <ThreeDFooter />
      </section>
    </div>
  );
}
