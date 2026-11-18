/**
 * FileLink — a file or folder named in the chat, as a tap that opens it in the Project
 * tab (`fileLinkContext`). Anything that is not one renders as `fallback`, unchanged. A link
 * (it navigates to the file's view), so it flows with the sentence round it as text does (a
 * <button> is one unbreakable box), is reachable by keyboard, and says what it does. The href
 * never loads.
 *
 * Three kinds (Nov 18 2026, `fileRefs.ts`):
 *   docs/plan.md            a path with a folder and an extension: a link at once
 *   /Users/me/proj/docs     a folder: a link once the Mac says it exists
 *   plan.md                 a bare name: a link once it is found (a folder the message
 *                           named, the project root, or the only file of that name)
 * Until the Mac answers, and when it says no, the text stays as it was written.
 */
import { useContext, type MouseEvent, type ReactNode } from 'react';
import { chatFileLink } from '@/lib/chat/fileLinks';
import { classifyRef } from '@/lib/fileRefs';
import { relInProject } from '@/lib/phoneProject';
import { useFileRef } from '@/hooks/useFileRef';
import { MessageFoldersContext, useChatFileLinks, type OpenFileOptions } from './fileLinkContext';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface FileLinkProps {
  /** The text that may name a file: a path, an inline code span, a link target. */
  path: string;
  /** What the link shows (defaults to `path`). */
  children?: ReactNode;
  className?: string;
  /** Rendered when `path` isn't a file of this project. */
  fallback: ReactNode;
}

const LINE_SUFFIX = /(?::\d+){1,2}$/;

export default function FileLink({ path, children, className, fallback }: FileLinkProps) {
  const links = useChatFileLinks();
  const folders = useContext(MessageFoldersContext);
  const projectPath = links?.projectPath ?? '';
  const rel = links ? chatFileLink(path, projectPath) : null;
  const clean = path.trim().replace(LINE_SUFFIX, '');
  // What still needs the Mac's word: a folder, a bare name, and (where the chat may open
  // them) a path outside the project or under ~.
  const kind = links && !rel ? classifyRef(clean) : null;
  const ask = kind === 'bare' ? 'bare' : kind === 'dir' || (kind === 'file' && links?.openOutside) ? 'dir' : null;
  const found = useFileRef(ask ? clean : null, ask, projectPath, folders);

  let target: { path: string; options: OpenFileOptions } | null = null;
  if (links && rel) target = { path: rel, options: {} };
  else if (links && found) {
    const inside = relInProject(found.absolute, projectPath);
    const dir = found.kind === 'dir' ? { kind: 'dir' as const } : {};
    if (inside) target = { path: inside, options: dir };
    else if (links.openOutside) target = { path: found.absolute, options: { ...dir, outside: true } };
  }
  if (!links || !target) return <>{fallback}</>;
  const { path: opens, options } = target;
  return (
    <a
      href="#"
      className={className}
      onClick={(event: MouseEvent) => {
        event.preventDefault();
        links.open(opens, { ...options, anchor: { x: event.clientX, y: event.clientY } });
      }}
      data-file-link={opens}
      data-file-kind={options.kind ?? 'file'}
    >
      {children ?? path}
      {/* The visible words stay the name; this says what a tap does. */}
      <span className={styles.srOnly}> (open in Project)</span>
    </a>
  );
}
