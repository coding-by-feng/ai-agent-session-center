/**
 * useSessionDisk — the disk reading of the session's folder for the disk chip (Nov 26 2026): read when the session
 * opens and every DISK_POLL_MS, or on `refresh()`. Null while unknown, on another device (the route is this Mac's),
 * and for a session on another SSH host.
 */
import { useCallback, useEffect, useState } from 'react';
import { parseDiskReply, type DiskReading } from '@/lib/diskUsage';

export const DISK_POLL_MS = 60_000;

async function readDisk(sessionId: string): Promise<DiskReading | null> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/disk`);
    if (!res.ok) return null;
    return parseDiskReply(await res.json());
  } catch {
    return null;
  }
}

export function useSessionDisk(sessionId: string | null): { disk: DiskReading | null; refresh: () => void } {
  const [state, setState] = useState<{ id: string | null; disk: DiskReading | null }>({ id: null, disk: null });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let live = true;
    const load = () => void readDisk(sessionId).then((disk) => { if (live) setState({ id: sessionId, disk }); });
    load();
    const timer = window.setInterval(load, DISK_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sessionId, tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  // A reading of the session shown before stays off screen until this one's arrives.
  return { disk: state.id === sessionId ? state.disk : null, refresh };
}
