/**
 * useResourceUsage — the Library's skill and command use counts (Oct 23 2026).
 *
 * Read once a scan has landed (the counts are keyed by that scan's ids), again after every
 * scan, and when the window comes back into focus — you have probably been typing skills
 * elsewhere. The server keeps a count for a minute, so a refocus is cheap.
 *
 * The counts are extra: when the read fails the Library shows no count, never an error, and
 * a count already shown stays until a read succeeds.
 */
import { useEffect, useMemo, useState } from 'react';
import type { ResourceUsage, ResourceUsageReport } from '@/types/resources';
import { fetchResourceUsage } from '@/lib/resourcesApi';

export interface LibraryUsage {
  windowDays: number;
  byId: ReadonlyMap<string, ResourceUsage>;
}

export function useResourceUsage(scannedAt: number | null): LibraryUsage | null {
  const [report, setReport] = useState<ResourceUsageReport | null>(null);

  useEffect(() => {
    if (scannedAt === null) return;
    let controller = new AbortController();
    const read = () => {
      controller.abort();
      controller = new AbortController();
      fetchResourceUsage(controller.signal).then(setReport, () => {
        // Nothing to show: the last counts (or none) stay, and the next scan or focus asks again.
      });
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      window.removeEventListener('focus', read);
      controller.abort();
    };
  }, [scannedAt]);

  return useMemo(
    () => (report ? { windowDays: report.windowDays, byId: new Map(Object.entries(report.byId)) } : null),
    [report],
  );
}
