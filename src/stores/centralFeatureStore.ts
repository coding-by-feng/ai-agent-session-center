/**
 * centralFeatureStore — is the central-session feature (server/mcp) on in the server's current run?
 *
 * Read once per page from GET /api/config (`centralSessions`), which every device may read, the phone too:
 * `mcpStore.available` answers the same question on this Mac only. While it is off (Oct 28 2026, by request)
 * nothing central is shown: no CENTRAL frame on the rail or in the phone's list, no ★ on a card. A card keeps
 * its `central` marker, so it comes back as a central when the feature is turned on again.
 *
 * `on` is null until a read answered; a failed read, or a server that does not send the field, leaves it null
 * and may be asked again. Unknown shows what it always showed: only an explicit `false` hides anything.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

interface CentralFeatureState {
  on: boolean | null;
  load: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

async function readCentralSessions(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    const value = ((await res.json()) as { centralSessions?: unknown }).centralSessions;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

export const useCentralFeatureStore = create<CentralFeatureState>((set, get) => ({
  on: null,
  load: () => {
    if (get().on !== null) return Promise.resolve();
    inFlight ??= readCentralSessions()
      .then((on) => set({ on }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },
}));

/** Show central things (frame, group, ★)? False only once the server said the feature is off. */
export function useCentralSessionsShown(): boolean {
  const on = useCentralFeatureStore((s) => s.on);
  const load = useCentralFeatureStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return on !== false;
}

/** @internal — test only: forget the answer and any read in flight. */
export function __resetCentralFeatureForTest(): void {
  inFlight = null;
  useCentralFeatureStore.setState({ on: null });
}
