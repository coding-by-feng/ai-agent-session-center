/**
 * recentPutDownStore — the sessions put down from the rail's RECENT frame today (lib/recentPutDown.ts).
 * Per device: saved in localStorage['recent-put-down'] as `{day, ids}`; a new day reads as nothing put down.
 */
import { create } from 'zustand';
import { EMPTY_PUT_DOWN, parsePutDown, putBack, putDown, type PutDownState } from '@/lib/recentPutDown';

export const RECENT_PUT_DOWN_KEY = 'recent-put-down';

function load(): PutDownState {
  try {
    return parsePutDown(localStorage.getItem(RECENT_PUT_DOWN_KEY));
  } catch {
    return EMPTY_PUT_DOWN;
  }
}

function save(state: PutDownState): void {
  try {
    localStorage.setItem(RECENT_PUT_DOWN_KEY, JSON.stringify(state));
  } catch {
    /* private mode or full: the choice lasts until reload */
  }
}

interface RecentPutDownState {
  putDown: PutDownState;
  /** Hide `sessionId` from RECENT for the rest of today. */
  putDownSession: (sessionId: string) => void;
  /** Return `sessionId` to RECENT. */
  putBackSession: (sessionId: string) => void;
  /** Return every session put down today. */
  putBackAll: () => void;
}

export const useRecentPutDownStore = create<RecentPutDownState>((set) => ({
  putDown: load(),
  putDownSession: (sessionId) =>
    set((s) => {
      const next = putDown(s.putDown, sessionId, Date.now());
      save(next);
      return { putDown: next };
    }),
  putBackSession: (sessionId) =>
    set((s) => {
      const next = putBack(s.putDown, sessionId, Date.now());
      save(next);
      return { putDown: next };
    }),
  putBackAll: () =>
    set(() => {
      save(EMPTY_PUT_DOWN);
      return { putDown: EMPTY_PUT_DOWN };
    }),
}));
