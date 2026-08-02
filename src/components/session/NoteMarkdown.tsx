/**
 * Rendered view of a note's Markdown body.
 *
 * **This module must only ever be reached through `lazy()`.** It pulls in
 * react-markdown + remark-gfm + rehype-highlight (~300 kB), and its only
 * consumer, `NotesTab`, is a *static* import of `DetailPanel` — which sits in
 * the eager entry chunk. That is the same reason `AiPopupHistory` and
 * `ProjectTabContainer` are lazy: a plain import here silently moves the whole
 * Markdown stack onto the boot path, and no linter reports it.
 */
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { isVideoSrc } from '@/lib/noteMedia';
import LinkifiedText from './LinkifiedText';
import styles from '@/styles/modules/DetailPanel.module.css';

interface NoteMarkdownProps {
  text: string;
  /** Enables clickable file paths inside prose; omitted for sessions with no project. */
  projectPath?: string;
}

/**
 * Re-apply the plain-text file-path linkifier to Markdown text nodes.
 *
 * Notes used to be rendered entirely by `LinkifiedText`, so a bare
 * `src/api.ts` in a note was clickable. Markdown rendering would silently drop
 * that, hence this pass over the string children of prose-bearing elements.
 */
function linkify(children: ReactNode, projectPath?: string): ReactNode {
  if (!projectPath) return children;
  if (typeof children === 'string') {
    return <LinkifiedText text={children} projectPath={projectPath} />;
  }
  if (Array.isArray(children)) {
    return children.map((child, i) =>
      typeof child === 'string' ? (
        <LinkifiedText key={i} text={child} projectPath={projectPath} />
      ) : (
        child
      ),
    );
  }
  return children;
}

export default function NoteMarkdown({ text, projectPath }: NoteMarkdownProps) {
  return (
    <div className={styles.noteBody}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          // Links open externally; react-markdown runs without rehype-raw, so
          // raw HTML is already blocked and javascript: URLs are sanitized.
          a: ({ children, href, ...props }) => (
            <a {...props} href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          // Markdown has no video syntax — video rides the image form and is
          // told apart by extension, the same convention GitHub uses. The
          // <video> is not preloaded: a notes list with several recordings
          // would otherwise fetch every one of them on render.
          img: ({ src, alt }) => {
            const url = typeof src === 'string' ? src : '';
            if (!url) return null;
            if (isVideoSrc(url)) {
              return (
                <video
                  className={styles.noteVideo}
                  src={url}
                  controls
                  preload="metadata"
                  playsInline
                />
              );
            }
            return (
              <a href={url} target="_blank" rel="noopener noreferrer" className={styles.noteImageLink}>
                <img className={styles.noteImage} src={url} alt={alt ?? ''} loading="lazy" />
              </a>
            );
          },
          p: ({ children }) => <p>{linkify(children, projectPath)}</p>,
          li: ({ children }) => <li>{linkify(children, projectPath)}</li>,
          td: ({ children }) => <td>{linkify(children, projectPath)}</td>,
          // A table can outgrow the panel; give it its own scroll box so it
          // never widens the note card (which lives inside .tabScroll).
          table: ({ children }) => (
            <div className={styles.noteTableWrap}>
              <table>{children}</table>
            </div>
          ),
          // Inline vs fenced code is left to CSS (`.noteBody code` vs
          // `.noteBody pre code`) — the DOM already distinguishes them, and
          // sniffing it here misreads an indented block as inline.
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
