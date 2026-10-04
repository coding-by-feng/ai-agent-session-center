import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import WorkdirLauncher from './WorkdirLauncher';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';

// The DIRS launcher: a recent directory, a CLI button, one POST. NavBar's tests stub the whole
// component out, so nothing else pins what a click here actually sends.
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
// One array for every render: the component re-runs its effect whenever the list's identity changes, so a
// factory returning a fresh literal each call re-renders it forever.
const { KNOWN } = vi.hoisted(() => ({ KNOWN: ['/Users/me/agent-manager'] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN }));

const DIR = '/Users/me/agent-manager';

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('WorkdirLauncher', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let selectSession: ReturnType<typeof vi.fn>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    // The open state lives in uiStore now, so a test must not inherit an open dropdown.
    useUiStore.setState({ workdirLauncherOpen: false });
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    selectSession = vi.fn();
    useSessionStore.setState({ selectSession } as never);
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    vi.unstubAllGlobals();
  });

  const launch = (label: 'Claude' | 'Codex') => {
    render(<WorkdirLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    fireEvent.click(screen.getByRole('button', { name: `Launch ${label} in agent-manager` }));
  };

  it('starts the chosen CLI in the directory with a plain { workingDir, command } body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' }));
    launch('Codex');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/terminals');
    expect(init?.method).toBe('POST');
    // No forceNew: re-launching a directory that already runs the CLI reuses that session.
    expect(JSON.parse(String(init?.body))).toEqual({ workingDir: DIR, command: 'codex' });
  });

  it('selects the new session and says so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-9' }));
    launch('Claude');

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('term-9'));
    expect(showToast).toHaveBeenCalledWith('Launched claude in agent-manager', 'success');
    // The dropdown closes on launch.
    expect(screen.queryByText('Recent Directories')).toBeNull();
  });

  it('says so, rather than claiming a launch, when the server hands back the session already running there', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'existing', deduplicated: true }));
    launch('Claude');

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('existing'));
    expect(showToast).toHaveBeenCalledWith('claude is already running in agent-manager', 'info');
  });

  it("shows the server's reason when it refuses, and selects nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Session limit reached' }));
    launch('Claude');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Session limit reached', 'error'));
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    launch('Claude');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network error launching session', 'error'));
    expect(selectSession).not.toHaveBeenCalled();
  });
});

// The LIVE page's "no sessions yet" card has a DIRS button of its own. It
// opens THIS dropdown, under the top bar's DIRS, so the user also learns where
// DIRS lives. The open state is shared (uiStore) for that reason.
describe('WorkdirLauncher — opened from elsewhere', () => {
  beforeEach(() => {
    useUiStore.setState({ workdirLauncherOpen: false });
  });

  it('opens when another part of the page asks for it', () => {
    render(<WorkdirLauncher />);
    expect(screen.queryByText('Recent Directories')).toBeNull();
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
  });

  it('closing it with DIRS clears the shared state, so the next request opens it again', () => {
    render(<WorkdirLauncher />);
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    expect(useUiStore.getState().workdirLauncherOpen).toBe(false);
    expect(screen.queryByText('Recent Directories')).toBeNull();
  });

  it('closes when the top bar unmounts (a session panel opened), so it never comes back open by itself', () => {
    const { unmount } = render(<WorkdirLauncher />);
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    unmount();
    expect(useUiStore.getState().workdirLauncherOpen).toBe(false);
  });

  it('Escape closes it', () => {
    render(<WorkdirLauncher />);
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(useUiStore.getState().workdirLauncherOpen).toBe(false);
  });

  // Opened from the LIVE page's card, the dropdown sits in the top bar, far
  // back in tab order: without this a keyboard user is left on the card with
  // the menu out of reach.
  it('takes keyboard focus into the dropdown, and Escape hands it back', () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <WorkdirLauncher />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'elsewhere' });
    opener.focus();
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Launch Claude in agent-manager' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  it('opened from its own button, focus stays on that button', () => {
    render(<WorkdirLauncher />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    dirs.focus();
    fireEvent.click(dirs);
    expect(document.activeElement).toBe(dirs);
  });

  it('the DIRS button says it opens a menu, and whether it is open', () => {
    render(<WorkdirLauncher />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    expect(dirs).toHaveAttribute('aria-haspopup', 'true');
    expect(dirs).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(dirs);
    expect(dirs).toHaveAttribute('aria-expanded', 'true');
  });
});

// Below 640px the top bar is a sideways scroller (overflow-x: auto), and per CSS
// that clips an absolutely positioned child to the bar's own height: the
// dropdown opened, its button lit up, and nothing could be seen. It is placed
// with `position: fixed` from the button's viewport rect instead, which no
// ancestor's overflow clips, while it stays inside this component's DOM (so
// click-outside and the top bar's stacking order are unchanged).
describe('WorkdirLauncher — the top bar cannot crop the dropdown', () => {
  beforeEach(() => {
    useUiStore.setState({ workdirLauncherOpen: false });
  });

  it('places the dropdown under the DIRS button from its viewport rect', () => {
    render(<WorkdirLauncher />);
    const trigger = screen.getByRole('button', { name: 'DIRS' });
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      top: 60, bottom: 84, left: 93, right: 140, width: 47, height: 24, x: 93, y: 60, toJSON: () => ({}),
    } as DOMRect);
    fireEvent.click(trigger);
    const menu = screen.getByText('Recent Directories').parentElement as HTMLElement;
    // the same rule every portaled menu here uses (lib/queueMovePlacement.ts)
    const want = computeMovePickerPosition(
      { top: 60, bottom: 84, left: 93, right: 140 },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      'left',
    );
    expect(menu.style.getPropertyValue('--dd-top')).toBe(`${want.top}px`);
    expect(menu.style.getPropertyValue('--dd-left')).toBe(`${want.left}px`);
  });

  it('keeps a real-sized menu inside the window, and re-places it on resize and on a sideways scroll', () => {
    // a 300 x 200 menu (jsdom lays nothing out, so give it a size)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('tabindex') === '-1' ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('tabindex') === '-1' ? 200 : 0;
    });
    const innerWidth = window.innerWidth;
    try {
      render(<WorkdirLauncher />);
      const trigger = screen.getByRole('button', { name: 'DIRS' });
      const rectAt = (left: number) =>
        ({ top: 60, bottom: 84, left, right: left + 47, width: 47, height: 24, x: left, y: 60, toJSON: () => ({}) }) as DOMRect;
      const spy = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rectAt(900));
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
      fireEvent.click(trigger);
      const menu = screen.getByText('Recent Directories').parentElement as HTMLElement;
      expect(menu.style.getPropertyValue('--dd-top')).toBe('86px'); // 2px under the button
      expect(menu.style.getPropertyValue('--dd-left')).toBe('716px'); // 1024 - 8 - 300: pulled in from the edge
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(menu.style.getPropertyValue('--dd-left')).toBe('492px'); // 800 - 8 - 300
      spy.mockReturnValue(rectAt(50)); // the top bar scrolled sideways under it
      act(() => { document.dispatchEvent(new Event('scroll')); });
      expect(menu.style.getPropertyValue('--dd-left')).toBe('50px');
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
      vi.restoreAllMocks();
    }
  });

  it('the stylesheet positions it fixed, from those two variables', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/modules/WorkdirLauncher.module.css'), 'utf8');
    const rule = css.match(/\.dropdown\s*\{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/position:\s*fixed/);
    expect(rule).toMatch(/top:\s*var\(--dd-top/);
    expect(rule).toMatch(/left:\s*var\(--dd-left/);
  });
});
