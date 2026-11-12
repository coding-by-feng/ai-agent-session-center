/**
 * restartProgressStore — the phone's Restart, followed to the end (Nov 8 2026).
 *
 * `start(session)` asks the Mac (requestSessionRestart) and keeps a track per card that
 * outlives the confirm sheet: stopping → starting → done | failed, judged by
 * `restartStep` (src/lib/chat/restartProgress.ts) on every session update and once more
 * when the phone's own give-up timer fires. A card re-keyed by its resume moves its track
 * to the new id. RestartBanner shows a track while that session's screen is up (`watch`);
 * an end nobody watches becomes a toast instead. A done track closes itself after
 * RESTART_DONE_SHOWN_MS; a failed one stays until dismissed.
 */
import { create } from 'zustand';
import type { Session } from '@/types';
import { requestSessionRestart } from '@/lib/restartSession';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { showToast } from '@/components/ui/ToastContainer';
import {
  RESTART_GIVE_UP_MS,
  findRestartedSession,
  restartCliName,
  restartStep,
  type RestartTrack,
} from '@/lib/chat/restartProgress';
import { useSessionStore } from './sessionStore';

export const RESTART_DONE_SHOWN_MS = 4_000;

/** Codex reports nothing until its first prompt, so a restart can't wait for it to say hello. */
const CODEX_DONE_NOTE = 'Codex reports in with its next message.';

interface RestartProgressState {
  tracks: Map<string, RestartTrack>;
  /** How many banners show each card's track (an end they show is not toasted). */
  shown: Map<string, number>;
  start: (session: Session) => void;
  /** A banner for `sessionId` is on screen until the returned release is called. */
  watch: (sessionId: string) => () => void;
  dismiss: (sessionId: string) => void;
  /** Tests: drop every track, timer and subscription. */
  reset: () => void;
}

const timers = new Set<ReturnType<typeof setTimeout>>();
let unsubscribe: (() => void) | null = null;

function later(fn: () => void, ms: number): void {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
}

export const useRestartProgressStore = create<RestartProgressState>((set, get) => {
  const put = (track: RestartTrack, replaces?: string) => set((s) => {
    const tracks = new Map(s.tracks);
    if (replaces) tracks.delete(replaces);
    tracks.set(track.sessionId, track);
    return { tracks };
  });
  const drop = (sessionId: string) => set((s) => {
    if (!s.tracks.has(sessionId)) return s;
    const tracks = new Map(s.tracks);
    tracks.delete(sessionId);
    return { tracks };
  });

  const finish = (track: RestartTrack, phase: 'done' | 'failed', error: string | null) => {
    const ended = { ...track, phase, error };
    if ((get().shown.get(track.sessionId) ?? 0) > 0) {
      put(ended);
      if (phase === 'done') {
        later(() => { if (get().tracks.get(track.sessionId)?.phase === 'done') drop(track.sessionId); }, RESTART_DONE_SHOWN_MS);
      }
    } else {
      drop(track.sessionId);
      if (phase === 'done') showToast(`${track.name} restarted`, 'success');
      else showToast(`${track.name} didn’t restart: ${error}`, 'error');
    }
    stopWatchingIfIdle();
  };

  const evaluate = () => {
    const sessions = useSessionStore.getState().sessions;
    for (const track of get().tracks.values()) {
      if (track.phase !== 'starting') continue;
      const session = findRestartedSession(sessions, track.sessionId);
      let current = track;
      if (session && session.sessionId !== track.sessionId) {
        current = { ...track, sessionId: session.sessionId };
        put(current, track.sessionId);
      }
      const step = restartStep(current, session, Date.now());
      if (step) finish(current, step.phase, step.error);
    }
  };

  const stopWatchingIfIdle = () => {
    if (unsubscribe && ![...get().tracks.values()].some((t) => t.phase === 'starting')) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  return {
    tracks: new Map(),
    shown: new Map(),

    start: (session) => {
      const sessionId = session.sessionId;
      if (get().tracks.get(sessionId)?.phase === 'stopping') return;
      const track: RestartTrack = {
        sessionId,
        name: sessionDisplayTitle(session),
        cli: restartCliName(session),
        phase: 'stopping',
        terminalId: null,
        error: null,
        startedAt: Date.now(),
      };
      put(track);
      // Started from the Sessions list: no banner shows the steps, so say it began (as before).
      if (!get().shown.get(sessionId)) showToast(`Restarting ${track.name}…`, 'info');
      void requestSessionRestart(sessionId).then((result) => {
        const now = get().tracks.get(sessionId);
        if (!now || now.startedAt !== track.startedAt) return; // dismissed, or a newer restart
        if (!result.ok) { finish(now, 'failed', result.error); return; }
        const starting: RestartTrack = { ...now, phase: 'starting', terminalId: result.terminalId, startedAt: Date.now() };
        if (session.cliSource === 'codex') { finish(starting, 'done', CODEX_DONE_NOTE); return; }
        put(starting);
        if (!unsubscribe) unsubscribe = useSessionStore.subscribe(evaluate);
        later(evaluate, RESTART_GIVE_UP_MS);
        evaluate();
      });
    },

    watch: (sessionId) => {
      set((s) => ({ shown: new Map(s.shown).set(sessionId, (s.shown.get(sessionId) ?? 0) + 1) }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        set((s) => {
          const shown = new Map(s.shown);
          const left = (shown.get(sessionId) ?? 1) - 1;
          if (left > 0) shown.set(sessionId, left);
          else shown.delete(sessionId);
          return { shown };
        });
        // A done banner that leaves the screen is not shown again later.
        if (!get().shown.has(sessionId) && get().tracks.get(sessionId)?.phase === 'done') drop(sessionId);
      };
    },

    dismiss: (sessionId) => { drop(sessionId); stopWatchingIfIdle(); },

    reset: () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      unsubscribe?.();
      unsubscribe = null;
      set({ tracks: new Map(), shown: new Map() });
    },
  };
});
