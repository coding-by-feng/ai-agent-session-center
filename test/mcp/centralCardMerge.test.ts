// test/mcp/centralCardMerge.test.ts — when two cards become one, the survivor is the central its new
// terminal was launched as, or no central at all.
//
// Two places fold one card into another and copy its terminal over:
//   - the session matcher's merge (reKeyResumedSession, when the target id is already a card), and
//   - the restore's orphan absorb (sessionStore.handleEvent): after an AASC restart, Priority 0.5 re-keys
//     the old card from the server snapshot, and the fresh CONNECTING card the workspace restore made for
//     the same folder is absorbed into it and removed.
// The marker goes where the terminal goes, so the central is still found (resolveCentralSession), and the
// removed card does not revoke it: only the exit of the terminal it is attached to does (lifecycle.ts).
// Its absence goes too: a restore that had to launch a plain session (Ruling 16) leaves no central behind,
// whatever marker the snapshot's card carried.
//
// Nothing here starts a process or a PTY: node-pty is the recording fake, the database is stubbed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { centrals, resolveCentralSession } from '../../server/mcp/centrals.js';
import { watchCentralLifecycle } from '../../server/mcp/lifecycle.js';
import { fakeTerminalExits, globalInput, makeMarker } from './centralFixtures.js';

vi.mock('node-pty', async () => (await import('./fakePty.js')).nodePtyModule);

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

/** A card with only what the matcher's merge reads. */
function card(over: Partial<Session>): Session {
  return {
    sessionId: 'card',
    status: 'idle',
    projectPath: '/tmp/merge',
    projectName: 'merge',
    title: '',
    promptHistory: [],
    toolLog: [],
    responseLog: [],
    events: [],
    terminalId: null,
    cachedPid: null,
    ...over,
  } as unknown as Session;
}

describe("the matcher's merge (reKeyResumedSession onto an existing card)", () => {
  it('gives the surviving card the central marker of the card whose terminal it takes', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const marker = makeMarker('6f5e4d3c-2b1a-4098-8776-5544332211aa');
    const existing = card({ sessionId: 'uuid-merge', status: 'ended' });
    const fresh = card({ sessionId: 'term-merge', terminalId: 'term-merge', central: marker });
    const sessions = new Map<string, Session>([
      ['uuid-merge', existing],
      ['term-merge', fresh],
    ]);

    const merged = reKeyResumedSession(sessions, fresh, 'uuid-merge', 'term-merge');

    expect(merged).toBe(existing);
    expect(merged.terminalId).toBe('term-merge');
    expect(merged.central).toEqual(marker);
    expect(sessions.has('term-merge')).toBe(false);
  });

  it('clears the marker of the surviving card when the terminal it takes was launched plain', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const marker = makeMarker('0a9b8c7d-6e5f-4a3b-9c1d-0e1f2a3b4c5d');
    const existing = card({ sessionId: 'uuid-plain', status: 'ended', central: marker });
    const fresh = card({ sessionId: 'term-plain', terminalId: 'term-plain' });
    const sessions = new Map<string, Session>([
      ['uuid-plain', existing],
      ['term-plain', fresh],
    ]);

    const merged = reKeyResumedSession(sessions, fresh, 'uuid-plain', 'term-plain');

    expect(merged.terminalId).toBe('term-plain');
    expect(merged.central).toBeUndefined();
  });

  it('keeps the marker of the surviving card when the other card brings no terminal', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const marker = makeMarker('1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8');
    const existing = card({ sessionId: 'uuid-keep', status: 'ended', central: marker });
    const hookOnly = card({ sessionId: 'term-keep' });
    const sessions = new Map<string, Session>([
      ['uuid-keep', existing],
      ['term-keep', hookOnly],
    ]);

    expect(reKeyResumedSession(sessions, hookOnly, 'uuid-keep', 'term-keep').central).toEqual(
      marker,
    );
  });
});

