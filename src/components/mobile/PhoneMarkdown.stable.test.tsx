// PhoneMarkdown keeps its images across re-renders (Nov 26 2026). The renderers were a fresh object of fresh
// functions on every render, so react-markdown saw a new component type each time and remounted every <img>: each
// parent re-render (every session update re-renders the Project tab, and the file view passes a new onOpenFile
// arrow each time) reloaded every picture, which dropped to zero height for a moment and made the page jump while
// the user scrolled.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PhoneMarkdown from './PhoneMarkdown';

const MARKDOWN = ['# Notes', '', '![tweet](assets/tweet.png)', '', '[other](other.md)', '', '## Later'].join('\n');
const props = { content: MARKDOWN, projectPath: '/w', filePath: '/06-ai/post-ZH.md' };

describe('PhoneMarkdown — stable across re-renders', () => {
  it('keeps the same <img> and heading elements when the parent re-renders with new callbacks', () => {
    const { rerender } = render(<PhoneMarkdown {...props} onOpenFile={() => {}} />);
    const img = screen.getByRole('img', { name: 'tweet' });
    const heading = screen.getByRole('heading', { name: 'Later' });

    rerender(<PhoneMarkdown {...props} onOpenFile={() => {}} />);

    expect(screen.getByRole('img', { name: 'tweet' })).toBe(img);
    expect(screen.getByRole('heading', { name: 'Later' })).toBe(heading);
  });

  it('a link calls the latest onOpenFile, not the one from the first render', () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<PhoneMarkdown {...props} onOpenFile={first} />);
    rerender(<PhoneMarkdown {...props} onOpenFile={latest} />);

    fireEvent.click(screen.getByText('other'));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith('/06-ai/other.md');
  });

  it('a new file path re-resolves its images', () => {
    const { rerender } = render(<PhoneMarkdown {...props} onOpenFile={() => {}} />);
    const before = screen.getByRole('img', { name: 'tweet' }).getAttribute('src');

    rerender(<PhoneMarkdown {...props} filePath="/07-other/post-ZH.md" onOpenFile={() => {}} />);

    const after = screen.getByRole('img', { name: 'tweet' }).getAttribute('src');
    expect(after).not.toBe(before);
    expect(decodeURIComponent(after ?? '')).toContain('/07-other/assets/tweet.png');
  });
});
