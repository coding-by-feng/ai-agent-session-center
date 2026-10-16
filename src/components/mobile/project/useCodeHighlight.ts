/**
 * useCodeHighlight — a file's lines in colour for the phone's code view
 * (AASC-56). highlight.js (its common languages) loads on first use, in a chunk
 * of its own: never in the entry chunk, never for a file it has no language for.
 * Until it is ready (or for a file too big to colour on a phone) the caller shows
 * the plain lines, so the text is never late.
 */
import { useEffect, useState } from 'react';
import { highlightedLines, languageForFile, type CodeLine } from '@/lib/codeLines';

/** Larger files stay plain: colouring them would stall a phone for seconds. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

type Hljs = typeof import('highlight.js/lib/common').default;
let loading: Promise<Hljs> | null = null;

function loadHljs(): Promise<Hljs> {
  loading ??= import('highlight.js/lib/common').then((m) => m.default);
  return loading;
}

/** `content` coloured as `fileName`'s language, or null while loading / when it gets none. */
export function useCodeHighlight(content: string, fileName: string, enabled: boolean): CodeLine[] | null {
  const key = `${fileName}\n${content.length}\n${content}`;
  const [done, setDone] = useState<{ key: string; lines: CodeLine[] | null } | null>(null);
  const wanted = enabled && content.length > 0 && content.length <= MAX_HIGHLIGHT_CHARS;

  useEffect(() => {
    if (!wanted) return;
    let live = true;
    loadHljs().then(
      (hljs) => {
        if (!live) return;
        const lang = languageForFile(fileName, (name) => !!hljs.getLanguage(name));
        let lines: CodeLine[] | null = null;
        if (lang) {
          try {
            lines = highlightedLines(hljs.highlight(content, { language: lang, ignoreIllegals: true }).value);
          } catch {
            lines = null; // a grammar that throws: plain text it is
          }
        }
        setDone({ key, lines });
      },
      () => { /* the chunk failed to load (offline): stay plain */ },
    );
    return () => {
      live = false;
    };
  }, [wanted, key, content, fileName]);

  return wanted && done?.key === key ? done.lines : null;
}
