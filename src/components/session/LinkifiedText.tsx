/**
 * LinkifiedText — renders plain text with clickable file paths.
 * Paths are found by `findFileRefs` (fileRefs.ts); clicking one opens the FileOpenChooser
 * popover (open in app / default app / reveal in Finder).
 *
 * Three kinds (Nov 18 2026): a path with a folder and an extension links at once, as before;
 * a folder (`/Users/me/proj/docs`) and a bare name (`plan.md`) link once the Mac has said
 * the path exists (`useFileRef`), and stay plain text otherwise.
 *
 * With `highlight` set, occurrences of that query are additionally wrapped in
 * <mark>. Marking happens INSIDE each part, after path splitting, so a query
 * that lands on a file path highlights the path without breaking its link.
 */
import { Fragment, useMemo, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useUiStore } from '@/stores/uiStore';
import { linkTarget, resolvedLinkTarget, type LinkTarget } from '@/lib/filePathLink';
import { findFileRefs, messageFolders } from '@/lib/fileRefs';
import { useFileRef } from '@/hooks/useFileRef';
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

const LINK_STYLE = {
  color: 'var(--accent-cyan, #00d4ff)',
  textDecoration: 'underline',
  textDecorationColor: 'rgba(0, 212, 255, 0.4)',
  cursor: 'pointer',
} as const;

function openChooser(target: LinkTarget, anchor: { x: number; y: number }): void {
  useUiStore.getState().openFileChooser(target.filePath, target.projectPath, anchor, target.hostProjectPath, target.kind);
}

/** The clickable span: a click or Enter opens the chooser on `target()`. */
function PathLink({ label, target, children }: { label: string; target: () => LinkTarget; children: ReactNode }) {
  return (
    <span
      role="button"
      tabIndex={0}
      style={LINK_STYLE}
      title={`Choose how to open ${label}`}
      onClick={(e: MouseEvent) => {
        e.stopPropagation();
        openChooser(target(), { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e: KeyboardEvent<HTMLSpanElement>) => {
        if (e.key !== 'Enter') return;
        // No cursor position on keyboard activation — anchor to the link element.
        const rect = e.currentTarget.getBoundingClientRect();
        openChooser(target(), { x: rect.left, y: rect.bottom });
      }}
    >
      {children}
    </span>
  );
}

/** A folder or bare name: plain text until the Mac confirms it, then a link. */
function CheckedPathLink({ value, kind, projectPath, folders, children }: {
  value: string;
  kind: 'dir' | 'bare';
  projectPath: string;
  folders: readonly string[];
  children: ReactNode;
}) {
  const found = useFileRef(value, kind, projectPath, folders);
  if (!found) return <span>{children}</span>;
  return <PathLink label={value} target={() => resolvedLinkTarget(found, projectPath)}>{children}</PathLink>;
}

export default function LinkifiedText({ text, projectPath, highlight }: LinkifiedTextProps) {
  const query = useMemo(() => normalizeQuery(highlight), [highlight]);
  const parts = useMemo(() => {
    if (!text || !projectPath) return null;
    const tokens = findFileRefs(text);
    if (tokens.length === 0) return null;
    const result: Array<{ type: 'text' | 'file' | 'dir' | 'bare'; value: string }> = [];
    let lastIndex = 0;
    for (const token of tokens) {
      if (token.start > lastIndex) result.push({ type: 'text', value: text.slice(lastIndex, token.start) });
      result.push({ type: token.kind, value: token.text });
      lastIndex = token.end;
    }
    if (lastIndex < text.length) result.push({ type: 'text', value: text.slice(lastIndex) });
    return result;
  }, [text, projectPath]);
  // Where a bare name is looked for first: the folders this same text names.
  const folders = useMemo(() => (parts?.some((p) => p.type === 'bare') ? messageFolders(text) : []), [parts, text]);

  if (!parts || !projectPath) return <Marked value={text} query={query} />;

  return (
    <>
      {parts.map((part, i) => {
        const marked = <Marked value={part.value} query={query} />;
        // "~/notes/x.md": only the Mac knows where ~ is, so it is checked like a folder.
        if (part.type === 'file' && !part.value.startsWith('~')) {
          return <PathLink key={i} label={part.value} target={() => linkTarget(part.value, projectPath)}>{marked}</PathLink>;
        }
        if (part.type !== 'text') {
          return <CheckedPathLink key={i} value={part.value} kind={part.type === 'bare' ? 'bare' : 'dir'} projectPath={projectPath} folders={folders}>{marked}</CheckedPathLink>;
        }
        return <span key={i}>{marked}</span>;
      })}
    </>
  );
}
