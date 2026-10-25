/**
 * ChatTable — a Markdown table in the phone chat (Oct 22 2026). The chat's prose
 * breaks anywhere, and a table's cells inherited it, so a four-column table was
 * squeezed into the screen one letter ("S t y l e") or one Chinese character per
 * line, and its sideways scroller had nothing to scroll.
 *
 * Now each cell keeps whole words and is capped (`.cell`: browsers ignore
 * max-width on a <td>, so the cap is on a box inside it): short cells stay on one
 * line, long prose wraps at the cap, and a wide table is wider than the screen and
 * scrolls sideways in its own card. Edge shades say there is more to either side;
 * with three columns or more the first one (the row labels) stays put. A table
 * that scrolls is a named region in the Tab order, so a keyboard can scroll it.
 */
import { useCallback, useEffect, useState, type TableHTMLAttributes, type TdHTMLAttributes, type ThHTMLAttributes } from 'react';
import styles from '@/styles/modules/mobile/ChatMarkdown.module.css';

interface Edges {
  /** Content hidden to the left / right. */
  start: boolean;
  end: boolean;
}

const NONE: Edges = { start: false, end: false };

/** Which sides of a sideways scroller hide content; follows scrolling and resizing. */
function useScrollEdges(): [Edges, (el: HTMLDivElement | null) => void] {
  const [edges, setEdges] = useState<Edges>(NONE);
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const measure = useCallback((node: HTMLDivElement) => {
    const max = node.scrollWidth - node.clientWidth;
    const next = { start: node.scrollLeft > 1, end: node.scrollLeft < max - 1 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);
  useEffect(() => {
    if (!el) return undefined;
    // First reading on the next frame, once the table has its width.
    const frame = requestAnimationFrame(() => measure(el));
    const onScroll = () => measure(el);
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure(el));
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [el, measure]);
  return [edges, setEl];
}

export function ChatTable({ children }: TableHTMLAttributes<HTMLTableElement>) {
  const [edges, attach] = useScrollEdges();
  const scrolls = edges.start || edges.end;
  return (
    <div className={styles.tableCard} data-more-start={edges.start ? '' : undefined} data-more-end={edges.end ? '' : undefined}>
      <div
        ref={attach}
        className={styles.tableWrap}
        // Only a table that scrolls is a stop in the Tab order (arrow keys scroll it).
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? 'region' : undefined}
        aria-label={scrolls ? 'Table, scrolls sideways' : undefined}
      >
        <table>{children}</table>
      </div>
    </div>
  );
}

// A column's alignment (`| :-: |`) arrives as `style.textAlign`; nothing else of the props is kept.
export function ChatTh({ children, style }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th style={style}><div className={styles.cell}>{children}</div></th>;
}

export function ChatTd({ children, style }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td style={style}><div className={styles.cell}>{children}</div></td>;
}

