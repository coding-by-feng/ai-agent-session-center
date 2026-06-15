/**
 * Floating session terminals — Zustand store.
 *
 * Tracks the small set of "fork-and-explain" / "fork-and-translate" terminals
 * users have spawned. They're rendered as draggable picture-in-picture windows
 * over the dashboard. Capped at MAX_FLOATS so the screen doesn't fill up.
 */
import { create } from 'zustand';
import { captureResponse } from '@/lib/translationLog';

const MAX_FLOATS = 4;

export interface FloatingSession {
  /** Server-issued PTY id (term-...) */
  terminalId: string;
  /** Human-readable label shown in the title bar (e.g. "Explain (中文)"). */
  label: string;
  /** Origin session that triggered the spawn. */
  originSessionId: string;
  /** Wall-clock time of creation (used for stable z-order). */
  createdAt: number;
}

interface FloatingSessionsState {
  floats: FloatingSession[];
  open: (input: Omit<FloatingSession, 'createdAt'>) => void;
  close: (terminalId: string) => void;
  closeAll: () => void;
  /**
   * Close every float spawned by a given main session. Used when that session
   * is removed — its popups only render under their origin session, so once the
   * origin is gone they'd be invisible AND their PTYs would leak. Closing them
   * snapshots output, kills the PTY, and drops them from the store.
   */
  /**
   * Snapshot the popup's on-screen output into its REVIEW/AI-popup log row
   * WITHOUT killing the PTY. Previously the response was only captured in
   * close(), so any restart/reload while a popup was still open lost the
   * answer permanently (the entry forever showed "response not captured").
   * Idempotent — re-capturing just overwrites the draft with the latest text,
   * so a panel can poll this safely while it's open.
   */
  captureNow: (terminalId: string) => Promise<void>;
  closeByOriginSession: (originSessionId: string) => void;
  /**
   * Re-point floats from an old origin session id to a new one. Used when a
   * session is re-keyed (clone/fork/resume via `replacesId`) so its popups stay
   * attached to the surviving session instead of orphaning on the dead id.
   */
  migrateOriginSession: (oldSessionId: string, newSessionId: string) => void;
  /**
   * Close every float whose origin session is NOT in `liveSessionIds`. Used when
   * the session set is replaced wholesale (a fresh WS snapshot) — sessions that
   * vanished never fire `session_removed`, so their popups would otherwise leak.
   */
  closeOrphans: (liveSessionIds: Set<string>) => void;
  /**
   * terminalIds currently popped out into their own native (Electron) window.
   * Their in-app panel is hidden — but the float entry + server PTY are kept —
   * so only the popout window is the WS subscriber. Re-docked (removed from this
   * list) when the popout window closes.
   */
  poppedOut: string[];
  setPoppedOut: (terminalId: string, on: boolean) => void;
}

export const useFloatingSessionsStore = create<FloatingSessionsState>((set, get) => ({
  floats: [],
  poppedOut: [],

  setPoppedOut: (terminalId, on) => set((s) => ({
    poppedOut: on
      ? (s.poppedOut.includes(terminalId) ? s.poppedOut : [...s.poppedOut, terminalId])
      : s.poppedOut.filter((id) => id !== terminalId),
  })),

  open: (input) => {
    const existing = get().floats;
    // De-dupe by terminalId — server returns a fresh id every time so this is
    // mostly defensive (e.g. double-click).
    if (existing.some((f) => f.terminalId === input.terminalId)) return;
    const next: FloatingSession = { ...input, createdAt: Date.now() };
    // Drop the oldest if we'd exceed the cap — and kill the evicted PTYs, else
    // the panel just unmounts and nothing would ever DELETE them (leak).
    if (existing.length >= MAX_FLOATS) {
      const cut = existing.length - MAX_FLOATS + 1;
      const dropped = existing.slice(0, cut);
      set({ floats: [...existing.slice(cut), next] });
      for (const f of dropped) {
        fetch(`/api/terminals/${encodeURIComponent(f.terminalId)}`, { method: 'DELETE' })
          .catch(() => { /* ignore */ });
      }
    } else {
      set({ floats: [...existing, next] });
    }
  },

  captureNow: async (terminalId) => {
    try {
      const resp = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/output`);
      if (resp.ok) {
        const data = await resp.json();
        if (typeof data.output === 'string' && data.output) {
          // Base64 → bytes → UTF-8. `atob` alone yields a Latin-1 binary
          // string, which mojibakes multibyte chars (e.g. `·` → `Â·`).
          const bytes = Uint8Array.from(atob(data.output), (c) => c.charCodeAt(0));
          const decoded = new TextDecoder().decode(bytes);
          await captureResponse(terminalId, decoded);
        }
      }
    } catch { /* ignore — log entry stays without a captured response */ }
  },

  close: (terminalId) => {
    set((state) => ({
      floats: state.floats.filter((f) => f.terminalId !== terminalId),
    }));
    // Snapshot the terminal output BEFORE killing it, then kill the pty.
    // Both calls are best-effort; failures don't block the UI.
    void (async () => {
      await get().captureNow(terminalId);
      try {
        await fetch(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: 'DELETE' });
      } catch { /* ignore */ }
    })();
  },

  closeAll: () => {
    const ids = get().floats.map((f) => f.terminalId);
    set({ floats: [] });
    for (const id of ids) {
      fetch(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .catch(() => { /* ignore */ });
    }
  },

  closeByOriginSession: (originSessionId) => {
    const targets = get().floats.filter((f) => f.originSessionId === originSessionId);
    // Reuse close() per terminal so each gets the same snapshot-then-kill path.
    for (const f of targets) get().close(f.terminalId);
  },

  migrateOriginSession: (oldSessionId, newSessionId) => {
    if (oldSessionId === newSessionId) return;
    set((state) => {
      if (!state.floats.some((f) => f.originSessionId === oldSessionId)) return state;
      return {
        floats: state.floats.map((f) =>
          f.originSessionId === oldSessionId
            ? { ...f, originSessionId: newSessionId }
            : f,
        ),
      };
    });
  },

  closeOrphans: (liveSessionIds) => {
    const orphanOrigins = new Set(
      get().floats
        .map((f) => f.originSessionId)
        .filter((id) => !liveSessionIds.has(id)),
    );
    for (const originId of orphanOrigins) get().closeByOriginSession(originId);
  },
}));
