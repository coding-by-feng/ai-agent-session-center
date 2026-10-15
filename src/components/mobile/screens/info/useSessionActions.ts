/**
 * useSessionActions — one session's actions that run without a confirm, shared by
 * the Sessions list (swipe, long press), Info and the session's ⋯ sheet (AASC-40 /
 * AASC-46): fork, clone, resume, notifications (mute) and loud alerts, mark read.
 *
 * Kill and restart confirm first: they live in SessionSheets. Every action says
 * what happened in a toast, including the Mac's refusal (never a silent no-op).
 */
import { useCallback, useRef, useState } from 'react';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import { copySession, type CopyKind } from '@/lib/sessionCopy';
import { requestSessionResume } from '@/lib/sessionActions';
import { alertSession, muteSession, unalertSession, unmuteSession } from '@/lib/alarmEngine';
import { markSessionRead, readStamp } from '@/lib/chat/sessionReads';
import { detectCli } from '@/lib/cliDetect';

export type ActionBusy = 'fork' | 'clone' | 'resume' | null;

/** Fork continues the conversation: Claude Code and Codex only. */
export function forkBlocker(session: Session): string | null {
  const cli = detectCli(session);
  return cli === 'claude' || cli === 'codex' ? null : 'Only Claude Code and Codex sessions can be forked.';
}

export function useSessionActions() {
  const [busy, setBusy] = useState<ActionBusy>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (kind: Exclude<ActionBusy, null>, action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    try {
      await action();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }, []);

  /** Fork or clone; the new session is selected, which opens it (the frame's selection bridge). */
  const copy = useCallback((sessionId: string, kind: CopyKind) => run(kind, async () => {
    const created = await copySession(sessionId, kind);
    if (created) showToast(kind === 'fork' ? 'Forked: opening the new session' : 'Cloned: opening the new session', 'success');
  }), [run]);

  const resume = useCallback((sessionId: string) => run('resume', async () => {
    try {
      const result = await requestSessionResume(sessionId);
      showToast(result.message, result.ok ? 'success' : 'error');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Resume failed', 'error');
    }
  }), [run]);

  /** Notifications on = not muted: muting also stops this session's push and sounds. */
  const setNotifications = useCallback((session: Session, on: boolean) => {
    if (on === !session.muted) return;
    useSessionStore.getState().toggleMute(session.sessionId);
    if (on) unmuteSession(session.sessionId);
    else muteSession(session.sessionId);
    showToast(on ? 'Notifications on for this session' : 'Muted: no notifications or sounds from this session', 'info');
  }, []);

  const setLoudAlerts = useCallback((session: Session, on: boolean) => {
    if (on === !!session.alerted) return;
    useSessionStore.getState().toggleAlert(session.sessionId);
    if (on) alertSession(session.sessionId);
    else unalertSession(session.sessionId);
    showToast(on ? 'Loud alerts on: approvals and finished turns ring out' : 'Loud alerts off', 'info');
  }, []);

  const markRead = useCallback((session: Session) => {
    markSessionRead(session.sessionId, readStamp(session));
  }, []);

  return { busy, copy, resume, setNotifications, setLoudAlerts, markRead };
}
