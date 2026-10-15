/**
 * PhoneMarkdown — a Markdown file rendered on a phone (AASC-20, feature 47).
 * Lazy (react-markdown, remark-gfm and highlight.js stay out of every eager
 * chunk). Headings carry the ids the OUTLINE sheet scrolls to — the same
 * `headingSlug(childrenToText(...))` the desktop viewer uses, so the two never
 * disagree. A link to another Markdown file opens it in the phone browser; any
 * other link opens outside the app.
 */
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { headingSlug, childrenToText } from '@/lib/markdownHeadings';
import { joinRel, parentRel } from '@/lib/phoneProject';
import { streamUrl } from '@/lib/phoneFiles';
import { scrollIntoContainer } from '@/lib/scrollWithinContainer';
import projectStyles from '@/styles/modules/ProjectTab.module.css';
import styles from '@/styles/modules/PhoneProject.module.css';
import type { AnchorHTMLAttributes, HTMLAttributes, ImgHTMLAttributes } from 'react';

const EXTERNAL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** `#some%20heading` → `some heading`; a malformed escape is taken as written. */
function anchorId(href: string): string {
  try {
    return decodeURIComponent(href.slice(1));
  } catch {
    return href.slice(1);
  }
}

export interface PhoneMarkdownProps {
  content: string;
  projectPath: string;
  /** This file's project path, for relative links and images. */
  filePath: string;
  onOpenFile: (path: string) => void;
}

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
  function Heading({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return <Tag id={headingSlug(childrenToText(children))} {...props}>{children}</Tag>;
  };

const HEADINGS = { h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6') };

export default function PhoneMarkdown({ content, projectPath, filePath, onOpenFile }: PhoneMarkdownProps) {
  const dir = parentRel(filePath);
  const components = {
    ...HEADINGS,
    a: ({ children, href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
      // An in-page link scrolls this file's own scroller, never the panel around it.
      if (href && href.startsWith('#') && href.length > 1) {
        return (
          <a
            {...props}
            href={href}
            onClick={(e) => {
              e.preventDefault();
              const scroller = e.currentTarget.closest<HTMLElement>('[data-phone-scroll]');
              scrollIntoContainer(scroller, scroller?.querySelector(`[id="${CSS.escape(anchorId(href))}"]`), { block: 'start', padding: 8 });
            }}
          >
            {children}
          </a>
        );
      }
      if (href && !EXTERNAL_RE.test(href) && !href.startsWith('#') && /\.mdx?$/i.test(href.split('#')[0])) {
        const target = href.startsWith('/') ? joinRel('/', href.split('#')[0]) : joinRel(dir, href.split('#')[0]);
        return (
          <a
            {...props}
            href="#"
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(target);
            }}
          >
            {children}
          </a>
        );
      }
      return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
    },
    img: ({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement>) => {
      if (!src || typeof src !== 'string' || EXTERNAL_RE.test(src) || src.startsWith('/api/')) {
        return <img {...props} src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />;
      }
      const target = src.startsWith('/') ? joinRel('/', src) : joinRel(dir, src);
      return <img {...props} src={streamUrl(projectPath, target)} alt={alt ?? ''} loading="lazy" />;
    },
  };
  return (
    <div className={`${projectStyles.markdown} ${styles.markdown}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
