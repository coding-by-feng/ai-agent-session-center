import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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

// App.tsx unmounts the top bar while a session panel is open, so the panel's
// strip carries its own copy of DIRS, as a folder icon. Two things set that
// copy apart from the top bar's:
//  - DetailPanel keeps the strip mounted, hidden, after the panel closes
//    (lastSessionRef), at the same moment the top bar comes back. Sharing the
//    uiStore flag, the top bar's DIRS would open the hidden copy too, and the
//    hidden copy's click-outside would shut the visible menu on the very
//    mousedown meant to launch. So the panel copy owns its open state.
//  - `.panel` has `will-change: transform`, which makes it the containing block
//    for `position: fixed`, so the menu is portaled to <body>.
describe('WorkdirLauncher — the session panel copy', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    useUiStore.setState({ workdirLauncherOpen: false });
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' }));
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.setState({ selectSession: vi.fn() } as never);
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    vi.unstubAllGlobals();
  });

  const openPanelCopy = () => {
    const view = render(<WorkdirLauncher variant="panel" />);
    fireEvent.click(screen.getByRole('button', { name: 'Recent directories' }));
    return view;
  };

  // The panel closed: its strip is still mounted (hidden), and the top bar is back.
  const renderPanelClosed = () =>
    render(
      <>
        <div data-testid="topbar"><WorkdirLauncher /></div>
        <div data-testid="panel" style={{ display: 'none' }}><WorkdirLauncher variant="panel" /></div>
      </>,
    );

  // The rail's icon line is budgeted for 26px icons; the top bar's DIRS label would wrap it.
  it('is an icon button, named for screen readers and hover only', () => {
    render(<WorkdirLauncher variant="panel" />);
    const trigger = screen.getByRole('button', { name: 'Recent directories' });
    expect(trigger.textContent).toBe('');
    expect(trigger).toHaveAttribute('title', 'Recent directories');
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it("opens its own menu and leaves the top bar's shared flag alone", () => {
    openPanelCopy();
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recent directories' })).toHaveAttribute('aria-expanded', 'true');
    expect(useUiStore.getState().workdirLauncherOpen).toBe(false);
  });

  it('portals the menu to <body>, out of the panel that would re-anchor a fixed menu', () => {
    const { container } = openPanelCopy();
    const menu = screen.getByText('Recent Directories').parentElement as HTMLElement;
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('launches from a click inside the portaled menu', async () => {
    openPanelCopy();
    const launch = screen.getByRole('button', { name: 'Launch Codex in agent-manager' });
    fireEvent.mouseDown(launch);
    fireEvent.click(launch);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ workingDir: DIR, command: 'codex' });
  });

  it('closes on a click anywhere else', () => {
    openPanelCopy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('Recent Directories')).toBeNull();
  });

  // DetailPanel listens for Escape on window (close search, leave maximized).
  it("Escape closes it without reaching the panel's own Escape handler", () => {
    const panelEscape = vi.fn();
    window.addEventListener('keydown', panelEscape);
    try {
      openPanelCopy();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByText('Recent Directories')).toBeNull();
      expect(panelEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', panelEscape);
    }
  });

  // A deselect hides the strip (display: none) instead of unmounting it, and a
  // menu portaled to <body> does not hide with it: it would float over the
  // dashboard. jsdom has no layout or ResizeObserver, so both are stood in for.
  it('closes when its icon stops being laid out, so the menu cannot outlive the panel', () => {
    let notify: () => void = () => {};
    const observed: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { notify = cb; }
      observe(target: Element) { observed.push(target); }
      disconnect() {}
    });
    openPanelCopy();
    const trigger = screen.getByRole('button', { name: 'Recent directories' });
    // The icon is what a hidden strip takes out of layout; the menu, in <body>, never is.
    expect(observed).toEqual([trigger]);
    const box = { top: 0, left: 0, bottom: 26, right: 26, width: 26, height: 26, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    const rects = vi.spyOn(trigger, 'getClientRects').mockReturnValue([box] as unknown as DOMRectList);
    act(() => notify());
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    rects.mockReturnValue([] as unknown as DOMRectList);
    act(() => notify());
    expect(screen.queryByText('Recent Directories')).toBeNull();
  });

  // The terminal's fullscreen hides the panel with `visibility: hidden`
  // (body.term-fullscreen), which keeps the icon's box, so no resize fires.
  it("closes when the terminal goes fullscreen, rather than floating over it", async () => {
    openPanelCopy();
    // MutationObserver callbacks run as microtasks: an async act() waits for them.
    await act(async () => { document.body.classList.add('some-other-state'); });
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    try {
      await act(async () => { document.body.classList.add('term-fullscreen'); });
      expect(screen.queryByText('Recent Directories')).toBeNull();
    } finally {
      document.body.classList.remove('term-fullscreen', 'some-other-state');
    }
  });

  // Portaled to the end of <body>, the menu is no longer the next stop after
  // its icon in Tab order (and the terminal behind it swallows Tab): a keyboard
  // user who opened it could never reach a launch button.
  it('opened from the keyboard, moves focus into the menu, and Escape hands it back', () => {
    render(<WorkdirLauncher variant="panel" />);
    const trigger = screen.getByRole('button', { name: 'Recent directories' });
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 }); // Enter / Space
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Launch Claude in agent-manager' }));
    expect(trigger).toHaveAttribute('aria-controls', screen.getByText('Recent Directories').parentElement?.id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('opened with the mouse, leaves focus on its icon', () => {
    render(<WorkdirLauncher variant="panel" />);
    const trigger = screen.getByRole('button', { name: 'Recent directories' });
    trigger.focus();
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });

  it("stays shut when the top bar's DIRS or the LIVE card opens the shared menu", () => {
    renderPanelClosed();
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    expect(screen.getAllByText('Recent Directories')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Recent directories', hidden: true }))
      .toHaveAttribute('aria-expanded', 'false');
  });

  it("does not stop the top bar's menu from launching", async () => {
    renderPanelClosed();
    const topbar = within(screen.getByTestId('topbar'));
    fireEvent.click(topbar.getByRole('button', { name: 'DIRS' }));
    const launch = topbar.getByRole('button', { name: 'Launch Claude in agent-manager' });
    fireEvent.mouseDown(launch);
    fireEvent.click(launch);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("does not close the top bar's menu when it unmounts", () => {
    const { unmount } = render(<WorkdirLauncher variant="panel" />);
    act(() => useUiStore.getState().setWorkdirLauncherOpen(true));
    unmount();
    expect(useUiStore.getState().workdirLauncherOpen).toBe(true);
  });

  // Portaled, the menu is a SIBLING of `.detailOverlay` in the root stacking
  // context, not its child: below the panel's z-index it opens, places itself
  // and is painted behind the panel (the QueueMovePicker bug). The two rules
  // live in CSS modules that cannot reference each other, so read the source.
  it('sits above the session panel, in the <body>-portal band', () => {
    const readZIndex = (file: string, cls: string): number => {
      const css = readFileSync(resolve(__dirname, '../../styles/modules', file), 'utf8');
      const block = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(css);
      if (!block) throw new Error(`.${cls} not found in ${file}`);
      const z = /z-index:\s*(\d+)/.exec(block[1]);
      if (!z) throw new Error(`.${cls} in ${file} declares no z-index`);
      return Number(z[1]);
    };
    const menu = readZIndex('WorkdirLauncher.module.css', 'dropdownPortaled');
    expect(menu).toBeGreaterThan(readZIndex('DetailPanel.module.css', 'detailOverlay'));
    expect(menu).toBeGreaterThanOrEqual(10000);
  });
});
