// test/codexNoDaemonLaunch.test.ts — AASC-59: what is typed into a terminal that starts Codex.
//
// Every local launch path types its line through one of two places in sshManager:
// createTerminal's auto-launch, and writeWhenReady for the deferred ones (resume, fork,
// clone, workspace restore, pinned respawn, Restart, floating forks). Both must put
// `--no-daemon` on a local interactive Codex when the installed Codex has it, and must
// change nothing when it does not (an unknown flag stops an older Codex from starting),
// on a remote host (its Codex was never probed), or for Claude.
//
// No real process is reached: node-pty is a stand-in that records what is typed, and the
// capability probe (which would run `codex --help`) is replaced.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { typed, support } = vi.hoisted(() => ({
  typed: [] as string[],
  support: { value: 'supported' as 'supported' | 'unsupported' | 'unknown', calls: 0 },
}));

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 4_242_424, // invented: above the OS pid range
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: (data: string) => { typed.push(data); },
      kill: () => {},
      resize: () => {},
    })),
  },
}));

vi.mock('../server/codexNoDaemon.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/codexNoDaemon.js')>();
  return {
    ...mod,
    codexNoDaemonSupport: vi.fn(async () => { support.calls += 1; return support.value; }),
  };
});

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

const ID = '01a1431a-6dbc-7fd2-9f87-00175b7a838a';
const realPlatform = process.platform;

describe.skipIf(realPlatform === 'win32')('Codex launch lines (sshManager)', () => {
  // createTerminal types once the shell is "ready" — a prompt, or a fallback timer (2 s local,
  // 10 s over ssh). Fake timers let the fallback fire at once.
  const settle = () => vi.advanceTimersByTimeAsync(10_500);

  beforeEach(() => {
    typed.length = 0;
    support.value = 'supported';
    support.calls = 0;
    delete process.env.AASC_DISABLE_CODEX_NO_DAEMON;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { getTerminals, closeTerminal } = await import('../server/sshManager.js');
    for (const t of getTerminals()) closeTerminal(t.terminalId);
    vi.clearAllTimers();
    vi.useRealTimers();
    delete process.env.AASC_DISABLE_CODEX_NO_DAEMON;
  });

  const config = (over: Record<string, unknown> = {}) => ({
    host: 'localhost',
    port: 22,
    username: 'tester',
    authMethod: 'key' as const,
    workingDir: '/tmp',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    ...over,
  });

  describe('auto-launch (createTerminal) — the phone and desktop "start a session" path', () => {
    it('starts a local Codex with --no-daemon so its hooks come from the PTY', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config(), null);
      await settle();
      expect(typed).toEqual(['codex --no-daemon --dangerously-bypass-approvals-and-sandbox\r']);
    });

    it('keeps the model / effort launch flags', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config({ command: 'codex', model: 'gpt-6', effortLevel: 'high' }), null);
      await settle();
      expect(typed).toHaveLength(1);
      expect(typed[0].startsWith('codex --no-daemon ')).toBe(true);
      expect(typed[0]).toContain('--model gpt-6');
    });

    it('puts it inside a local tmux wrapper too', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config({ useTmux: true }), null);
      await settle();
      expect(typed).toHaveLength(1);
      expect(typed[0]).toMatch(/^tmux new-session -s '[^']+' 'codex --no-daemon --dangerously-bypass-approvals-and-sandbox'\r$/);
    });

    it('types the plain command when the installed Codex has no --no-daemon (older Codex)', async () => {
      support.value = 'unsupported';
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config(), null);
      await settle();
      expect(typed).toEqual(['codex --dangerously-bypass-approvals-and-sandbox\r']);
    });

    it('types the plain command when the probe could not tell', async () => {
      support.value = 'unknown';
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config(), null);
      await settle();
      expect(typed).toEqual(['codex --dangerously-bypass-approvals-and-sandbox\r']);
    });

    it('never touches a remote host (its Codex was not probed)', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config({ host: 'build-box.example.invalid' }), null);
      await settle();
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('codex --dangerously-bypass-approvals-and-sandbox');
      expect(typed[0]).not.toContain('--no-daemon');
      expect(support.calls).toBe(0);
    });

    it('never probes or touches a Claude launch', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config({ command: 'claude --dangerously-skip-permissions', sessionTitle: 'T' }), null);
      await settle();
      expect(typed).toHaveLength(1);
      expect(typed[0]).not.toContain('--no-daemon');
      expect(support.calls).toBe(0);
    });

    it('honours the opt-out AASC_DISABLE_CODEX_NO_DAEMON=1', async () => {
      process.env.AASC_DISABLE_CODEX_NO_DAEMON = '1';
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(config(), null);
      await settle();
      expect(typed).toEqual(['codex --dangerously-bypass-approvals-and-sandbox\r']);
      expect(support.calls).toBe(0);
    });
  });

  describe('deferred launch (writeWhenReady) — resume, fork, restore, respawn, Restart', () => {
    it('covers both halves of a resume-with-fallback line', async () => {
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(config({ command: '', deferredLaunch: true }), null);
      const written = writeWhenReady(id, `codex --yolo resume '${ID}' || codex --yolo\r`);
      await settle();
      expect(await written).toBe(true);
      expect(typed).toEqual([`codex --yolo resume --no-daemon '${ID}' || codex --no-daemon --yolo\r`]);
    });

    it('moves a stored root-level flag (the hook stores the live CLI\'s ps args) instead of doubling it', async () => {
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(config({ command: '', deferredLaunch: true }), null);
      const written = writeWhenReady(id, `codex --no-daemon --yolo resume '${ID}' || codex --no-daemon --yolo\r`);
      await settle();
      await written;
      expect(typed).toEqual([`codex --yolo resume --no-daemon '${ID}' || codex --no-daemon --yolo\r`]);
    });

    it('drops a stored flag the installed Codex no longer accepts', async () => {
      support.value = 'unsupported';
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(config({ command: '', deferredLaunch: true }), null);
      const written = writeWhenReady(id, `codex --no-daemon --yolo resume '${ID}'\r`);
      await settle();
      await written;
      expect(typed).toEqual([`codex --yolo resume '${ID}'\r`]);
    });

    it('leaves non-launch writes (a prompt typed into a running agent) alone', async () => {
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(config({ command: '', deferredLaunch: true }), null);
      const written = writeWhenReady(id, 'please run codex later\r');
      await settle();
      await written;
      expect(typed).toEqual(['please run codex later\r']);
      expect(support.calls).toBe(0);
    });
  });
});
