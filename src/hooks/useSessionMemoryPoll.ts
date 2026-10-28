/**
 * useSessionMemoryPoll — read `GET /api/session-memory` now and every POLL_MS while the window is
 * visible (Oct 28 2026). The server samples with one async `ps` and caches it for 10 s, so this costs
 * nothing while nobody looks. A 404 (not this Mac) stops polling for good.
 */
import { useEffect } from 'react';
import { authFetch } from '@/hooks/useAuth';
import { useSessionMemoryStore, type SessionMemorySample } from '@/stores/sessionMemoryStore';

export const POLL_MS = 30_000;

export function useSessionMemoryPoll(): void {
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const setSample = useSessionMemoryStore.getState().setSample;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        try {
          const res = await authFetch('/api/session-memory');
          if (res.status === 404) { stopped = true; return; }
          if (res.ok) setSample((await res.json()) as SessionMemorySample);
        } catch {
          // A missed reading keeps the last one; the next tick tries again.
        }
      }
      if (!stopped) timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);
}
