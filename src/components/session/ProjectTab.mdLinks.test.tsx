import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import ProjectTab from './ProjectTab';
import { setFileSystemProvider, type FileSystemProvider } from '@/lib/fileSystemProvider';

// A link in a previewed markdown file opens the file it points at in its own file tab, whatever
// its type (Nov 24 2026): the Riemann article's companion-video link opened a blank browser
// window, and its Chinese file name arrives percent-encoded from the markdown renderer.
const ARTICLE = '/06-ai/ai-blog/articles/riemann-ZH.md';
const VIDEO = '/06-ai/ai-video/assets/riemann/黎曼猜想.mp4';
const MARKDOWN = [
  '# 黎曼',
  '',
  '[观看配套短片](../../ai-video/assets/riemann/黎曼猜想.mp4)',
  '',
  '[作者声明](https://example.com/statement)',
  '',
  '[越界](../../../../outside.txt)',
].join('\n');

describe('ProjectTab — links in a markdown preview', () => {
  let readFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    localStorage.clear();
    readFile = vi.fn(async (_root: string, rel: string) => (rel.endsWith('.md')
      ? { path: rel, name: rel.split('/').pop(), content: MARKDOWN, ext: 'md' }
      : { path: rel, name: rel.split('/').pop(), ext: 'mp4', streamable: true }));
    const provider = new Proxy({ readFile, streamUrl: (_r: string, p: string) => `/api/files/stream?path=${encodeURIComponent(p)}` } as unknown as FileSystemProvider, {
      get: (t, k) => (k in t ? (t as never)[k] : vi.fn(async () => ({ path: '', items: [], results: [], indexing: false, matches: [] }))),
    });
    setFileSystemProvider(provider);
  });

  const renderArticle = () =>
    render(<MemoryRouter><ProjectTab projectPath="/p" persistId="links-/p" initialPath={ARTICLE} initialIsFile preferInitialFile /></MemoryRouter>);

  it('opens a linked video in its own file tab, by its decoded path, keeping the article open', async () => {
    renderArticle();
    const link = await screen.findByText('观看配套短片');
    expect(link.closest('a')).not.toHaveAttribute('target');
    fireEvent.click(link);
    await waitFor(() => expect(readFile.mock.calls.map((c) => c[1])).toEqual([ARTICLE, VIDEO]));
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem('agent-manager:file-tabs:links-/p') ?? '{}');
      expect(saved.active).toBe(VIDEO);
      expect(saved.tabs.map((t: { name: string }) => t.name)).toEqual(['riemann-ZH.md', '黎曼猜想.mp4']);
    });
  });

  it('leaves a web link to the browser', async () => {
    renderArticle();
    const link = (await screen.findByText('作者声明')).closest('a')!;
    expect(link).toHaveAttribute('href', 'https://example.com/statement');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('refuses a link above the project root instead of opening another file', async () => {
    renderArticle();
    fireEvent.click(await screen.findByText('越界'));
    await new Promise((r) => setTimeout(r, 50));
    expect(readFile.mock.calls.map((c) => c[1])).toEqual([ARTICLE]);
  });
});
