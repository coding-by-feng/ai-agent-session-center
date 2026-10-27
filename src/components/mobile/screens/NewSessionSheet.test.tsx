// NewSessionSheet.test.tsx — AASC-54: the phone's ＋ sheet browses the Mac's folders and asks
// "Start in a new folder?" before it starts a session where no agent has worked. `/api/folders`
// is a fake tree on a stubbed fetch, and the launch is mocked: nothing reaches a server or a process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/launchSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/launchSession')>()),
  launchSession: vi.fn(async () => ({ ok: true, terminalId: 'term-new', deduplicated: false })),
}));
const known = vi.hoisted(() => ({ ranked: ['/Users/me/code/known'] as string[] | null }));
vi.mock('@/hooks/useKnownProjects', () => ({ useRankedProjects: () => known.ranked }));

import NewSessionSheet from './NewSessionSheet';
import PhoneFolderBrowser from '../PhoneFolderBrowser';
import { launchSession } from '@/lib/launchSession';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

const HOME = '/Users/me';
const TREE: Record<string, string[]> = {
  [HOME]: ['code', 'Documents'],
  [`${HOME}/code`]: ['fresh', 'known'],
  [`${HOME}/code/fresh`]: [],
  [`${HOME}/code/known`]: [],
  [`${HOME}/Documents`]: [],
};

function folderAnswer(url: string): Response {
  const raw = new URL(url, 'http://mac').searchParams.get('path') || HOME;
  const path = raw.startsWith('~') ? raw.replace(/^~/, HOME) : raw;
  const names = TREE[path];
  if (!names) return { ok: false, status: 404, json: async () => ({ success: false, error: 'no' }) } as Response;
  const parent = path === HOME ? null : path.slice(0, path.lastIndexOf('/'));
  const data = { path, home: HOME, parent, folders: names.map((name) => ({ name, path: `${path}/${name}` })), truncated: false };
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => folderAnswer(url));
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(launchSession).mockClear();
  known.ranked = ['/Users/me/code/known'];
  useSessionStore.setState({ sessions: new Map() });
});

afterEach(() => {
  act(() => useUiStore.getState().closeModal());
  vi.unstubAllGlobals();
});

