import { create } from 'zustand';
import type { Session } from '@/types';

interface SessionState {
  sessions: Map<string, Session>;
  selectedSessionId: string | null;
  previousSessionId: string | null;

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (session: Session) => void;
  selectSession: (sessionId: string) => void;
  deselectSession: () => void;
  setSessions: (sessions: Map<string, Session>) => void;
  togglePin: (sessionId: string) => void;
  toggleMute: (sessionId: string) => void;
  toggleAlert: (sessionId: string) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,
  previousSessionId: null,

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
      return { sessions: next, selectedSessionId };
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

      return { sessions: next, selectedSessionId };
    }),

  selectSession: (sessionId) => set((state) => ({
    previousSessionId: state.selectedSessionId,
    selectedSessionId: sessionId,
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
}));
