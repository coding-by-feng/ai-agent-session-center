/**
 * ResourceMarkdown — a markdown resource rendered, with its frontmatter as a
 * card of rows instead of the two `<hr>`s and a run of `key: value` text that
 * a plain renderer makes of it.
 *
 * **Only ever reach this module through `lazy()`** (see ResourceDetail). It
 * pulls in react-markdown + remark-gfm + rehype-highlight; a static import
 * would move all of that into the tab's first chunk, and no linter reports it
 * (same rule as NoteMarkdown).
 *
 * The preview is inert. react-markdown runs without rehype-raw, so raw HTML in
 * a skill is never parsed into elements; images render as a labelled
 * placeholder instead of loading (a remote `![](https://…)` must not phone home
 * from a resource preview, and a relative one has nothing to load from here);
 * and only absolute http(s)/mailto links to ANOTHER machine are clickable
 * (`isExternalHref`). A relative link points into the skill's package, not into
 * this app, and a link to this app's origin — or to any loopback host on any
 * port — could open an internal window under Electron (`attachWindowOpenPolicy`)
 * — e.g. the Project Browser, which can edit files — from text nobody on this
 * machine necessarily wrote.
 *
 * Memoised: its parent re-renders on every keystroke in the search box, every
 * scan poll and every age tick, and re-parsing plus re-highlighting up to
 * 256 KB each time made typing lag.
 */
import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github-dark-dimmed.css';
import { frontmatterRows, isExternalHref } from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    isExternalHref(href, window.location.origin) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    ) : (
      <span className={styles.mdInertLink} title={href ? `Link target: ${href}` : undefined}>{children}</span>
    ),
  img: ({ src, alt }) => (
    <span className={styles.mdImage}>[image: {alt || (typeof src === 'string' ? src : '')}]</span>
  ),
  // A wide table gets its own scroll box instead of widening the pane.
  table: ({ children }) => (
    <div className={styles.mdTableWrap}>
      <table>{children}</table>
    </div>
  ),
};

interface ResourceMarkdownProps {
  body: string;
  frontmatter?: Record<string, unknown>;
  frontmatterError?: string;
}

function FrontmatterCard({ frontmatter, error }: { frontmatter?: Record<string, unknown>; error?: string }) {
  const rows = frontmatter ? frontmatterRows(frontmatter) : [];
  return (
    <section className={styles.frontmatterCard} aria-label="Frontmatter">
      {error && <p className={styles.errorNote}>Frontmatter could not be parsed: {error}</p>}
      {rows.length > 0 && (
        <dl className={styles.frontmatterList}>
          {rows.map((row) => (
            <div key={row.key} className={styles.frontmatterRow}>
              <dt>{row.key}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {!error && rows.length === 0 && <p className={styles.muted}>Empty frontmatter.</p>}
    </section>
  );
}

/**
 * `body` arrives with the frontmatter block already stripped by the server,
 * parsed or not. It is NOT stripped again here: what remains may legitimately
 * open with a `---` rule, and a second strip would swallow everything up to
 * the next one.
 */
function ResourceMarkdown({ body, frontmatter, frontmatterError }: ResourceMarkdownProps) {
  const hasFrontmatter = frontmatter !== undefined || frontmatterError !== undefined;
  return (
    <div className={styles.markdownPane}>
      {hasFrontmatter && <FrontmatterCard frontmatter={frontmatter} error={frontmatterError} />}
      {body.trim() ? (
        <div className={styles.markdown}>
          <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={COMPONENTS}>
            {body}
          </ReactMarkdown>
        </div>
      ) : (
        <p className={styles.muted}>No content below the frontmatter.</p>
      )}
    </div>
  );
}

export default memo(ResourceMarkdown);
