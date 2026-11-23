/**
 * terminalFileLinks — the terminal's file-path link provider (moved out of useTerminal.ts Nov 23 2026, unchanged
 * apart from the two-line join). Clicking a path opens the FileOpenChooser (the caller's `open`).
 *
 * - One line: findFileRefs. `path/to/file.ext`, `./…`, `../…`, non-ASCII segments; an absolute path is made
 *   relative to the session folder, or rooted at its own folder outside it (linkTarget, Nov 17 2026). A folder, a
 *   bare name or a ~ path links only once the Mac says it exists (Nov 18 2026); xterm asks per hovered line, so the
 *   lookups are few.
 * - Two lines (Nov 23 2026, fileRefJoin.ts): a path Codex broke onto an indented line, or the terminal soft-wrapped,
 *   is joined with the line above or below and linked across both once the Mac says the whole path exists, so
 *   either half opens it. A half that also matched alone (a wrong file, a bare name) is dropped.
 *
 * Columns come from the buffer cells (mapLineColumns) so wide (CJK) characters stay aligned: match offsets are
 * UTF-16 offsets, not terminal columns.
 */
import type { IBufferLine, ILink, ILinkProvider } from '@xterm/xterm';
import { findFileRefs } from './fileRefs';
import { findJoinedRef } from './fileRefJoin';
import { resolveFileRef } from './fileRefResolve';
import { linkTarget, mapLineColumns, resolvedLinkTarget, type LinkTarget } from './filePathLink';

/** The part of a terminal the provider reads (an xterm Terminal, or @xterm/headless in tests). */
export interface LinkTerminal {
  buffer: { active: { getLine(y: number): IBufferLine | undefined } };
}

export interface FileLinkDeps {
  /** The session's folder: what relative paths are under. Empty: only certain one-line paths link. */
  projectPath: () => string;
  open: (target: LinkTarget, event: MouseEvent) => void;
}

const TOOLTIP = 'Click to choose how to open';

export function fileLinkProvider(term: LinkTerminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active;
      const here = bufferLineNumber - 1;
      const line = buffer.getLine(here);
      if (!line) { callback(undefined); return; }
      const { text, startCol, endCol } = mapLineColumns(line);
      const pp = deps.projectPath();
      const links: ILink[] = [];
      // Where on this line each one-line link sits (code-unit offsets), so a joined path can drop the halves it covers.
      const spans: Array<{ start: number; end: number }> = [];
      const addLink = (token: { start: number; end: number; text: string }, target: LinkTarget) => {
        spans.push({ start: token.start, end: token.end });
        links.push({
          range: {
            start: { x: startCol[token.start] + 1, y: bufferLineNumber }, // xterm columns are 1-indexed
            end: { x: endCol[token.end - 1] + 1, y: bufferLineNumber },   // inclusive, wide-char aware
          },
          text: token.text,
          activate: (event) => deps.open(target, event),
        });
      };
      const checks: Array<Promise<void>> = [];
      for (const token of findFileRefs(text)) {
        if (token.kind === 'file' && !token.text.startsWith('~')) {
          addLink(token, linkTarget(token.text.replace(/^\.\//, ''), pp));
          continue;
        }
        if (!pp) continue;
        checks.push(resolveFileRef(token.text, token.kind === 'bare' ? 'bare' : 'dir', { projectPath: pp }).then((found) => {
          if (found) addLink(token, resolvedLinkTarget(found, pp));
        }));
      }
      const covered: Array<{ start: number; end: number }> = [];
      const joined: ILink[] = [];
      if (pp) {
        const colsOf = (y: number) => (y === here ? { text, startCol, endCol } : mapLineColumns(buffer.getLine(y)!));
        for (const upperY of [here - 1, here]) {
          const lowerY = upperY + 1;
          if (upperY < 0 || !buffer.getLine(upperY) || !buffer.getLine(lowerY)) continue;
          const upper = colsOf(upperY);
          const lower = colsOf(lowerY);
          const ref = findJoinedRef(upper.text, lower.text);
          if (!ref) continue;
          checks.push(resolveFileRef(ref.text, 'dir', { projectPath: pp }).then((found) => {
            if (!found) return;
            covered.push(upperY === here ? { start: ref.upperStart, end: ref.upperEnd } : { start: ref.lowerStart, end: ref.lowerEnd });
            joined.push({
              range: {
                start: { x: upper.startCol[ref.upperStart] + 1, y: upperY + 1 },
                end: { x: lower.endCol[ref.lowerEnd - 1] + 1, y: lowerY + 1 },
              },
              text: ref.text,
                  activate: (event) => deps.open(resolvedLinkTarget(found, pp), event),
            });
          }));
        }
      }
      const finish = () => {
        const kept = links.filter((_, i) => !covered.some((c) => spans[i].start < c.end && spans[i].end > c.start));
        const all = [...kept, ...joined].map((l) => ({ ...l, tooltip: TOOLTIP }));
        callback(all.length > 0 ? all : undefined);
      };
      if (checks.length > 0) {
        void Promise.all(checks).then(finish);
        return;
      }
      finish();
    },
  };
}
