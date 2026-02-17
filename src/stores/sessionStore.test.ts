import { describe, it, expect, beforeEach } from 'vitest';
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
