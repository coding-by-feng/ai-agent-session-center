/**
 * memoryFormat — bytes as the memory chip and the LIVE cards show them (Oct 28 2026):
 * "≈ 312 MB" below a gigabyte, "≈ 10.4 GB" above. Resident size, so always "≈".
 */
const MB = 1024 * 1024;
const GB = 1024 * MB;

export function formatMemory(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '≈ 0 MB';
  if (bytes >= GB) return `≈ ${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  return `≈ ${Math.max(1, Math.round(bytes / MB))} MB`;
}
