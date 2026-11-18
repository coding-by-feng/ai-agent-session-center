/**
 * ChatMarkdown — the agent's text in the phone chat (AASC-41), formatted, never
 * shortened. Lazy: react-markdown, remark-gfm and highlight.js load on the first
 * reply, not with the phone frame.
 *
 * - No raw HTML: react-markdown escapes it (no rehype-raw here, ever).
 * - Links open outside the app through the app's window-open policy
 *   (`target="_blank"`); only http(s) and mailto links are links at all, except
 *   a file of the session's project: a relative link, an inline `code` path
 *   ("docs/plan.md") or, since Nov 18 2026, a path, folder or file name in plain
 *   prose opens it in the Project tab (FileLink; `rehypeFileRefs` marks the prose ones).
 *   A folder or a bare name is a link only once the Mac says it exists.
 * - Code blocks scroll sideways inside their own box, with Copy; blocks over 200
 *   lines are left unhighlighted (a phone shouldn't tokenise a whole file). A reply
 *   with no fenced code skips the highlighter altogether: react-markdown builds its
 *   processor per render, and rehype-highlight registers every language each time.
 * - Tables keep whole words and scroll sideways in their own card (ChatTable); images
 *   show as a link to the image.
 */
import { memo, useMemo, type AnchorHTMLAttributes, type HTMLAttributes, type ImgHTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { childrenToText } from '@/lib/markdownHeadings';
import CopyButton from '../CopyButton';
import FileLink from '../FileLink';
import { MessageFoldersContext } from '../fileLinkContext';
import { findFileRefs, messageFolders } from '@/lib/fileRefs';
import { ChatTable, ChatTd, ChatTh } from './ChatTable';
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

/** Marks inline code (`code` outside a `pre`) with `data-inline`: a path there may become a link (prose: rehypeFileRefs). */
function rehypeMarkInlineCode() {
  const visit = (node: HastNode, parent: HastNode | null) => {
    if (node.type === 'element' && node.tagName === 'code') {
      if (parent?.tagName !== 'pre') (node.properties ??= {}).dataInline = true;
      return;
    }
    node.children?.forEach((child) => visit(child, node));
  };
  return (tree: HastNode) => visit(tree, null);
}

/** Text nodes are left alone inside these: code keeps its own rule, a link is already one. */
const NO_FILE_REFS = new Set(['code', 'pre', 'a']);

/**
 * Wraps each path, folder or file name in plain prose in a `fileref` element (Nov 18 2026),
 * which `FileRef` below draws through FileLink: a link when it names something, the same
 * text when it doesn't.
 */
function rehypeFileRefs() {
  const visit = (node: HastNode) => {
    if (!node.children || (node.type === 'element' && NO_FILE_REFS.has(node.tagName ?? ''))) return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      const tokens = child.type === 'text' && child.value ? findFileRefs(child.value) : [];
      if (tokens.length === 0) {
        visit(child);
        next.push(child);
        continue;
      }
      const value = child.value ?? '';
      let at = 0;
      for (const token of tokens) {
        if (token.start > at) next.push({ type: 'text', value: value.slice(at, token.start) });
        next.push({ type: 'element', tagName: 'fileref', properties: { dataPath: token.text }, children: [{ type: 'text', value: token.text }] });
        at = token.end;
      }
      if (at < value.length) next.push({ type: 'text', value: value.slice(at) });
    }
    node.children = next;
  };
  return (tree: HastNode) => visit(tree);
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

/** Inline code; a path to a file of the project is a tap that opens it. */
function Code({ children, className, ...rest }: HTMLAttributes<HTMLElement> & { 'data-inline'?: unknown }) {
  const inline = rest['data-inline'] !== undefined;
  const code = <code className={className}>{children}</code>;
  if (!inline) return code;
  return (
    <FileLink path={childrenToText(children)} className={styles.fileCode} fallback={code}>
      <code>{children}</code>
    </FileLink>
  );
}

function Link({ href, children }: AnchorHTMLAttributes<HTMLAnchorElement>) {
  if (href && !SAFE_HREF.test(href)) {
    return <FileLink path={href} className={styles.fileLink} fallback={<>{children}</>}>{children}</FileLink>;
  }
  if (!href) return <>{children}</>;
  return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}

function Image({ src, alt }: ImgHTMLAttributes<HTMLImageElement>) {
  const label = `Image${alt ? `: ${alt}` : ''}`;
  return typeof src === 'string' && SAFE_HREF.test(src)
    ? <a href={src} target="_blank" rel="noopener noreferrer">{label}</a>
    : <span>[{label}]</span>;
}

/** A path or name found in plain prose (rehypeFileRefs). */
function FileRef({ children, ...rest }: HTMLAttributes<HTMLElement> & { 'data-path'?: string }) {
  const path = rest['data-path'] ?? childrenToText(children);
  return <FileLink path={path} className={styles.fileLink} fallback={<>{children}</>}>{children}</FileLink>;
}

// `fileref` is this file's own element, so it is not in react-markdown's tag list.
const COMPONENTS = { pre: CodeBlock, code: Code, a: Link, table: ChatTable, th: ChatTh, td: ChatTd, img: Image, fileref: FileRef } as Components;
const REMARK = [remarkGfm];
const REHYPE_CODE = [rehypeMarkInlineCode, rehypeFileRefs, rehypeSkipLongCode, rehypeHighlight];
const REHYPE_PLAIN: typeof REHYPE_CODE = [rehypeMarkInlineCode, rehypeFileRefs];
/** A fenced code block that names its language: the only thing the highlighter colours. */
const FENCE_WITH_LANGUAGE = /(^|\n)\s*(```|~~~)\s*[\w+#.-]/;

function ChatMarkdown({ text }: { text: string }) {
  // Where this message's bare file names are looked for first ("Files are in X:" then a list).
  const folders = useMemo(() => messageFolders(text), [text]);
  return (
    <div className={styles.md}>
      <MessageFoldersContext.Provider value={folders}>
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={FENCE_WITH_LANGUAGE.test(text) ? REHYPE_CODE : REHYPE_PLAIN} components={COMPONENTS}>
          {text}
        </ReactMarkdown>
      </MessageFoldersContext.Provider>
    </div>
  );
}

export default memo(ChatMarkdown);
