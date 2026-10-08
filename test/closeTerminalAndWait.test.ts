// test/closeTerminalAndWait.test.ts — closing a terminal and KNOWING its agent is gone.
//
// closeTerminal() reaps the shell's children fire-and-forget and returns at once, which is right for a
// kill but not for a restart: a restart launches a second `claude --resume <same id>` into a fresh PTY, and two
// agents on one transcript corrupt each other. closeTerminalAndWait() lists the shell's children BEFORE the
// shell dies (afterwards they are reparented and unfindable), closes the terminal, then waits until every one
// of those process groups is confirmed dead.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  ptyKill: vi.fn(),
  listChildPids: vi.fn(),
  terminateProcessTree: vi.fn(),
  reapPtyChildren: vi.fn(),
}));

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 4321,
      cols: 80,
      rows: 24,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      kill: mocks.ptyKill,
      resize: () => {},
    })),
  },
}));

vi.mock('../server/processMonitor.js', async () => {
  const actual = await vi.importActual<typeof import('../server/processMonitor.js')>('../server/processMonitor.js');
  return {
    ...actual,
    listChildPids: mocks.listChildPids,
    terminateProcessTree: mocks.terminateProcessTree,
    reapPtyChildren: mocks.reapPtyChildren,
  };
});

const config = {
  host: 'localhost', port: 22, username: 'tester', authMethod: 'key' as const,
  workingDir: '/tmp', command: '',
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe('closeTerminalAndWait', () => {
  it('lists the shell\'s children before closing it, then waits for each to die', async () => {
    const { createTerminal, closeTerminalAndWait, getTerminals } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    mocks.listChildPids.mockReturnValue([111, 222]);
    mocks.terminateProcessTree.mockResolvedValue(true);

    await expect(closeTerminalAndWait(id)).resolves.toBe(true);

    expect(mocks.listChildPids).toHaveBeenCalledWith(4321);
    expect(mocks.terminateProcessTree).toHaveBeenCalledWith(111);
    expect(mocks.terminateProcessTree).toHaveBeenCalledWith(222);
    // each child is signalled ONCE: closeTerminal's own fire-and-forget reap is skipped
    expect(mocks.terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(mocks.listChildPids).toHaveBeenCalledTimes(1);
    expect(mocks.reapPtyChildren).not.toHaveBeenCalled();
    // SIGTERM goes out before the shell is killed, the same order closeTerminal uses
    expect(mocks.terminateProcessTree.mock.invocationCallOrder[0]).toBeLessThan(mocks.ptyKill.mock.invocationCallOrder[0]);
    // Children are found while the shell still owns them — after pty.kill() they are orphans.
    expect(mocks.listChildPids.mock.invocationCallOrder[0]).toBeLessThan(mocks.ptyKill.mock.invocationCallOrder[0]);
    expect(mocks.ptyKill).toHaveBeenCalledTimes(1);
    expect(getTerminals().some((t) => t.terminalId === id)).toBe(false);
  });

  it('does not resolve until the slowest child is confirmed dead', async () => {
    const { createTerminal, closeTerminalAndWait } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    mocks.listChildPids.mockReturnValue([333]);
    let release: (dead: boolean) => void = () => {};
    mocks.terminateProcessTree.mockReturnValue(new Promise<boolean>((r) => { release = r; }));

    let settled = false;
    const done = closeTerminalAndWait(id).then((v) => { settled = true; return v; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);

    release(true);
    await expect(done).resolves.toBe(true);
  });

  it('resolves false when a child survives SIGKILL', async () => {
    const { createTerminal, closeTerminalAndWait } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    mocks.listChildPids.mockReturnValue([444, 555]);
    mocks.terminateProcessTree.mockImplementation(async (pid: number) => pid !== 555);

    await expect(closeTerminalAndWait(id)).resolves.toBe(false);
  });

  it('is true, and harmless, for a terminal with no children or one that no longer exists', async () => {
    const { createTerminal, closeTerminalAndWait } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    mocks.listChildPids.mockReturnValue([]);
    await expect(closeTerminalAndWait(id)).resolves.toBe(true);
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();

    await expect(closeTerminalAndWait('term-gone')).resolves.toBe(true);
    expect(mocks.listChildPids).toHaveBeenCalledTimes(1); // nothing to look up for a missing terminal
  });
});

describe('isTmuxBackedTerminal', () => {
  it('is false for a plain shell terminal and for an unknown id', async () => {
    const { createTerminal, isTmuxBackedTerminal } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    expect(isTmuxBackedTerminal(id)).toBe(false);
    expect(isTmuxBackedTerminal('term-gone')).toBe(false);
  });
});
