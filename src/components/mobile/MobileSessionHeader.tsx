/**
 * MobileSessionHeader — the open session's header on a phone (AASC-18).
 *
 * The desktop top row (SessionSwitcher) packs a dozen 24–28px controls and lost
 * the session's name on a phone. This one keeps to what a phone needs in view:
 *
 *   [‹] Title (tap to rename)            [Restart | Resume] [⋯]
 *       project · running time
 *   status · baton · interruption · plan usage · model·effort   (one swipeable line)
 *
 * Everything else is in the actions sheet behind ⋯. Kill and Restart confirm in a
 * ConfirmSheet first (a tap is easy to misfire); Resume does not (it only starts).
 * Desktop-only controls are simply absent: Share is a localhost-only route, and
 * pop-out and split layouts have no phone meaning.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useControlBaton } from '@/hooks/useControlBaton';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { requestSessionRestart, restartNeedsConfirm } from '@/lib/restartSession';
import { requestSessionKill, requestSessionResume } from '@/lib/sessionActions';
import { resolveRuntimeDisplay } from '@/lib/sessionRuntime';
import { faultLabel } from '@/lib/resumeWatchdog';
import { muteSession, unmuteSession, alertSession, unalertSession } from '@/lib/alarmEngine';
import { showToast } from '@/components/ui/ToastContainer';
import Button from '@/components/ui/Button';
import Tooltip from '@/components/ui/Tooltip';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import StatusBadge from '@/components/session/StatusBadge';
import PlanUsageChip from '@/components/session/PlanUsageChip';
import SessionRuntimeChip from '@/components/session/SessionRuntimeChip';
import SheetAction, { SheetSection } from './SheetAction';
import { ManageRoomsSheet, MoveToRoomSheet, RoomIcon } from './RoomSheets';
import PhoneFloatsButton from './PhoneFloatsButton';
import {
  BackIcon,
  BellIcon,
  HandIcon,
  KillIcon,
  MoreIcon,
  PinIcon,
  PlayIcon,
  PlusIcon,
  RenameIcon,
  RestartIcon,
  SpeakerIcon,
} from './phoneIcons';
import styles from '@/styles/modules/PhoneSession.module.css';

export interface MobileSessionHeaderProps {
  session: Session;
  /** How long the session has run, already formatted ("1h 22m"). */
  duration?: string;
  /** Back to the session list (the panel's minimize). */
  onBack?: () => void;
}

type Confirming = 'restart' | 'kill' | null;

/** Restart is the toolbar's: the agent's own terminal, never a fork's. */
function canRestartSession(session: Session): boolean {
  return session.source === 'ssh' && !!session.terminalId && !session.isFork && session.status !== 'ended';
}

