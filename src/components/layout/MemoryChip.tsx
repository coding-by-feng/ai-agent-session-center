/**
 * MemoryChip — "≈ 10.4 GB" in the header (Oct 28 2026, by request): what macOS charges AASC for,
 * which is mostly the agent CLIs running in its terminals, not AASC itself. Its tooltip splits the
 * total into AASC itself and the sessions, and counts the sleeping ones. Since Nov 17 2026 it is a
 * button: it opens "Sessions to close" (CloseSuggestionsModal), the idle and unused sessions worth
 * closing. Renders nothing until the first reading, and nothing on a device that may not read it,
 * so the list has no way in there either (its route is this-Mac-only too).
 */
import { lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { useSessionMemoryPoll } from '@/hooks/useSessionMemoryPoll';
import { useSessionMemoryStore } from '@/stores/sessionMemoryStore';
import { useUiStore, CLOSE_SUGGESTIONS_MODAL_ID } from '@/stores/uiStore';
import { formatMemory } from '@/lib/memoryFormat';
import styles from '@/styles/modules/MemoryChip.module.css';

// Loaded on the first click: the header is in every renderer's entry chunk.
const CloseSuggestionsModal = lazy(() => import('@/components/modals/CloseSuggestionsModal'));

export default function MemoryChip() {
  useSessionMemoryPoll();
  const sample = useSessionMemoryStore((s) => s.sample);
  const isOpen = useUiStore((s) => s.activeModal === CLOSE_SUGGESTIONS_MODAL_ID);
  const openModal = useUiStore((s) => s.openModal);
  if (!sample) return null;
  const sessionsBytes = Math.max(0, sample.totalBytes - sample.appBytes);
  const running = Object.keys(sample.bySession).length;
  const detail = [
    `Memory in use: ${formatMemory(sample.totalBytes)}`,
    `AASC itself: ${formatMemory(sample.appBytes)}`,
    `${running} running session${running === 1 ? '' : 's'}: ${formatMemory(sessionsBytes)}`,
    sample.asleep > 0 ? `${sample.asleep} asleep (no memory)` : '',
    'Click to list sessions to close',
    'Sleep idle sessions: Settings → ADVANCED',
  ].filter(Boolean).join('\n');
  return (
    <>
      <button
        type="button"
        className={styles.chip}
        aria-label={`Memory in use: ${formatMemory(sample.totalBytes)}. Show sessions to close`}
        aria-haspopup="dialog"
        title={detail}
        onClick={() => openModal(CLOSE_SUGGESTIONS_MODAL_ID)}
      >
        <span className={styles.value}>{formatMemory(sample.totalBytes)}</span>
        {sample.asleep > 0 && <span className={styles.asleep}>{`z ${sample.asleep}`}</span>}
      </button>
      {/* In <body>, not the header: the dialog's fixed overlay must not be laid out inside the header row. */}
      {isOpen && createPortal(
        <Suspense fallback={null}><CloseSuggestionsModal /></Suspense>,
        document.body,
      )}
    </>
  );
}
