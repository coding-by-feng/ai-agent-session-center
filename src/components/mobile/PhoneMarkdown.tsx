/**
 * PhoneMarkdown — a Markdown file rendered on a phone (AASC-20, feature 47).
 * Lazy (react-markdown, remark-gfm and highlight.js stay out of every eager
 * chunk). Headings carry the ids the OUTLINE sheet scrolls to — the same
 * `headingSlug(childrenToText(...))` the desktop viewer uses, so the two never
 * disagree. A link to a project file opens it in the phone browser, whatever its
 * type (Nov 24 2026: was Markdown only, so a video or PDF link opened a blank page);
 * a folder link opens that folder; web and mail links open outside the app. The
 * rule is the desktop viewer's (lib/markdownLinkTarget.ts), percent-decoding included.
 *
 * Images stay put while the page is read (Nov 26 2026). The renderers used to be fresh functions on every render,
 * so react-markdown saw new component types and remounted every <img> whenever the parent re-rendered (every session
 * update does: each hook of a working session): the pictures reloaded, dropped to zero height for a moment and the
 * page jumped under the reader's finger. The renderers are module constants now and read the file and its
 * callbacks from context, and the parsed tree is kept until the text changes. Guarded by PhoneMarkdown.stable.test.
 */
import { createContext, useContext, useMemo } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { headingSlug, childrenToText } from '@/lib/markdownHeadings';
import { joinRel, parentRel } from '@/lib/phoneProject';
import { streamUrl } from '@/lib/phoneFiles';
import { scrollIntoContainer } from '@/lib/scrollWithinContainer';
import { resolveMarkdownLink } from '@/lib/markdownLinkTarget';
import { showToast } from '@/components/ui/ToastContainer';
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
  /** A link ending in `/`: open that folder. Without it, a folder link opens nothing. */
  onOpenDir?: (path: string) => void;
}

/** react-markdown's syntax node, which must never reach the DOM as an attribute (`node="[object Object]"`). */
function withoutNode<T extends ExtraProps>(props: T): Omit<T, 'node'> {
  const { node, ...rest } = props;
  void node;
  return rest;
}

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
  function Heading({ children, ...props }: HTMLAttributes<HTMLHeadingElement> & ExtraProps) {
    return <Tag id={headingSlug(childrenToText(children))} {...withoutNode(props)}>{children}</Tag>;
  };

const HEADINGS = { h1: heading('h1'), h2: heading('h2'), h3: heading('h3'), h4: heading('h4'), h5: heading('h5'), h6: heading('h6') };

/** What the renderers need from the file on screen: given by context, so the renderers themselves never change. */
type MarkdownFile = Omit<PhoneMarkdownProps, 'content'>;
const FileContext = createContext<MarkdownFile>({ projectPath: '', filePath: '/', onOpenFile: () => {} });

function MarkdownLink({ children, href, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & ExtraProps) {
  const { filePath, onOpenFile, onOpenDir } = useContext(FileContext);
  const props = withoutNode(rest);
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
  const target = resolveMarkdownLink(href, filePath);
  if (target.kind !== 'external') {
    return (
      <a
        {...props}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (target.kind === 'file') onOpenFile(target.path);
          else if (target.kind === 'folder') onOpenDir?.(target.path);
          else showToast('This link points outside the project', 'error');
        }}
      >
        {children}
      </a>
    );
  }
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function MarkdownImage({ src, alt, ...rest }: ImgHTMLAttributes<HTMLImageElement> & ExtraProps) {
  const { projectPath, filePath } = useContext(FileContext);
  const props = withoutNode(rest);
  if (!src || typeof src !== 'string' || EXTERNAL_RE.test(src) || src.startsWith('/api/')) {
    return <img {...props} src={typeof src === 'string' ? src : undefined} alt={alt ?? ''} />;
  }
  const target = src.startsWith('/') ? joinRel('/', src) : joinRel(parentRel(filePath), src);
  return <img {...props} src={streamUrl(projectPath, target)} alt={alt ?? ''} loading="lazy" />;
}

/** One set of renderers for every file: a re-render reconciles the page instead of remounting it. */
const COMPONENTS = { ...HEADINGS, a: MarkdownLink, img: MarkdownImage };
const REMARK = [remarkGfm];
const REHYPE = [rehypeHighlight];

export default function PhoneMarkdown({ content, projectPath, filePath, onOpenFile, onOpenDir }: PhoneMarkdownProps) {
  // A new onOpenFile arrow from the parent re-renders the links (cheap), never the parse or the images.
  const file = useMemo(() => ({ projectPath, filePath, onOpenFile, onOpenDir }), [projectPath, filePath, onOpenFile, onOpenDir]);
  const tree = useMemo(
    () => (
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={COMPONENTS}>
        {content}
      </ReactMarkdown>
    ),
    [content],
  );
  return (
    <FileContext.Provider value={file}>
      <div className={`${projectStyles.markdown} ${styles.markdown}`}>{tree}</div>
    </FileContext.Provider>
  );
}
