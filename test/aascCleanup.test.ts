import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { onCleanup, _resetCleanupForTests } from '../cli/client/cleanup.js';

const ROOT = resolve(__dirname, '..');

afterEach(() => {
  _resetCleanupForTests();
  vi.restoreAllMocks();
});

describe('the process cleanup hooks', () => {
  for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`${signal} runs every cleanup, newest first, then exits ${code}`, () => {
      // The real handlers are installed on this process; only the final exit is caught.
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      const order: string[] = [];
      onCleanup(() => order.push('tunnel'));
      onCleanup(() => order.push('tty'));
      process.emit(signal, signal);
      expect(order).toEqual(['tty', 'tunnel']);
      expect(exit).toHaveBeenCalledWith(code);
    });
  }

  it('process exit runs them too, once', () => {
    const fn = vi.fn();
    onCleanup(fn);
    process.emit('exit', 0);
    process.emit('exit', 0);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('an unregistered cleanup does not run, and one that throws does not stop the rest', () => {
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const gone = vi.fn();
    const after = vi.fn();
    onCleanup(after);
    onCleanup(() => { throw new Error('boom'); });
    onCleanup(gone)();
    process.emit('SIGTERM', 'SIGTERM');
    expect(gone).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalled();
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0: a liveness check on the fake ssh this test started
    return true;
  } catch {
    return false;
  }
};

describe('a signalled aasc never orphans its ssh tunnel', () => {
  it('SIGTERM kills the ssh child, removes the socket folder, and exits 143', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aasc-sig-'));
    const bin = join(dir, 'bin');
    const pidFile = join(dir, 'ssh.pid');
    let sshPid = 0;
    try {
      (await import('fs')).mkdirSync(bin);
      symlinkSync(join(ROOT, 'test/fixtures/aasc/fake-ssh.cjs'), join(bin, 'ssh'));
      const child = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'test/fixtures/aasc/tunnelChild.ts')], {
        cwd: ROOT,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_SSH_PID_FILE: pidFile, HOME: dir, XDG_CONFIG_HOME: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (c) => { stderr += c; });
      const report = await new Promise<{ socketPath: string | null }>((res, rej) => {
        child.stdout.once('data', (c) => res(JSON.parse(String(c))));
        child.once('exit', () => rej(new Error(`child exited early: ${stderr}`)));
      });
      sshPid = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(sshPid)).toBe(true);
      expect(report.socketPath && existsSync(report.socketPath)).toBeTruthy();

      const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
      child.kill('SIGTERM');
      expect(await exited).toBe(143);
      const deadline = Date.now() + 3000;
      while (alive(sshPid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(alive(sshPid)).toBe(false);
      expect(existsSync(resolve(report.socketPath!, '..'))).toBe(false);
    } finally {
      // Only ever the fake ssh this test started.
      if (sshPid && alive(sshPid)) process.kill(sshPid, 'SIGKILL');
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
