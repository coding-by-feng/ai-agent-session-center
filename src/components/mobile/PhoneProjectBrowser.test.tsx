/**
 * The PROJECT tab on a phone (AASC-20, features 46–50): a read-only
 * drill-down. What is pinned here is the phone's contract with the Mac — only
 * GETs of /api/files/(list|read|search|grep|stream), nothing to edit, a refused
 * (404) path explained instead of a broken screen — and the screens: folder →
 * folder → file with a breadcrumb and Back, the outline as a sheet, search that
 * opens a file at its match, full screen, and a terminal link landing here.
 * The pixels are checked in the phone harness (scratch/phone-harness).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PhoneProjectBrowser from './PhoneProjectBrowser';
import { useUiStore } from '@/stores/uiStore';
import { closeTopBackLayer } from '@/lib/backLayers';
import { ScreenSlotContext } from './kit/screenSlot';

vi.mock('@/components/session/PdfViewer', () => ({
  default: (p: { src: string; compact?: boolean }) => <div data-testid="pdf" data-src={p.src} data-compact={String(p.compact)} />,
}));
vi.mock('@/components/session/TexViewer', () => ({
  default: (p: { source: string; compact?: boolean }) => <div data-testid="tex" data-compact={String(p.compact)}>{p.source}</div>,
}));

const ROOT = '/Users/me/proj';
const MD = '# Title\n\nIntro.\n\n## Setup\n\nSteps.\n\n## Usage\n\nMore.';
const CODE = Array.from({ length: 60 }, (_, i) => (i === 41 ? 'const target = sendPrompt();' : `line ${i + 1}`)).join('\n');
const TREE: Record<string, Array<{ name: string; type: 'dir' | 'file'; size?: number }>> = {
  '/': [
    { name: 'docs', type: 'dir' }, { name: 'secret', type: 'dir' }, { name: 'src', type: 'dir' },
    { name: '.env', type: 'file', size: 10 }, { name: 'README.md', type: 'file', size: MD.length },
  ],
  '/src': [{ name: 'lib', type: 'dir' }],
  '/src/lib': [{ name: 'a.ts', type: 'file', size: CODE.length }],
  '/docs': [{ name: 'm.pdf', type: 'file', size: 9 }, { name: 'p.tex', type: 'file', size: 9 }, { name: 'h.png', type: 'file', size: 9 }],
};
const FILES: Record<string, object> = {
  '/README.md': { content: MD, ext: 'md' },
  '/src/lib/a.ts': { content: CODE, ext: 'ts' },
  '/docs/m.pdf': { streamable: true, ext: 'pdf' },
  '/docs/p.tex': { content: '\\section{Intro}', ext: 'tex' },
  '/docs/h.png': { streamable: true, ext: 'png' },
};
const refused = (p: string) => p === '/.env' || p.startsWith('/secret');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const notFound = () => json({ error: 'Not found', code: 'PHONE_NOT_ALLOWED' }, 404);

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  void init;
  const u = new URL(url, 'http://phone');
  const path = u.searchParams.get('path') ?? '/';
  if (u.pathname === '/api/files/list') return refused(path) || !TREE[path] ? notFound() : json({ path, items: TREE[path] });
  if (u.pathname === '/api/files/read') {
    if (refused(path) || !FILES[path]) return notFound();
    return json({ path, name: path.split('/').pop(), size: 9, ...FILES[path] });
  }
  if (u.pathname === '/api/files/search') {
    return json({ results: [{ path: '/src/lib', name: 'lib', type: 'dir' }, { path: '/src/lib/a.ts', name: 'a.ts', type: 'file' }], indexing: false });
  }
  if (u.pathname === '/api/files/grep') return json({ matches: [{ file: '/src/lib/a.ts', line: 42, text: 'const target = sendPrompt();' }], truncated: false });
  return notFound();
});

const renderBrowser = () => render(<PhoneProjectBrowser projectPath={ROOT} sessionId="s1" />);
const root = () => document.querySelector('[data-phone-project]') as HTMLElement;
const button = (name: string | RegExp) => within(root()).getByRole('button', { name });
const openRow = async (name: string | RegExp) => fireEvent.click(await within(root()).findByRole('button', { name }));

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  useUiStore.setState({ pendingFileOpen: null });
});
afterEach(() => vi.unstubAllGlobals());

describe('PhoneProjectBrowser — the drill-down', () => {
  it('goes folder → folder → file with a breadcrumb and Back, and back up again', async () => {
    renderBrowser();
    expect(await within(root()).findByRole('button', { name: 'Folder docs' })).toBeInTheDocument();
    expect(within(root()).queryByRole('button', { name: 'Back' })).toBeNull();

    await openRow('Folder src');
    await openRow('Folder lib');
    const path = within(root()).getByRole('navigation', { name: 'Path' });
    expect(within(path).getAllByRole('button').map((b) => b.textContent)).toEqual(['proj', 'src']);
    expect(within(path).getByText('lib')).toHaveAttribute('aria-current', 'page');

    await openRow('a.ts');
    expect(await screen.findByText('const target = sendPrompt();')).toBeInTheDocument();
    expect(within(within(root()).getByRole('navigation', { name: 'Path' })).getByText('a.ts')).toHaveAttribute('aria-current', 'page');

    fireEvent.click(button('Back'));
    expect(await within(root()).findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
    fireEvent.click(within(within(root()).getByRole('navigation', { name: 'Path' })).getByRole('button', { name: 'proj' }));
    expect(await within(root()).findByRole('button', { name: 'Folder docs' })).toBeInTheDocument();
  });

  it('is read-only: no editing control anywhere, and only GETs of the read routes', async () => {
    renderBrowser();
    await openRow('README.md');
    await screen.findByRole('heading', { name: 'Title' });
    fireEvent.click(button('Source'));
    await openRowBack();
    await openRow('Folder src');
    for (const b of document.querySelectorAll('button')) {
      expect(b.textContent + ' ' + b.getAttribute('aria-label')).not.toMatch(/edit|new file|new folder|delete|rename|save|upload|reveal|finder|open with/i);
    }
    expect(document.querySelector('textarea, [contenteditable=true]')).toBeNull();
    for (const [url, init] of fetchMock.mock.calls) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(url).toMatch(/^\/api\/files\/(list|read|search|grep|stream)\?/);
    }
  });

  it('remembers the folder, per project (AASC-56: a /clear keeps it)', async () => {
    const { unmount } = renderBrowser();
    await openRow('Folder src');
    await within(root()).findByRole('button', { name: 'Folder lib' });
    unmount();
    renderBrowser();
    expect(await within(root()).findByRole('button', { name: 'Folder lib' })).toBeInTheDocument();
    expect(button('Back')).toBeInTheDocument();
  });
});

async function openRowBack() {
  fireEvent.click(button('Back'));
  await within(root()).findByRole('button', { name: 'Folder docs' });
}

// e2e run 5, F5 (Android): the phone's Back from an open file left the whole session for the list, while the
// tab's own ‹ went back to the folder. The tab's folder/file steps are back layers now, like a sheet.
describe('PhoneProjectBrowser — the phone’s Back button', () => {
  it('walks back up the tab’s own steps, one per press, before the screen is popped', async () => {
    renderBrowser();
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    expect(await screen.findByText('const target = sendPrompt();')).toBeInTheDocument();

    act(() => { expect(closeTopBackLayer()).toBe(true); });
    expect(await within(root()).findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
    act(() => { expect(closeTopBackLayer()).toBe(true); });
    expect(await within(root()).findByRole('button', { name: 'Folder lib' })).toBeInTheDocument();
    act(() => { expect(closeTopBackLayer()).toBe(true); });
    expect(await within(root()).findByRole('button', { name: 'Folder docs' })).toBeInTheDocument();
    // At the project's root there is nothing left in the tab: the frame pops the screen.
    expect(closeTopBackLayer()).toBe(false);
  });

  it('a screen pushed over the session takes the Back, not the hidden tab underneath', async () => {
    const { rerender } = render(
      <ScreenSlotContext.Provider value={{ isTop: true, registerScroller: () => {} }}>
        <PhoneProjectBrowser projectPath={ROOT} sessionId="s1" />
      </ScreenSlotContext.Provider>,
    );
    await openRow('Folder src');
    expect(await within(root()).findByRole('button', { name: 'Folder lib' })).toBeInTheDocument();
    rerender(
      <ScreenSlotContext.Provider value={{ isTop: false, registerScroller: () => {} }}>
        <PhoneProjectBrowser projectPath={ROOT} sessionId="s1" />
      </ScreenSlotContext.Provider>,
    );
    expect(closeTopBackLayer()).toBe(false);
    expect(within(root()).getByRole('button', { name: 'Folder lib' })).toBeInTheDocument();
  });
});

describe('PhoneProjectBrowser — refused paths (a paired phone gets a plain 404)', () => {
  it('says a refused folder is not available on this phone, with a way back', async () => {
    renderBrowser();
    await openRow('Folder secret');
    expect(await screen.findByText("This folder isn't available on this phone")).toBeInTheDocument();
    expect(screen.getByText(/never private files such as \.env/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Project folder' }));
    expect(await within(root()).findByRole('button', { name: 'Folder docs' })).toBeInTheDocument();
  });

  it('says a refused file is not available on this phone, and can try again', async () => {
    renderBrowser();
    await openRow('.env');
    expect(await screen.findByText("This file isn't available on this phone")).toBeInTheDocument();
    const reads = fetchMock.mock.calls.filter(([u]) => u.startsWith('/api/files/read')).length;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => u.startsWith('/api/files/read')).length).toBe(reads + 1));
  });

  it('says so when an image the Mac refuses fails to load', async () => {
    renderBrowser();
    await openRow('Folder docs');
    await openRow('h.png');
    const img = await screen.findByRole('img', { name: 'h.png' });
    expect(img.getAttribute('src')).toBe(`/api/files/stream?root=${encodeURIComponent(ROOT)}&path=%2Fdocs%2Fh.png`);
    fireEvent.error(img);
    expect(await screen.findByText("This file isn't available on this phone")).toBeInTheDocument();
  });
});

describe('PhoneProjectBrowser — viewers', () => {
  it('opens PDF and TeX in their compact phone viewers, lazily, from the stream route', async () => {
    renderBrowser();
    await openRow('Folder docs');
    await openRow('m.pdf');
    const pdf = await screen.findByTestId('pdf');
    expect(pdf.dataset.compact).toBe('true');
    expect(pdf.dataset.src).toBe(`/api/files/stream?root=${encodeURIComponent(ROOT)}&path=%2Fdocs%2Fm.pdf`);
    fireEvent.click(button('Back'));
    await openRow('p.tex');
    expect((await screen.findByTestId('tex')).dataset.compact).toBe('true');
    fireEvent.click(button('Source'));
    expect(screen.queryByTestId('tex')).toBeNull();
    expect(screen.getByText('\\section{Intro}')).toBeInTheDocument();
  });

  it('shows a Markdown outline as a sheet and jumps to the heading', async () => {
    const scrollTo = vi.fn();
    HTMLElement.prototype.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    renderBrowser();
    await openRow('README.md');
    expect(await screen.findByRole('heading', { name: 'Usage' })).toHaveAttribute('id', 'usage');
    fireEvent.click(button('Outline'));
    const sheet = screen.getByRole('dialog', { name: 'Outline' });
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual(['×', 'Title', 'Setup', 'Usage']);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Usage' }));
    expect(screen.queryByRole('dialog', { name: 'Outline' })).toBeNull();
    expect(scrollTo).toHaveBeenCalled();
  });

  it('goes full screen over the app and comes back, without reloading the file or its view', async () => {
    const { container } = renderBrowser();
    await openRow('README.md');
    await screen.findByRole('heading', { name: 'Title' });
    fireEvent.click(button('Source'));
    const reads = () => fetchMock.mock.calls.filter(([u]) => u.startsWith('/api/files/read')).length;
    const before = reads();
    fireEvent.click(button('Full screen'));
    const full = await screen.findByRole('dialog', { name: 'README.md' });
    // Moved over the app (a child of <body>), out of the tab.
    expect(full.parentElement?.parentElement).toBe(document.body);
    expect(container.contains(full)).toBe(false);
    expect(within(full).getByRole('button', { name: 'Exit full screen' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(full).getByRole('button', { name: 'Source' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'README.md' })).toBeNull());
    expect(container.contains(button('Full screen'))).toBe(true);
    expect(button('Source')).toHaveAttribute('aria-pressed', 'true');
    expect(reads()).toBe(before);
  });
});

describe('PhoneProjectBrowser — search', () => {
  it('finds text and opens the file at the match, marked; Back returns to the results', async () => {
    renderBrowser();
    await within(root()).findByRole('button', { name: 'Folder docs' });
    fireEvent.click(button('Search the project'));
    fireEvent.click(button('Text'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'sendPrompt' } });
    fireEvent.click(button('Search'));
    const hit = await within(root()).findByRole('button', { name: /src\/lib\/a\.ts line 42/ });
    expect(fetchMock.mock.calls.some(([u]) => u.startsWith('/api/files/grep?') && !u.includes('glob'))).toBe(true);
    fireEvent.click(hit);
    const line = await waitFor(() => {
      const el = document.querySelector('[data-line="42"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(line.className).toMatch(/codeLineTarget/);
    expect(within(line).getByText('sendPrompt').tagName).toBe('MARK');
    fireEvent.click(button('Back'));
    expect(await within(root()).findByRole('button', { name: /src\/lib\/a\.ts line 42/ })).toBeInTheDocument();
  });

  it('never leaves Search disabled after leaving a search that was still running', async () => {
    let release: (() => void) | null = null;
    renderBrowser();
    await within(root()).findByRole('button', { name: 'Folder docs' });
    fireEvent.click(button('Search the project'));
    fireEvent.click(button('Text'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'slow' } });
    fetchMock.mockImplementationOnce(async () => new Promise<Response>((resolve) => {
      release = () => resolve(json({ matches: [], truncated: false }));
    }));
    fireEvent.click(button('Search'));
    await waitFor(() => expect(release).not.toBeNull());
    expect(button('Search')).toBeDisabled();
    fireEvent.click(button('Back'));
    fireEvent.click(await within(root()).findByRole('button', { name: 'Search the project' }));
    expect(button('Search')).toBeEnabled();
    release!();
  });

  it('finds names as you type, and a folder hit opens the folder', async () => {
    renderBrowser();
    await within(root()).findByRole('button', { name: 'Folder docs' });
    fireEvent.click(button('Search the project'));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'lib' } });
    fireEvent.click(await within(root()).findByRole('button', { name: /^lib/ }, { timeout: 2000 }));
    expect(await within(root()).findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
  });
});

describe('PhoneProjectBrowser — a file link from the terminal', () => {
  it('opens a file of this project, and says so for one outside it', async () => {
    renderBrowser();
    await within(root()).findByRole('button', { name: 'Folder docs' });
    act(() => useUiStore.getState().openFileInProject('src/lib/a.ts', ROOT));
    expect(await screen.findByText('const target = sendPrompt();')).toBeInTheDocument();
    expect(useUiStore.getState().pendingFileOpen).toBeNull();
    act(() => useUiStore.getState().openFileInProject('/etc/hosts', ROOT));
    expect(await screen.findByText('/etc/hosts is outside this project.')).toBeInTheDocument();
  });
});

describe('PhoneProjectBrowser — open and recent files (AASC-56)', () => {
  it('keeps every opened file one tap away; Close takes it off, and it stays under Recent', async () => {
    renderBrowser();
    await openRow('README.md');
    await screen.findByRole('heading', { name: 'Title' });
    fireEvent.click(button('Back'));
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    await screen.findByText('const target = sendPrompt();');

    fireEvent.click(button('Open and recent files, 2 open'));
    const sheet = await screen.findByTestId('project-files-sheet');
    const open = within(sheet).getByRole('region', { name: /Open/ });
    expect(within(open).getAllByRole('button', { name: /^Open / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Open src/lib/a.ts', 'Open README.md']);
    expect(within(open).getByText(/Reading/)).toBeInTheDocument();

    fireEvent.click(within(open).getByRole('button', { name: 'Close README.md' }));
    const recent = within(sheet).getByRole('region', { name: 'Recent' });
    fireEvent.click(within(recent).getByRole('button', { name: 'Open README.md' }));
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
    // Opened from the list, it sits over its own folder: Back goes there.
    fireEvent.click(button('Back'));
    expect(await within(root()).findByRole('button', { name: 'Folder docs' })).toBeInTheDocument();
  });

  it('closing the file on screen goes back to its folder', async () => {
    renderBrowser();
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    await screen.findByText('const target = sendPrompt();');
    fireEvent.click(button('Open and recent files, 1 open'));
    fireEvent.click(within(await screen.findByTestId('project-files-sheet')).getByRole('button', { name: 'Close all' }));
    expect(await within(root()).findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
    expect(button('Open and recent files')).toBeInTheDocument();
  });

  it('comes back to the file you were reading when the tab is shown again', async () => {
    const { unmount } = renderBrowser();
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    await screen.findByText('const target = sendPrompt();');
    unmount();
    renderBrowser();
    expect(await screen.findByText('const target = sendPrompt();')).toBeInTheDocument();
    fireEvent.click(button('Back'));
    expect(await within(root()).findByRole('button', { name: 'a.ts' })).toBeInTheDocument();
  });
});

describe('PhoneProjectBrowser — find in the file and coloured code (AASC-56)', () => {
  it('finds in a code file: counts, steps, marks the current hit', async () => {
    renderBrowser();
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    await screen.findByText('const target = sendPrompt();');
    fireEvent.click(button('Find in file'));
    const field = within(root()).getByRole('searchbox', { name: 'Find in this file' });
    fireEvent.change(field, { target: { value: 'line 5' } });
    // line 5, line 50 … line 59 (line 42 is the code line)
    expect(within(root()).getByRole('status').textContent).toBe('1 of 11');
    // The hit may cross coloured pieces ("line " and the number): all of it is marked current.
    const current = [...document.querySelectorAll('[data-line="5"] [data-find-current]')].map((el) => el.textContent).join('');
    expect(current).toBe('line 5');
    fireEvent.click(button('Next match'));
    expect(within(root()).getByRole('status').textContent).toBe('2 of 11');
    expect(document.querySelector('[data-line="50"] [data-find-current]')).not.toBeNull();
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(within(root()).getByRole('status').textContent).toBe('1 of 11');
    fireEvent.click(button('Previous match'));
    expect(within(root()).getByRole('status').textContent).toBe('11 of 11');
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(within(root()).getByRole('status').textContent).toBe('No matches');
    expect(button('Next match')).toBeDisabled();
    fireEvent.click(button('Close find'));
    expect(within(root()).queryByRole('searchbox', { name: 'Find in this file' })).toBeNull();
  });

  it('finds in a rendered Markdown page', async () => {
    renderBrowser();
    await openRow('README.md');
    await screen.findByRole('heading', { name: 'Usage' });
    fireEvent.click(button('Find in file'));
    fireEvent.change(within(root()).getByRole('searchbox', { name: 'Find in this file' }), { target: { value: 'steps' } });
    await waitFor(() => expect(within(root()).getByRole('status').textContent).toBe('1 of 1'));
  });

  it('colours code where highlight.js knows the language', async () => {
    renderBrowser();
    await openRow('Folder src');
    await openRow('Folder lib');
    await openRow('a.ts');
    const line = await waitFor(() => {
      const el = document.querySelector('[data-line="42"] .hljs-keyword');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    }, { timeout: 4000 });
    expect(line.textContent).toBe('const');
    expect(document.querySelector('[data-line="42"]')?.textContent).toContain('const target = sendPrompt();');
  });
});
