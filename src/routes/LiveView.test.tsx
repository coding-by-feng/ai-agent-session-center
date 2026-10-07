// LiveView.test.tsx — the separate AGENTS list on the LIVE page.
//
// On desktop it duplicated the session panel's own rail, so it is gone there:
// the LIVE tab opens the panel instead (see NavBar.live.test.tsx). On a phone
// (useIsMobile, ≤480px) the same list goes full-bleed and is the phone's
// session list, so it stays. The rule lives inside RobotListSidebar, so the
// 3D scene (which mounts it too) follows the same rule without its own check.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { Session } from '@/types';

// WebGL is not what these tests are about: the scene is a marker element.
const { scene } = vi.hoisted(() => ({ scene: { crash: false } }));
vi.mock('@/components/3d/CyberdromeScene', () => ({
  default: () => {
    if (scene.crash) throw new Error('WebGL context lost');
    return <div data-testid="scene" />;
  },
}));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));

import LiveView from './LiveView';
import RobotListSidebar from '@/components/3d/RobotListSidebar';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';

function phoneWidth(isPhone: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: isPhone && query.includes('max-width: 480px'),
    addEventListener: () => {},
    removeEventListener: () => {},
  })));
}

const session = (id: string): Session =>
  ({ sessionId: id, title: id, status: 'idle', lastActivityAt: Date.now(), events: [], promptHistory: [] } as unknown as Session);

