/**
 * TerminalTextSheet — the terminal's recent text as plain, selectable lines, to
 * ask the AI about (AASC-57).
 *
 * A phone can't drag-select in xterm: a touch scrolls it, and holding a line
 * bookmarks it. So "Ask AI" on the Terminal shows what the terminal holds as text
 * the system's own handles can select; the surface is `data-ai-selectable`, and the
 * terminal's PhoneSelectionAi raises its Ask AI bar over this sheet. Each line is
 * its own `data-ai-context`, so the line a word came from goes with it.
 *
 * Opens at the bottom (the newest output), like the terminal itself.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { Button, Sheet } from '../kit';
import { SELECTABLE_ATTR } from '@/lib/aiSelectable';
import { usePhoneAiScopeOn, usePhoneAiStore } from '@/stores/phoneAiStore';
import styles from '@/styles/modules/mobile/PhoneTerminal.module.css';

const DETENTS = ['large'] as const;

export interface TerminalTextSheetProps {
  open: boolean;
  onClose: () => void;
  /** The terminal's recent text, oldest line first. */
  text: string;
  /** The terminal's AI scope (`terminal:<terminalId>`). */
  scopeId: string;
}

export default function TerminalTextSheet({ open, onClose, text, scopeId }: TerminalTextSheetProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const canAsk = usePhoneAiScopeOn(scopeId);
  const lines = useMemo(() => text.split('\n'), [text]);

  // The sheet's body is the scroller: bring the last line into view once it has laid out.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => {
      const last = scrollRef.current?.lastElementChild as HTMLElement | null | undefined;
      if (last && typeof last.scrollIntoView === 'function') last.scrollIntoView({ block: 'end' });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, text]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ask AI about the terminal"
      detents={DETENTS}
      testId="terminal-text-sheet"
      footer={canAsk ? (
        <Button onClick={() => usePhoneAiStore.getState().ask(scopeId, null)}>
          Translate the last answer…
        </Button>
      ) : undefined}
    >
      <p className={styles.textSheetHint}>Select the text to ask about, then tap Ask AI.</p>
      <div ref={scrollRef} className={styles.textSheetBody} {...{ [SELECTABLE_ATTR]: scopeId }} data-testid="terminal-text">
        {text.trim() === ''
          ? <p className={styles.textSheetHint}>The terminal has no text yet.</p>
          : lines.map((line, i) => (
            // Index keys: a static snapshot, re-read each time the sheet opens.
            <div key={i} className={styles.textSheetLine} data-ai-context="">{line || ' '}</div>
          ))}
      </div>
    </Sheet>
  );
}
