/**
 * MemoryChip — "≈ 10.4 GB" in the header (Oct 28 2026, by request): what macOS charges AASC for,
 * which is mostly the agent CLIs running in its terminals, not AASC itself. A readout, not a button;
 * its tooltip splits the total into AASC itself and the sessions, and counts the sleeping ones.
 * Renders nothing until the first reading, and nothing on a device that may not read it.
 */
import { useSessionMemoryPoll } from '@/hooks/useSessionMemoryPoll';
import { useSessionMemoryStore } from '@/stores/sessionMemoryStore';
import { formatMemory } from '@/lib/memoryFormat';
import styles from '@/styles/modules/MemoryChip.module.css';

export default function MemoryChip() {
  useSessionMemoryPoll();
  const sample = useSessionMemoryStore((s) => s.sample);
  if (!sample) return null;
  const sessionsBytes = Math.max(0, sample.totalBytes - sample.appBytes);
  const running = Object.keys(sample.bySession).length;
  const detail = [
    `Memory in use: ${formatMemory(sample.totalBytes)}`,
    `AASC itself: ${formatMemory(sample.appBytes)}`,
    `${running} running session${running === 1 ? '' : 's'}: ${formatMemory(sessionsBytes)}`,
    sample.asleep > 0 ? `${sample.asleep} asleep (no memory)` : '',
    'Sleep idle sessions: Settings → ADVANCED',
  ].filter(Boolean).join('\n');
  return (
    <span className={styles.chip} role="img" aria-label={detail.replace(/\n/g, '. ')} title={detail}>
      <span className={styles.value}>{formatMemory(sample.totalBytes)}</span>
      {sample.asleep > 0 && <span className={styles.asleep}>{`z ${sample.asleep}`}</span>}
    </span>
  );
}
