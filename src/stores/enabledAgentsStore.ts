/**
 * enabledAgentsStore — which agent CLIs the server has hooks enabled for (GET /api/config `enabledClis`).
 * The desktop launch menus show OpenCode / Antigravity only when enabled (cliLaunchers.ts `launchersFor`).
 * Read once per page; Settings → Hooks calls `refresh()` after an install changes the list. A failed read leaves
 * it null (Claude + Codex only, what the menus always showed) and may be asked again.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { launchersFor, type Launcher } from '@/components/layout/cliLaunchers';

interface EnabledAgentsState {
  enabledClis: readonly string[] | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

async function readEnabledClis(): Promise<readonly string[] | null> {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) return null;
    const value = ((await res.json()) as { enabledClis?: unknown }).enabledClis;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : null;
  } catch {
    return null;
  }
}

export const useEnabledAgentsStore = create<EnabledAgentsState>((set, get) => ({
  enabledClis: null,
  load: () => {
    if (get().enabledClis !== null) return Promise.resolve();
    return get().refresh();
  },
  refresh: () => {
    inFlight ??= readEnabledClis()
      .then((enabledClis) => set({ enabledClis }))
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  },
}));

/** The launch buttons this desktop shows: Claude, Codex, plus every enabled extra agent. */
export function useLaunchers(): readonly Launcher[] {
  const enabledClis = useEnabledAgentsStore((s) => s.enabledClis);
  const load = useEnabledAgentsStore((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  return launchersFor(enabledClis);
}
