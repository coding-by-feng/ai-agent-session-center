// test/sshManager.replayBuffer.test.ts — Settings ▸ Terminal ▸ Scrollback replay
// buffer. POST /api/config/terminal-buffer calls setReplayBufferBytes(); every
// terminal created afterwards replays at most that many bytes, and a terminal
// created before keeps the size it was born with.
import { describe, it, expect, vi } from 'vitest';

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
const replayed = (b64: string | null) => (b64 === null ? '' : Buffer.from(b64, 'base64').toString('utf8'));
const MB = 1024 * 1024;

describe('setReplayBufferBytes', () => {
  it('sizes terminals created after it, and only those', async () => {
    const { createTerminal, getTerminalOutputBuffer, setReplayBufferBytes } = await import('../server/sshManager.js');

    expect(setReplayBufferBytes(0.25 * MB)).toBe(0.25 * MB);
    const small = await createTerminal(config, null);
    expect(setReplayBufferBytes(1 * MB)).toBe(1 * MB);
    const big = await createTerminal(config, null);

    // 600 KB of numbered lines, to both terminals.
    const lines = Array.from({ length: 6000 }, (_, i) => `line ${String(i).padStart(5, '0')} ${'x'.repeat(88)}\n`);
    for (const l of lines) ptyOutput.emit(l);

    const smallOut = replayed(getTerminalOutputBuffer(small));
    const bigOut = replayed(getTerminalOutputBuffer(big));
    expect(smallOut.length).toBeLessThanOrEqual(0.25 * MB);
    expect(smallOut).toContain('line 05999');
    expect(smallOut).not.toContain('line 00000');
    expect(bigOut).toContain('line 00000');
    expect(bigOut).toContain('line 05999');
  });

  it('clamps what a client sends to 0.25–32 MB', async () => {
    const { setReplayBufferBytes } = await import('../server/sshManager.js');
    expect(setReplayBufferBytes(1)).toBe(0.25 * MB);
    expect(setReplayBufferBytes(10_000 * MB)).toBe(32 * MB);
  });
});
