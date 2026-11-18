// test/sshManager.hookLevel.test.ts — the Automation mark reaches the agent's PTY environment (and only its own).
// node-pty is mocked: no shell is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawned = vi.hoisted(() => ({ env: [] as Array<Record<string, string> | undefined>, typed: [] as string[] }));

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn((_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
      spawned.env.push(opts.env);
      return {
        pid: 99999,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: (data: string) => { spawned.typed.push(data); },
        kill: () => {},
        resize: () => {},
      };
    }),
  },
}));

const base = { host: 'localhost', port: 22, username: 'tester', authMethod: 'key' as const, workingDir: '/tmp', command: '' };

describe('createTerminal — AASC_HOOK_LEVEL', () => {
  const saved = process.env.AASC_HOOK_LEVEL;
  beforeEach(() => { spawned.env = []; spawned.typed = []; });
  afterEach(() => {
    if (saved === undefined) delete process.env.AASC_HOOK_LEVEL;
    else process.env.AASC_HOOK_LEVEL = saved;
  });

  it('puts lite into the PTY of a session marked Automation', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    await createTerminal({ ...base, hookLevel: 'lite' }, null);
    expect(spawned.env[0]?.AASC_HOOK_LEVEL).toBe('lite');
  });

  it('leaves it out of an unmarked session', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    await createTerminal(base, null);
    expect(spawned.env[0]).toBeDefined();
    expect(spawned.env[0]).not.toHaveProperty('AASC_HOOK_LEVEL');
  });

  it('never passes on a level the server itself was started with', async () => {
    process.env.AASC_HOOK_LEVEL = 'lite';
    const { createTerminal } = await import('../server/sshManager.js');
    await createTerminal(base, null);
    expect(spawned.env[0]).not.toHaveProperty('AASC_HOOK_LEVEL');
  });
});

describe.skipIf(process.platform === 'win32')('createTerminal — AASC_HOOK_LEVEL in a local tmux launch', () => {
  // A tmux server keeps the environment of the PTY that started it and hands it to every later pane, AASC's or the
  // user's own: lite must never enter that PTY, and each pane sets or clears it for itself.
  const tmux = { ...base, command: 'bash', useTmux: true };
  const settle = () => vi.advanceTimersByTimeAsync(10_500);
  beforeEach(() => { spawned.env = []; spawned.typed = []; vi.useFakeTimers(); });
  afterEach(async () => {
    const { getTerminals, closeTerminal } = await import('../server/sshManager.js');
    for (const t of getTerminals()) closeTerminal(t.terminalId);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps lite out of the PTY that may start the tmux server, and exports it inside the pane', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    await createTerminal({ ...tmux, hookLevel: 'lite' }, null);
    await settle();
    expect(spawned.env[0]).not.toHaveProperty('AASC_HOOK_LEVEL');
    expect(spawned.typed.join('')).toContain('export AASC_HOOK_LEVEL=lite && bash');
  });

  it('clears an inherited lite inside an unmarked pane', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    await createTerminal(tmux, null);
    await settle();
    expect(spawned.typed.join('')).toContain('unset AASC_HOOK_LEVEL && bash');
  });
});
