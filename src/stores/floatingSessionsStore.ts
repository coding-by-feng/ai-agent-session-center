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
}

export const useFloatingSessionsStore = create<FloatingSessionsState>((set, get) => ({
  floats: [],

  open: (input) => {
    const existing = get().floats;
    // De-dupe by terminalId — server returns a fresh id every time so this is
    // mostly defensive (e.g. double-click).
    if (existing.some((f) => f.terminalId === input.terminalId)) return;
    const next: FloatingSession = { ...input, createdAt: Date.now() };
    // Drop the oldest if we'd exceed the cap.
    const trimmed = existing.length >= MAX_FLOATS
      ? existing.slice(existing.length - MAX_FLOATS + 1)
      : existing;
    set({ floats: [...trimmed, next] });
  },

  close: (terminalId) => {
    set((state) => ({
      floats: state.floats.filter((f) => f.terminalId !== terminalId),
    }));
    // Snapshot the terminal output BEFORE killing it, then kill the pty.
    // Both calls are best-effort; failures don't block the UI.
    void (async () => {
      try {
        const resp = await fetch(`/api/terminals/${encodeURIComponent(terminalId)}/output`);
        if (resp.ok) {
          const data = await resp.json();
          if (typeof data.output === 'string' && data.output) {
            const decoded = atob(data.output);
            await captureResponse(terminalId, decoded);
          }
        }
      } catch { /* ignore — log entry stays without a captured response */ }
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
}));
