/**
 * LinkifiedText — renders plain text with clickable file paths.
 * File paths are detected via regex; clicking opens the FileOpenChooser
 * popover (open in app / default app / reveal in Finder).
 *
 * With `highlight` set, occurrences of that query are additionally wrapped in
 * <mark>. Marking happens INSIDE each part, after path splitting, so a query
 * that lands on a file path highlights the path without breaking its link.
 */
import { Fragment, useMemo } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { createFilePathRegex } from '@/lib/filePathLink';
import { normalizeQuery, splitHighlight } from '@/lib/textHighlight';

interface LinkifiedTextProps {
  text: string;
  projectPath?: string;
  /** Raw search query; matches are wrapped in <mark>. Normalized internally. */
  highlight?: string;
}

/**
 * Render one run of text, wrapping query matches in <mark>.
 *
 * Exported for the rows that deliberately do NOT linkify (tool inputs, tool
 * results, command chips, events) — they still need identical highlighting, and
 * routing them through LinkifiedText just to reach this would silently start
 * turning their contents into clickable paths.
 *
 * `query` must be pre-normalized (see `normalizeQuery`).
 */
export function MarkedText({ value, query }: { value: string; query: string }) {
  return <Marked value={value} query={query} />;
}

function Marked({ value, query }: { value: string; query: string }) {
  if (!query) return <>{value}</>;
  return (
    <>
      {splitHighlight(value, query).map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <Fragment key={i}>{seg.text}</Fragment>,
      )}
    </>
  );
}

export default function LinkifiedText({ text, projectPath, highlight }: LinkifiedTextProps) {
  const query = useMemo(() => normalizeQuery(highlight), [highlight]);
  const parts = useMemo(() => {
    if (!text || !projectPath) return null;
    const result: Array<{ type: 'text' | 'path'; value: string }> = [];
    let lastIndex = 0;
    // Matches path/to/file.ext, ./… and ../… including non-ASCII segments.
    const filePathRe = createFilePathRegex();
    let match: RegExpExecArray | null;
    while ((match = filePathRe.exec(text)) !== null) {
      if (match.index > lastIndex) {
        result.push({ type: 'text', value: text.slice(lastIndex, match.index) });
      }
      result.push({ type: 'path', value: match[0] });
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      result.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return result.length > 0 && result.some((p) => p.type === 'path') ? result : null;
  }, [text, projectPath]);

  if (!parts) return <Marked value={text} query={query} />;

  return (
    <>
      {parts.map((part, i) =>
        part.type === 'path' ? (
          <span
            key={i}
            role="button"
            tabIndex={0}
            style={{
              color: 'var(--accent-cyan, #00d4ff)',
              textDecoration: 'underline',
              textDecorationColor: 'rgba(0, 212, 255, 0.4)',
              cursor: 'pointer',
            }}
            title={`Choose how to open ${part.value}`}
            onClick={(e) => {
              e.stopPropagation();
              const clean = part.value.replace(/^\.\//, '');
              useUiStore.getState().openFileChooser(clean, projectPath || '', { x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const clean = part.value.replace(/^\.\//, '');
                // No cursor position on keyboard activation — anchor to the link element.
                const rect = e.currentTarget.getBoundingClientRect();
                useUiStore.getState().openFileChooser(clean, projectPath || '', { x: rect.left, y: rect.bottom });
              }
            }}
          >
            <Marked value={part.value} query={query} />
          </span>
        ) : (
          <span key={i}>
            <Marked value={part.value} query={query} />
          </span>
        ),
      )}
    </>
  );
}
