import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { extractHeadings, headingSlug, childrenToText } from './markdownHeadings';

// The unit tests in markdownHeadings.test.ts construct `children` by hand via
// createElement — they cover the id-computation logic but assume react-
// markdown actually shapes `children` the way ProjectTab's h1-h6 renderers
// expect. This test renders the SAME markdown through the real
// ReactMarkdown + remarkGfm pipeline ProjectTab uses, with an h2 renderer
// built the identical way, and drives the exact DOM lookup the OUTLINE
// panel's click handler performs — closing that one remaining assumption
// end-to-end rather than leaving it implicit.
describe('OUTLINE click-to-jump — end-to-end through real ReactMarkdown', () => {
  const components = {
    h2: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
      <h2 id={headingSlug(childrenToText(children))} {...props}>{children}</h2>
    ),
  };

  it('renders a heading with inline code spans at the id extractHeadings() computed', () => {
    const source = '## EDIT 1 — `01_introduction.md` · `02_literature_review.md`';
    const [heading] = extractHeadings(source);

    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>,
    );

    // Exactly what the outline button's onClick does: markdownRef.current
    // .querySelector(`[id="${h.slug}"]`) — using the container as the ref
    // stand-in.
    const target = container.querySelector(`[id="${heading.slug}"]`);
    expect(target).not.toBeNull();
    expect(target?.tagName).toBe('H2');
  });

  it('renders a heading with a markdown link at the id extractHeadings() computed', () => {
    const source = '## Read the [docs](https://example.com/page) here';
    const [heading] = extractHeadings(source);

    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>,
    );

    const target = container.querySelector(`[id="${heading.slug}"]`);
    expect(target).not.toBeNull();
  });

  it('renders a plain-text heading (no inline markdown) at the id extractHeadings() computed', () => {
    const source = '## Plain Section Heading';
    const [heading] = extractHeadings(source);

    const { container } = render(
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{source}</ReactMarkdown>,
    );

    const target = container.querySelector(`[id="${heading.slug}"]`);
    expect(target).not.toBeNull();
  });
});
