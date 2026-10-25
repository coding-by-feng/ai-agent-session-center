/**
 * cliVersionsStore — the Mac's agent CLI versions and their updates (Oct 25 2026), for Settings ▸
 * ADVANCED ▸ Agent CLIs and the phone's Settings → Advanced. A view loads it when it opens;
 * `cli_update` broadcasts keep it current while an update runs, on every device.
 */
import { create } from 'zustand';
import { fetchCliVersions, startCliUpdate } from '@/lib/cliVersionsApi';
import type { AgentCli, CliVersionInfo } from '@/types/cliVersions';

interface CliVersionsState {
  items: CliVersionInfo[] | null;
  loading: boolean;
  error: string | null;
  /** Read the versions; `refresh` asks npm again instead of the Mac's hour-long cache. */
  load: (refresh?: boolean) => Promise<void>;
  /** Start one CLI's update. Resolves to the reason it was refused, or null. */
  update: (cli: AgentCli) => Promise<string | null>;
  /** A `cli_update` broadcast: replace that CLI's info. */
  receive: (info: CliVersionInfo) => void;
}

const withInfo = (items: CliVersionInfo[] | null, info: CliVersionInfo): CliVersionInfo[] => {
  const list = items ?? [];
  return list.some((i) => i.cli === info.cli) ? list.map((i) => (i.cli === info.cli ? info : i)) : [...list, info];
};

export const useCliVersionsStore = create<CliVersionsState>((set, get) => ({
  items: null,
  loading: false,
  error: null,

  load: async (refresh = false) => {
    if (get().loading) return;
    set({ loading: true, error: null });
    try {
      set({ items: await fetchCliVersions(refresh), loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  update: async (cli) => {
    const before = get().items;
    try {
      await startCliUpdate(cli);
      // Show it at once, unless a broadcast already came in while the request ran: a fast failure's
      // `updating` and `failed` can beat the HTTP answer, and must not be painted over.
      if (get().items !== before) return null;
      const current = before?.find((i) => i.cli === cli);
      if (current && current.update.state !== 'updating') {
        get().receive({ ...current, update: { state: 'updating', from: current.installed, at: Date.now(), startedAt: Date.now(), log: [] } });
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  },

  receive: (info) => set((s) => ({ items: withInfo(s.items, info) })),
}));

/** The CLI whose update is running, or null. */
export const selectBusyCli = (s: Pick<CliVersionsState, 'items'>): AgentCli | null =>
  s.items?.find((i) => i.update.state === 'updating')?.cli ?? null;
