/**
 * alertConfigStore — the alert level table (src/lib/attention.ts, Nov 25 2026) as this window knows it: read from the
 * server (`GET /api/alert-levels`, server/alertConfig.ts) when the app starts and whenever the window gains focus, and
 * saved there from Settings ▸ Sound ▸ Alert levels. The server's copy is the one that counts (it decides phone
 * pushes); until the first read, and wherever the route is not reachable (a paired phone), this is the defaults.
 */
import { create } from 'zustand';
import { authFetch } from '@/hooks/useAuth';
import { DEFAULT_ALERT_CONFIG, parseAlertConfig, type AlertConfig } from '@/lib/attention';

interface AlertConfigState {
  config: AlertConfig;
  /** Read from the server at least once. */
  loaded: boolean;
  /** Read the table from the server. A failed read keeps what this window has. */
  load: () => Promise<void>;
  /** Save a whole table. Shown at once; put back when the server refuses it. True when it was saved. */
  save: (next: AlertConfig) => Promise<boolean>;
}

const ROUTE = '/api/alert-levels';

async function readConfig(res: Response): Promise<AlertConfig | null> {
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { ok?: unknown; config?: unknown } | null;
  return body?.ok === true ? parseAlertConfig(body.config) : null;
}

export const useAlertConfigStore = create<AlertConfigState>((set, get) => ({
  config: DEFAULT_ALERT_CONFIG,
  loaded: false,

  load: async () => {
    try {
      const config = await readConfig(await authFetch(ROUTE));
      if (config) set({ config, loaded: true });
    } catch {
      // Offline or refused: the table this window has stays in use.
    }
  },

  save: async (next) => {
    const before = get().config;
    set({ config: next });
    try {
      const res = await authFetch(ROUTE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const saved = await readConfig(res);
      if (saved) {
        set({ config: saved, loaded: true });
        return true;
      }
    } catch {
      // Fall through: put the table back.
    }
    if (get().config === next) set({ config: before });
    return false;
  },
}));
