/**
 * Where a link in a previewed markdown file goes (Nov 24 2026). The PROJECT tab opens a project
 * file in its own file tab, whatever its type (a video, an image, a PDF, another note), and reveals
 * a folder in the tree; web, mail and in-page links stay with the browser.
 *
 * The markdown renderer percent-encodes a link (`黎曼猜想.mp4` arrives as `%E9%BB%8E…mp4`), so the
 * path is decoded here, once; the file API encodes it again for its own URL. A `..` that climbs
 * above the project root is refused rather than clamped, which would open some other file.
 * The result keeps the open file's style: the tree's paths start with `/` (`/docs/a.md`), and a
 * path in the other style would open the same file in a second tab.
 */
export type MarkdownLinkTarget =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'outside' }
  | { kind: 'external' };

/** A scheme (`https:`, `mailto:`, `data:` …), protocol-relative `//`, or an in-page `#` link. */
const BROWSER_LINK_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // a bare `%` in a real file name
  }
}

/**
 * @param href the link as rendered (may be percent-encoded)
 * @param currentPath the open file's project-relative path; a link resolves against its folder
 */
export function resolveMarkdownLink(href: string | undefined, currentPath: string | null | undefined): MarkdownLinkTarget {
  if (!href || BROWSER_LINK_RE.test(href)) return { kind: 'external' };
  const raw = decodePath(href.split(/[?#]/)[0]);
  if (!raw) return { kind: 'external' };

  const current = currentPath ?? '';
  const baseDir = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  const joined = raw.startsWith('/') ? raw : `${baseDir}/${raw}`;

  const resolved: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) return { kind: 'outside' };
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  const leading = !current || current.startsWith('/') ? '/' : '';
  const path = leading + resolved.join('/');
  if (raw.endsWith('/')) return { kind: 'folder', path };
  return resolved.length ? { kind: 'file', path } : { kind: 'folder', path };
}
