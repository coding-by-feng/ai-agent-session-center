/**
 * workspaceSnapshot.test.ts — Tests for snapshot import bug fixes:
 * - RC-2: dedup key must include originalSessionId (8 fields)
 * - RC-4: clear-all must send suppressBroadcast: true
 * - RC-12: orphan sessions must be assigned to a synthesized "Ungrouped" room
 * - RC-14: term-* sessions with shell metacharacters must route via startupCommand
 * - Fix 7: importSnapshot must return failedTitles[] for failed sessions
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildSavedOutputIndex,
  claimSavedOutput,
  buildSnapshot,
  loadFromConfig,
  deduplicateSessions,
  reconcileWorkspaceSnapshot,
  importSnapshot,
  isFloatingSnapshot,
  scheduleAutoSave,
  scheduleAutomationSave,
  cancelAutoSave,
  setRestorePending,
  _resetAutoSaveStateForTests,
  type SessionSnapshot,
  type WorkspaceSnapshot,
} from './workspaceSnapshot';
import type { Session } from '@/types';
import type { Room } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { itemType } from './queueScheduler';
import { clearLocalStorage } from '../__tests__/setup';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSnap(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    originalSessionId: 'term-1-abc',
    title: 'Test',
    enableOpsTerminal: false,
    sshConfig: {
      host: 'localhost',
      port: 22,
      username: 'kasonzhan',
      authMethod: 'key',
      privateKeyPath: '~/.ssh/id_rsa',
      workingDir: '/Users/kasonzhan',
      command: 'claude',
    },
    projectTabs: null,
    ...overrides,
  };
}

interface MockResponse {
  ok: boolean;
  json: () => Promise<unknown>;
}
function mockResponse(body: unknown, ok = true): MockResponse {
  return { ok, json: () => Promise.resolve(body) };
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function setupFetchMock(
  routeMap: Record<string, (init?: RequestInit) => MockResponse>,
): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    for (const route of Object.keys(routeMap)) {
      if (u.includes(route)) return routeMap[route](init) as unknown as Response;
    }
    return mockResponse({ ok: true }) as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls };
}

// ---------------------------------------------------------------------------
// RC-2 (Fix 4) — sessionDedupeKey must include originalSessionId
// ---------------------------------------------------------------------------

describe('sessionDedupeKey via deduplicateSessions', () => {
  it('keeps two sessions sharing all 7 prior fields when originalSessionId differs', () => {
    const a = makeSnap({
      originalSessionId: 'uuid-AAA-1111',
      title: 'Same Title',
      sshConfig: {
        host: 'localhost',
        port: 22,
        username: 'u',
        workingDir: '/same',
        command: 'claude',
      },
      startupCommand: 'claude',
    });
    const b = makeSnap({
      originalSessionId: 'uuid-BBB-2222',
      title: 'Same Title',
      sshConfig: {
        host: 'localhost',
        port: 22,
        username: 'u',
        workingDir: '/same',
        command: 'claude',
      },
      startupCommand: 'claude',
    });
    const out = deduplicateSessions([a, b]);
    expect(out).toHaveLength(2);
    expect(out.map((s) => s.originalSessionId).sort()).toEqual([
      'uuid-AAA-1111',
      'uuid-BBB-2222',
    ]);
  });

  it('still drops genuine duplicates that share all 8 fields including originalSessionId', () => {
    const a = makeSnap({ originalSessionId: 'same-id', title: 'X' });
    const b = makeSnap({ originalSessionId: 'same-id', title: 'X' });
    const out = deduplicateSessions([a, b]);
    expect(out).toHaveLength(1);
  });
});

describe('session identity reconciliation', () => {
  const room = (ids: string[]): Room => ({
    id: 'common', name: 'Common Area', sessionIds: ids,
    collapsed: false, createdAt: 1,
  });

  it('exports only the canonical session and remaps a temporary terminal card', () => {
    const ghost = {
      ...loopSession('term-codex'),
      terminalId: 'term-codex',
      title: 'KTS Codex Agent',
      lastActivityAt: 10,
    } as unknown as Session;
    const canonical = {
      ...loopSession('codex-uuid'),
      terminalId: 'term-codex',
      title: 'KTS Codex Agent',
      lastActivityAt: 20,
      previousSessions: [{ sessionId: 'codex-old' }],
    } as unknown as Session;

    const snapshot = buildSnapshot(
      new Map([['term-codex', ghost], ['codex-uuid', canonical]]),
      [room(['term-codex', 'codex-uuid'])],
    );

    expect(snapshot.sessions.map((session) => session.originalSessionId)).toEqual(['codex-uuid']);
    expect(snapshot.sessions[0].terminalId).toBe('term-codex');
    expect(snapshot.sessions[0].previousSessionIds).toEqual(['codex-old']);
    expect(snapshot.rooms[0].sessionIds).toEqual(['codex-uuid']);
  });

  it('uses live terminal and previous-session lineage to repair a legacy snapshot', () => {
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [
        makeSnap({ originalSessionId: 'term-codex', title: 'Codex' }),
        makeSnap({ originalSessionId: 'codex-old', title: 'Codex' }),
        makeSnap({ originalSessionId: 'codex-current', title: 'Codex' }),
      ],
      rooms: [room(['term-codex', 'codex-old', 'codex-current'])],
    };
    const current = {
      ...loopSession('codex-current'),
      terminalId: 'term-codex',
      previousSessions: [{ sessionId: 'codex-old' }],
      lastActivityAt: 30,
    } as unknown as Session;

    const repaired = reconcileWorkspaceSnapshot(
      legacy,
      new Map([['codex-current', current]]),
    );

    expect(repaired.sessions.map((session) => session.originalSessionId)).toEqual(['codex-current']);
    expect(repaired.rooms[0].sessionIds).toEqual(['codex-current']);
  });

  it('uses lastTerminalId after restart and drops a ghost whose ended owner is not restorable', () => {
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [makeSnap({ originalSessionId: 'term-old', title: 'KTS Codex Agent', status: 'idle' })],
      rooms: [room(['term-old'])],
    };
    const endedOwner = {
      ...loopSession('codex-ended'),
      status: 'ended',
      terminalId: null,
      lastTerminalId: 'term-old',
    } as unknown as Session;

    const repaired = reconcileWorkspaceSnapshot(
      legacy,
      new Map([['codex-ended', endedOwner]]),
    );

    expect(repaired.sessions).toEqual([]);
    expect(repaired.rooms[0].sessionIds).toEqual([]);
  });

  it('repairs a legacy synthetic Codex ghost even before live sessions hydrate', () => {
    const codexConfig = { ...makeSnap().sshConfig, command: 'codex --full-auto' };
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [
        makeSnap({ originalSessionId: 'term-old', title: 'KTS Codex Agent', status: 'idle', startupCommand: undefined, sshConfig: codexConfig }),
        makeSnap({ originalSessionId: 'codex-current', title: 'KTS Codex Agent', status: 'waiting', startupCommand: '/opt/codex/bin/codex', sshConfig: codexConfig }),
      ],
      rooms: [room(['term-old', 'codex-current'])],
    };

    const repaired = reconcileWorkspaceSnapshot(legacy, new Map());

    expect(repaired.sessions.map((session) => session.originalSessionId)).toEqual(['codex-current']);
    expect(repaired.rooms[0].sessionIds).toEqual(['codex-current']);
  });

  it('drops only an ambiguous legacy terminal ghost and preserves parallel UUID threads', () => {
    const codexConfig = { ...makeSnap().sshConfig, command: 'codex --full-auto' };
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [
        makeSnap({ originalSessionId: 'term-old', title: 'SMS-AUTO', status: 'idle', startupCommand: undefined, sshConfig: codexConfig }),
        makeSnap({ originalSessionId: 'codex-a', title: 'SMS-AUTO', status: 'waiting', startupCommand: '/opt/codex/bin/codex', sshConfig: codexConfig }),
        makeSnap({ originalSessionId: 'codex-b', title: 'SMS-AUTO', status: 'prompting', startupCommand: '/opt/codex/bin/codex', sshConfig: codexConfig }),
      ],
      rooms: [room(['term-old', 'codex-a', 'codex-b'])],
    };

    const repaired = reconcileWorkspaceSnapshot(legacy, new Map());

    expect(repaired.sessions.map((session) => session.originalSessionId)).toEqual(['codex-a', 'codex-b']);
    expect(repaired.rooms[0].sessionIds).toEqual(['codex-a', 'codex-b']);
  });

  it('lets exact live terminal ownership override an ambiguous legacy tombstone', () => {
    const codexConfig = { ...makeSnap().sshConfig, command: 'codex --full-auto' };
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [
        makeSnap({ originalSessionId: 'term-old', title: 'SMS-AUTO', status: 'idle', startupCommand: undefined, sshConfig: codexConfig }),
        makeSnap({ originalSessionId: 'codex-current', title: 'SMS-AUTO', status: 'waiting', startupCommand: '/opt/codex/bin/codex', sshConfig: codexConfig }),
        makeSnap({ originalSessionId: 'codex-parallel', title: 'SMS-AUTO', status: 'prompting', startupCommand: '/opt/codex/bin/codex', sshConfig: codexConfig }),
      ],
      rooms: [room(['term-old'])],
    };
    const current = {
      ...loopSession('codex-current'),
      terminalId: 'term-old',
      cliSource: 'codex',
    } as unknown as Session;

    const repaired = reconcileWorkspaceSnapshot(
      legacy,
      new Map([['codex-current', current]]),
    );

    expect(repaired.sessions.map((session) => session.originalSessionId))
      .toEqual(['codex-current', 'codex-parallel']);
    expect(repaired.rooms[0].sessionIds).toEqual(['codex-current']);
  });

  it('retains an active live canonical owner that is absent from the saved snapshot', () => {
    const legacy: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [
        makeSnap({ originalSessionId: 'codex-old', title: 'Current thread' }),
        makeSnap({ originalSessionId: 'other', title: 'Other thread' }),
      ],
      rooms: [room(['codex-old', 'other'])],
    };
    const current = {
      ...loopSession('codex-current'),
      status: 'waiting',
      previousSessions: [{ sessionId: 'codex-old' }],
    } as unknown as Session;

    const repaired = reconcileWorkspaceSnapshot(
      legacy,
      new Map([['codex-current', current]]),
    );

    expect(repaired.sessions.map((session) => session.originalSessionId))
      .toEqual(['codex-current', 'other']);
    expect(repaired.rooms[0].sessionIds).toEqual(['codex-current', 'other']);
  });

  it('keeps parallel same-title sessions when they do not share identity ownership', () => {
    const a = { ...loopSession('a'), title: 'Codex', terminalId: 'term-a', cachedPid: 101 } as unknown as Session;
    const b = { ...loopSession('b'), title: 'Codex', terminalId: 'term-b', cachedPid: 101 } as unknown as Session;

    const snapshot = buildSnapshot(new Map([['a', a], ['b', b]]), [room(['a', 'b'])]);

    expect(snapshot.sessions.map((session) => session.originalSessionId)).toEqual(['a', 'b']);
    expect(snapshot.rooms[0].sessionIds).toEqual(['a', 'b']);
  });

  it('fetches server lineage when cold-start reconciliation runs before Zustand hydration', async () => {
    const old = makeSnap({ originalSessionId: 'codex-old', title: 'SMS-AUTO' });
    const current = makeSnap({ originalSessionId: 'codex-current', title: 'SMS-AUTO' });
    const saved: WorkspaceSnapshot = {
      version: 1,
      exportedAt: 1,
      sessions: [old, current],
      rooms: [room(['codex-old', 'codex-current'])],
    };
    const liveCurrent = {
      ...loopSession('codex-current'),
      previousSessions: [{ sessionId: 'codex-old' }],
    } as unknown as Session;
    useSessionStore.getState().setSessions(new Map());
    setupFetchMock({
      '/api/workspace/load': () => mockResponse(saved),
      '/api/sessions': () => mockResponse({ 'codex-current': liveCurrent }),
    });

    const repaired = await loadFromConfig();

    expect(repaired?.sessions.map((session) => session.originalSessionId)).toEqual(['codex-current']);
    expect(repaired?.rooms[0].sessionIds).toEqual(['codex-current']);
  });
});

// ---------------------------------------------------------------------------
// importSnapshot — fetch-mocked end-to-end tests
// ---------------------------------------------------------------------------

describe('importSnapshot', () => {
  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // ---- RC-4 (Fix 2) — suppress broadcast during import -------------------
  it('sends suppressBroadcast: true in clear-all body', async () => {
    let capturedClearBody: string | undefined;
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': (init) => {
        capturedClearBody = typeof init?.body === 'string' ? init.body : undefined;
        return mockResponse({ savedOutputs: [] });
      },
      '/api/terminals': () =>
        mockResponse({ ok: true, terminalId: 'new-1' }),
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [makeSnap()],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    expect(capturedClearBody).toBeDefined();
    const parsed = JSON.parse(capturedClearBody!);
    expect(parsed).toEqual({ suppressBroadcast: true });

    const clearCall = calls.find((c) => c.url.includes('/api/sessions/clear-all'));
    expect(clearCall).toBeDefined();
    const headers = clearCall!.init?.headers as Record<string, string> | undefined;
    expect(headers && headers['Content-Type']).toBe('application/json');
  });

  // ---- RC-14 (Fix 3) — term-* sessions with shell metacharacters --------
  it('rewrites term-* command with shell metacharacters via startupCommand', async () => {
    let capturedTerminalBody: Record<string, unknown> | undefined;
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        capturedTerminalBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mockResponse({ ok: true, terminalId: 'new-term-1' });
      },
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: 'term-1234567890-abc',
          title: 'Term With Meta',
          sshConfig: {
            host: 'localhost',
            port: 22,
            username: 'kasonzhan',
            workingDir: '/tmp',
            command: 'npm run dev && claude',
          },
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    expect(capturedTerminalBody).toBeDefined();
    expect(capturedTerminalBody!.command).toBe('');
    expect(capturedTerminalBody!.startupCommand).toBe('npm run dev && claude');
  });

  it('prefers existing snapshot startupCommand over cfg.command for term-* sessions', async () => {
    let capturedTerminalBody: Record<string, unknown> | undefined;
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        capturedTerminalBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mockResponse({ ok: true, terminalId: 'new-term-2' });
      },
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: 'term-9999-xyz',
          sshConfig: {
            host: 'localhost',
            port: 22,
            username: 'kasonzhan',
            workingDir: '/tmp',
            command: 'fallback && cmd',
          },
          startupCommand: 'preferred && command',
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    expect(capturedTerminalBody!.command).toBe('');
    expect(capturedTerminalBody!.startupCommand).toBe('preferred && command');
  });

  it('keeps Claude UUID session command unchanged (no rewrite)', async () => {
    let capturedTerminalBody: Record<string, unknown> | undefined;
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        capturedTerminalBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return mockResponse({ ok: true, terminalId: 'new-claude-1' });
      },
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: '6e0d51a7-4198-4cb3-a231-1f1a78280514',
          sshConfig: {
            host: 'localhost',
            port: 22,
            username: 'kasonzhan',
            workingDir: '/tmp',
            command: 'claude --resume foo --fork-session',
          },
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    expect(capturedTerminalBody!.command).toBe('claude --resume foo --fork-session');
    expect(capturedTerminalBody!.resumeSessionId).toBe(
      '6e0d51a7-4198-4cb3-a231-1f1a78280514',
    );
  });

  // ---- RC-12 (Fix 6) — orphan sessions get an "Ungrouped" room -----------
  it('creates synthesized "Ungrouped" room for orphan sessions', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        const body = JSON.parse(String(init?.body)) as { sessionTitle?: string };
        return mockResponse({
          ok: true,
          terminalId: `new-${body.sessionTitle ?? 'x'}`,
        });
      },
    });

    const orphan = makeSnap({
      originalSessionId: 'term-orphan-1',
      title: 'OrphanA',
    });
    const inRoom = makeSnap({
      originalSessionId: 'term-in-1',
      title: 'InRoom',
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [orphan, inRoom],
      rooms: [
        {
          id: 'room-existing',
          name: 'MD',
          sessionIds: ['term-in-1'],
          collapsed: false,
          createdAt: 1,
        },
      ],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    const stored = JSON.parse(localStorage.getItem('session-rooms') ?? '[]') as Array<{
      name: string;
      sessionIds: string[];
    }>;
    const ungrouped = stored.find((r) => r.name === 'Ungrouped');
    expect(ungrouped).toBeDefined();
    expect(ungrouped!.sessionIds).toContain('new-OrphanA');
    expect(ungrouped!.sessionIds).not.toContain('new-InRoom');
  });

  it('appends orphans to existing "Ungrouped" room rather than creating a duplicate', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        const body = JSON.parse(String(init?.body)) as { sessionTitle?: string };
        return mockResponse({
          ok: true,
          terminalId: `new-${body.sessionTitle ?? 'x'}`,
        });
      },
    });

    const orphan = makeSnap({
      originalSessionId: 'term-orphan-1',
      title: 'OrphanA',
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [orphan],
      rooms: [
        {
          id: 'room-existing-ungrouped',
          name: 'Ungrouped',
          sessionIds: [],
          collapsed: false,
          createdAt: 1,
        },
      ],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    const stored = JSON.parse(localStorage.getItem('session-rooms') ?? '[]') as Array<{
      id: string;
      name: string;
      sessionIds: string[];
    }>;
    const ungroupedRooms = stored.filter((r) => r.name === 'Ungrouped');
    expect(ungroupedRooms).toHaveLength(1);
    expect(ungroupedRooms[0].sessionIds).toContain('new-OrphanA');
  });

  it('does not create "Ungrouped" room when there are no orphans', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        const body = JSON.parse(String(init?.body)) as { sessionTitle?: string };
        return mockResponse({
          ok: true,
          terminalId: `new-${body.sessionTitle ?? 'x'}`,
        });
      },
    });

    const inRoom = makeSnap({
      originalSessionId: 'term-in-1',
      title: 'InRoom',
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [inRoom],
      rooms: [
        {
          id: 'room-existing',
          name: 'MD',
          sessionIds: ['term-in-1'],
          collapsed: false,
          createdAt: 1,
        },
      ],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    const stored = JSON.parse(localStorage.getItem('session-rooms') ?? '[]') as Array<{
      name: string;
    }>;
    expect(stored.some((r) => r.name === 'Ungrouped')).toBe(false);
  });

  // ---- Fix 7 — failedTitles tracking ------------------------------------
  it('tracks failed session titles when server returns ok: false', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': (init) => {
        const body = JSON.parse(String(init?.body)) as { sessionTitle?: string };
        if (body.sessionTitle === 'BadOne') {
          return mockResponse({ ok: false, error: 'fail' });
        }
        return mockResponse({
          ok: true,
          terminalId: `new-${body.sessionTitle ?? 'x'}`,
        });
      },
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'a', title: 'GoodOne' }),
        makeSnap({ originalSessionId: 'b', title: 'BadOne' }),
      ],
      rooms: [],
    };

    let result: { created: number; failed: number; failedTitles: string[] } | undefined;
    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: (created, failed) => {
        // Older signature still receives created/failed
        expect(created).toBe(1);
        expect(failed).toBe(1);
      },
    }).then((r) => {
      result = r as unknown as { created: number; failed: number; failedTitles: string[] };
    });

    expect(result).toBeDefined();
    expect(result!.created).toBe(1);
    expect(result!.failed).toBe(1);
    expect(result!.failedTitles).toEqual(['BadOne']);
  });

  it('tracks failed titles when fetch throws', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
    });
    // Override /api/terminals to throw
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/api/sessions/clear-all')) {
        return mockResponse({ savedOutputs: [] }) as unknown as Response;
      }
      if (u.includes('/api/terminals')) {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { sessionTitle?: string })
          : {};
        if (body.sessionTitle === 'Throwy') {
          throw new Error('network down');
        }
        return mockResponse({
          ok: true,
          terminalId: `new-${body.sessionTitle ?? 'x'}`,
        }) as unknown as Response;
      }
      return mockResponse({}) as unknown as Response;
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'a', title: 'OkOne' }),
        makeSnap({ originalSessionId: 'b', title: 'Throwy' }),
      ],
      rooms: [],
    };

    const result = await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.failedTitles).toEqual(['Throwy']);
  });
});

// ---------------------------------------------------------------------------
// Auto-save restore-pending guard — prevents the snapshot from being overwritten
// before the user resolves the Restore Workspace dialog. Without this guard,
// the in-memory session list (a partial reflection of what was saved) gets
// persisted ~5s after page load, permanently losing any unrestored sessions.
// ---------------------------------------------------------------------------
describe('scheduleAutoSave restore-pending guard', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function sessionWithSsh(id: string): Session {
    return {
      sessionId: id,
      projectPath: '/tmp/x',
      projectName: 'x',
      status: 'idle',
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      sshConfig: { host: 'localhost', port: 22, workingDir: '/tmp/x', command: 'claude' },
    } as unknown as Session;
  }

  beforeEach(() => {
    _resetAutoSaveStateForTests(); // clear leftover _importInProgress/timer from prior tests
    vi.useFakeTimers();
    fetchMock = vi.fn(async () =>
      ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cancelAutoSave();
    setRestorePending(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('skips save while restore is pending (snapshot must not be overwritten)', async () => {
    const sessions = new Map<string, Session>([['s1', sessionWithSsh('s1')]]);
    const rooms: Room[] = [];

    scheduleAutoSave(() => sessions, () => rooms);
    await vi.advanceTimersByTimeAsync(10_000);

    const saveCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/workspace/save'),
    );
    expect(saveCalls).toHaveLength(0);
  });

  // The LIVE page also waits for the restore decision before it says "No agent
  // sessions yet" (the first snapshot of a fresh server is empty, and sessions
  // started from that card would be killed by the restore's clear-all). The flag
  // lives here as module state, so it is mirrored into uiStore for React.
  it('mirrors the restore decision into uiStore, so the LIVE page can wait for it', () => {
    _resetAutoSaveStateForTests();
    expect(useUiStore.getState().workspaceRestorePending).toBe(true);
    setRestorePending(false);
    expect(useUiStore.getState().workspaceRestorePending).toBe(false);
  });

  it('saves once restore is resolved (setRestorePending(false))', async () => {
    const sessions = new Map<string, Session>([['s1', sessionWithSsh('s1')]]);
    const rooms: Room[] = [];

    setRestorePending(false);
    scheduleAutoSave(() => sessions, () => rooms);
    await vi.advanceTimersByTimeAsync(10_000);

    const saveCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/workspace/save'),
    );
    expect(saveCalls.length).toBeGreaterThan(0);
  });

  it('does NOT clobber the snapshot when every session is ENDED (buildSnapshot yields zero)', async () => {
    // Regression: after a server restart, the client re-registers its IndexedDB
    // sessions as ENDED (they still carry sshConfig) before reconnecting to live
    // PTYs. The old guard only checked sshConfig presence, so it persisted an
    // EMPTY snapshot (buildSnapshot drops ended sessions) over the good one —
    // silently breaking restart-to-resume.
    const ended = { ...sessionWithSsh('s1'), status: 'ended' } as unknown as Session;
    const sessions = new Map<string, Session>([['s1', ended]]);
    const rooms: Room[] = [];

    setRestorePending(false);
    scheduleAutoSave(() => sessions, () => rooms);
    await vi.advanceTimersByTimeAsync(10_000);

    const saveCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/workspace/save'),
    );
    expect(saveCalls).toHaveLength(0);
  });

  it('still saves when an active session sits alongside ended ones', async () => {
    const active = sessionWithSsh('s1');
    const ended = { ...sessionWithSsh('s2'), status: 'ended' } as unknown as Session;
    const sessions = new Map<string, Session>([['s1', active], ['s2', ended]]);
    const rooms: Room[] = [];

    setRestorePending(false);
    scheduleAutoSave(() => sessions, () => rooms);
    await vi.advanceTimersByTimeAsync(10_000);

    const saveCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/workspace/save'),
    );
    expect(saveCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Loop queue items must survive a workspace export/restore cycle.
// Regression: the snapshot used to capture only {text, position, createdAt,
// images}, so a restored loop came back with type=undefined → treated as
// 'once' → consumed (deleted) on its first fire. The loop "vanished" from the
// queue panel after every app reopen / Restore-Workspace.
// ---------------------------------------------------------------------------

function loopSession(id: string): Session {
  return {
    sessionId: id,
    status: 'idle',
    sshConfig: {
      host: 'localhost',
      port: 22,
      username: 'u',
      workingDir: '/x',
      command: 'claude',
    },
  } as unknown as Session;
}

describe('buildSnapshot — queue automation preservation', () => {
  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
    useQueueStore.setState({ queues: new Map(), automation: new Map() });
  });

  it('captures a loop item with its type / intervalMs intact', () => {
    const loop: QueueItem = {
      id: 1,
      sessionId: 'sess-loop',
      text: 'run tests',
      position: 0,
      createdAt: 123,
      type: 'loop',
      intervalMs: 300_000,
      nextFireAt: 999,
      totalFires: 4,
    };
    useQueueStore.getState().setQueue('sess-loop', [loop]);

    const snap = buildSnapshot(
      new Map([['sess-loop', loopSession('sess-loop')]]),
      [],
    );
    const qi = snap.sessions[0].queueItems?.[0];
    expect(qi).toBeDefined();
    expect(qi!.type).toBe('loop');
    expect(qi!.intervalMs).toBe(300_000);
  });

  it('captures effortLevel + model so a resume can re-apply the same effort', () => {
    const s = { ...loopSession('sess-effort'), effortLevel: 'ultracode', model: 'opus' } as unknown as Session;
    const snap = buildSnapshot(new Map([['sess-effort', s]]), []);
    expect(snap.sessions[0].effortLevel).toBe('ultracode');
    expect(snap.sessions[0].model).toBe('opus');
  });

  // AASC-54: a phone's session in a folder no agent had used answers Claude's trust prompt itself;
  // the flag must survive the workspace restore, or the restore would answer it.
  it('keeps autoConfirmTrust: false, and only that value', () => {
    const base = loopSession('sess-trust') as unknown as { sshConfig?: Record<string, unknown> };
    const own = { ...base, sshConfig: { ...(base.sshConfig ?? {}), autoConfirmTrust: false } } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-trust', own]]), []).sessions[0].autoConfirmTrust).toBe(false);
    const plain = loopSession('sess-plain') as unknown as Session;
    expect(buildSnapshot(new Map([['sess-plain', plain]]), []).sessions[0]).not.toHaveProperty('autoConfirmTrust');
  });

  // Found on a real iPhone (Oct 2026): after AASC restarted, every session was hidden from the phone,
  // the ones it had started too, because the snapshot never kept the share.
  it('keeps the share choice — shared, or hidden on purpose — and nothing for a session never chosen', () => {
    const shared = { ...loopSession('sess-shared'), remoteVisible: true } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-shared', shared]]), []).sessions[0].remoteVisible).toBe(true);
    // Hidden on purpose stays hidden after a restart, even with "share new sessions" on.
    const unshared = { ...loopSession('sess-unshared'), remoteVisible: false } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-unshared', unshared]]), []).sessions[0].remoteVisible).toBe(false);
    const never = loopSession('sess-never') as unknown as Session;
    expect(buildSnapshot(new Map([['sess-never', never]]), []).sessions[0]).not.toHaveProperty('remoteVisible');
  });

  // A central (server/mcp) is a property of its card: the snapshot keeps the marker (never a token,
  // which the card does not have), so a restore relaunches it as the same central.
  it('keeps the central marker, as a copy, and nothing for a session that is no central', () => {
    const central = { centralId: '7d6c4c1e-1b0a-4c3e-9f5a-2b8e1d0c9a77', kind: 'project' as const, scopeRef: '/x' };
    const s = { ...loopSession('sess-central'), central } as unknown as Session;
    const saved = buildSnapshot(new Map([['sess-central', s]]), []).sessions[0];
    expect(saved.central).toEqual(central);
    expect(saved.central).not.toBe(central);
    const plain = loopSession('sess-plain-c') as unknown as Session;
    expect(buildSnapshot(new Map([['sess-plain-c', plain]]), []).sessions[0]).not.toHaveProperty('central');
  });

  // Hands-off (server/mcp) is the person's switch on a session: a central may read it, never steer it. It
  // must survive the workspace restore like `muted` does, or a restart would hand every session back.
  it('keeps hands-off, and nothing for a session that is not (absent already means a central may steer it)', () => {
    const off = { ...loopSession('sess-hands-off'), handsOff: true } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-hands-off', off]]), []).sessions[0].handsOff).toBe(true);
    const plain = loopSession('sess-hands-on') as unknown as Session;
    expect(buildSnapshot(new Map([['sess-hands-on', plain]]), []).sessions[0]).not.toHaveProperty('handsOff');
    // `false` is not written either: the snapshot says "hands-off" or says nothing.
    const explicitFalse = { ...loopSession('sess-hands-false'), handsOff: false } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-hands-false', explicitFalse]]), []).sessions[0]).not.toHaveProperty('handsOff');
  });

  it('drops a non-clean model (raw command / bracket-contaminated) so it cannot 400 the restore', () => {
    // Non-Claude session: session.model is the raw launch command (has spaces).
    const cmd = { ...loopSession('sess-cmd'), model: 'codex --search foo' } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-cmd', cmd]]), []).sessions[0].model).toBeUndefined();
    // Contaminated Claude model id (ANSI leftover brackets).
    const brk = { ...loopSession('sess-brk'), model: 'claude-opus-4-8[1m]' } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-brk', brk]]), []).sessions[0].model).toBeUndefined();
    // A clean id is preserved.
    const ok = { ...loopSession('sess-ok'), model: 'claude-opus-4-8' } as unknown as Session;
    expect(buildSnapshot(new Map([['sess-ok', ok]]), []).sessions[0].model).toBe('claude-opus-4-8');
  });
});

describe('importSnapshot — loop round-trip', () => {
  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
    useQueueStore.setState({ queues: new Map(), automation: new Map() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('restores a loop with its loop-ness intact (does not degrade to once)', async () => {
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-loop-1' }),
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: 'old-loop',
          queueItems: [
            {
              text: 'run tests',
              position: 0,
              createdAt: 1,
              type: 'loop',
              intervalMs: 300_000,
            },
          ],
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    const restored = useQueueStore.getState().queues.get('new-loop-1');
    expect(restored).toBeDefined();
    expect(restored!).toHaveLength(1);
    expect(itemType(restored![0])).toBe('loop');
    expect(restored![0].intervalMs).toBe(300_000);
    expect(restored![0].nextFireAt ?? 0).toBeGreaterThan(Date.now());
  });

  it('sends autoConfirmTrust: false in the restore POST so a restore never answers the trust prompt', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-trust-1' }),
    });
    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff', autoConfirmTrust: false })],
      rooms: [],
    };
    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });
    const create = calls.find((c) => c.url.includes('/api/terminals') && c.init?.method === 'POST');
    expect(create).toBeDefined();
    expect(JSON.parse(String(create!.init!.body)).autoConfirmTrust).toBe(false);
  });

  it('sends remoteVisible: true in the restore POST so a shared session stays shared', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-shared-1' }),
    });
    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-111111111111', remoteVisible: true }),
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-222222222222' }),
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-333333333333', remoteVisible: false }),
      ],
      rooms: [],
    };
    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });
    const bodies = calls.filter((c) => c.url.includes('/api/terminals') && c.init?.method === 'POST').map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies.map((b) => b.remoteVisible)).toEqual([true, undefined, false]);
  });

  it('sends the central marker back in the restore POST, so the server re-mints the same central', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-central-1' }),
    });
    const central = { centralId: '7d6c4c1e-1b0a-4c3e-9f5a-2b8e1d0c9a77', kind: 'global' as const, scopeRef: null };
    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-444444444444', central }),
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-555555555555' }),
      ],
      rooms: [],
    };
    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });
    const bodies = calls.filter((c) => c.url.includes('/api/terminals') && c.init?.method === 'POST').map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies.map((b) => b.central)).toEqual([central, undefined]);
  });

  it('sends handsOff: true in the restore POST, so a hands-off session comes back hands-off', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-hands-off-1' }),
    });
    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-666666666666', handsOff: true }),
        makeSnap({ originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-777777777777' }),
      ],
      rooms: [],
    };
    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });
    const bodies = calls.filter((c) => c.url.includes('/api/terminals') && c.init?.method === 'POST').map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies.map((b) => b.handsOff)).toEqual([true, undefined]);
  });

  it('round-trips hands-off: what a snapshot saved is what the restore POSTs', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-round-trip-1' }),
    });
    const guarded = { ...loopSession('sess-round-1'), handsOff: true } as unknown as Session;
    const open = loopSession('sess-round-2') as unknown as Session;
    const saved = buildSnapshot(new Map([['sess-round-1', guarded], ['sess-round-2', open]]), []);

    await importSnapshot(saved, { onSessionCreated: () => {}, onComplete: () => {} });

    const bodies = calls.filter((c) => c.url.includes('/api/terminals') && c.init?.method === 'POST').map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies.map((b) => b.handsOff)).toEqual(saved.sessions.map((snap) => snap.handsOff ? true : undefined));
    expect(bodies.filter((b) => b.handsOff === true)).toHaveLength(1);
  });

  it('sends effortLevel + model in the resume POST body so effort survives restart', async () => {
    const { calls } = setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: 'new-effort-1' }),
    });

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          effortLevel: 'ultracode',
          model: 'opus',
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    });

    const create = calls.find(
      (c) => c.url.includes('/api/terminals') && c.init?.method === 'POST',
    );
    expect(create).toBeDefined();
    const body = JSON.parse(create!.init!.body as string);
    expect(body.effortLevel).toBe('ultracode');
    expect(body.model).toBe('opus');
    expect(body.resumeSessionId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

// ---------------------------------------------------------------------------
// Floating popup re-link — popups must reattach to their origin session's NEW
// id after restore, and must not be re-created (orphaned) when their origin is
// excluded from a selective restore.
// ---------------------------------------------------------------------------

describe('importSnapshot — floating popup re-link', () => {
  // Hand out a fresh terminal id per CREATE so origin and fork get distinct
  // ids, letting us assert the float re-links to the origin's NEW id.
  function setupIncrementingFetchMock(): { calls: CapturedCall[] } {
    let n = 0;
    const calls: CapturedCall[] = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('/api/sessions/clear-all')) {
        return mockResponse({ savedOutputs: [] }) as unknown as Response;
      }
      // CREATE is POST to exactly /api/terminals (not the /…/prefill-output subpath).
      if (/\/api\/terminals$/.test(u) && (init?.method ?? 'POST') === 'POST') {
        n += 1;
        return mockResponse({ ok: true, terminalId: `new-${n}` }) as unknown as Response;
      }
      return mockResponse({ ok: true }) as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls };
  }

  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
    useFloatingSessionsStore.setState({ floats: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useFloatingSessionsStore.setState({ floats: [] });
  });

  it('re-links a restored popup to its origin session\'s NEW id (not the stale snapshot id)', async () => {
    setupIncrementingFetchMock();

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        // Origin first → new-1, fork second → new-2.
        makeSnap({ originalSessionId: 'mainA', title: 'Main A' }),
        makeSnap({
          originalSessionId: 'forkSess',
          title: 'Explain (中文)',
          isFork: true,
          originSessionId: 'mainA',
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });

    const floats = useFloatingSessionsStore.getState().floats;
    expect(floats).toHaveLength(1);
    expect(floats[0].terminalId).toBe('new-2');
    // Re-linked to the origin's NEW id — NOT the stale 'mainA'.
    expect(floats[0].originSessionId).toBe('new-1');
  });

  it('drops a popup whose origin session is excluded by the restore filter (no orphan, no PTY)', async () => {
    const { calls } = setupIncrementingFetchMock();

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({ originalSessionId: 'mainA', title: 'Main A' }),
        makeSnap({
          originalSessionId: 'forkSess',
          title: 'Explain (中文)',
          isFork: true,
          originSessionId: 'mainA',
        }),
      ],
      rooms: [],
    };

    // Restore ONLY the fork, excluding its origin 'mainA'.
    await importSnapshot(snap, {
      onSessionCreated: () => {},
      onComplete: () => {},
    }, new Set(['forkSess']));

    // No float opened…
    expect(useFloatingSessionsStore.getState().floats).toHaveLength(0);
    // …and the orphan fork's PTY was never created.
    const creates = calls.filter(
      (c) => /\/api\/terminals$/.test(c.url) && (c.init?.method ?? 'POST') === 'POST',
    );
    expect(creates).toHaveLength(0);
  });

  it('restores a clone (isFork, isFloating: false) as a visible session even without its origin', async () => {
    const { calls } = setupIncrementingFetchMock();

    const snap: WorkspaceSnapshot = {
      version: 1,
      exportedAt: Date.now(),
      sessions: [
        makeSnap({
          originalSessionId: 'cloneSess',
          title: 'Clone of Thesis',
          isFork: true,
          isFloating: false,
          originSessionId: 'mainA', // origin NOT part of this restore
        }),
      ],
      rooms: [],
    };

    await importSnapshot(snap, { onSessionCreated: () => {}, onComplete: () => {} });

    // Restored as a normal session (PTY created, not dropped as an orphan popup)…
    const creates = calls.filter(
      (c) => /\/api\/terminals$/.test(c.url) && (c.init?.method ?? 'POST') === 'POST',
    );
    expect(creates).toHaveLength(1);
    // …keeping the kill-guard but NOT the floating flag…
    const body = JSON.parse((creates[0].init?.body ?? '{}') as string);
    expect(body.isFork).toBe(true);
    expect(body.isFloating).toBeUndefined();
    // …and no PiP float was opened for it.
    expect(useFloatingSessionsStore.getState().floats).toHaveLength(0);
  });
});

describe('isFloatingSnapshot', () => {
  it('trusts an explicit isFloating value', () => {
    expect(isFloatingSnapshot(makeSnap({ isFloating: true }))).toBe(true);
    expect(
      isFloatingSnapshot(makeSnap({ isFloating: false, isFork: true, originSessionId: 'x' })),
    ).toBe(false);
  });
  it('falls back to isFork+originSessionId for legacy snapshots', () => {
    expect(isFloatingSnapshot(makeSnap({ isFork: true, originSessionId: 'x' }))).toBe(true);
    expect(isFloatingSnapshot(makeSnap({ isFork: true }))).toBe(false);
    expect(isFloatingSnapshot(makeSnap())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Saved scrollback claiming — the "terminal shows another session's output" bug
// ---------------------------------------------------------------------------
//
// Repro: two sessions titled "Figma" in /Users/k/Android_App. The server keys
// each saved ring buffer by `title\0workDir`, which is NOT unique (an unnamed
// session's default title is `${host}:${workDir}`, so a collision is the norm).
// The client used to fold the list into a LAST-WINS Map and then hand the
// survivor to EVERY same-key session via a non-consuming get(). sshManager's
// prefillTerminalOutput concatenates those bytes AHEAD of the new PTY's own
// output, so the terminal replayed a FOREIGN scrollback tail followed by its
// own fresh banner.
describe('saved scrollback claiming', () => {
  const KEY = 'Figma\0/Users/k/Android_App';

  it('REGRESSION: two same-key sessions never receive the same buffer', () => {
    const index = buildSavedOutputIndex([
      { key: KEY, sessionId: 'aaa', data: 'BUF_A' },
      { key: KEY, sessionId: 'bbb', data: 'BUF_B' },
    ]);
    const first = claimSavedOutput(index, KEY, 'aaa');
    const second = claimSavedOutput(index, KEY, 'bbb');
    expect(first).toBe('BUF_A');
    expect(second).toBe('BUF_B');
    expect(first).not.toBe(second);
  });

  it('keeps BOTH buffers instead of dropping one to last-wins', () => {
    const index = buildSavedOutputIndex([
      { key: KEY, sessionId: 'aaa', data: 'BUF_A' },
      { key: KEY, sessionId: 'bbb', data: 'BUF_B' },
    ]);
    // A last-wins Map would have retained only BUF_B and lost BUF_A entirely.
    expect(index.get(KEY)?.map((e) => e.data)).toEqual(['BUF_A', 'BUF_B']);
  });

  it('hands each buffer to its true owner regardless of list order', () => {
    const index = buildSavedOutputIndex([
      { key: KEY, sessionId: 'aaa', data: 'BUF_A' },
      { key: KEY, sessionId: 'bbb', data: 'BUF_B' },
    ]);
    // Restore order is not save order — 'bbb' restores first.
    expect(claimSavedOutput(index, KEY, 'bbb')).toBe('BUF_B');
    expect(claimSavedOutput(index, KEY, 'aaa')).toBe('BUF_A');
  });

  it('a claimed buffer is consumed — a third same-key session gets nothing', () => {
    const index = buildSavedOutputIndex([
      { key: KEY, sessionId: 'aaa', data: 'BUF_A' },
      { key: KEY, sessionId: 'bbb', data: 'BUF_B' },
    ]);
    claimSavedOutput(index, KEY, 'aaa');
    claimSavedOutput(index, KEY, 'bbb');
    // No bytes left: better to restore nothing than to inject foreign output.
    expect(claimSavedOutput(index, KEY, 'ccc')).toBeUndefined();
  });

  it('still matches by key when ids were reminted (export -> import)', () => {
    // A foreign/older snapshot: originalSessionId matches nothing the server
    // just cleared. title\0workDir is the only surviving identity — it must
    // still restore, or scrollback silently vanishes on every real import.
    const index = buildSavedOutputIndex([{ key: KEY, sessionId: 'live-1', data: 'BUF_A' }]);
    expect(claimSavedOutput(index, KEY, 'ancient-id-from-old-export')).toBe('BUF_A');
  });

  it('tolerates a server that omits sessionId (older build)', () => {
    const index = buildSavedOutputIndex([{ key: KEY, data: 'BUF_A' }]);
    expect(claimSavedOutput(index, KEY, 'aaa')).toBe('BUF_A');
  });

  it('returns undefined for an unknown key and drops empty entries', () => {
    const index = buildSavedOutputIndex([
      { key: KEY, sessionId: 'aaa', data: '' },
      { key: '', sessionId: 'bbb', data: 'BUF_B' },
    ]);
    expect(claimSavedOutput(index, KEY, 'aaa')).toBeUndefined();
    expect(claimSavedOutput(index, 'nope\0/tmp', 'x')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Auto-send (and the other per-session queue switches) must survive a restart.
//
// A restart gives every session a NEW id, so the Dexie rows and the server's
// session_queues rows (both keyed by the old id) cannot be found again: the
// workspace snapshot is the only record the restore reads. Toggling a switch
// changes neither `sessions` nor `rooms`, the only things that scheduled a
// snapshot save, so on an idle board the snapshot predated the toggle and the
// session came back with the default (Auto-send ON) after a hard exit.
// ---------------------------------------------------------------------------

describe('scheduleAutomationSave — an Auto-send toggle reaches the snapshot', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const saves = (): WorkspaceSnapshot[] =>
    fetchMock.mock.calls
      .filter((c) => String(c[0]).includes('/api/workspace/save'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)) as WorkspaceSnapshot);
  const automationOf = (snap: WorkspaceSnapshot, id: string) =>
    snap.sessions.find((x) => x.originalSessionId === id)?.automation;
  const live = () => new Map<string, Session>([['s1', loopSession('s1')], ['s2', loopSession('s2')]]);

  beforeEach(() => {
    clearLocalStorage();
    _resetAutoSaveStateForTests();
    setRestorePending(false);
    useQueueStore.setState({ queues: new Map(), automation: new Map() });
    usePresenceStore.setState({ workspaceWriter: null } as never);
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }) as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    cancelAutoSave();
    setRestorePending(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('saves a snapshot carrying autoSend:false about a second after the toggle, for that session only', async () => {
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(live, () => []);
    await vi.advanceTimersByTimeAsync(900);
    expect(saves()).toHaveLength(0); // not at once: a burst of toggles coalesces
    await vi.advanceTimersByTimeAsync(200);
    const [snap] = saves();
    expect(automationOf(snap, 's1')?.autoSend).toBe(false);
    expect(automationOf(snap, 's2')).toBeUndefined(); // the other session keeps the default
  });

  it('is not starved by session churn: updates every 250 ms keep resetting the session timer, the toggle still saves', async () => {
    for (let t = 0; t < 32; t++) {
      scheduleAutoSave(live, () => []); // a busy session: an update every 250 ms, for 8 s
      if (t === 8) {
        useQueueStore.getState().setAutoSend('s1', false);
        scheduleAutomationSave(live, () => []);
      }
      await vi.advanceTimersByTimeAsync(250);
    }
    const withOff = saves().filter((snap) => automationOf(snap, 's1')?.autoSend === false);
    expect(withOff.length).toBeGreaterThan(0);
  });

  it('saves again when it is turned back ON, so a stale OFF cannot come back after a restart', async () => {
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(live, () => []);
    await vi.advanceTimersByTimeAsync(1_100);
    useQueueStore.getState().setAutoSend('s1', true);
    scheduleAutomationSave(live, () => []);
    await vi.advanceTimersByTimeAsync(1_100);
    const all = saves();
    expect(all).toHaveLength(2);
    expect(automationOf(all[0], 's1')?.autoSend).toBe(false);
    // default again: the snapshot omits it, and that omission is what overwrites the OFF
    expect(automationOf(all[1], 's1')).toBeUndefined();
  });

  it('coalesces a burst of toggles across sessions into one save that has all of them', async () => {
    for (const id of ['s1', 's2']) {
      useQueueStore.getState().setAutoSend(id, false);
      scheduleAutomationSave(live, () => []);
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(1_500);
    const all = saves();
    expect(all).toHaveLength(1);
    expect(automationOf(all[0], 's1')?.autoSend).toBe(false);
    expect(automationOf(all[0], 's2')?.autoSend).toBe(false);
  });

  it('does nothing while the restore decision is pending (the snapshot must not be overwritten)', async () => {
    _resetAutoSaveStateForTests(); // pending again
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(live, () => []);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });

  it('is cancelled by cancelAutoSave, like the session timer', async () => {
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(live, () => []);
    cancelAutoSave();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });

  it('keeps the single-writer rule: a device that is not the workspace writer does not save', async () => {
    usePresenceStore.setState({ workspaceWriter: 'another-device' } as never);
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(live, () => []);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });

  it('keeps the empty-snapshot guard: all sessions ended means nothing is written over the good snapshot', async () => {
    const ended = new Map<string, Session>([['s1', { ...loopSession('s1'), status: 'ended' } as Session]]);
    useQueueStore.getState().setAutoSend('s1', false);
    scheduleAutomationSave(() => ended, () => []);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(saves()).toHaveLength(0);
  });
});

describe('Auto-send round trip across a restart — per session', () => {
  beforeEach(() => {
    clearLocalStorage();
    useSessionStore.getState().setSessions(new Map());
    useRoomStore.setState({ rooms: [] });
    useQueueStore.setState({ queues: new Map(), automation: new Map() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('restores OFF for one session and the default for the other, under the new ids, and keeps both through the re-key', async () => {
    useQueueStore.getState().setAutoSend('old-1', false);
    const exported = JSON.parse(
      JSON.stringify(buildSnapshot(new Map([['old-1', loopSession('old-1')], ['old-2', loopSession('old-2')]]), [])),
    ) as WorkspaceSnapshot;

    // the app restarts: nothing in memory
    useQueueStore.setState({ queues: new Map(), automation: new Map() });
    let n = 0;
    setupFetchMock({
      '/api/sessions/clear-all': () => mockResponse({ savedOutputs: [] }),
      '/api/terminals': () => mockResponse({ ok: true, terminalId: `new-${++n}` }),
    });
    await importSnapshot(exported, { onSessionCreated: () => {}, onComplete: () => {} });

    const q = useQueueStore.getState();
    expect(q.getAutomation('new-1').autoSend).toBe(false); // old-1 (restored first)
    expect(q.getAutomation('new-2').autoSend).toBe(true); // old-2 keeps the default

    // the CLI reports its own id and the card is re-keyed: the OFF follows it
    useQueueStore.getState().migrateSession('new-1', 'hook-1');
    useQueueStore.getState().migrateSession('new-2', 'hook-2');
    expect(useQueueStore.getState().getAutomation('hook-1').autoSend).toBe(false);
    expect(useQueueStore.getState().getAutomation('hook-2').autoSend).toBe(true);
  });
});
