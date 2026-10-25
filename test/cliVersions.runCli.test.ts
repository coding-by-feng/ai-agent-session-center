// test/cliVersions.runCli.test.ts — the real spawner, with child_process mocked: no process ever starts.
// It must settle when the CLI exits but something it started keeps the pipe open, and a timeout must
// end the whole process group (SIGTERM, then SIGKILL) and still settle.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new PassThrough();
  stderr = new PassThrough();
}
const spawned: Array<{ cmd: string; args: string[]; opts: Record<string, unknown>; child: FakeChild }> = [];

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[], opts: Record<string, unknown>) => {
      const child = new FakeChild();
      spawned.push({ cmd, args, opts, child });
      return child;
    }),
    execFile: vi.fn(),
  };
});

const { runCli, EXIT_DRAIN_MS, KILL_GRACE_MS } = await import('../server/cliVersions.js');

describe('runCli', () => {
  let kill: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    spawned.length = 0;
    // Never signal a real process: the fake pid is not ours.
    kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  });
  afterEach(() => {
    vi.useRealTimers();
    kill.mockRestore();
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
  });

  it('runs the fixed command in a login shell, own group, home folder, markers stripped, stdin closed', async () => {
    const p = runCli('codex', 'update', 60_000);
    const { cmd, args, opts, child } = spawned[0];
    expect(cmd).toBe(process.env.SHELL || '/bin/sh');
    expect(args).toEqual(['-lc', 'exec codex update']);
    expect(opts).toMatchObject({ detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    expect((opts.env as Record<string, string>).CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(opts.cwd).toBe((await import('node:os')).homedir());
    child.stdout.write('codex-cli 0.164.0\n');
    child.emit('exit', 0);
    child.emit('close', 0);
    await expect(p).resolves.toMatchObject({ code: 0, stdout: 'codex-cli 0.164.0\n', timedOut: false });
  });

  it('hands each output chunk to onOutput as it arrives, a split UTF-8 character kept whole', async () => {
    const chunks: string[] = [];
    const p = runCli('codex', 'update', 60_000, (stream, chunk) => chunks.push(`${stream}:${chunk}`));
    const { child } = spawned[0];
    const arrow = Buffer.from('→');
    child.stdout.write(Buffer.concat([Buffer.from('a '), arrow.subarray(0, 1)]));
    child.stdout.write(Buffer.concat([arrow.subarray(1), Buffer.from(' b\n')]));
    child.stderr.write('warn\n');
    await vi.advanceTimersByTimeAsync(0);
    child.emit('exit', 0);
    child.emit('close', 0);
    await expect(p).resolves.toMatchObject({ stdout: 'a → b\n', stderr: 'warn\n' });
    expect(chunks.join('')).toBe('stdout:a stdout:→ b\nstderr:warn\n');
  });

  it('settles shortly after exit even when a leftover process keeps the pipe open', async () => {
    const p = runCli('claude', 'version', 60_000);
    spawned[0].child.emit('exit', 0); // no 'close': a grandchild still holds stdout
    let done = false;
    void p.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toMatchObject({ code: 0, timedOut: false });
    expect(spawned[0].child.stdout.destroyed).toBe(true);
  });

  it('on a timeout, SIGTERMs then SIGKILLs the group and settles as timed out', async () => {
    const p = runCli('codex', 'update', 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
    await vi.advanceTimersByTimeAsync(KILL_GRACE_MS);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS);
    await expect(p).resolves.toMatchObject({ code: null, timedOut: true });
  });

  it('rejects when the shell cannot start', async () => {
    const p = runCli('codex', 'version', 1_000);
    spawned[0].child.emit('error', new Error('spawn ENOENT'));
    await expect(p).rejects.toThrow('spawn ENOENT');
  });
});
