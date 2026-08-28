import { isValidElement, type ReactNode } from 'react';

/** One entry in the markdown OUTLINE panel (ProjectTab). */
export interface HeadingItem {
  level: number;
  text: string;
  slug: string;
}

/**
 * Strips the common inline-markdown delimiters ReactMarkdown would otherwise
 * render as elements — code spans, links, bold — down to their visible text.
 * Order matters: code spans are unwrapped first so a literal `*` inside one
 * (e.g. `` `a*b*c` ``) isn't mistaken for emphasis by the later passes, and
 * links before bold for the same reason.
 *
 * Deliberately does NOT strip single-underscore `_italic_` — a naive
 * `/_([^_]+)_/` has no word-boundary awareness, so on a heading with two
 * separate underscored filenames (e.g. this repo's own outline bug report:
 * "EDIT 1 — `01_introduction.md` · `02_literature_review.md`") it spans from
 * the FIRST filename's underscore to the SECOND's, swallowing the em dash
 * and everything between as "italic content". CommonMark excludes intraword
 * underscores from emphasis for exactly this reason (snake_case is common);
 * this helper follows suit rather than hand-rolling word-boundary detection
 * for a construct real markdown headings rarely use in the first place.
 */
function stripInlineMarkdown(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1');
}

/** Generate a slug from heading text — must match what ReactMarkdown produces. */
export function headingSlug(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

/** Extract headings from markdown content for outline navigation. */
export function extractHeadings(content: string): HeadingItem[] {
  const headings: HeadingItem[] = [];
  let inCodeBlock = false;
  for (const line of content.split('\n')) {
    if (line.trimStart().startsWith('```')) { inCodeBlock = !inCodeBlock; continue; }
    if (inCodeBlock) continue;
    const match = line.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      // `text` keeps the raw markdown syntax (backticks, **, etc.) — it's
      // only ever shown as-is in the OUTLINE panel's label, and changing
      // that display is out of scope for the click-to-jump fix below.
      const text = match[2].replace(/\s*#+\s*$/, '').trim();
      // `slug` must match the id the h1-h6 renderers below compute from the
      // *rendered* heading, so it's built from the markdown-stripped text,
      // not the raw one — see stripInlineMarkdown's docblock.
      const slug = headingSlug(stripInlineMarkdown(text));
      headings.push({ level: match[1].length, text, slug });
    }
  }
  return headings;
}

/**
 * Flattens a heading's rendered children into plain text. A heading with any
 * inline markdown — `` `code` ``, **bold**, a link, etc. — renders `children`
 * as an array mixing strings and elements (e.g. a code span's text sits
 * inside its own <code> child), never a single string. `String(children)` on
 * that array stringifies the array/elements themselves ("[object Object]"),
 * not their visible text — so `headingSlug(String(children))` silently
 * produced a wrong id for every such heading, while `extractHeadings()`
 * (parsing the raw markdown source) computed the *correct* slug for the
 * OUTLINE panel — the two never matched, and clicking the outline entry did
 * nothing. This walks the actual children tree so both sides agree.
 */
export function childrenToText(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(childrenToText).join('');
  if (isValidElement(children)) {
    const props = children.props as { children?: ReactNode };
    return childrenToText(props.children);
  }
  return '';
}
