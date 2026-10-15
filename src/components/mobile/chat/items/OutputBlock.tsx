/**
 * OutputBlock — a tool's output, a command, a subagent's prompt (AASC-41): 12 lines,
 * then "Show all N lines". Monospace output scrolls sideways inside its own box;
 * `wrap` text (prompts, notices) wraps.
 */
import { useState } from 'react';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

const VISIBLE_LINES = 12;

export interface OutputBlockProps {
  text: string;
  wrap?: boolean;
  /** Words, not output: the body font (implies wrap). */
  prose?: boolean;
  /** Names the block for a screen reader ("Output of npm test"). */
  label?: string;
  lines?: number;
}

export default function OutputBlock({ text, wrap, prose, label, lines = VISIBLE_LINES }: OutputBlockProps) {
  const [all, setAll] = useState(false);
  const rows = text.replace(/\n+$/, '').split('\n');
  const long = rows.length > lines;
  const shown = all || !long ? rows.join('\n') : rows.slice(0, lines).join('\n');
  return (
    <>
      <pre className={`${styles.pre}${wrap || prose ? ` ${styles.preWrap}` : ''}${prose ? ` ${styles.prose}` : ''}`} aria-label={label}>
        {shown}
      </pre>
      {long && (
        <button type="button" className={`${styles.smallBtn} ${styles.plainBtn}`} onClick={() => setAll((v) => !v)} aria-expanded={all}>
          {all ? 'Show less' : `Show all ${rows.length} lines`}
        </button>
      )}
    </>
  );
}
