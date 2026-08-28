import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { extractHeadings, headingSlug, childrenToText } from './markdownHeadings';

// Regression cover for the OUTLINE click-to-jump bug: extractHeadings() (raw
// markdown source) and the h1-h6 renderers (React's `children` prop) used to
// compute a heading's slug from two different text representations that only
// happened to agree for a plain-text heading. Any heading with inline
// markdown — a code span, a link, bold/italic — desynced them, so
// `markdownRef.current?.querySelector([id="${h.slug}"])` never found the
// element and the click silently did nothing.
describe('headingSlug', () => {
  it('lowercases, strips punctuation, and hyphenates spaces', () => {
    expect(headingSlug('Getting Started')).toBe('getting-started');
    expect(headingSlug('API: Endpoints & Routes')).toBe('api-endpoints-routes');
  });
});

describe('extractHeadings', () => {
  it('parses headings of every level and ignores fenced code blocks', () => {
    const md = [
      '# Title',
      '## Section One',
      '```',
      '# not a heading',
      '```',
      '### Sub Section',
    ].join('\n');
    const headings = extractHeadings(md);
    expect(headings).toEqual([
      { level: 1, text: 'Title', slug: 'title' },
      { level: 2, text: 'Section One', slug: 'section-one' },
      { level: 3, text: 'Sub Section', slug: 'sub-section' },
    ]);
  });

  it('keeps the raw markdown syntax in `text` (display label) but strips it from `slug` (id match)', () => {
    const [heading] = extractHeadings('## EDIT 1 — `01_introduction.md`');
    expect(heading.text).toBe('EDIT 1 — `01_introduction.md`');
    expect(heading.slug).toBe('edit-1-01_introductionmd');
  });

  it('unwraps a markdown link to its visible link text for the slug', () => {
    const [heading] = extractHeadings('## Read the [docs](https://example.com/page) here');
    expect(heading.slug).toBe('read-the-docs-here');
  });

  it('strips ** and __ bold delimiters from the slug', () => {
    expect(extractHeadings('## **Important** Notice')[0].slug).toBe('important-notice');
    expect(extractHeadings('## __Important__ Notice')[0].slug).toBe('important-notice');
  });

  it('does not let two separate underscored filenames get merged into one "italic span" (regression)', () => {
    // A naive /_([^_]+)_/ strip spans from the first filename's underscore to
    // the second's, swallowing the " · " between them — this is the actual
    // heading shape from the reported bug (docs/feature/.manifest.json-style
    // "EDIT N — `file.md`" headings, chained with " · " for multi-file edits).
    const [heading] = extractHeadings('## EDIT 1 — `01_introduction.md` · `02_literature_review.md`');
    expect(heading.slug).toBe('edit-1-01_introductionmd-02_literature_reviewmd');
  });
});

describe('childrenToText', () => {
  it('returns a plain string unchanged', () => {
    expect(childrenToText('Plain Heading')).toBe('Plain Heading');
  });

  it('stringifies a bare number child', () => {
    expect(childrenToText(42)).toBe('42');
  });

  it('flattens a mixed array of strings and elements (e.g. a heading with an inline code span)', () => {
    // Mirrors what react-markdown hands the h1-h6 renderers for
    // "EDIT 1 — `01_introduction.md`": a string, then a <code> element whose
    // own children is the span's text (no backticks — those are markdown
    // delimiters, not rendered characters).
    const children = ['EDIT 1 — ', createElement('code', null, '01_introduction.md')];
    expect(childrenToText(children)).toBe('EDIT 1 — 01_introduction.md');
  });

  it('recurses through nested element children (e.g. bold text inside a link)', () => {
    const children = [createElement('a', null, createElement('strong', null, 'docs'))];
    expect(childrenToText(children)).toBe('docs');
  });

  it('ignores elements with no children and returns empty string for null/undefined', () => {
    expect(childrenToText(createElement('br'))).toBe('');
    expect(childrenToText(null)).toBe('');
    expect(childrenToText(undefined)).toBe('');
  });

  it('agrees with extractHeadings\' slug for a heading with an inline code span', () => {
    const raw = '## EDIT 1 — `01_introduction.md` · `02_literature_review.md`';
    const [heading] = extractHeadings(raw);
    // What react-markdown would actually hand the h2 renderer for that line.
    const renderedChildren = [
      'EDIT 1 — ',
      createElement('code', null, '01_introduction.md'),
      ' · ',
      createElement('code', null, '02_literature_review.md'),
    ];
    const renderedSlug = headingSlug(childrenToText(renderedChildren));
    expect(renderedSlug).toBe(heading.slug);
  });

  it('agrees with extractHeadings\' slug for a heading with a markdown link', () => {
    const raw = '## Read the [docs](https://example.com/page) here';
    const [heading] = extractHeadings(raw);
    const renderedChildren = ['Read the ', createElement('a', { href: 'https://example.com/page' }, 'docs'), ' here'];
    const renderedSlug = headingSlug(childrenToText(renderedChildren));
    expect(renderedSlug).toBe(heading.slug);
  });
});
