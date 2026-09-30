import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSessionStore } from './sessionStore';
import type { Session } from '@/types';

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test',
    title: `Session ${id}`,
    source: 'terminal',
    model: 'claude-sonnet-4-5-20250514',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

describe('sessionStore', () => {
  beforeEach(() => {
    useSessionStore.setState({
      sessions: new Map(),
      selectedSessionId: null,
    });
  });

  describe('addSession', () => {
    it('adds a session to the map', () => {
      const session = makeSession('s1');
      useSessionStore.getState().addSession(session);
      const { sessions } = useSessionStore.getState();
      expect(sessions.size).toBe(1);
      expect(sessions.get('s1')).toEqual(session);
    });

    it('preserves existing sessions when adding', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().addSession(makeSession('s2'));
      expect(useSessionStore.getState().sessions.size).toBe(2);
    });
  });

  describe('removeSession', () => {
    it('removes a session from the map', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().addSession(makeSession('s2'));
      useSessionStore.getState().removeSession('s1');
      const { sessions } = useSessionStore.getState();
      expect(sessions.size).toBe(1);
      expect(sessions.has('s1')).toBe(false);
      expect(sessions.has('s2')).toBe(true);
    });

    it('clears selectedSessionId if removed session was selected', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().selectSession('s1');
      useSessionStore.getState().removeSession('s1');
      expect(useSessionStore.getState().selectedSessionId).toBe(null);
    });

    it('preserves selectedSessionId if a different session was removed', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().addSession(makeSession('s2'));
      useSessionStore.getState().selectSession('s1');
      useSessionStore.getState().removeSession('s2');
      expect(useSessionStore.getState().selectedSessionId).toBe('s1');
    });
  });

  describe('updateSession', () => {
    it('updates an existing session', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      const updated = makeSession('s1', { status: 'working' });
      useSessionStore.getState().updateSession(updated);
      expect(useSessionStore.getState().sessions.get('s1')?.status).toBe('working');
    });

    it('handles replacesId by removing old entry', () => {
      useSessionStore.getState().addSession(makeSession('old-id'));
      const newSession = makeSession('new-id', { replacesId: 'old-id' });
      useSessionStore.getState().updateSession(newSession);
      const { sessions } = useSessionStore.getState();
      expect(sessions.has('old-id')).toBe(false);
      expect(sessions.has('new-id')).toBe(true);
    });

    it('follows selectedSessionId when session is replaced', () => {
      useSessionStore.getState().addSession(makeSession('old-id'));
      useSessionStore.getState().selectSession('old-id');
      const newSession = makeSession('new-id', { replacesId: 'old-id' });
      useSessionStore.getState().updateSession(newSession);
      expect(useSessionStore.getState().selectedSessionId).toBe('new-id');
    });

    it('does not change selectedSessionId for unrelated replacesId', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().addSession(makeSession('old-id'));
      useSessionStore.getState().selectSession('s1');
      const newSession = makeSession('new-id', { replacesId: 'old-id' });
      useSessionStore.getState().updateSession(newSession);
      expect(useSessionStore.getState().selectedSessionId).toBe('s1');
    });
  });

  describe('selectSession / deselectSession', () => {
    it('sets selectedSessionId', () => {
      useSessionStore.getState().selectSession('s1');
      expect(useSessionStore.getState().selectedSessionId).toBe('s1');
    });

    it('clears selectedSessionId on deselect', () => {
      useSessionStore.getState().selectSession('s1');
      useSessionStore.getState().deselectSession();
      expect(useSessionStore.getState().selectedSessionId).toBe(null);
    });
  });

  describe('toggleRemoteVisible', () => {
    // The bug this covers: the button previously only awaited a fetch and
    // showed a toast — it never wrote to the local store, so nothing here
    // would have failed even though the click was silently inert in the UI.
    // Asserting on `sessions.get(...).remoteVisible` synchronously,
    // immediately after the call, is what actually catches that: it fails
    // unless the flip happens in the same `set()` as the fetch is fired, not
    // after the request resolves.
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('flips remoteVisible synchronously, before the request settles', () => {
      useSessionStore.getState().addSession(makeSession('s1', { remoteVisible: false }));
      useSessionStore.getState().toggleRemoteVisible('s1');
      // fetchSpy's promise has not resolved yet (no await) — if the flip were
      // gated on the response, this read would still see the old value.
      expect(useSessionStore.getState().sessions.get('s1')?.remoteVisible).toBe(true);
    });

    it('toggles back off on a second call', () => {
      useSessionStore.getState().addSession(makeSession('s1', { remoteVisible: true }));
      useSessionStore.getState().toggleRemoteVisible('s1');
      expect(useSessionStore.getState().sessions.get('s1')?.remoteVisible).toBe(false);
    });

    it('PUTs the new value to the remote-visible route', () => {
      useSessionStore.getState().addSession(makeSession('s1', { remoteVisible: false }));
      useSessionStore.getState().toggleRemoteVisible('s1');
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/sessions/s1/remote-visible',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ remoteVisible: true }),
        }),
      );
    });

    it('does nothing for an unknown session id', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().toggleRemoteVisible('does-not-exist');
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(useSessionStore.getState().sessions.size).toBe(1);
    });

    it('leaves other sessions untouched', () => {
      useSessionStore.getState().addSession(makeSession('s1', { remoteVisible: false }));
      useSessionStore.getState().addSession(makeSession('s2', { remoteVisible: false }));
      useSessionStore.getState().toggleRemoteVisible('s1');
      expect(useSessionStore.getState().sessions.get('s2')?.remoteVisible).toBe(false);
    });
  });

  describe('toggleAiPopup', () => {
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchSpy = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('turns the popup OFF on the first click of an untouched session', () => {
      // THE trap: an untouched session has aiPopupEnabled === undefined, and
      // the feature is ON by default. A naive `!session.aiPopupEnabled` reads
      // undefined as false and "enables" something already enabled — so the
      // first click would appear to do nothing.
      useSessionStore.getState().addSession(makeSession('s1'));
      expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBeUndefined();

      useSessionStore.getState().toggleAiPopup('s1');

      expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(false);
    });

    it('toggles back on', () => {
      useSessionStore.getState().addSession(makeSession('s1', { aiPopupEnabled: false }));
      useSessionStore.getState().toggleAiPopup('s1');
      expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(true);
    });

    it('flips synchronously, before the request settles', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().toggleAiPopup('s1');
      // No await — if the flip were gated on the response this would still
      // read the old value, and the button would not react to the click.
      expect(useSessionStore.getState().sessions.get('s1')?.aiPopupEnabled).toBe(false);
    });

    it('PUTs the new value to the ai-popup route', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().toggleAiPopup('s1');
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/sessions/s1/ai-popup',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ aiPopupEnabled: false }),
        }),
      );
    });

    it('does nothing for an unknown session', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().toggleAiPopup('nope');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('leaves other sessions untouched', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      useSessionStore.getState().addSession(makeSession('s2'));
      useSessionStore.getState().toggleAiPopup('s1');
      expect(useSessionStore.getState().sessions.get('s2')?.aiPopupEnabled).toBeUndefined();
    });
  });

  describe('setSessions', () => {
    it('replaces all sessions', () => {
      useSessionStore.getState().addSession(makeSession('s1'));
      const newMap = new Map<string, Session>();
      newMap.set('s2', makeSession('s2'));
      newMap.set('s3', makeSession('s3'));
      useSessionStore.getState().setSessions(newMap);
      const { sessions } = useSessionStore.getState();
      expect(sessions.size).toBe(2);
      expect(sessions.has('s1')).toBe(false);
      expect(sessions.has('s2')).toBe(true);
      expect(sessions.has('s3')).toBe(true);
    });
  });
});

/**
 * The LIVE tab reopens "the session you last had open", but every other nav
 * tab closes the panel with deselectSession — which also wipes the persisted
 * selection. So the last open session is remembered separately.
 */
describe('sessionStore — lastSelectedSessionId', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null, previousSessionId: null, lastSelectedSessionId: null });
  });

  it('remembers the selected session through a deselect', () => {
    const st = useSessionStore.getState();
    st.addSession(makeSession('a'));
    st.selectSession('a');
    useSessionStore.getState().deselectSession();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(useSessionStore.getState().lastSelectedSessionId).toBe('a');
  });

  it('follows the session when a resume re-keys it', () => {
    useSessionStore.getState().addSession(makeSession('old'));
    useSessionStore.getState().selectSession('old');
    useSessionStore.getState().deselectSession();
    useSessionStore.getState().updateSession(makeSession('new', { replacesId: 'old' }));
    expect(useSessionStore.getState().lastSelectedSessionId).toBe('new');
  });

  it('forgets a session that is removed', () => {
    useSessionStore.getState().addSession(makeSession('a'));
    useSessionStore.getState().selectSession('a');
    useSessionStore.getState().removeSession('a');
    expect(useSessionStore.getState().lastSelectedSessionId).toBeNull();
  });
});
