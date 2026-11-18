// A file printed with an absolute path outside the session's folder opens in a PROJECT sub-tab rooted at
// its own folder (Nov 17 2026): before, the PROJECT tab asked for `<root>/Users/…` and showed nothing.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useUiStore } from '@/stores/uiStore';

vi.mock('./ProjectTab', () => ({
  default: (p: { projectPath: string; initialPath?: string; initialIsFile?: boolean; navigateToFile?: string | null }) => (
    <div data-testid="project-tab" data-root={p.projectPath} data-initial={p.initialPath ?? ''} data-file={String(!!p.initialIsFile)} data-nav={p.navigateToFile ?? ''} />
  ),
}));

import ProjectTabContainer from './ProjectTabContainer';

const ROOT = '/Users/me/aasc/public/website';
const DOCS = '/Users/me/aasc/private/docs';

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({ pendingFileOpen: null });
});

const tabs = () => screen.getAllByTestId('project-tab');

describe('ProjectTabContainer: a file outside the session folder', () => {
  it('opens a sub-tab rooted at the file’s folder, on the file', async () => {
    render(<ProjectTabContainer projectPath={ROOT} sessionId="s1" />);
    act(() => { useUiStore.getState().openFileInProject('plan.md', DOCS, ROOT); });
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
    const sub = tabs()[1];
    expect(sub.dataset.root).toBe(DOCS);
    expect(sub.dataset.initial).toBe('plan.md');
    expect(sub.dataset.file).toBe('true');
    expect(useUiStore.getState().pendingFileOpen).toBeNull();
  });

  it('a second click brings back the same sub-tab instead of adding one', async () => {
    render(<ProjectTabContainer projectPath={ROOT} sessionId="s1" />);
    act(() => { useUiStore.getState().openFileInProject('plan.md', DOCS, ROOT); });
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
    act(() => { useUiStore.getState().openFileInProject('plan.md', DOCS, ROOT); });
    await vi.waitFor(() => expect(useUiStore.getState().pendingFileOpen).toBeNull());
    expect(tabs()).toHaveLength(2);
  });

  it('another session’s container leaves it alone', async () => {
    render(<ProjectTabContainer projectPath="/Users/me/other" sessionId="s2" />);
    act(() => { useUiStore.getState().openFileInProject('plan.md', DOCS, ROOT); });
    await new Promise((r) => setTimeout(r, 20));
    expect(tabs()).toHaveLength(1);
    expect(useUiStore.getState().pendingFileOpen).not.toBeNull();
  });

  it('a file inside the folder still opens in the main tab', async () => {
    render(<ProjectTabContainer projectPath={ROOT} sessionId="s1" />);
    act(() => { useUiStore.getState().openFileInProject('src/a.md', ROOT); });
    await vi.waitFor(() => expect(tabs()[0].dataset.nav).toBe('src/a.md'));
    expect(tabs()).toHaveLength(1);
  });
});

// Nov 18 2026: a folder named in the chat or the terminal opens as a sub-tab rooted at it.
describe('ProjectTabContainer: a folder', () => {
  it('opens a sub-tab at the folder, and a second click brings it back', async () => {
    render(<ProjectTabContainer projectPath={ROOT} sessionId="s1" />);
    act(() => { useUiStore.getState().openFileInProject('/', DOCS, ROOT, 'dir'); });
    await vi.waitFor(() => expect(tabs()).toHaveLength(2));
    const sub = tabs()[1];
    expect(sub.dataset.root).toBe(DOCS);
    expect(sub.dataset.file).toBe('false');
    expect(useUiStore.getState().pendingFileOpen).toBeNull();
    act(() => { useUiStore.getState().openFileInProject('/', DOCS, ROOT, 'dir'); });
    await vi.waitFor(() => expect(useUiStore.getState().pendingFileOpen).toBeNull());
    expect(tabs()).toHaveLength(2);
  });

  it('the session folder itself is the tab already open', async () => {
    render(<ProjectTabContainer projectPath={ROOT} sessionId="s1" />);
    act(() => { useUiStore.getState().openFileInProject('/', ROOT, ROOT, 'dir'); });
    await vi.waitFor(() => expect(useUiStore.getState().pendingFileOpen).toBeNull());
    expect(tabs()).toHaveLength(1);
  });
});
