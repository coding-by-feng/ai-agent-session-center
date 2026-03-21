/**
 * OutputTab — plain-text capture of terminal output for post-compaction review.
 * Receives pre-processed lines from useOutputCapture (no ANSI codes).
 */
import { memo } from 'react';
import type { RefObject } from 'react';
import styles from '@/styles/modules/DetailPanel.module.css';

interface OutputTabProps {
  lines: string[];
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  isAutoScrolling: boolean;
  scrollToBottom: () => void;
  clearOutput: () => void;
}

export default memo(function OutputTab({
  lines,
  scrollContainerRef,
  isAutoScrolling,
  scrollToBottom,
  clearOutput,
}: OutputTabProps) {
  return (
    <div className={styles.outputTab}>
      <div className={styles.outputToolbar}>
        <span className={styles.outputLineCount}>{lines.length.toLocaleString()} lines captured</span>
        {!isAutoScrolling && (
          <button className={styles.outputScrollBtn} onClick={scrollToBottom} title="Scroll to bottom">
            ▼ BOTTOM
          </button>
        )}
        <button className={styles.outputClearBtn} onClick={clearOutput} title="Clear output">
          CLEAR
        </button>
      </div>
      <div ref={scrollContainerRef} className={styles.outputScroll}>
        {lines.length === 0 ? (
          <div className={styles.outputEmpty}>
            No output captured yet. Interact with the terminal to see output here.
          </div>
        ) : (
          <pre className={styles.outputPre}>{lines.join('\n')}</pre>
        )}
      </div>
    </div>
  );
});
