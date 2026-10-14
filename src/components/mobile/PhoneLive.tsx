/**
 * PhoneLive — the LIVE page on a phone (AASC-18): one column of session cards
 * (the LIVE board's own cards: status glyph and words, title, room, the latest
 * prompt or the user's remark, how long it has been quiet; a tap opens the
 * session), pulled down to refresh, with search and "new session" in its header.
 *
 * Not the desktop's 3D control panel (units online, sound, 3D, rooms): the
 * phone has no 3D scene (LiveView), so none of it applies here.
 */
import { useCallback, useMemo, useState } from 'react';
import LiveBoard from '@/components/live/LiveBoard';
import IconButton from '@/components/ui/IconButton';
import Button from '@/components/ui/Button';
import { NewSessionIcon, RefreshListIcon, SearchIcon } from '@/components/ui/icons';
import { useLiveFlatState } from '@/hooks/useLiveBoard';
import { usePullToRefresh, type PullPhase } from '@/hooks/usePullToRefresh';
import { boardSessions } from '@/lib/liveBoard';
import { refreshSessionList } from '@/lib/sessionRefresh';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import QuickLaunchSheet from './QuickLaunchSheet';
import styles from '@/styles/modules/PhoneLive.module.css';

const PULL_WORDS: Record<PullPhase, string> = {
  idle: '',
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  refreshing: 'Refreshing…',
};

/** The refresh behind the pull and the button: tells the user when it could not reach the server. */
async function refreshOrSay(): Promise<void> {
  const ok = await refreshSessionList();
  if (!ok) showToast("Couldn't reach the session server. Still trying to reconnect.", 'error');
}

function PageActions({
  refreshing,
  onRefresh,
  onNew,
}: {
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
}) {
  const openModal = useUiStore((s) => s.openModal);
  return (
    <>
      <IconButton label="Search all sessions" tooltip={false} onClick={() => openModal('global-search')}>
        <SearchIcon />
      </IconButton>
      <IconButton
        label="Refresh the session list"
        tooltip={false}
        onClick={onRefresh}
        disabled={refreshing}
        aria-busy={refreshing || undefined}
        className={refreshing ? styles.spinning : undefined}
      >
        <RefreshListIcon />
      </IconButton>
      <IconButton label="New session" tooltip={false} onClick={onNew}>
        <NewSessionIcon />
      </IconButton>
    </>
  );
}

/** No session listed yet, or still loading: says which, and how to start one. */
function PhoneLiveEmpty({ loading, actions, onStart }: { loading: boolean; actions: React.ReactNode; onStart: () => void }) {
  const connected = useWsStore((s) => s.connected);
  const hiddenCount = useWsStore((s) => s.hiddenCount);
  return (
    <section className={styles.empty} aria-labelledby="phone-live-heading">
      <header className={styles.emptyHeader}>
        <h2 id="phone-live-heading" className={styles.heading}>Sessions</h2>
        <div className={styles.actions}>{actions}</div>
      </header>
      {loading ? (
        <p className={styles.note} role="status">
          {connected ? 'Loading sessions…' : 'Connecting to the session server…'}
        </p>
      ) : (
        <>
          <p className={styles.note}>No sessions here yet.</p>
          {hiddenCount > 0 && (
            <p className={styles.note}>
              {hiddenCount === 1 ? '1 session is' : `${hiddenCount} sessions are`} running on the host but not
              shared with this device.
            </p>
          )}
          <Button variant="primary" className={styles.start} onClick={onStart}>Start a session</Button>
        </>
      )}
    </section>
  );
}

export default function PhoneLive() {
  const sessions = useSessionStore((s) => s.sessions);
  const board = useMemo(() => boardSessions(sessions.values()), [sessions]);
  const state = useLiveFlatState();
  const [launchOpen, setLaunchOpen] = useState(false);
  const openLaunch = useCallback(() => setLaunchOpen(true), []);
  const closeLaunch = useCallback(() => setLaunchOpen(false), []);

  const { scrollerRef, phase, handlers, refresh } = usePullToRefresh<HTMLDivElement>(refreshOrSay);
  const refreshing = phase === 'refreshing';
  const onRefresh = useCallback(() => { void refresh(); }, [refresh]);

  const actions = <PageActions refreshing={refreshing} onRefresh={onRefresh} onNew={openLaunch} />;

  return (
    <div
      ref={scrollerRef}
      className={styles.page}
      data-pull={phase}
      data-testid="phone-live"
      {...handlers}
    >
      <div className={styles.pull} aria-hidden={phase === 'idle' ? true : undefined}>
        {phase !== 'idle' && (
          <span className={styles.pullInner} role="status">
            <span className={styles.pullSpinner} aria-hidden="true" />
            {PULL_WORDS[phase]}
          </span>
        )}
      </div>
      {state === 'board' && board.length > 0 ? (
        <LiveBoard sessions={board} variant="phone" actions={actions} />
      ) : (
        <PhoneLiveEmpty loading={state === 'loading'} actions={actions} onStart={openLaunch} />
      )}
      <QuickLaunchSheet open={launchOpen} onClose={closeLaunch} />
    </div>
  );
}
