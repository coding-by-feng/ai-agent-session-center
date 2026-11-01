/**
 * useProjectSync — Project Sync's links, runs and saved servers for the Projects cards (Oct 31
 * 2026). Read when the tab shows, then every second while a compare or run is working; after a
 * failed read during one, every 4 s, so a single bad poll never freezes a running view.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SyncOverview, SyncRun } from '@/types/projectSync';
import { projectSyncApi } from '@/lib/projectSyncApi';

const POLL_ACTIVE_MS = 1000;
const POLL_RETRY_MS = 4000;

const working = (o: SyncOverview | null) =>
  o?.runs.some((r) => r.state === 'comparing' || r.state === 'running') ?? false;

export interface ProjectSync {
  /** Null until the first read lands (or when it failed). */
  overview: SyncOverview | null;
  error: string | null;
  /** Reads everything again, e.g. after a link, a server or a compare was added. */
  refresh: () => Promise<SyncOverview>;
  /** Puts a run a request answered with in place of the one the list holds. */
  replaceRun: (r: SyncRun) => void;
}

export function useProjectSync(enabled: boolean): ProjectSync {
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = working(overview);

  const refresh = useCallback(async () => {
    const o = await projectSyncApi.overview();
    setOverview(o);
    setError(null);
    return o;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      projectSyncApi.overview().then(
        (o) => {
          if (!alive) return;
          setOverview(o);
          setError(null);
          if (working(o)) timer = setTimeout(tick, POLL_ACTIVE_MS);
        },
        (e: unknown) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : 'Could not load project sync.');
          if (active) timer = setTimeout(tick, POLL_RETRY_MS);
        },
      );
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [enabled, active]);

  const replaceRun = useCallback(
    (r: SyncRun) =>
      setOverview((o) =>
        o
          ? {
              ...o,
              runs: o.runs.some((x) => x.id === r.id)
                ? o.runs.map((x) => (x.id === r.id ? r : x))
                : [r, ...o.runs],
            }
          : o,
      ),
    [],
  );

  return { overview, error, refresh, replaceRun };
}
