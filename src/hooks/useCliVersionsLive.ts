/**
 * The agent CLI versions for a view that shows them (Settings ▸ ADVANCED ▸ Agent CLIs, the phone's
 * Settings → Advanced): read once when it opens, and again every `BUSY_POLL_MS` while an update
 * runs. `cli_update` broadcasts normally carry the result; the poll covers one lost to a reconnect,
 * which would otherwise leave the row on "Updating…".
 */
import { useEffect } from 'react';
import { useCliVersionsStore, selectBusyCli } from '@/stores/cliVersionsStore';
import type { AgentCli } from '@/types/cliVersions';

export const BUSY_POLL_MS = 10_000;

/** @returns the CLI whose update is running, or null */
export function useCliVersionsLive(): AgentCli | null {
  const load = useCliVersionsStore((s) => s.load);
  const busy = useCliVersionsStore(selectBusyCli);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), BUSY_POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  return busy;
}
