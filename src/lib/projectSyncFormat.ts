/** Pure labels and formatting for the PROJECTS sub-tab (kept out of component files for Fast Refresh). */
import type { SyncChange, SyncRun } from '@/types/projectSync';

export const CHANGE_LABEL: Record<SyncChange, string> = {
  same: 'same',
  add: 'add',
  change: 'change',
  delete: 'delete',
  drift: 'changed on device',
  conflict: 'changed on both',
  extra: 'only on device',
  different: 'different',
  blocked: 'not copyable',
};
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
export const runSummary = (r: SyncRun) =>
  (Object.entries(r.counts) as [SyncChange, number][])
    .filter(([c, n]) => c !== 'same' && n > 0)
    .map(([c, n]) => `${n} ${CHANGE_LABEL[c]}`)
    .join(' · ') || 'Nothing to change';

/** `~/Documents/x` on this machine → `<device home>/Documents/x` on the device. */
export function suggestRemoteRoot(localPath: string, deviceHome: string): string {
  return localPath.startsWith('~/') ? `${deviceHome}/${localPath.slice(2)}` : '';
}
