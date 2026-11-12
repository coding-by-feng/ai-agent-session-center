/**
 * serverEditionStore — is the server this page talks to a headless `aasc-server` (no screen of its own)?
 *
 * Read once per page from GET /api/config (`headless`), which every device may read. The LIVE page's
 * "not shared" card uses it (Oct 29 2026): on a desktop host a session is shared from the host's own
 * panel, but a headless box has no panel, so the card names `aasc-server share-default on` instead.
 *
 * `headless` is null until a read answered; a failed read, or an older server without the field, leaves it
 * null and may be asked again. Unknown reads as a desktop host, which is what the card always said.
 */
import { useEffect } from 'react';
import { create } from 'zustand';

interface ServerEditionState {
  headless: boolean | null;
  load: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

async function readHeadless(): Promise<boolean | null> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    const value = ((await res.json()) as { headless?: unknown }).headless;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

export const useServerEditionStore = create<ServerEditionState>((set, get) => ({
  headless: null,
  load: () => {
    if (get().headless !== null) return Promise.resolve();
    inFlight ??= readHeadless()
      .then((headless) => set({ headless }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },
}));

/** Is the server headless? True only once it said so. */
export function useServerHeadless(): boolean {
  const headless = useServerEditionStore((s) => s.headless);
  const load = useServerEditionStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return headless === true;
}
