/**
 * SourceLines — a text or code file as numbered lines (AASC-20), coloured by
 * highlight.js where it has the language (AASC-56), with find in the file laid
 * over the colours. At most PHONE_LINE_WINDOW lines are on the page; "Show
 * earlier / later lines" moves the window, and so does stepping to a find hit
 * outside it.
 *
 * Opened from a text search at a line: that line is marked and centred, the
 * searched text marked on it.
 */
import { useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { lineWindow } from '@/lib/phoneProject';
import { normalizeQuery, splitHighlight } from '@/lib/textHighlight';
import { markPieces, plainLines, type CodeLine, type LineMatch, type MarkRange } from '@/lib/codeLines';
import { scrollIntoContainer } from '@/lib/scrollWithinContainer';
import { useCodeHighlight } from './useCodeHighlight';
import styles from '@/styles/modules/PhoneProject.module.css';

export interface SourceFind {
  matches: readonly LineMatch[];
  /** Index into `matches` of the current hit, -1 for none. */
  index: number;
}

export interface SourceLinesProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  content: string;
  fileName: string;
  wrap: boolean;
  /** 1-based line to open at (a text-search hit), or null. */
  line: number | null;
  /** The searched text, marked on that line. */
  query: string;
  find: SourceFind | null;
}

/** The ranges to mark on line `n`: find hits, else the search query on the target line. */
function rangesFor(n: number, find: SourceFind | null, byLine: Map<number, LineMatch[]>, target: number | null, query: string, text: string): MarkRange[] {
  if (find && find.matches.length > 0) {
    const current = find.matches[find.index];
    return (byLine.get(n) ?? []).map((m) => ({ start: m.start, end: m.end, current: m === current }));
  }
  if (n !== target || !query) return [];
  const ranges: MarkRange[] = [];
  let col = 0;
  for (const seg of splitHighlight(text, normalizeQuery(query))) {
    if (seg.match) ranges.push({ start: col, end: col + seg.text.length, current: false });
    col += seg.text.length;
  }
  return ranges;
}

function Pieces({ pieces }: { pieces: CodeLine }) {
  if (pieces.length === 0) return <>{' '}</>;
  return (
    <>
      {pieces.map((p, i) => {
        if (p.mark) {
          const cls = `${styles.mark}${p.mark === 'current' ? ` ${styles.markCurrent}` : ''}${p.cls ? ` ${p.cls}` : ''}`;
          return <mark key={i} className={cls} data-find-current={p.mark === 'current' ? '' : undefined}>{p.text}</mark>;
        }
        return p.cls ? <span key={i} className={p.cls}>{p.text}</span> : <span key={i}>{p.text}</span>;
      })}
    </>
  );
}

export default function SourceLines({ scrollRef, content, fileName, wrap, line, query, find }: SourceLinesProps) {
  const texts = useMemo(() => content.split('\n'), [content]);
  const plain = useMemo(() => plainLines(content), [content]);
  const coloured = useCodeHighlight(content, fileName, true);
  const lines = coloured && coloured.length === texts.length ? coloured : plain;
  const byLine = useMemo(() => {
    const map = new Map<number, LineMatch[]>();
    for (const m of find?.matches ?? []) map.set(m.line, [...(map.get(m.line) ?? []), m]);
    return map;
  }, [find?.matches]);

  const currentLine = find && find.index >= 0 ? find.matches[find.index]?.line ?? null : null;
  const [anchor, setAnchor] = useState(line);
  // A find hit outside the window brings the window to it (state adjusted while rendering).
  const shown = lineWindow(texts.length, anchor);
  if (currentLine && (currentLine <= shown.start || currentLine > shown.end) && anchor !== currentLine) {
    setAnchor(currentLine);
  }
  const { start, end } = lineWindow(texts.length, anchor);

  // Open at the search hit: centred, once the lines are on screen.
  useLayoutEffect(() => {
    if (!line) return;
    const scroller = scrollRef.current;
    scrollIntoContainer(scroller, scroller?.querySelector(`[data-line="${line}"]`), { block: 'center', behavior: 'auto' });
  }, [line, scrollRef]);

  // Step to the current find hit.
  useLayoutEffect(() => {
    if (!currentLine) return;
    const scroller = scrollRef.current;
    scrollIntoContainer(scroller, scroller?.querySelector(`[data-line="${currentLine}"]`), { block: 'center', behavior: 'auto' });
  }, [currentLine, find?.index, scrollRef]);

  return (
    <div ref={scrollRef} className={`${styles.scroll} ${styles.code}${wrap ? ` ${styles.codeWrap}` : ''}`} data-phone-scroll="">
      {start > 0 && (
        <button type="button" className={styles.moreLines} onClick={() => setAnchor(Math.max(1, start + 1 - Math.floor((end - start) / 2)))}>
          Show earlier lines (1–{start})
        </button>
      )}
      {texts.slice(start, end).map((text, i) => {
        const n = start + i + 1;
        const ranges = rangesFor(n, find, byLine, line, query, text);
        return (
          <div key={n} className={`${styles.codeLine}${n === line ? ` ${styles.codeLineTarget}` : ''}`} data-line={n}>
            <span className={styles.lineNum} aria-hidden="true">{n}</span>
            <span className={styles.lineText}><Pieces pieces={markPieces(lines[n - 1] ?? [], ranges)} /></span>
          </div>
        );
      })}
      {end < texts.length && (
        <button type="button" className={styles.moreLines} onClick={() => setAnchor(end + 1)}>
          Show later lines ({end + 1}–{texts.length})
        </button>
      )}
    </div>
  );
}
