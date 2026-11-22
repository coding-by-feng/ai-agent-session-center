// test/claudePrint.test.ts — the one way the server runs `claude -p` with a prompt on stdin (Nov 20 2026).
// The child here is this Node binary with a one-line script, never `claude`, so no test starts the CLI.
// The login-shell lookup is always faked: no test starts the user's shell either.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { runPrint, resolveCli, lastAbsolutePath, clearCliPathCache } from '../server/claudePrint.js';

const node = process.execPath;
const asIs = async (name: string) => name;

describe('runPrint', () => {
  it('sends the prompt on stdin and answers the trimmed output', async () => {
    await expect(runPrint(node, ['-e', 'process.stdin.pipe(process.stdout)'], '  • a line \n', 10_000)).resolves.toBe('• a line');
  });

  it('rejects, without an uncaught EPIPE, when the child exits before reading a large prompt', async () => {
    // Past the ~64 KB pipe buffer the write is still pending when the child exits. With no error handler on
    // stdin that EPIPE was an uncaught exception, and the desktop app's crash logger quits on one.
    const big = '日'.repeat(400_000); // 1.2 MB, like a long day of CJK prompts
    await expect(runPrint(node, ['-e', 'process.exit(3)'], big, 10_000)).rejects.toMatchObject({ code: 3 });
  });

  it('rejects when the command is not installed', async () => {
    await expect(runPrint('aasc-no-such-command-xyz', [], 'hi', 10_000, { resolve: asIs })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the path the resolver found, not the bare name (packaged app PATH, Nov 21 2026)', async () => {
    const resolve = vi.fn(async () => node);
    await expect(runPrint('claude', ['-e', 'process.stdin.pipe(process.stdout)'], 'ok', 10_000, { resolve })).resolves.toBe('ok');
    expect(resolve).toHaveBeenCalledWith('claude');
  });
});

describe('resolveCli', () => {
  beforeEach(() => clearCliPathCache());

  it('answers the login shell’s path and asks only once', async () => {
    const lookup = vi.fn(async () => '/Users/me/.local/bin/claude');
    await expect(resolveCli('claude', lookup)).resolves.toBe('/Users/me/.local/bin/claude');
    await expect(resolveCli('claude', lookup)).resolves.toBe('/Users/me/.local/bin/claude');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it('falls back to the bare name on a miss and asks again next time', async () => {
    const lookup = vi.fn(async () => null);
    await expect(resolveCli('claude', lookup)).resolves.toBe('claude');
    await expect(resolveCli('claude', lookup)).resolves.toBe('claude');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('falls back to the bare name when the lookup throws', async () => {
    await expect(resolveCli('claude', async () => { throw new Error('shell died'); })).resolves.toBe('claude');
  });

  it('leaves a path alone without asking', async () => {
    const lookup = vi.fn(async () => '/elsewhere');
    await expect(resolveCli('/usr/local/bin/claude', lookup)).resolves.toBe('/usr/local/bin/claude');
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('lastAbsolutePath', () => {
  it('skips what a chatty profile prints and takes the last path line', () => {
    expect(lastAbsolutePath('Welcome back!\n/opt/old/claude\n/Users/me/.local/bin/claude\n')).toBe('/Users/me/.local/bin/claude');
  });

  it('answers null when no line is a path (an alias or function prints its name)', () => {
    expect(lastAbsolutePath('claude: aliased to foo\n')).toBeNull();
    expect(lastAbsolutePath('')).toBeNull();
  });
});