async function openBrowser(user: ReturnType<typeof userEvent.setup>) {
  render(<NewSessionSheet open onClose={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Browse folders…' }));
  return screen.findByRole('dialog', { name: 'Choose a folder' });
}

describe('PhoneFolderBrowser', () => {
  it('opens at the home folder, drills down, and goes back up by its crumbs', async () => {
    const user = userEvent.setup();
    const browser = await openBrowser(user);
    await within(browser).findByRole('button', { name: 'Open code' });
    // At home: nothing to use yet (the home folder itself is not a project).
    expect(within(browser).getByRole('button', { name: 'Use this folder' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(within(browser).getByRole('button', { name: 'Open code' }));
    await within(browser).findByRole('button', { name: 'Open fresh' });
    const crumbs = within(browser).getByRole('navigation', { name: 'Folder path' });
    expect(crumbs.textContent).toBe('Home›code');
    expect(within(browser).getByText('Used before')).toBeTruthy(); // ~/code/known is a known project
    await user.click(within(crumbs).getByRole('button', { name: 'Home' }));
    await within(browser).findByRole('button', { name: 'Open Documents' });
    expect(fetchMock).toHaveBeenLastCalledWith(`/api/folders?path=${encodeURIComponent(HOME)}`, expect.anything());
  });

  it('falls back to the home folder when the folder it opens with can’t be browsed', async () => {
    const onPick = vi.fn();
    render(<PhoneFolderBrowser open onClose={vi.fn()} onPick={onPick} startPath="/etc" />);
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    await within(browser).findByRole('button', { name: 'Open code' });
    expect(fetchMock.mock.calls.map(([u]) => u)).toEqual(['/api/folders?path=%2Fetc', '/api/folders']);
  });

  it('says why a folder can’t be opened, and offers the home folder', async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementationOnce(async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response);
    render(<PhoneFolderBrowser open onClose={vi.fn()} onPick={vi.fn()} />);
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    expect((await within(browser).findByRole('alert')).textContent).toMatch(/aren’t hidden or private/);
    await user.click(within(browser).getByRole('button', { name: 'Go to the home folder' }));
    await within(browser).findByRole('button', { name: 'Open code' });
  });
});

describe('NewSessionSheet: a folder found by browsing', () => {
  it('asks “Start in a new folder?” before it starts where no agent has worked, and only then starts', async () => {
    const user = userEvent.setup();
    const browser = await openBrowser(user);
    await user.click(await within(browser).findByRole('button', { name: 'Open code' }));
    await user.click(await within(browser).findByRole('button', { name: 'Open fresh' }));
    await user.click(await within(browser).findByRole('button', { name: 'Use “fresh”' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull());

    const sheet = screen.getByRole('dialog', { name: 'New session' });
    expect(within(sheet).getByText('No agent has worked here yet.')).toBeTruthy();
    await user.click(within(sheet).getByRole('button', { name: 'New Codex session in fresh' }));
    const confirm = await screen.findByRole('dialog', { name: 'Start in a new folder?' });
    expect(confirm.textContent).toContain(`${HOME}/code/fresh`);
    expect(confirm.textContent).toContain('Codex will start there');
    expect(launchSession).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(launchSession).not.toHaveBeenCalled();

    await user.click(within(sheet).getByRole('button', { name: 'New Claude session in fresh' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Start in a new folder?' })).getByRole('button', { name: 'Start here' }));
    await waitFor(() => expect(launchSession).toHaveBeenCalledWith({
      workingDir: `${HOME}/code/fresh`, command: 'claude', forceNew: true, requireExistingDir: true,
    }));
  });

  it('starts a known folder or a live session’s folder in one tap, without the confirm', async () => {
    const user = userEvent.setup();
    const browser = await openBrowser(user);
    await user.click(await within(browser).findByRole('button', { name: 'Open code' }));
    await user.click(await within(browser).findByRole('button', { name: 'Open known' }));
    await user.click(await within(browser).findByRole('button', { name: 'Use “known”' }));
    const sheet = screen.getByRole('dialog', { name: 'New session' });
    const chosen = within(sheet).getByRole('region', { name: 'Chosen folder' });
    await user.click(within(chosen).getByRole('button', { name: 'New Claude session in known' }));
    await waitFor(() => expect(launchSession).toHaveBeenCalledWith(expect.objectContaining({ workingDir: `${HOME}/code/known` })));
    expect(screen.queryByRole('dialog', { name: 'Start in a new folder?' })).toBeNull();
  });

  it('carries the chosen folder into the full form', async () => {
    const user = userEvent.setup();
    const browser = await openBrowser(user);
    await user.click(await within(browser).findByRole('button', { name: 'Open Documents' }));
    await user.click(await within(browser).findByRole('button', { name: 'Use “Documents”' }));
    await user.click(screen.getByRole('button', { name: 'More options…' }));
    expect(useUiStore.getState().activeModal).toBe('new-session');
    expect(useUiStore.getState().newSessionDir).toBe(`${HOME}/Documents`);
  });
});

describe('NewSessionSheet layout and order', () => {
  it('lists the Mac’s ranking in its order (most used first)', () => {
    known.ranked = ['/Users/me/busy', '/Users/me/quiet'];
    render(<NewSessionSheet open onClose={vi.fn()} />);
    const recent = screen.getByRole('region', { name: 'Recent projects' });
    expect(within(recent).getAllByRole('button', { name: /^New Claude session in / }).map((b) => b.getAttribute('aria-label')))
      .toEqual(['New Claude session in busy', 'New Claude session in quiet']);
  });

  it('lists nothing, and doesn’t say "No projects yet", until the ranking arrives', () => {
    known.ranked = null;
    render(<NewSessionSheet open onClose={vi.fn()} />);
    expect(screen.queryByRole('region', { name: 'Recent projects' })).toBeNull();
    expect(screen.queryByText(/No projects yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Browse folders…' })).toBeTruthy();
  });

  it('shows Browse and More options above the recent projects, so they need no scroll', () => {
    render(<NewSessionSheet open onClose={vi.fn()} />);
    const browse = screen.getByRole('button', { name: 'Browse folders…' });
    const more = screen.getByRole('button', { name: 'More options…' });
    const recent = screen.getByRole('region', { name: 'Recent projects' });
    expect(browse.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(more.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
