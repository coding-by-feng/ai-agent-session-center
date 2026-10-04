// NavBar.live.test.tsx — what clicking the LIVE tab does to the session panel.
//
// Every tab used to call deselectSession(), so LIVE closed the session panel
// and dropped you on the dashboard to pick the session again. LIVE now opens
// the panel on the session you had open; only the panel's minimize (‒) hides
// it. The other tabs still close it so their own page can be seen.
// (Kept apart from NavBar.test.tsx, which covers which tabs a device gets.)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Session } from '@/types';

vi.mock('@/lib/deviceIdentity', () => ({
  getClientId: () => 'me',
  getClientLabel: () => 'Test Device',
}));
vi.mock('./WorkdirLauncher', () => ({ default: () => null }));

import NavBar from './NavBar';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWsStore } from '@/stores/wsStore';

const T = Date.now();

function s(id: string, over: Partial<Session> = {}): Session {
  return { sessionId: id, title: id, status: 'idle', lastActivityAt: T, events: [], promptHistory: [], ...over } as Session;
}

function setSessions(...list: Session[]): void {
  useSessionStore.setState({ sessions: new Map(list.map((x) => [x.sessionId, x])) });
}

function renderNav(path = '/'): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <NavBar />
    </MemoryRouter>,
  );
}

const click = (label: string) => fireEvent.click(screen.getByRole('link', { name: new RegExp(`^${label}`) }));

beforeEach(() => {
  useSessionStore.setState({ sessions: new Map(), selectedSessionId: null, previousSessionId: null, lastSelectedSessionId: null });
  useUiStore.setState({ detailPanelMinimized: false });
});

describe('NavBar — the LIVE tab opens the session panel', () => {
  it('a minimized panel comes back on the same session', () => {
    setSessions(s('a'), s('b'));
    useSessionStore.getState().selectSession('a');
    useUiStore.setState({ detailPanelMinimized: true });
    const prev = useSessionStore.getState().previousSessionId;
    renderNav();
    click('LIVE');
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
    // Re-selecting the open session would make it its own "previous" and break
    // the switch-to-previous shortcut.
    expect(useSessionStore.getState().previousSessionId).toBe(prev);
  });

  it('after another tab closed the panel, LIVE reopens the session you had open', () => {
    setSessions(s('a'), s('b', { promptHistory: [{ text: 'x', timestamp: T }] }));
    useSessionStore.getState().selectSession('a');
    renderNav('/agenda');
    click('HISTORY');
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    click('LIVE');
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
  });

  it('with nothing opened yet, LIVE opens the most recently worked session', () => {
    setSessions(s('quiet'), s('busy', { promptHistory: [{ text: 'x', timestamp: T }] }));
    renderNav('/history');
    click('LIVE');
    expect(useSessionStore.getState().selectedSessionId).toBe('busy');
  });

  it('with no sessions at all, LIVE just shows the LIVE page', () => {
    renderNav('/history');
    click('LIVE');
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('the other tabs still close the panel so their page shows', () => {
    setSessions(s('a'));
    useSessionStore.getState().selectSession('a');
    renderNav();
    click('HISTORY');
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });
});

// The one-time tip on the LIVE board ("Open a session: click a card, or LIVE")
// marks the LIVE tab with a dot, so the word LIVE in the tip has something to
// point at. LIVE is already the active tab, so its highlight alone reads as
// "you are here", not "click me".
describe('NavBar — the LIVE tab carries the tip mark', () => {
  beforeEach(() => {
    useUiStore.setState({ liveHintDismissed: false, detailPanelMinimized: false });
    useSettingsStore.setState({ scene3dEnabled: false } as never);
    useWsStore.setState({ snapshotReceived: true });
  });

  const liveLink = () => screen.getByRole('link', { name: /^LIVE/ });
  const mark = () => liveLink().querySelector('[data-live-cue]');

  it('marks LIVE while the tip is up on the LIVE board', () => {
    setSessions(s('a'));
    renderNav('/');
    expect(mark()).not.toBeNull();
  });

  it('the mark is decorative: the tab is still called LIVE', () => {
    setSessions(s('a'));
    renderNav('/');
    expect(liveLink()).toHaveAccessibleName('LIVE');
    expect(mark()?.getAttribute('aria-hidden')).toBe('true');
  });

  it.each<[string, () => void, string]>([
    ['with no sessions yet (the empty state explains instead)', () => setSessions(), '/'],
    ['on another page', () => setSessions(s('a')), '/history'],
    ['with the 3D scene on', () => { setSessions(s('a')); useSettingsStore.setState({ scene3dEnabled: true } as never); }, '/'],
    ['once the tip is dismissed', () => { setSessions(s('a')); useUiStore.setState({ liveHintDismissed: true }); }, '/'],
    ['before the session list has loaded', () => { setSessions(s('a')); useWsStore.setState({ snapshotReceived: false }); }, '/'],
  ])('no mark %s', (_why, arrange, path) => {
    arrange();
    renderNav(path);
    expect(mark()).toBeNull();
  });

  it('a LIVE click that opens nothing does not retire it (a first-run user has not learned it yet)', () => {
    setSessions();
    renderNav('/history');
    click('LIVE');
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(useUiStore.getState().liveHintDismissed).toBe(false);
  });

  it('clicking LIVE retires the tip for good', () => {
    setSessions(s('a'));
    renderNav('/');
    click('LIVE');
    expect(useUiStore.getState().liveHintDismissed).toBe(true);
    expect(localStorage.getItem('live-hint-dismissed')).toBe('1');
  });
});
