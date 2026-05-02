// test/sshManager.workdir.test.ts — RC-6 fix verification.
// Verifies that createTerminal() falls back to homedir when the requested
// workingDir does not exist on disk, instead of letting pty.spawn throw ENOENT.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';

// We need to mock node-pty BEFORE the module under test imports it.
// The mock captures spawn arguments so the test can assert that `cwd` was
// rewritten to homedir() when the original directory does not exist.
let lastSpawnOptions: { cwd?: string; env?: Record<string, string> } | null = null;
let mockSpawnImpl: ((cmd: string, args: string[], opts: { cwd?: string }) => unknown) | null = null;

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn((cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> }) => {
      lastSpawnOptions = opts;
      if (mockSpawnImpl) return mockSpawnImpl(cmd, args, opts);
      // Return a minimal IPty-shaped object; tests don't actually run the shell.
      return {
        pid: 99999,
        onData: () => ({ dispose: () => {} }),
        onExit: () => ({ dispose: () => {} }),
        write: () => {},
        kill: () => {},
        resize: () => {},
      };
    }),
  },
}));

describe('sshManager.createTerminal — workingDir existence check (RC-6 fix)', () => {
  beforeEach(() => {
    lastSpawnOptions = null;
    mockSpawnImpl = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('falls back to homedir when workingDir does not exist', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    const missingDir = '/tmp/this-dir-does-not-exist-xyz12345';
    const config = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      authMethod: 'key' as const,
      workingDir: missingDir,
      command: '',
    };

    // Should NOT throw despite the missing dir
    const terminalId = await createTerminal(config, null);
    expect(typeof terminalId).toBe('string');
    expect(terminalId.length).toBeGreaterThan(0);
    expect(lastSpawnOptions?.cwd).toBe(homedir());
  });

  it('uses the requested workingDir when it exists', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    // Use the OS tmp dir which is guaranteed to exist on test runners
    const existingDir = '/tmp';
    const config = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      authMethod: 'key' as const,
      workingDir: existingDir,
      command: '',
    };

    await createTerminal(config, null);
    expect(lastSpawnOptions?.cwd).toBe(existingDir);
  });

  it('uses homedir when workingDir is "~"', async () => {
    const { createTerminal } = await import('../server/sshManager.js');
    const config = {
      host: 'localhost',
      port: 22,
      username: 'tester',
      authMethod: 'key' as const,
      workingDir: '~',
      command: '',
    };

    await createTerminal(config, null);
    expect(lastSpawnOptions?.cwd).toBe(homedir());
  });
});