export default function MobileSessionHeader({ session, duration, onBack }: MobileSessionHeaderProps) {
  const { sessionId } = session;
  const name = sessionDisplayTitle(session);
  const isEnded = session.status === 'ended';
  const canRestart = canRestartSession(session);
  const baton = useControlBaton(sessionId);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState<'restart' | 'kill' | 'resume' | null>(null);
  // Rooms (AASC-20): the "Move to room…" and rooms sheets, from the ⋯ sheet.
  const [roomSheet, setRoomSheet] = useState<'move' | 'manage' | null>(null);
  const closeRoomSheet = useCallback(() => setRoomSheet(null), []);
  const manageRooms = useCallback(() => setRoomSheet('manage'), []);

  // ---- Rename (tap the title) ----
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  /** What the box was pre-filled with: saving that untouched would count as a
   *  manual rename and suppress the automatic title from the first prompt. */
  const editFrom = useRef('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const beginRename = useCallback(() => {
    const initial = session.title || session.projectName || '';
    editFrom.current = initial.trim();
    setDraft(initial);
    setRenaming(true);
  }, [session.title, session.projectName]);

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const commitRename = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== editFrom.current && trimmed !== session.title) {
      useSessionStore.getState().setSessionTitle(sessionId, trimmed);
    }
    setRenaming(false);
  }, [draft, sessionId, session.title]);

  // ---- Actions ----
  // Stable: BottomSheet re-runs its focus effect whenever onClose changes, and
  // this header re-renders on every session update and baton tick.
  const closeSheet = useCallback(() => setSheetOpen(false), []);
  const cancelConfirm = useCallback(() => setConfirming(null), []);
  const fromSheet = (action: () => void) => () => {
    setSheetOpen(false);
    action();
  };

  const restart = useCallback(async () => {
    setBusy('restart');
    try {
      const result = await requestSessionRestart(sessionId);
      showToast(result.ok ? `Restarting ${name}` : `${name}: ${result.error}`, result.ok ? 'info' : 'error');
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }, [sessionId, name]);

  const kill = useCallback(async () => {
    setBusy('kill');
    try {
      const result = await requestSessionKill(sessionId, session.terminalId);
      if (result.warning) showToast(result.warning, 'error');
      showToast(result.message, result.ok ? 'success' : 'error');
      if (result.ok) useSessionStore.getState().deselectSession();
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  }, [sessionId, session.terminalId]);

  const resume = useCallback(async () => {
    setBusy('resume');
    try {
      const result = await requestSessionResume(sessionId);
      showToast(result.message, result.ok ? 'success' : 'error');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Resume failed', 'error');
    } finally {
      setBusy(null);
    }
  }, [sessionId]);

  const toggleMute = useCallback(() => {
    const muted = !session.muted;
    useSessionStore.getState().toggleMute(sessionId);
    if (muted) muteSession(sessionId);
    else unmuteSession(sessionId);
    showToast(muted ? 'Session muted' : 'Session unmuted', 'info');
  }, [sessionId, session.muted]);

  const toggleAlert = useCallback(() => {
    const alerted = !session.alerted;
    useSessionStore.getState().toggleAlert(sessionId);
    if (alerted) alertSession(sessionId);
    else unalertSession(sessionId);
    showToast(alerted ? 'Alert on: loud sounds for approval and completion' : 'Alert off', 'info');
  }, [sessionId, session.alerted]);

  const busySession = restartNeedsConfirm(session.status);
  const restartMessage = busySession
    ? `"${name}" is running right now: the current turn is stopped. It comes back in a new terminal with the same name, model and effort.`
    : `The agent quits and "${name}" comes back in a new terminal with the same name, model and effort.`;

  const subtitle = [session.projectName && session.projectName !== name ? session.projectName : null, duration]
    .filter(Boolean)
    .join(' · ');
  const hasRuntimeChip = resolveRuntimeDisplay(session) !== null;

  return (
    <header className={styles.header} aria-label="Session">
      <div className={styles.headerRow}>
        {onBack && (
          <button type="button" className={styles.iconBtn} onClick={onBack} aria-label="Back to sessions">
            <BackIcon />
          </button>
        )}
        {renaming ? (
          <input
            ref={inputRef}
            className={styles.titleInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                commitRename();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRenaming(false);
              }
            }}
            aria-label="Session title"
            maxLength={200}
            enterKeyHint="done"
          />
        ) : (
          <button type="button" className={styles.titleBtn} onClick={beginRename} aria-label={`${name}. Rename session`}>
            <span className={styles.title}>{name}</span>
            {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
          </button>
        )}
        {isEnded ? (
          <span className={styles.primaryAction}>
            <Button variant="primary" icon={<PlayIcon width={16} height={16} />} onClick={resume} disabled={busy === 'resume'} aria-busy={busy === 'resume' || undefined}>
              {busy === 'resume' ? 'Resuming' : 'Resume'}
            </Button>
          </span>
        ) : canRestart && (
          <button
            type="button"
            className={styles.iconBtn}
            onClick={() => setConfirming('restart')}
            disabled={busy === 'restart'}
            aria-busy={busy === 'restart' || undefined}
            aria-label="Restart session"
          >
            <RestartIcon />
          </button>
        )}
        <PhoneFloatsButton sessionId={sessionId} />
        <button
          type="button"
          className={styles.iconBtn}
          onClick={() => setSheetOpen(true)}
          aria-label="Session actions"
          aria-haspopup="dialog"
        >
          <MoreIcon />
        </button>
      </div>

      <div className={styles.chipRow}>
        <StatusBadge status={session.status} />
        {baton.mode === 'spectator' && baton.holder && (
          <span className={`${styles.chip} ${styles.chipLock}`}>
            <span aria-hidden="true">🔒</span> {baton.holder.label} driving
          </span>
        )}
        {(baton.mode === 'driver' || baton.mode === 'asked') && (
          <span className={`${styles.chip} ${styles.chipDrive}`}>
            <span aria-hidden="true">🎮</span> You're driving
          </span>
        )}
        {session.interruption && (
          // The failure's own line was a hover title, out of a finger's reach:
          // a long press shows it (Tooltip's touch mode, AASC-20).
          <Tooltip label={faultLabel(session.interruption.kind)} description={session.interruption.line} placement="bottom">
            <span className={`${styles.chip} ${styles.chipWarn}`} tabIndex={0}>
              <span aria-hidden="true">⚠</span> {faultLabel(session.interruption.kind)}
            </span>
          </Tooltip>
        )}
        <span className={styles.planSlot}><PlanUsageChip session={session} /></span>
        {hasRuntimeChip
          ? <SessionRuntimeChip session={session} />
          : session.model && <span className={styles.chip}>{session.model}</span>}
      </div>

      <BottomSheet open={sheetOpen} onClose={closeSheet} title={name}>
        <SheetSection title="Session">
          <SheetAction icon={<RenameIcon />} label="Rename" onClick={fromSheet(beginRename)} />
          {isEnded && <SheetAction icon={<PlayIcon />} label="Resume" onClick={fromSheet(() => void resume())} />}
          {canRestart && (
            <SheetAction icon={<RestartIcon />} label="Restart session…" onClick={fromSheet(() => setConfirming('restart'))} />
          )}
          <SheetAction
            icon={<PinIcon />}
            label="Pin session"
            pressed={!!session.pinned}
            onClick={fromSheet(() => useSessionStore.getState().togglePin(sessionId))}
          />
          <SheetAction icon={<SpeakerIcon />} label="Mute sounds" pressed={!!session.muted} onClick={fromSheet(toggleMute)} />
          <SheetAction icon={<BellIcon />} label="Alert" pressed={!!session.alerted} onClick={fromSheet(toggleAlert)} />
          <SheetAction icon={<RoomIcon />} label="Move to room…" onClick={fromSheet(() => setRoomSheet('move'))} />
          <SheetAction icon={<RoomIcon />} label="Manage rooms…" onClick={fromSheet(() => setRoomSheet('manage'))} />
          <SheetAction
            icon={<PlusIcon />}
            label="New session…"
            onClick={fromSheet(() => useUiStore.getState().openModal('new-session'))}
          />
        </SheetSection>
        {baton.mode === 'spectator' && baton.holder && (
          <SheetSection title={`Control · ${baton.holder.label} is driving`}>
            <SheetAction icon={<HandIcon />} label="Ask for control" onClick={fromSheet(() => void baton.ask())} />
            <SheetAction
              icon={<HandIcon />}
              label={baton.canTake ? 'Take control' : `Take control (in ${baton.waitSecs}s)`}
              disabled={!baton.canTake}
              onClick={fromSheet(() => void baton.take())}
            />
          </SheetSection>
        )}
        {(baton.mode === 'driver' || baton.mode === 'asked') && (
          <SheetSection title="Control · you're driving">
            <SheetAction icon={<HandIcon />} label="Release control" onClick={fromSheet(() => void baton.release())} />
          </SheetSection>
        )}
        <SheetSection title="Danger">
          <SheetAction icon={<KillIcon />} label="Kill session…" danger onClick={fromSheet(() => setConfirming('kill'))} />
        </SheetSection>
      </BottomSheet>

      <MoveToRoomSheet sessionId={roomSheet === 'move' ? sessionId : null} onClose={closeRoomSheet} onManage={manageRooms} />
      <ManageRoomsSheet open={roomSheet === 'manage'} onClose={closeRoomSheet} />
      <ConfirmSheet
        open={confirming === 'restart'}
        title="Restart this session?"
        message={restartMessage}
        confirmLabel="Restart"
        danger={busySession}
        busy={busy === 'restart'}
        onConfirm={() => void restart()}
        onCancel={cancelConfirm}
      />
      <ConfirmSheet
        open={confirming === 'kill'}
        title="Kill this session?"
        message={`"${name}" stops: its terminal closes and the agent process ends.`}
        confirmLabel="Kill session"
        danger
        busy={busy === 'kill'}
        onConfirm={() => void kill()}
        onCancel={cancelConfirm}
      />
    </header>
  );
}
