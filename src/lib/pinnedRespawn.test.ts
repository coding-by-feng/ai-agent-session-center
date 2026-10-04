import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  backoffMs,
  respawnKey,
  buildRespawnBody,
  shouldRespawn,
  onSessionEnded,
  _resetForTests,
  MAX_ATTEMPTS,
} from './pinnedRespawn';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types/session';

const toasts: Array<{ msg: string; kind: string }> = [];
vi.mock('@/components/ui/ToastContainer', () => ({
  showToast: (msg: string, kind: string) => { toasts.push({ msg, kind }); },
}));

function mkSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'uuid-abc-123',
    status: 'ended',
    projectName: 'proj',
    projectPath: '/work/proj',
    title: 'My Agent',
    model: 'claude',
    source: 'claude',
    pinned: true,
    sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/work/proj', command: 'claude' },
    terminalId: null,
    cachedPid: null,
    // unused-but-required fields filled minimally
    animationState: 'idle' as never,
    emote: 'none' as never,
    startedAt: 0, lastActivityAt: 0, endedAt: 1,
    currentPrompt: '', promptHistory: [], toolUsage: {}, totalToolCalls: 0,
    toolLog: [], responseLog: [], events: [],
    pendingTool: null, waitingDetail: null, subagentCount: 0,
    archived: 0, queueCount: 0,
    ...overrides,
  } as Session;
}

function fetchCallsToCreate(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((c) => String(c[0]).endsWith('/api/terminals'));
}

/** What useWebSocket does on a fresh 'ended': store the update first, then hand it to onSessionEnded. */
function die(session: Session): void {
  useSessionStore.getState().updateSession(session);
  onSessionEnded(session);
}

