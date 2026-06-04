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
  buildSnapshot,
  deduplicateSessions,
  importSnapshot,
  scheduleAutoSave,
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
import { useQueueStore, type QueueItem } from '@/stores/queueStore';
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
});