beforeEach(() => {
  useSessionStore.setState({ sessions: new Map([['a', session('a')], ['b', session('b')]]), selectedSessionId: null });
  useSettingsStore.setState({ scene3dEnabled: false } as never);
  useWsStore.setState({ snapshotReceived: true });
  useUiStore.setState({ workspaceLoad: { active: false, total: 0, done: 0, currentTitle: '' }, workspaceRestorePending: false });
  useWsStore.setState({ connected: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the AGENTS list on the LIVE page', () => {
  it('is not shown on desktop', () => {
    phoneWidth(false);
    const { container } = render(<RobotListSidebar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is shown on a phone, where it is the session list', () => {
    phoneWidth(true);
    render(<RobotListSidebar />);
    expect(screen.getByText(/Agents \(2\)/i)).toBeInTheDocument();
  });

  it('desktop LIVE page (3D off): no AGENTS list; the session board shows instead of the old "3D Scene Paused" label', () => {
    phoneWidth(false);
    const { container } = render(<LiveView />);
    expect(screen.queryByText(/Agents \(/i)).toBeNull();
    expect(screen.queryByText(/3D Scene Paused/i)).toBeNull();
    expect(screen.getByRole('heading', { name: /Sessions \(2\)/i })).toBeInTheDocument();
    expect(container.querySelector('[class*="flatRoot"]')).not.toBeNull();
  });

  it('phone LIVE page (3D off): the list replaces the label, as before, and there is no board', () => {
    phoneWidth(true);
    render(<LiveView />);
    expect(screen.getByText(/Agents \(2\)/i)).toBeInTheDocument();
    expect(screen.getByText(/3D Scene Paused/i).className).toMatch(/scenePausedHasSidebar/);
    expect(screen.queryByRole('heading', { name: /Sessions \(/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /No agent sessions yet/i })).toBeNull();
  });
});

// What a desktop LIVE page (3D off) shows depends on whether the session list
// has loaded, and on whether there is anything in it. See lib/liveBoard.ts.
describe('the desktop LIVE page (3D off) before and after sessions exist', () => {
  beforeEach(() => phoneWidth(false));

  it('shows neither the board nor "no sessions" before the first snapshot, so returning users see no flash', () => {
    useWsStore.setState({ snapshotReceived: false });
    useSessionStore.setState({ sessions: new Map() });
    render(<LiveView />);
    expect(screen.queryByRole('heading', { name: /No agent sessions yet/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Sessions \(/i })).toBeNull();
  });

  it('shows how to start once loaded with no sessions', () => {
    useSessionStore.setState({ sessions: new Map() });
    render(<LiveView />);
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
  });

  it('holds "no sessions" back while a workspace restore is re-creating them', () => {
    useSessionStore.setState({ sessions: new Map() });
    useUiStore.setState({ workspaceLoad: { active: true, total: 3, done: 0, currentTitle: '' } });
    render(<LiveView />);
    expect(screen.queryByRole('heading', { name: /No agent sessions yet/i })).toBeNull();
  });

  it('holds "no sessions" back until the workspace auto-load has decided whether to restore', () => {
    useSessionStore.setState({ sessions: new Map() });
    useUiStore.setState({ workspaceRestorePending: true });
    render(<LiveView />);
    expect(screen.queryByRole('heading', { name: /No agent sessions yet/i })).toBeNull();
    act(() => useUiStore.setState({ workspaceRestorePending: false }));
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
  });

  it('counts only sessions it lists: an ended one does not keep the board up', () => {
    useSessionStore.setState({ sessions: new Map([['gone', { ...session('gone'), status: 'ended' } as Session]]) });
    render(<LiveView />);
    expect(screen.getByRole('heading', { name: /No agent sessions yet/i })).toBeInTheDocument();
  });

  it('keeps the HUD (sound and 3D toggles) in every state', () => {
    useSessionStore.setState({ sessions: new Map() });
    render(<LiveView />);
    expect(screen.getByRole('button', { name: /3D Off/i })).toBeInTheDocument();
  });
});

// With the 3D scene on there was no "no sessions yet" card: the top bar's + NEW
// and DIRS were the only way to start a session. Those moved into the session
// panel's strip, which cannot exist without a session, so the card shows over
// the scene whenever the scene has no robot, under the flat page's loading
// rules. The scene draws a robot only for a session the dashboard launched
// (`source: 'ssh'`), so a claude started in iTerm leaves it empty too.
describe('the desktop LIVE page with the 3D scene on', () => {
  const OFFICE = /No sessions in the 3D office yet/i;
  const robot = (id: string): Session => ({ ...session(id), source: 'ssh' } as Session);
  const outside = (id: string): Session => ({ ...session(id), source: 'iterm' } as Session);

  beforeEach(() => {
    phoneWidth(false);
    scene.crash = false;
    useSettingsStore.setState({ scene3dEnabled: true } as never);
  });

  it('shows how to start over the empty scene once loaded with no sessions', async () => {
    useSessionStore.setState({ sessions: new Map() });
    render(<LiveView />);
    expect(screen.getByRole('heading', { name: OFFICE })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ NEW' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'DIRS' })).toBeInTheDocument();
    // A claude started elsewhere gets no robot, so the card does not promise one.
    expect(screen.queryByText(/any terminal/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Turn on 3D/i })).toBeNull();
    expect(await screen.findByTestId('scene')).toBeInTheDocument(); // the scene stays under it
    // Around the card, the pointer reaches the scene (orbit / zoom).
    const heading = screen.getByRole('heading', { name: OFFICE });
    expect(heading.closest('[class*="wrapOverScene"]')).not.toBeNull();
  });

  it('shows no card while the scene has a robot', async () => {
    useSessionStore.setState({ sessions: new Map([['a', robot('a')], ['b', outside('b')]]) });
    render(<LiveView />);
    expect(await screen.findByTestId('scene')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: OFFICE })).toBeNull();
  });

  it('with only sessions started outside the dashboard, the office is empty: the card shows and points to LIVE', () => {
    useSessionStore.setState({ sessions: new Map([['a', outside('a')], ['b', outside('b')]]) });
    render(<LiveView />);
    expect(screen.getByRole('heading', { name: OFFICE })).toBeInTheDocument();
    expect(screen.getByText(/2 sessions are running outside the dashboard/i)).toHaveTextContent(/press LIVE/i);
  });

  it('waits for the first snapshot and for a restore decision, like the flat page', () => {
    useSessionStore.setState({ sessions: new Map() });
    useWsStore.setState({ snapshotReceived: false });
    render(<LiveView />);
    expect(screen.queryByRole('heading', { name: OFFICE })).toBeNull();
    act(() => useWsStore.setState({ snapshotReceived: true }));
    expect(screen.getByRole('heading', { name: OFFICE })).toBeInTheDocument();
    act(() => useUiStore.setState({ workspaceRestorePending: true }));
    expect(screen.queryByRole('heading', { name: OFFICE })).toBeNull();
  });

  it('a phone gets no card, as on the flat page', () => {
    phoneWidth(true);
    useSessionStore.setState({ sessions: new Map() });
    render(<LiveView />);
    expect(screen.queryByRole('heading', { name: OFFICE })).toBeNull();
  });

  // The scene's error screen (with RETRY) is centred where the card would be.
  it('a crashed scene shows its error, not the card over it', async () => {
    scene.crash = true;
    useSessionStore.setState({ sessions: new Map() });
    // React reports the caught error; the scene loads lazily, so keep it quiet until it has.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<LiveView />);
      expect(await screen.findByText(/3D scene error/i)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: OFFICE })).toBeNull();
    } finally {
      quiet.mockRestore();
    }
  });
});

// While loading, the page says nothing at first (no flash), then says why it is
// empty if it stays that way: a dead server, or a remote device the server
// refuses, would otherwise leave a blank page with only the HUD on it.
describe('the desktop LIVE page while the session list has not arrived', () => {
  beforeEach(() => {
    phoneWidth(false);
    vi.useFakeTimers();
    useWsStore.setState({ snapshotReceived: false });
  });
  afterEach(() => vi.useRealTimers());

  it('is quiet at first, then says it is still connecting', () => {
    useWsStore.setState({ connected: false });
    render(<LiveView />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => { vi.advanceTimersByTime(2500); });
    expect(screen.getByRole('status')).toHaveTextContent(/Connecting to the session server/i);
  });

  it('connected but still loading says so', () => {
    useWsStore.setState({ connected: true });
    render(<LiveView />);
    act(() => { vi.advanceTimersByTime(2500); });
    expect(screen.getByRole('status')).toHaveTextContent(/Loading sessions/i);
  });
});
