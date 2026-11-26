// PhoneMarkdown links (Nov 24 2026): a link to any project file opens it in the phone browser, by its decoded
// path, as the desktop viewer does (lib/markdownLinkTarget.ts); a folder link opens that folder; a link above the
// project root opens nothing; web links leave the app.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

import PhoneMarkdown from './PhoneMarkdown';
import { showToast } from '@/components/ui/ToastContainer';

const MARKDOWN = [
  '[观看配套短片](../../ai-video/assets/riemann/黎曼猜想.mp4)',
  '',
  '[素材](assets/)',
  '',
  '[另一篇](other-EN.md#intro)',
  '',
  '[作者声明](https://example.com/statement)',
  '',
  '[越界](../../../../outside.txt)',
].join('\n');

describe('PhoneMarkdown links', () => {
  const onOpenFile = vi.fn();
  const onOpenDir = vi.fn();
  beforeEach(() => {
    onOpenFile.mockReset();
    onOpenDir.mockReset();
    vi.mocked(showToast).mockReset();
    render(
      <PhoneMarkdown content={MARKDOWN} projectPath="/w" filePath="/06-ai/ai-blog/articles/riemann-ZH.md" onOpenFile={onOpenFile} onOpenDir={onOpenDir} />,
    );
  });

  it('opens a linked video by its decoded path, not only Markdown', () => {
    fireEvent.click(screen.getByText('观看配套短片'));
    expect(onOpenFile).toHaveBeenCalledWith('/06-ai/ai-video/assets/riemann/黎曼猜想.mp4');
  });

  it('still opens another Markdown file, without its #fragment', () => {
    fireEvent.click(screen.getByText('另一篇'));
    expect(onOpenFile).toHaveBeenCalledWith('/06-ai/ai-blog/articles/other-EN.md');
  });

  it('opens a folder link as a folder', () => {
    fireEvent.click(screen.getByText('素材'));
    expect(onOpenDir).toHaveBeenCalledWith('/06-ai/ai-blog/articles/assets');
    expect(onOpenFile).not.toHaveBeenCalled();
  });

  it('opens nothing for a link above the project root, and says so', () => {
    fireEvent.click(screen.getByText('越界'));
    expect(onOpenFile).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith('This link points outside the project', 'error');
  });

  it('leaves a web link to the browser', () => {
    const link = screen.getByText('作者声明').closest('a')!;
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('href', 'https://example.com/statement');
  });
});