describe("the restore's orphan absorb (sessionStore.handleEvent, Priority 0.5)", () => {
  const DIR = '/tmp/central-absorb';
  const OLD = '22222222-3333-4444-8555-666666666666';
  const NEW = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  const FRESH = 'term-restored-central';
  // A second folder, whose old card was a central: the restore could not bring that central back.
  const PLAIN_DIR = '/tmp/central-absorb-plain';
  const PLAIN_OLD = '33333333-4444-4555-8666-777777777777';
  const PLAIN_NEW = '88888888-9999-4aaa-8bbb-cccccccccccc';
  const PLAIN_FRESH = 'term-restored-plain';
  const STALE = makeMarker('4d5e6f70-8192-4a3b-8c4d-5e6f70819203');
  let dataDir = '';
  let previousDataDir: string | undefined;
  let store: typeof import('../../server/sessionStore.js');

  beforeAll(async () => {
    // The server snapshot an AASC restart loads: the old cards, whose PTYs died with the server.
    dataDir = mkdtempSync(join(tmpdir(), 'aasc-central-absorb-'));
    mkdirSync(join(dataDir, 'data'));
    const now = Date.now();
    const old = {
      sessionId: OLD,
      projectPath: DIR,
      projectName: 'central-absorb',
      title: 'Central',
      status: 'working',
      animationState: 'Running',
      emote: null,
      startedAt: now - 60_000,
      lastActivityAt: now - 60_000,
      endedAt: null,
      currentPrompt: '',
      promptHistory: [],
      toolUsage: {},
      totalToolCalls: 0,
      model: '',
      subagentCount: 0,
      toolLog: [],
      responseLog: [],
      events: [],
      archived: 0,
      source: 'ssh',
      pendingTool: null,
      waitingDetail: null,
      cachedPid: null,
      queueCount: 0,
      terminalId: 'term-before-restart',
      sshHost: 'localhost',
      sshCommand: 'claude',
      sshConfig: {
        host: 'localhost',
        port: 22,
        username: 'local',
        authMethod: 'key',
        workingDir: DIR,
        command: 'claude',
      },
    };
    const oldCentral = {
      ...old,
      sessionId: PLAIN_OLD,
      projectPath: PLAIN_DIR,
      projectName: 'central-absorb-plain',
      terminalId: 'term-before-restart-2',
      sshConfig: { ...old.sshConfig, workingDir: PLAIN_DIR },
      central: STALE,
    };
    writeFileSync(
      join(dataDir, 'data', 'sessions-snapshot.json'),
      JSON.stringify({
        version: 1,
        savedAt: now,
        eventSeq: 0,
        mqOffset: 0,
        sessions: { [OLD]: old, [PLAIN_OLD]: oldCentral },
        projectSessionCounters: {},
        pidToSession: {},
        pendingResume: {},
      }),
    );
    previousDataDir = process.env.APP_USER_DATA;
    process.env.APP_USER_DATA = dataDir;
    store = await import('../../server/sessionStore.js');
    expect(store.loadSnapshot()).not.toBeNull();
  });

  afterAll(() => {
    for (const record of centrals.list()) centrals.revoke(record.centralId);
    if (previousDataDir === undefined) delete process.env.APP_USER_DATA;
    else process.env.APP_USER_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('absorbs the central card into the re-keyed one: the marker survives and the central is not revoked', async () => {
    expect(store.getSession(OLD)).toMatchObject({ status: 'idle', terminalId: null });
    expect(store.getSession(OLD)?.central).toBeUndefined();

    // The workspace restore relaunched the central in a fresh terminal: a CONNECTING card that carries it.
    const record = centrals.mint(globalInput());
    const marker = makeMarker(record.centralId);
    await store.createTerminalSession(FRESH, {
      host: 'localhost',
      workingDir: DIR,
      command: 'claude',
      central: marker,
    });
    centrals.attachTerminal(record.centralId, FRESH);

    // The real watcher on the real broadcast feed, and a terminal-exit feed this test plays.
    const { onBroadcast } = await import('../../server/wsManager.js');
    const seen: string[] = [];
    const stopSeen = onBroadcast((msg) => seen.push(msg.type));
    const exits = fakeTerminalExits();
    const stopWatching = watchCentralLifecycle(centrals, onBroadcast, exits.subscribe);

    try {
      // The resumed CLI starts under a new id in the restored terminal.
      store.handleEvent({
        session_id: NEW,
        hook_event_name: 'SessionStart',
        agent_terminal_id: FRESH,
        cwd: DIR,
        tty_path: '/dev/ttys004',
      } as never);
      await vi.waitFor(() => expect(seen).toContain('session_removed'));

      const survivor = store.getSession(NEW);
      expect(survivor?.terminalId).toBe(FRESH);
      expect(survivor?.central).toEqual(marker);
      expect(store.getSession(FRESH)).toBeNull();
      expect(
        resolveCentralSession(record.centralId, Object.values(store.getAllSessions()))?.sessionId,
      ).toBe(NEW);
      // The card was removed, the central was not: its terminal lives on, in the surviving card.
      expect(centrals.byId(record.centralId)?.token).toBe(record.token);

      // What does revoke it: the terminal it is attached to going away.
      exits.exit(FRESH);
      expect(centrals.byId(record.centralId)).toBeNull();
    } finally {
      stopWatching();
      stopSeen();
    }
  });

  it('absorbs a plain restore into a re-keyed central: the marker its snapshot carried goes', async () => {
    expect(store.getSession(PLAIN_OLD)).toMatchObject({ status: 'idle', terminalId: null });
    expect(store.getSession(PLAIN_OLD)?.central).toEqual(STALE);

    // The restore could not bring the central back (Ruling 16): a plain CONNECTING card for the same folder.
    await store.createTerminalSession(PLAIN_FRESH, {
      host: 'localhost',
      workingDir: PLAIN_DIR,
      command: 'claude',
    });

    store.handleEvent({
      session_id: PLAIN_NEW,
      hook_event_name: 'SessionStart',
      agent_terminal_id: PLAIN_FRESH,
      cwd: PLAIN_DIR,
      tty_path: '/dev/ttys005',
    } as never);

    const survivor = store.getSession(PLAIN_NEW);
    expect(survivor?.terminalId).toBe(PLAIN_FRESH);
    expect(survivor?.central).toBeUndefined();
    expect(store.getSession(PLAIN_FRESH)).toBeNull();
    expect(
      resolveCentralSession(STALE.centralId, Object.values(store.getAllSessions())),
    ).toBeNull();
  });

  it('a terminal registered after a card owns it: the card is a central exactly when the terminal is', async () => {
    const terminal = 'term-late-registered';
    const launch = { host: 'localhost', workingDir: '/tmp/central-late', command: 'claude' };
    await store.createTerminalSession(terminal, { ...launch, central: STALE });
    expect(store.getSession(terminal)?.central).toEqual(STALE);

    // The late branch (a card already owns this terminal), for a terminal that was launched plain.
    await store.createTerminalSession(terminal, launch);

    expect(store.getSession(terminal)?.central).toBeUndefined();
  });
});