describe('pinnedRespawn', () => {
  let clock = 0;
  beforeEach(() => {
    toasts.length = 0;
    clock = 1_000_000;
    useSessionStore.setState({ sessions: new Map() });
    _resetForTests(() => clock);
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, terminalId: 't-new' }) })));
  });
  afterEach(() => {
    _resetForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('backoffMs', () => {
    it('doubles and caps at 8s', () => {
      expect(backoffMs(0)).toBe(2000);
      expect(backoffMs(1)).toBe(4000);
      expect(backoffMs(2)).toBe(8000);
      expect(backoffMs(5)).toBe(8000);
    });
  });

  describe('respawnKey', () => {
    it('is stable across id changes (keyed by projectPath + title)', () => {
      const a = mkSession({ sessionId: 'id-1' });
      const b = mkSession({ sessionId: 'id-2' });
      expect(respawnKey(a)).toBe(respawnKey(b));
    });
  });

  describe('buildRespawnBody', () => {
    it('resumes a real CLI session id and forces pinned', () => {
      const body = buildRespawnBody(mkSession({ sessionId: 'abc123' }))!;
      expect(body.resumeSessionId).toBe('abc123');
      expect(body.command).toBe('claude');
      expect(body.pinned).toBe(true);
      expect(body.sessionTitle).toBe('My Agent');
    });

    it('routes a term-* raw command through startupCommand (no resume)', () => {
      const body = buildRespawnBody(mkSession({
        sessionId: 'term-1-xyz',
        sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/w', command: 'npm run dev && claude' },
      }))!;
      expect(body.resumeSessionId).toBeUndefined();
      expect(body.command).toBe('');
      expect(body.startupCommand).toBe('npm run dev && claude');
    });

    it('returns null without sshConfig', () => {
      expect(buildRespawnBody(mkSession({ sshConfig: undefined }))).toBeNull();
    });

    it('preserves effort/model so the respawn keeps the same effort', () => {
      const body = buildRespawnBody(mkSession({ sessionId: 'abc123', effortLevel: 'ultracode', model: 'opus' }))!;
      expect(body.effortLevel).toBe('ultracode');
      expect(body.model).toBe('opus');
    });
  });

  describe('shouldRespawn', () => {
    it('true for a pinned, non-fork session with sshConfig', () => {
      expect(shouldRespawn(mkSession())).toBe(true);
    });
    it('false when unpinned / floating popup / no sshConfig', () => {
      expect(shouldRespawn(mkSession({ pinned: false }))).toBe(false);
      expect(shouldRespawn(mkSession({ isFork: true, isFloating: true }))).toBe(false);
      expect(shouldRespawn(mkSession({ sshConfig: undefined }))).toBe(false);
    });
    it('true for a pinned clone/fork (isFork without isFloating)', () => {
      expect(shouldRespawn(mkSession({ isFork: true }))).toBe(true);
    });
  });

  describe('onSessionEnded', () => {
    it('respawns a pinned session after backoff with pinned:true', async () => {
      die(mkSession());
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      expect(fetchCallsToCreate(fetchMock)).toHaveLength(0); // not yet — waiting on backoff
      await vi.advanceTimersByTimeAsync(2000);
      const creates = fetchCallsToCreate(fetchMock);
      expect(creates).toHaveLength(1);
      const body = JSON.parse((creates[0][1] as RequestInit).body as string);
      expect(body.pinned).toBe(true);
      expect(body.resumeSessionId).toBe('uuid-abc-123');
    });

    it('does nothing for a non-pinned session', async () => {
      die(mkSession({ pinned: false }));
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(0);
    });

    it('gives up after MAX_ATTEMPTS deaths within the window', async () => {
      // Realistic interleave: each death's respawn fires before the next death.
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        die(mkSession());
        await vi.advanceTimersByTimeAsync(8000);
      }
      const before = fetchCallsToCreate(global.fetch as never).length;
      expect(before).toBe(MAX_ATTEMPTS); // 3 respawns fired

      // The (MAX_ATTEMPTS + 1)th death is capped — no further respawn, a toast instead.
      die(mkSession());
      await vi.advanceTimersByTimeAsync(8000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(MAX_ATTEMPTS);
      expect(toasts.some((t) => t.kind === 'error' && /giving up/i.test(t.msg))).toBe(true);
    });
  });

  // The timer holds a snapshot taken when the session died. A kill makes the
  // server broadcast ENDED more than once (a hook-driven one can land before
  // the kill route finishes), so by the time the backoff ends the live store may
  // say something different — the respawn must follow the store, not the snapshot.
  describe('when the backoff ends', () => {
    it('skips the respawn if the card was removed meanwhile (closed / killed)', async () => {
      const s = mkSession();
      die(s);
      useSessionStore.getState().removeSession(s.sessionId);
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(0);
    });

    it('skips the respawn if the session was unpinned meanwhile — a kill\'s final ENDED carries pinned:false', async () => {
      const s = mkSession();
      die(s); // early ENDED, still pinned: schedules a respawn
      useSessionStore.getState().updateSession({ ...s, pinned: false }); // final ENDED from the kill route
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(0);
    });

    it('skips the respawn if the session came back to life meanwhile', async () => {
      const s = mkSession();
      die(s);
      useSessionStore.getState().updateSession({ ...s, status: 'idle', endedAt: null });
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(0);
    });

    it('still respawns when nothing about the dead session changed', async () => {
      die(mkSession());
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(1);
    });

    it('does not count a skipped respawn toward the crash-loop cap', async () => {
      // /clear re-keys the card, ✕ lands during the backoff, a kill unpins it: every
      // one of these ends with the timer skipping, so none of them relaunched anything.
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const s = mkSession();
        die(s);
        useSessionStore.getState().removeSession(s.sessionId);
        await vi.advanceTimersByTimeAsync(8000);
      }
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(0);

      die(mkSession()); // a genuine crash right after
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchCallsToCreate(global.fetch as never)).toHaveLength(1);
      expect(toasts.some((t) => /giving up/i.test(t.msg))).toBe(false);
    });
  });
});
