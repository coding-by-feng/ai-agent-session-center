import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import WorkdirLauncher from './WorkdirLauncher';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { computeMovePickerPosition } from '@/lib/queueMovePlacement';

// The recent-directories launcher: a recent directory, a CLI button, one POST. It has two hosts —
// the folder-and-clock icon in the session panel's strip, and the DIRS button on the LIVE page's
// "no sessions yet" card — and nothing else pins what a click here actually sends.
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
// One array for every render: the component re-runs its effect whenever the list's identity changes, so a
// factory returning a fresh literal each call re-renders it forever.
const { KNOWN } = vi.hoisted(() => ({ KNOWN: ['/Users/me/agent-manager'] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN }));

const DIR = '/Users/me/agent-manager';
const ICON = 'Recent directories';
/** Each host styles its own trigger (the strip's icon row, the card's buttons). */
const hostClass = (open: boolean) => (open ? 'host-trigger host-open' : 'host-trigger');

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('WorkdirLauncher', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let selectSession: ReturnType<typeof vi.fn>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
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
    render(<WorkdirLauncher triggerClassName={hostClass} />);
    fireEvent.click(screen.getByRole('button', { name: ICON }));
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

// The menu is portaled to <body> and placed with `position: fixed` from the
// trigger's viewport rect, so neither the session panel's `will-change:
// transform` (which re-anchors `position: fixed`) nor a scrolling ancestor can
// move or crop it.
describe('WorkdirLauncher — the menu is placed from its trigger', () => {
  it('places the dropdown under the trigger from its viewport rect', () => {
    render(<WorkdirLauncher triggerClassName={hostClass} />);
    const trigger = screen.getByRole('button', { name: ICON });
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

  it('keeps a real-sized menu inside the window, and re-places it on resize and on a scroll', () => {
    // a 300 x 200 menu (jsdom lays nothing out, so give it a size)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('tabindex') === '-1' ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('tabindex') === '-1' ? 200 : 0;
    });
    const innerWidth = window.innerWidth;
    try {
      render(<WorkdirLauncher triggerClassName={hostClass} />);
      const trigger = screen.getByRole('button', { name: ICON });
      const rectAt = (left: number) =>
        ({ top: 60, bottom: 84, left, right: left + 47, width: 47, height: 24, x: left, y: 60, toJSON: () => ({}) }) as DOMRect;
      const spy = vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue(rectAt(900));
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
      fireEvent.click(trigger);
      const menu = screen.getByText('Recent Directories').parentElement as HTMLElement;
      expect(menu.style.getPropertyValue('--dd-top')).toBe('86px'); // 2px under the trigger
      expect(menu.style.getPropertyValue('--dd-left')).toBe('716px'); // 1024 - 8 - 300: pulled in from the edge
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
      act(() => { window.dispatchEvent(new Event('resize')); });
      expect(menu.style.getPropertyValue('--dd-left')).toBe('492px'); // 800 - 8 - 300
      spy.mockReturnValue(rectAt(50)); // a scrolling ancestor moved the trigger
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
    const menu = readZIndex('WorkdirLauncher.module.css', 'dropdown');
    expect(menu).toBeGreaterThan(readZIndex('DetailPanel.module.css', 'detailOverlay'));
    expect(menu).toBeGreaterThanOrEqual(10000);
  });
});

// The session panel's strip shows the launcher as a folder-and-clock icon, its
// own open state, and a menu portaled to <body>: `.panel` has `will-change:
// transform`, which makes it the containing block for `position: fixed`.
describe('WorkdirLauncher — the session panel copy (icon)', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' }));
    vi.stubGlobal('fetch', fetchMock);
    useSessionStore.setState({ selectSession: vi.fn() } as never);
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    vi.unstubAllGlobals();
  });

  const openPanelCopy = () => {
    const view = render(<WorkdirLauncher triggerClassName={hostClass} />);
    fireEvent.click(screen.getByRole('button', { name: ICON }));
    return view;
  };

  // The rail's icon line is budgeted for 26px icons; a text label would wrap it.
  it('is an icon button, named for screen readers and hover only', () => {
    render(<WorkdirLauncher triggerClassName={hostClass} />);
    const trigger = screen.getByRole('button', { name: ICON });
    expect(trigger.textContent).toBe('');
    expect(trigger).toHaveAttribute('title', ICON);
    // A disclosure, not an ARIA menu: the panel is a list of buttons.
    expect(trigger).not.toHaveAttribute('aria-haspopup');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it("opens its own menu and wears its host's open class", () => {
    openPanelCopy();
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: ICON });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveClass('host-trigger', 'host-open');
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
    const trigger = screen.getByRole('button', { name: ICON });
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
    render(<WorkdirLauncher triggerClassName={hostClass} />);
    const trigger = screen.getByRole('button', { name: ICON });
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 }); // Enter / Space
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Launch Claude in agent-manager' }));
    expect(trigger).toHaveAttribute('aria-controls', screen.getByText('Recent Directories').parentElement?.id);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('opened with the mouse, leaves focus on its icon', () => {
    render(<WorkdirLauncher triggerClassName={hostClass} />);
    const trigger = screen.getByRole('button', { name: ICON });
    trigger.focus();
    fireEvent.click(trigger, { detail: 1 });
    expect(screen.getByText('Recent Directories')).toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});

// The LIVE page's "no sessions yet" card shows the launcher as a text button,
// DIRS. It used to open the top bar's DIRS menu through a shared uiStore flag;
// the top bar's copy is gone (the session panel's strip carries it), so the
// card's button is a launcher of its own, portaled like the strip's.
describe('WorkdirLauncher — a labelled copy (the LIVE card)', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows its label, is named by it, and says whether its panel is open', () => {
    render(<WorkdirLauncher label="DIRS" triggerClassName={hostClass} />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    expect(dirs).toHaveTextContent('DIRS');
    expect(dirs).toHaveClass('host-trigger');
    expect(dirs).not.toHaveAttribute('aria-haspopup');
    expect(dirs).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(dirs);
    expect(dirs).toHaveAttribute('aria-expanded', 'true');
    expect(dirs).toHaveClass('host-open');
    expect(screen.getByRole('button', { name: 'Launch Claude in agent-manager' })).toBeInTheDocument();
  });

  it('an empty label falls back to the icon, never an empty, unnamed button', () => {
    render(<WorkdirLauncher label="" triggerClassName={hostClass} />);
    const trigger = screen.getByRole('button', { name: ICON });
    expect(trigger.querySelector('svg')).not.toBeNull();
  });

  it('portals its menu to <body> as well', () => {
    const { container } = render(<WorkdirLauncher label="DIRS" triggerClassName={hostClass} />);
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    const menu = screen.getByText('Recent Directories').parentElement as HTMLElement;
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
  });

  it('opened from the keyboard, moves focus into the menu, and Escape hands it back', () => {
    render(<WorkdirLauncher label="DIRS" triggerClassName={hostClass} />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    dirs.focus();
    fireEvent.click(dirs, { detail: 0 }); // Enter / Space
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Launch Claude in agent-manager' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(dirs);
  });

  it('opened with the mouse, leaves focus on the button', () => {
    render(<WorkdirLauncher label="DIRS" triggerClassName={hostClass} />);
    const dirs = screen.getByRole('button', { name: 'DIRS' });
    dirs.focus();
    fireEvent.click(dirs, { detail: 1 });
    expect(document.activeElement).toBe(dirs);
  });
});

// Both copies can be mounted at once: DetailPanel keeps the strip mounted,
// hidden (display: none), after its panel closes, and with no sessions left the
// LIVE card shows its DIRS at the same time. Each owns its open state, so one
// never opens the other, and the hidden one's click-outside never shuts the
// visible menu on the mousedown meant to launch.
describe('WorkdirLauncher — two copies on one page', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderBoth = () =>
    render(
      <>
        <div style={{ display: 'none' }}><WorkdirLauncher triggerClassName={hostClass} /></div>
        <WorkdirLauncher label="DIRS" triggerClassName={hostClass} />
      </>,
    );

  it("opening the card's DIRS opens only its own menu", () => {
    renderBoth();
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    expect(screen.getAllByText('Recent Directories')).toHaveLength(1);
    expect(screen.getByRole('button', { name: ICON, hidden: true })).toHaveAttribute('aria-expanded', 'false');
  });

  it("the hidden strip copy does not stop the card's menu from launching", async () => {
    renderBoth();
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    const launch = screen.getByRole('button', { name: 'Launch Claude in agent-manager' });
    fireEvent.mouseDown(launch);
    fireEvent.click(launch);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
