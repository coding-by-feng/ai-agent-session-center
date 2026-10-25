// test/mcp/handsOffMerge.test.ts — when two cards become one, hands-off is never lost: the survivor is hands-off
// when either card was. Hands-off is a protection (a central may not type into the session), so the merge only ever
// adds it: a restore that brings the flag back must not lose it to a card the server's snapshot knew without it,
// and a card that already has it must not lose it to a fresh card that has none.
//
// Two places fold one card into another and copy its terminal over (as test/mcp/centralCardMerge.test.ts says):
//   - the session matcher's merge (reKeyResumedSession, when the target id is already a card), and
//   - the restore's orphan absorb (sessionStore.handleEvent): after an AASC restart, Priority 0.5 re-keys the old
//     card from the server snapshot, and the fresh CONNECTING card the workspace restore made for the same folder
//     is absorbed into it and removed.
//
// Nothing here starts a process or a PTY: node-pty is the recording fake, the database is stubbed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';

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
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

// Second line of defence (known-issues.md: a test must never reach a real process): any real signal other than the
// liveness probe (signal 0) fails loudly. Nothing here signals one; the real store is driven with hooks only.
const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`handsOffMerge.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

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
  it('gives the surviving card the flag of the card whose terminal it takes', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const existing = card({ sessionId: 'uuid-a', status: 'ended' });
    const fresh = card({ sessionId: 'term-a', terminalId: 'term-a', handsOff: true });
    const sessions = new Map<string, Session>([['uuid-a', existing], ['term-a', fresh]]);

    const merged = reKeyResumedSession(sessions, fresh, 'uuid-a', 'term-a');

    expect(merged).toBe(existing);
    expect(merged.terminalId).toBe('term-a');
    expect(merged.handsOff).toBe(true);
  });

  it('keeps the flag of the surviving card when the card whose terminal it takes has none', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const existing = card({ sessionId: 'uuid-b', status: 'ended', handsOff: true });
    const fresh = card({ sessionId: 'term-b', terminalId: 'term-b' });
    const sessions = new Map<string, Session>([['uuid-b', existing], ['term-b', fresh]]);

    expect(reKeyResumedSession(sessions, fresh, 'uuid-b', 'term-b').handsOff).toBe(true);
  });

  it('leaves a merge of two plain cards plain: no flag appears from nowhere', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const existing = card({ sessionId: 'uuid-c', status: 'ended' });
    const fresh = card({ sessionId: 'term-c', terminalId: 'term-c' });
    const sessions = new Map<string, Session>([['uuid-c', existing], ['term-c', fresh]]);

    expect(reKeyResumedSession(sessions, fresh, 'uuid-c', 'term-c')).not.toHaveProperty('handsOff');
  });

  it('keeps the flag of the surviving card when the other card is only hook-made (no terminal)', async () => {
    const { reKeyResumedSession } = await import('../../server/sessionMatcher.js');
    const existing = card({ sessionId: 'uuid-d', status: 'ended', handsOff: true });
    const hookOnly = card({ sessionId: 'term-d' });
    const sessions = new Map<string, Session>([['uuid-d', existing], ['term-d', hookOnly]]);

    expect(reKeyResumedSession(sessions, hookOnly, 'uuid-d', 'term-d').handsOff).toBe(true);
  });
});

describe("the restore's orphan absorb (sessionStore.handleEvent, Priority 0.5)", () => {
  const FLAGGED_DIR = '/tmp/hands-off-absorb-flagged';
  const KEPT_DIR = '/tmp/hands-off-absorb-kept';
  const PLAIN_DIR = '/tmp/hands-off-absorb-plain';
  const FLAGGED_OLD = '22222222-3333-4444-8555-666666666661';
  const KEPT_OLD = '22222222-3333-4444-8555-666666666662';
  const PLAIN_OLD = '22222222-3333-4444-8555-666666666663';
  let dataDir = '';
  let previousDataDir: string | undefined;
  let store: typeof import('../../server/sessionStore.js');

  /** The old card a server snapshot holds, whose PTY died with the server. */
  const oldCard = (sessionId: string, dir: string, over: Record<string, unknown> = {}) => ({
    sessionId,
    projectPath: dir,
    projectName: dir.split('/').pop(),
    title: 'Worker',
    status: 'working',
    animationState: 'Running',
    emote: null,
    startedAt: Date.now() - 60_000,
    lastActivityAt: Date.now() - 60_000,
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
    terminalId: `term-before-${sessionId.slice(-1)}`,
    sshHost: 'localhost',
    sshCommand: 'claude',
    sshConfig: { host: 'localhost', port: 22, username: 'local', authMethod: 'key', workingDir: dir, command: 'claude' },
    ...over,
  });

  /** The workspace restore's side: a fresh CONNECTING card for the folder, then the resumed CLI under a new id. */
  async function restore(dir: string, fresh: string, newId: string, tty: string, handsOff: boolean): Promise<void> {
    await store.createTerminalSession(fresh, { host: 'localhost', workingDir: dir, command: 'claude', ...(handsOff ? { handsOff: true } : {}) });
    store.handleEvent({
      session_id: newId,
      hook_event_name: 'SessionStart',
      agent_terminal_id: fresh,
      cwd: dir,
      tty_path: tty,
    } as never);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'aasc-handsoff-absorb-'));
    mkdirSync(join(dataDir, 'data'));
    writeFileSync(
      join(dataDir, 'data', 'sessions-snapshot.json'),
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        eventSeq: 0,
        mqOffset: 0,
        sessions: {
          [FLAGGED_OLD]: oldCard(FLAGGED_OLD, FLAGGED_DIR),
          [KEPT_OLD]: oldCard(KEPT_OLD, KEPT_DIR, { handsOff: true }),
          [PLAIN_OLD]: oldCard(PLAIN_OLD, PLAIN_DIR),
        },
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
    vi.restoreAllMocks();
    if (previousDataDir === undefined) delete process.env.APP_USER_DATA;
    else process.env.APP_USER_DATA = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('brings the flag the restore carried into the card it is absorbed by (the server’s snapshot lacked it)', async () => {
    expect(store.getSession(FLAGGED_OLD)).not.toHaveProperty('handsOff');

    await restore(FLAGGED_DIR, 'term-restored-flagged', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001', '/dev/ttys021', true);

    const survivor = store.getSession('aaaaaaaa-bbbb-4ccc-8ddd-000000000001');
    expect(survivor?.terminalId).toBe('term-restored-flagged');
    expect(survivor?.handsOff).toBe(true);
    expect(store.getSession('term-restored-flagged')).toBeNull();
  });

  it('keeps the flag of the card that has it when the restored card has none', async () => {
    expect(store.getSession(KEPT_OLD)?.handsOff).toBe(true);

    await restore(KEPT_DIR, 'term-restored-kept', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002', '/dev/ttys022', false);

    const survivor = store.getSession('aaaaaaaa-bbbb-4ccc-8ddd-000000000002');
    expect(survivor?.terminalId).toBe('term-restored-kept');
    expect(survivor?.handsOff).toBe(true);
  });

  it('adds nothing to a merge of two plain cards', async () => {
    await restore(PLAIN_DIR, 'term-restored-plain', 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003', '/dev/ttys023', false);

    const survivor = store.getSession('aaaaaaaa-bbbb-4ccc-8ddd-000000000003');
    expect(survivor?.terminalId).toBe('term-restored-plain');
    expect(survivor).not.toHaveProperty('handsOff');
  });
});
