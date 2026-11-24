import { create } from 'zustand';
import type { Session } from '@/types';
import { isAiPopupEnabled } from '@/lib/aiPopup';
import { isListedSession } from '@/lib/sessionSort';
import { nextPinOrder, planPinnedOrder } from '@/lib/pinOrder';

/** The answer to an Automation (lite hooks) change: see `setHookLevel`. */
export type HookLevelResult =
  | { ok: true; appliesOnRestart: boolean }
  | { ok: false; error: string };

/** How many sessions `recentSelectedIds` remembers. */
const RECENT_SELECTED_MAX = 20;

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
  /**
   * The sessions opened in the panel, newest first, each once (capped at 20,
   * in memory only). What a kill from the panel steps back through
   * (`leaveSession`); one `previousSessionId` slot would point at the session
   * just killed. Follows re-keys; drops removed sessions.
   */
  recentSelectedIds: string[];

  addSession: (session: Session) => void;
  removeSession: (sessionId: string) => void;
  updateSession: (session: Session) => void;
  selectSession: (sessionId: string) => void;
  deselectSession: () => void;
  /**
   * The open session is going away (killed from its panel): open the one
   * opened before it that is still listed, and return its id; with none left,
   * deselect and return null. `previousSessionId` then names the one before
   * that, never `goneId`.
   */
  leaveSession: (goneId: string) => string | null;
  setSessions: (sessions: Map<string, Session>) => void;
  togglePin: (sessionId: string) => void;
  /**
   * The PINNED frame's cards top to bottom after a drag (Nov 18 2026): renumbers `pinOrder` at
   * once, then `PUT /api/pinned-order`; a refusal puts the old places back.
   */
  setPinnedOrder: (sessionIds: readonly string[]) => void;
  toggleMute: (sessionId: string) => void;
  toggleAlert: (sessionId: string) => void;
  /**
   * Set Alert to `alerted` on several sessions at once (the room frame header's Alert, `roomAlert.ts`). Optimistic, one
   * store update, then the same `PUT /api/sessions/:id/alerted` per session as `toggleAlert`.
   */
  setAlertedMany: (sessionIds: readonly string[], alerted: boolean) => void;
  toggleRemoteVisible: (sessionId: string) => void;
  toggleAiPopup: (sessionId: string) => void;
  /**
   * Mark the session Automation (lite hooks) or clear it. Optimistic; the old value comes back when the server
   * refuses. Resolves with the server's answer: `appliesOnRestart` when the agent running now keeps its old level.
   */
  setHookLevel: (sessionId: string, lite: boolean) => Promise<HookLevelResult>;
  setSessionTitle: (sessionId: string, title: string) => void;
  /** Set the inline progress remark. Empty string clears it. */
  setSessionRemark: (sessionId: string, remark: string) => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: new Map(),
  selectedSessionId: null,
  previousSessionId: null,
  lastSelectedSessionId: null,
  recentSelectedIds: [],

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
      const recentSelectedIds = state.recentSelectedIds.includes(sessionId)
        ? state.recentSelectedIds.filter((id) => id !== sessionId)
        : state.recentSelectedIds;
      return { sessions: next, selectedSessionId, lastSelectedSessionId, recentSelectedIds };
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
      let recentSelectedIds = state.recentSelectedIds;
      if (session.replacesId && recentSelectedIds.includes(session.replacesId)) {
        const renamed = recentSelectedIds.map((id) => (id === session.replacesId ? session.sessionId : id));
        recentSelectedIds = renamed.filter((id, i) => renamed.indexOf(id) === i);
      }

      return { sessions: next, selectedSessionId, lastSelectedSessionId, recentSelectedIds };
    }),

  selectSession: (sessionId) => set((state) => ({
    previousSessionId: state.selectedSessionId,
    selectedSessionId: sessionId,
    lastSelectedSessionId: sessionId,
    recentSelectedIds: [sessionId, ...state.recentSelectedIds.filter((id) => id !== sessionId)]
      .slice(0, RECENT_SELECTED_MAX),
  })),

  deselectSession: () => set({ selectedSessionId: null }),

  leaveSession: (goneId) => {
    const { sessions, recentSelectedIds } = get();
    const kept = recentSelectedIds.filter((id) => id !== goneId);
    const [nextId = null, afterId = null] = kept.filter((id) => {
      const s = sessions.get(id);
      return s !== undefined && isListedSession(s);
    });
    if (nextId === null) {
      set({ selectedSessionId: null, previousSessionId: null, recentSelectedIds: kept });
      return null;
    }
    set({
      selectedSessionId: nextId,
      previousSessionId: afterId,
      lastSelectedSessionId: nextId,
      recentSelectedIds: [nextId, ...kept.filter((id) => id !== nextId)],
    });
    return nextId;
  },

  setSessions: (sessions) => set({ sessions }),

  togglePin: (sessionId) =>
    set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const pinned = !session.pinned;
      const next = new Map(state.sessions);
      // A new pin goes to the end of PINNED, unpinning gives up the place; the server does the
      // same (sessionStore.setSessionPinned), so the next update agrees.
      next.set(sessionId, {
        ...session,
        pinned,
        pinOrder: pinned ? nextPinOrder(state.sessions.values()) : undefined,
      });
      // Persist to server. A refusal (a session not shared with this device) puts
      // the old value back instead of showing a pin the Mac never made. The phone
      // pins through useSessionActions.setPinned, which also says why (Nov 2 2026).
      fetch(`/api/sessions/${encodeURIComponent(sessionId)}/pinned`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned }),
      }).then((res) => {
        if (res.ok) return;
        set((later) => {
          const current = later.sessions.get(sessionId);
          if (!current || current.pinned !== pinned) return later;
          const reverted = new Map(later.sessions);
          reverted.set(sessionId, { ...current, pinned: !pinned });
          return { sessions: reverted };
        });
      }).catch(() => { /* ignore network errors */ });
      return { sessions: next };
    }),

  setPinnedOrder: (sessionIds) =>
    set((state) => {
      const pinned = [...state.sessions.values()].filter((s) => s.pinned && s.status !== 'ended');
      const plan = planPinnedOrder(pinned, sessionIds);
      const before = new Map(pinned.map((s) => [s.sessionId, s.pinOrder]));
      const next = new Map(state.sessions);
      let changed = false;
      for (const s of pinned) {
        const order = plan.get(s.sessionId);
        if (order === undefined || s.pinOrder === order) continue;
        next.set(s.sessionId, { ...s, pinOrder: order });
        changed = true;
      }
      if (!changed) return state;
      fetch('/api/pinned-order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: [...sessionIds] }),
      }).then((res) => {
        if (res.ok) return;
        // Refused (a session not shared with this device): back to the places it had,
        // unless a later drag or update has moved a card since.
        set((later) => {
          const reverted = new Map(later.sessions);
          let undone = false;
          for (const [id, order] of before) {
            const current = later.sessions.get(id);
            if (!current || current.pinOrder !== plan.get(id)) continue;
            reverted.set(id, { ...current, pinOrder: order });
            undone = true;
          }
          return undone ? { sessions: reverted } : later;
        });
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

  setAlertedMany: (sessionIds, alerted) =>
    set((state) => {
      const changed = sessionIds.filter((id) => {
        const session = state.sessions.get(id);
        return session !== undefined && !!session.alerted !== alerted;
      });
      if (changed.length === 0) return state;
      const next = new Map(state.sessions);
      for (const id of changed) {
        const session = state.sessions.get(id);
        if (session) next.set(id, { ...session, alerted });
        fetch(`/api/sessions/${encodeURIComponent(id)}/alerted`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alerted }),
        }).catch(() => { /* ignore network errors */ });
      }
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

  setHookLevel: async (sessionId, lite) => {
    const before = get().sessions.get(sessionId);
    if (!before) return { ok: false, error: 'Session not found' };
    const flip = (on: boolean) => set((state) => {
      const session = state.sessions.get(sessionId);
      if (!session) return state;
      const { hookLevel: _old, ...rest } = session;
      void _old;
      const next = new Map(state.sessions);
      next.set(sessionId, on ? { ...rest, hookLevel: 'lite' } : rest);
      return { sessions: next };
    });
    flip(lite);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/hook-level`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hookLevel: lite ? 'lite' : null }),
      });
      const body: { error?: string; appliesOnRestart?: boolean } | null = await res.json().catch(() => null);
      if (!res.ok) {
        flip(before.hookLevel === 'lite');
        return { ok: false, error: body?.error || `Could not change Automation (HTTP ${res.status})` };
      }
      return { ok: true, appliesOnRestart: body?.appliesOnRestart === true };
    } catch (err) {
      flip(before.hookLevel === 'lite');
      return { ok: false, error: err instanceof Error ? err.message : 'Could not change Automation' };
    }
  },

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
