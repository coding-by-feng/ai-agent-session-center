import { describe, expect, it } from 'vitest';
import { resolveMarkdownLink } from './markdownLinkTarget';

const ARTICLE = '/06-ai/ai-blog/articles/2026-11-22-01-riemann-proof-verification-ZH.md';

describe('resolveMarkdownLink', () => {
  it('opens a percent-encoded video link as its decoded project path (the 黎曼猜想 link, Nov 24 2026)', () => {
    const href = '../../ai-video/assets/2026-11-22-04-riemann-reference-to-video/%E9%BB%8E%E6%9B%BC%E7%8C%9C%E6%83%B3.mp4';
    expect(resolveMarkdownLink(href, ARTICLE)).toEqual({
      kind: 'file',
      path: '/06-ai/ai-video/assets/2026-11-22-04-riemann-reference-to-video/黎曼猜想.mp4',
    });
  });

  it('opens any file type, not only markdown', () => {
    expect(resolveMarkdownLink('assets/cover.png', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/assets/cover.png' });
    expect(resolveMarkdownLink('./data.csv', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/data.csv' });
    expect(resolveMarkdownLink('../paper.pdf', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/paper.pdf' });
  });

  it('keeps markdown links working, dropping the #fragment and ?query', () => {
    expect(resolveMarkdownLink('other-EN.md#intro', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/other-EN.md' });
    expect(resolveMarkdownLink('notes.md?plain=1', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/notes.md' });
    expect(resolveMarkdownLink('%E7%AC%94%E8%AE%B0.md', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/笔记.md' });
  });

  it('reads a leading slash from the project root, as images do', () => {
    expect(resolveMarkdownLink('/docs/guide.pdf', ARTICLE)).toEqual({ kind: 'file', path: '/docs/guide.pdf' });
  });

  it('resolves against the root for a root-level file, keeping the open file\'s path style', () => {
    expect(resolveMarkdownLink('a/b.mp4', '/README.md')).toEqual({ kind: 'file', path: '/a/b.mp4' });
    expect(resolveMarkdownLink('a/b.mp4', 'README.md')).toEqual({ kind: 'file', path: 'a/b.mp4' });
    expect(resolveMarkdownLink('a/b.mp4', null)).toEqual({ kind: 'file', path: '/a/b.mp4' });
    expect(resolveMarkdownLink('x.md', 'docs/a.md')).toEqual({ kind: 'file', path: 'docs/x.md' });
  });

  it('treats a trailing slash as a folder', () => {
    expect(resolveMarkdownLink('assets/', ARTICLE)).toEqual({ kind: 'folder', path: '/06-ai/ai-blog/articles/assets' });
    expect(resolveMarkdownLink('../', ARTICLE)).toEqual({ kind: 'folder', path: '/06-ai/ai-blog' });
  });

  it('refuses a link that climbs above the project root instead of opening another file', () => {
    expect(resolveMarkdownLink('../../../../etc/passwd', ARTICLE)).toEqual({ kind: 'outside' });
    expect(resolveMarkdownLink('../x.mp4', '/README.md')).toEqual({ kind: 'outside' });
  });

  it('leaves web, mail, phone, protocol-relative and in-page links to the browser', () => {
    for (const href of ['https://example.com/v.mp4', 'http://x.test', '//cdn.test/a.png', 'mailto:a@b.test', 'tel:123', '#heading', 'data:text/plain,hi', '']) {
      expect(resolveMarkdownLink(href, ARTICLE)).toEqual({ kind: 'external' });
    }
  });

  it('keeps a malformed escape as written rather than throwing', () => {
    expect(resolveMarkdownLink('100%.txt', ARTICLE)).toEqual({ kind: 'file', path: '/06-ai/ai-blog/articles/100%.txt' });
  });
});
