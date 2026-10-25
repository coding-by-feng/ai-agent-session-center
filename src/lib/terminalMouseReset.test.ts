/**
 * A TUI that leaves the alternate screen with mouse tracking still on (Codex's
 * /logout, Oct 22 2026) left every mouse move typed into the shell as
 * `^[[<35;72;27M…`. Exercised on a real xterm.js Terminal (never opened).
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { installAltScreenMouseReset, isMouseReport } from './terminalMouseReset';

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

const ENTER_TUI = '\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';
const MOVE = '\x1b[<35;72;27M';

describe('installAltScreenMouseReset', () => {
  it('xterm itself keeps mouse tracking after the alt screen closes (the bug)', async () => {
    const term = new Terminal({ allowProposedApi: true });
    await write(term, `${ENTER_TUI}\x1b[?1049l`);
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  it('drops the first stale mouse report and switches tracking off', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    await write(term, `${ENTER_TUI}\x1b[?1049l`);
    expect(guard.filterInput(MOVE + MOVE)).toBeNull();
    await write(term, '');
    expect(term.modes.mouseTrackingMode).toBe('none');
    term.dispose();
  });

  it('typing is never touched', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    await write(term, `${ENTER_TUI}\x1b[?1049l`);
    expect(guard.filterInput('ls\r')).toBe('ls\r');
    expect(guard.filterInput('\x1b[D')).toBe('\x1b[D');
    term.dispose();
  });

  it('also after the older alt-screen modes 47 and 1047', async () => {
    for (const mode of [47, 1047]) {
      const term = new Terminal({ allowProposedApi: true });
      const guard = installAltScreenMouseReset(term);
      await write(term, `\x1b[?${mode}h\x1b[?1002h\x1b[?1006h\x1b[?${mode}l`);
      expect(guard.filterInput(MOVE)).toBeNull();
      term.dispose();
    }
  });

  it('passes mouse reports through while the TUI is on the alt screen', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    await write(term, ENTER_TUI);
    expect(guard.filterInput(MOVE)).toBe(MOVE);
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  it('a TUI that turns mouse off on its way out is left alone', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    // Codex's normal /quit: tracking off, then the alt screen closes.
    await write(term, `${ENTER_TUI}\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1049l`);
    expect(guard.filterInput(MOVE)).toBe(MOVE);
    term.dispose();
  });

  it('keeps the mouse of an app that re-enters and re-enables it (suspend / resume)', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    await write(term, `${ENTER_TUI}\x1b[?1049l${ENTER_TUI}`);
    expect(guard.filterInput(MOVE)).toBe(MOVE);
    expect(term.modes.mouseTrackingMode).toBe('any');
    term.dispose();
  });

  it('dispose removes the handlers', async () => {
    const term = new Terminal({ allowProposedApi: true });
    const guard = installAltScreenMouseReset(term);
    guard.dispose();
    await write(term, `${ENTER_TUI}\x1b[?1049l`);
    expect(guard.filterInput(MOVE)).toBe(MOVE);
    term.dispose();
  });
});

describe('isMouseReport', () => {
  it('matches SGR, urxvt and X10 reports, alone or batched', () => {
    expect(isMouseReport('\x1b[<35;72;27M\x1b[<0;39;26m')).toBe(true);
    expect(isMouseReport('\x1b[32;10;5M')).toBe(true);
    expect(isMouseReport('\x1b[M !!')).toBe(true);
  });
  it('rejects keys and text', () => {
    for (const s of ['a', '\x1b[D', '\x1b[1;5C', '\x1b[200~paste\x1b[201~', '\x1b[<35;72;27Mx']) {
      expect(isMouseReport(s)).toBe(false);
    }
  });
});
