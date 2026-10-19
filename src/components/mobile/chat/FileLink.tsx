/**
 * FileLink — a file of the session's project, named in the chat, as a tap that
 * opens it in the Project tab (`fileLinkContext`). Anything that is not such a
 * file renders as `fallback`, unchanged. A link (it navigates to the file's view),
 * so it flows with the sentence round it as text does (a <button> is one unbreakable
 * box), is reachable by keyboard, and says what it does. The href never loads.
 */
import type { ReactNode } from 'react';
import { chatFileLink } from '@/lib/chat/fileLinks';
import { useChatFileLinks } from './fileLinkContext';
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

export default function FileLink({ path, children, className, fallback }: FileLinkProps) {
  const links = useChatFileLinks();
  const rel = links ? chatFileLink(path, links.projectPath) : null;
  if (!links || !rel) return <>{fallback}</>;
  return (
    <a
      href="#"
      className={className}
      onClick={(event) => {
        event.preventDefault();
        links.open(rel);
      }}
      data-file-link={rel}
    >
      {children ?? path}
      {/* The visible words stay the name; this says what a tap does. */}
      <span className={styles.srOnly}> (open in Project)</span>
    </a>
  );
}
