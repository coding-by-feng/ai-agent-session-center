// test/sshManager.clearOutput.test.ts — the terminal toolbar's "Clear output".
//
// A clear must empty the terminal's replay ring, not just the screen of the
// device that clicked: ↻ Refresh, a reconnect, a remount after switching
// sessions and every other device all paint from that ring, so output cleared
// only in one xterm comes straight back. Output printed AFTER the clear must
// still be recorded.
import { describe, it, expect, vi } from 'vitest';

// The PTY is a stand-in whose output the test drives by hand. sshManager
// attaches several data listeners (the ring writer, startup watchers), so the
// stand-in delivers each chunk to all of them, like node-pty does.
const { ptyOutput } = vi.hoisted(() => {
  const listeners: Array<(data: string) => void> = [];
  return {
    ptyOutput: {
      listeners,
      emit: (data: string) => { for (const cb of [...listeners]) cb(data); },
    },
  };
});
vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 99999,
      cols: 80,
      rows: 24,
      onData: (cb: (data: string) => void) => {
        ptyOutput.listeners.push(cb);
        return { dispose: () => { ptyOutput.listeners.splice(ptyOutput.listeners.indexOf(cb), 1); } };
      },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      kill: () => {},
      resize: () => {},
    })),
  },
}));

const config = {
  host: 'localhost', port: 22, username: 'tester', authMethod: 'key' as const,
  workingDir: '/tmp', command: '',
};
const decode = (b64: string | null) => (b64 === null ? null : Buffer.from(b64, 'base64').toString('utf8'));

describe('clearTerminalOutput', () => {
  it('empties the replay ring, and keeps recording what is printed afterwards', async () => {
    const { createTerminal, clearTerminalOutput, getTerminalOutputBuffer } = await import('../server/sshManager.js');
    const id = await createTerminal(config, null);
    ptyOutput.emit('old line 1\r\nold line 2\r\n');
    expect(decode(getTerminalOutputBuffer(id))).toContain('old line 2');

    expect(clearTerminalOutput(id)).toBe(true);
    expect(getTerminalOutputBuffer(id)).toBeNull(); // nothing left to replay

    ptyOutput.emit('after the clear');
    expect(decode(getTerminalOutputBuffer(id))).toBe('after the clear');
  });

  it('says so when there is no such terminal', async () => {
    const { clearTerminalOutput } = await import('../server/sshManager.js');
    expect(clearTerminalOutput('term-does-not-exist')).toBe(false);
  });
});
