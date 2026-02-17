import { create } from 'zustand';
import type { Session } from '@/types';

interface SessionState {
  sessions: Map<string, Session>;
  selectedSessionId: string | null;

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (session: Session) => void;
  selectSession: (sessionId: string) => void;
  deselectSession: () => void;
  setSessions: (sessions: Map<string, Session>) => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: new Map(),
  selectedSessionId: null,

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

  selectSession: (sessionId) => set({ selectedSessionId: sessionId }),

  deselectSession: () => set({ selectedSessionId: null }),

  setSessions: (sessions) => set({ sessions }),
}));
