/**
 * ChatMarkdown — the agent's text in the phone chat (AASC-41), formatted, never
 * shortened. Lazy: react-markdown, remark-gfm and highlight.js load on the first
 * reply, not with the phone frame.
 *
 * - No raw HTML: react-markdown escapes it (no rehype-raw here, ever).
 * - Links open outside the app through the app's window-open policy
 *   (`target="_blank"`); only http(s) and mailto links are links at all.
 * - Code blocks scroll sideways inside their own box, with Copy; blocks over 200
 *   lines are left unhighlighted (a phone shouldn't tokenise a whole file). A reply
 *   with no fenced code skips the highlighter altogether: react-markdown builds its
 *   processor per render, and rehype-highlight registers every language each time.
 * - Tables scroll sideways in a wrapper; images show as a link to the image.
 */
import { memo, type AnchorHTMLAttributes, type HTMLAttributes, type ImgHTMLAttributes, type ReactNode, type TableHTMLAttributes } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { childrenToText } from '@/lib/markdownHeadings';
import CopyButton from '../CopyButton';
import styles from '@/styles/modules/mobile/ChatMarkdown.module.css';

const LONG_CODE_LINES = 200;
const SAFE_HREF = /^(?:https?:|mailto:)/i;

interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
}

function textOf(node: HastNode): string {
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(textOf).join('');
}

/** Marks code blocks too long to highlight with `no-highlight` (rehype-highlight skips those). */
function rehypeSkipLongCode() {
  const visit = (node: HastNode) => {
    if (node.type === 'element' && node.tagName === 'code') {
      const lines = textOf(node).split('\n').length;
      if (lines > LONG_CODE_LINES) {
        const props = node.properties ?? (node.properties = {});
        const current = Array.isArray(props.className) ? props.className : [];
        props.className = [...current, 'no-highlight'];
      }
      return;
    }
    node.children?.forEach(visit);
  };
  return (tree: HastNode) => visit(tree);
}

function languageOf(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child as { props?: { className?: unknown } } | null)?.props?.className;
  const match = typeof className === 'string' ? /language-([\w+#.-]+)/.exec(className) : null;
  return match ? match[1] : '';
}

function CodeBlock({ children }: HTMLAttributes<HTMLPreElement>) {
  const raw = childrenToText(children).replace(/\n$/, '');
  const language = languageOf(children);
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHead}>
        <span>{language || 'code'}</span>
        <CopyButton text={raw} className={styles.copyBtn} label={language ? `Copy ${language} code` : 'Copy code'} />
      </div>
      <pre className={styles.codePre}>{children}</pre>
    </div>
  );
}

function Link({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (!href || !SAFE_HREF.test(href)) return <>{children}</>;
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Table({ children }: TableHTMLAttributes<HTMLTableElement>) {
  return <div className={styles.tableWrap}><table>{children}</table></div>;
}

function Image({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
  const label = `Image${alt ? `: ${alt}` : ''}`;
  return typeof src === 'string' && SAFE_HREF.test(src)
    ? <a href={src} target="_blank" rel="noopener noreferrer">{label}</a>
    : <span>[{label}]</span>;
}

const COMPONENTS = { pre: CodeBlock, a: Link, table: Table, img: Image };
const REMARK = [remarkGfm];
const REHYPE_CODE = [rehypeSkipLongCode, rehypeHighlight];
const REHYPE_PLAIN: typeof REHYPE_CODE = [];
/** A fenced code block that names its language: the only thing the highlighter colours. */
const FENCE_WITH_LANGUAGE = /(^|\n)\s*(```|~~~)\s*[\w+#.-]/;

function ChatMarkdown({ text }: { text: string }) {
  return (
    <div className={styles.md}>
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={FENCE_WITH_LANGUAGE.test(text) ? REHYPE_CODE : REHYPE_PLAIN} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
