import { describe, it, expect, beforeEach } from 'vitest';
import { openLiveSession, openSessionPanel, pickLiveSession } from './liveSession';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const T = 1_800_000_000_000;
const MIN = 60_000;

function s(id: string, over: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    title: id,
    status: 'idle',
    lastActivityAt: T,
    events: [],
    promptHistory: [],
    ...over,
  } as Session;
}

const map = (...list: Session[]) => new Map(list.map((x) => [x.sessionId, x]));
const worked = (minAgo: number) => ({ promptHistory: [{ text: 'go', timestamp: T - minAgo * MIN }] });

describe('pickLiveSession — which session the LIVE tab opens', () => {
  it('keeps the session that is already open (e.g. minimized)', () => {
    expect(pickLiveSession(map(s('a'), s('b', worked(1))), 'a', 'b')).toBe('a');
  });

  it('keeps an open session even after it ended — you were looking at it', () => {
    expect(pickLiveSession(map(s('a', { status: 'ended' }), s('b')), 'a', null)).toBe('a');
  });

  it('after another tab closed the panel, reopens the one you last had open', () => {
    expect(pickLiveSession(map(s('a', worked(30)), s('b', worked(1))), null, 'a')).toBe('a');
  });

  it('skips a last-open session that has ended or gone, for the most recently worked one', () => {
    const sessions = map(s('gone-soon', { status: 'ended' }), s('old', worked(40)), s('fresh', worked(2)));
    expect(pickLiveSession(sessions, null, 'gone-soon')).toBe('fresh');
    expect(pickLiveSession(sessions, null, 'no-such-id')).toBe('fresh');
  });

  it('ranks by real work, not lastActivityAt (a restore stamps that on every session)', () => {
    const restored = s('restored', { lastActivityAt: T + 5 * MIN }); // SessionStart just now, no work
    const busy = s('busy', { lastActivityAt: T, ...worked(3) });
    expect(pickLiveSession(map(restored, busy), null, null)).toBe('busy');
  });

  it('falls back to lastActivityAt when nothing has any work yet', () => {
    expect(pickLiveSession(map(s('a', { lastActivityAt: T - MIN }), s('b', { lastActivityAt: T })), null, null)).toBe('b');
  });

  it('never opens a floating AI popup or an ended session on its own', () => {
    const sessions = map(s('popup', { isFloating: true, ...worked(0) }), s('dead', { status: 'ended', ...worked(0) }), s('ok', worked(50)));
    expect(pickLiveSession(sessions, null, 'popup')).toBe('ok');
    expect(pickLiveSession(sessions, 'popup', null)).toBe('ok');
  });

  it('returns null when there is nothing to open', () => {
    expect(pickLiveSession(map(), null, null)).toBeNull();
    expect(pickLiveSession(map(s('dead', { status: 'ended' })), null, 'dead')).toBeNull();
  });
});

// The one rule for "open this session's panel from the LIVE page", shared by
// the LIVE tab (openLiveSession) and the board's cards.
describe('openSessionPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: map(s('a'), s('b')), selectedSessionId: null, previousSessionId: null, lastSelectedSessionId: null });
    useUiStore.setState({ detailPanelMinimized: false });
  });

  it('openLiveSession says whether it opened anything', () => {
    expect(openLiveSession()).toBe(true);
    useSessionStore.setState({ sessions: map(), selectedSessionId: null, lastSelectedSessionId: null });
    expect(openLiveSession()).toBe(false);
  });

  it('selects the session and shows its panel', () => {
    useUiStore.setState({ detailPanelMinimized: true });
    openSessionPanel('b');
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
  });

  it('does not re-select the session already open, which would make it its own "previous"', () => {
    useSessionStore.getState().selectSession('a');
    const prev = useSessionStore.getState().previousSessionId;
    useUiStore.setState({ detailPanelMinimized: true });
    openSessionPanel('a');
    expect(useSessionStore.getState().previousSessionId).toBe(prev);
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
  });
});
