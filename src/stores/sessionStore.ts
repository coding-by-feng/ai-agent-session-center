import { create } from 'zustand';
import type { Session } from '@/types';
import { isAiPopupEnabled } from '@/lib/aiPopup';

interface SessionState {
  sessions: Map<string, Session>;
  selectedSessionId: string | null;
  previousSessionId: string | null;
  /**
   * The session most recently opened in the panel. Unlike selectedSessionId it
   * survives deselectSession(), which every nav tab but LIVE calls; the LIVE
   * tab reopens it (src/lib/liveSession.ts). Follows re-keys; cleared when
   * the session is removed.
   */
  lastSelectedSessionId: string | null;

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (session: Session) => void;
  selectSession: (sessionId: string) => void;
  deselectSession: () => void;
  setSessions: (sessions: Map<string, Session>) => void;
  togglePin: (sessionId: string) => void;
  toggleMute: (sessionId: string) => void;
  toggleAlert: (sessionId: string) => void;
  toggleRemoteVisible: (sessionId: string) => void;
  toggleAiPopup: (sessionId: string) => void;
  setSessionTitle: (sessionId: string, title: string) => void;
  /** Set the inline progress remark. Empty string clears it. */
  setSessionRemark: (sessionId: string, remark: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  previousSessionId: null,
  lastSelectedSessionId: null,

  addSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.set(session.sessionId, session);
      return { sessions: next };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      const next = new Map(state.sessions);
      next.delete(sessionId);
      const selectedSessionId =
        state.selectedSessionId === sessionId ? null : state.selectedSessionId;
      const lastSelectedSessionId =
        state.lastSelectedSessionId === sessionId ? null : state.lastSelectedSessionId;
      return { sessions: next, selectedSessionId, lastSelectedSessionId };
    }),

  updateSession: (session) =>
    set((state) => {
      const next = new Map(state.sessions);

      // Fix 6: when a session has replacesId, remove the old entry
      if (session.replacesId) {
        next.delete(session.replacesId);
      }

      next.set(session.sessionId, session);

      // If selected session was replaced, follow the new ID
      let selectedSessionId = state.selectedSessionId;
      if (session.replacesId && state.selectedSessionId === session.replacesId) {
        selectedSessionId = session.sessionId;
      }
      let lastSelectedSessionId = state.lastSelectedSessionId;
      if (session.replacesId && state.lastSelectedSessionId === session.replacesId) {
        lastSelectedSessionId = session.sessionId;
      }

      return { sessions: next, selectedSessionId, lastSelectedSessionId };
    }),

  selectSession: (sessionId) => set((state) => ({
    previousSessionId: state.selectedSessionId,
    selectedSessionId: sessionId,
    lastSelectedSessionId: sessionId,
  })),

  deselectSession: () => set({ selectedSessionId: null }),

  setSessions: (sessions) => set({ sessions }),

  togglePin: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const pinned = !session.pinned;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, pinned });
      // Persist to server
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  toggleMute: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const muted = !session.muted;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, muted });
      // Persist to server
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/muted`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  toggleAlert: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const alerted = !session.alerted;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, alerted });
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/alerted`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alerted }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  // Flips optimistically, same as toggleMute/toggleAlert above — the button
  // previously fired the PUT alone with no local update and no WS broadcast
  // back, so it never visibly changed state on click; only a full reload
  // picked up the server's write. The PUT route is localhost-only (see
  // server/sessionVisibility.ts) so this action is only ever reachable from
  // that same UI, which already can't render for a remote client.
  toggleRemoteVisible: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const remoteVisible = !session.remoteVisible;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, remoteVisible });
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remote-visible`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteVisible }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  // Optimistic flip + fire-and-forget persist, same shape as the toggles
  // above. Reads through the default-ON rule rather than the raw field: an
  // untouched session has `aiPopupEnabled === undefined`, and treating that
  // as false would make the first click a no-op (undefined -> !undefined
  // -> true, i.e. "enable" something already enabled).
  toggleAiPopup: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const aiPopupEnabled = !isAiPopupEnabled(session);
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, aiPopupEnabled });
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/ai-popup`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aiPopupEnabled }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  setSessionTitle: (sessionId, title) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const trimmed = title.trim();
      if (!trimmed || trimmed === session.title) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, title: trimmed });
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  setSessionRemark: (sessionId, remark) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      // Unlike the title, an EMPTY remark is meaningful — it clears the note.
      // So only bail when the value is unchanged, never merely because it's ''.
      const trimmed = remark.trim();
      if (trimmed === (session.remark ?? '')) return state;
      const next = new Map(state.sessions);
      next.set(sessionId, { ...session, remark: trimmed });
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remark`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remark: trimmed }),
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),
}));
