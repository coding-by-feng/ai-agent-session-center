/**
 * DiskChip — the room left on the disk this session works on (Nov 26 2026), in the session panel's top-left usage
 * line beside the plan chip: a disk mark and the free space. Amber when it runs low, red near full (thresholds:
 * src/lib/diskUsage.ts); the tone is also said in words in the tooltip and the label, never colour alone. Hovering or
 * focusing it shows free, total, % used and the folder; a click reads it again. Nothing renders on another device
 * or for a session on another SSH host (the route answers 404 there). Full only.
 */
import Tooltip from '@/components/ui/Tooltip';
import { useSessionDisk } from '@/hooks/useSessionDisk';
import { diskTone, formatBytes, usedPercent, type DiskTone } from '@/lib/diskUsage';
import styles from '@/styles/modules/DiskChip.module.css';

const TONE_WORD: Record<DiskTone, string> = { ok: '', low: 'Running low. ', critical: 'Almost full. ' };

function DiskIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M2 9.5h12" />
      <circle cx="11.5" cy="11.2" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function DiskChip({ sessionId }: { sessionId: string }) {
  const { disk, refresh } = useSessionDisk(sessionId);
  if (!disk) return null;
  const tone = diskTone(disk.freeBytes, disk.totalBytes);
  const free = formatBytes(disk.freeBytes);
  const total = formatBytes(disk.totalBytes);
  const used = usedPercent(disk.freeBytes, disk.totalBytes);
  const summary = `${free} free of ${total} · ${used}% used`;
  return (
    <Tooltip
      label="Disk"
      description={`${TONE_WORD[tone]}${summary}. Click to read it again.`}
      content={<span className={styles.path}>{disk.path}</span>}
      placement="bottom"
    >
      <button
        type="button"
        className={styles.chip}
        data-tone={tone}
        data-testid="disk-chip"
        onClick={refresh}
        aria-label={`Disk: ${TONE_WORD[tone]}${summary}. Read it again.`}
      >
        <DiskIcon />
        <span className={styles.value}>{free}</span>
      </button>
    </Tooltip>
  );
}
