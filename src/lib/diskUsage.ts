/**
 * diskUsage.ts — how the session panel's disk chip reads a disk (Nov 26 2026). Pure. The reading comes from
 * GET /api/sessions/:id/disk (server/diskUsage.ts). Builds and installs start failing with a few GB left, and the
 * failures look like build errors, so the chip turns amber well before that and red near it.
 */

const GB = 1024 ** 3;

/** Red: under 5 GB, or under 5% of the disk free. */
export const DISK_CRITICAL_BYTES = 5 * GB;
export const DISK_CRITICAL_RATIO = 0.05;
/** Amber: under 20 GB, or under 10% free. */
export const DISK_LOW_BYTES = 20 * GB;
export const DISK_LOW_RATIO = 0.1;

export type DiskTone = 'ok' | 'low' | 'critical';

export interface DiskReading {
  freeBytes: number;
  totalBytes: number;
  path: string;
}

export function diskTone(freeBytes: number, totalBytes: number): DiskTone {
  const ratio = totalBytes > 0 ? freeBytes / totalBytes : 1;
  if (freeBytes < DISK_CRITICAL_BYTES || ratio < DISK_CRITICAL_RATIO) return 'critical';
  if (freeBytes < DISK_LOW_BYTES || ratio < DISK_LOW_RATIO) return 'low';
  return 'ok';
}

/** "3.8 GB", "182 GB", "1.2 TB", "640 MB": two significant figures under 10, whole numbers above. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = value < 10 && unit > 0 ? value.toFixed(1).replace(/\.0$/, '') : String(Math.round(value));
  return `${text} ${units[unit]}`;
}

/** Percent of the disk in use, whole (99% rather than 99.2%). */
export function usedPercent(freeBytes: number, totalBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
}

/** Parses the route's reply; null for anything else (a 404, another device, a missing session). */
export function parseDiskReply(body: unknown): DiskReading | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== true) return null;
  const { freeBytes, totalBytes, path } = b;
  if (typeof freeBytes !== 'number' || typeof totalBytes !== 'number' || typeof path !== 'string') return null;
  if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return { freeBytes, totalBytes, path };
}
