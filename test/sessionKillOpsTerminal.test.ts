// test/sessionKillOpsTerminal.test.ts — killing a session must tear down its
// ops shell ("Commands Terminal") too.
//
// Regression cover for the premature "Terminal limit reached" report: killSession
// closed only session.terminalId, so every killed session left a live blank shell
// in the PTY map. Those orphans kept consuming terminal budget, and new sessions
// were refused while the visible session count sat far below the cap.
import { describe, it, beforeEach, expect, vi } from 'vitest';

// sessionStore opens better-sqlite3 at module scope via db.ts. Stub the handful of
// functions it calls so this suite exercises in-memory behaviour and stays runnable
// when the native module's ABI doesn't match the local Node — otherwise the whole
// file fails at import and silently covers nothing.
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));


const sshMocks = vi.hoisted(() => ({ closeTerminal: vi.fn() }));

vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, closeTerminal: sshMocks.closeTerminal };
});

const { createTerminalSession, killSession, getSession } = await import('../server/sessionStore.js');

beforeEach(() => {
  sshMocks.closeTerminal.mockClear();
});

async function makeSession(id: string, opsTerminalId?: string) {
  return createTerminalSession(
    id,
    { host: 'localhost', workingDir: '/tmp/ops-kill-test', command: 'claude' },
    opsTerminalId,
  );
}

describe('killSession — ops terminal teardown', () => {
  it('closes both the agent terminal and the ops shell', async () => {
    await makeSession('ops-kill-1', 'ops-kill-1-ops');

    killSession('ops-kill-1');

    const closed = sshMocks.closeTerminal.mock.calls.map(([id]) => id);
    expect(closed).toContain('ops-kill-1');
    expect(closed).toContain('ops-kill-1-ops');
  });

  it('clears opsTerminalId so the dead shell is not shown as reconnectable', async () => {
    await makeSession('ops-kill-2', 'ops-kill-2-ops');

    killSession('ops-kill-2');

    expect(getSession('ops-kill-2')?.opsTerminalId).toBeNull();
  });

  it('still works for a session with no ops shell', async () => {
    await makeSession('ops-kill-3');

    killSession('ops-kill-3');

    expect(sshMocks.closeTerminal.mock.calls.map(([id]) => id)).toEqual(['ops-kill-3']);
  });
});
