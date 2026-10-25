/**
 * Mouse tracking left on by a TUI that has already left the alternate screen.
 *
 * Codex's /logout (Oct 22 2026) closes its alt screen and hands the tty back in
 * cooked mode while xterm.js still has mouse tracking (DECSET 1000/1002/1003 +
 * 1006) on — xterm keeps those modes across an alt-screen switch. Every mouse
 * move then reached the PTY as `\x1b[<35;72;27M`, which the tty echoed (and the
 * shell after it read) as typed text.
 *
 * The guard marks tracking STALE when the alt screen closes (DECRST 47 / 1047 /
 * 1049) with it on, and un-marks it when the app turns tracking on again (a
 * suspend/resume re-enables it after re-entering). It acts lazily, on the first
 * mouse report while stale: that report is dropped and the modes are switched
 * off. Lazily, not at the DECRST: a reset written then would be queued behind
 * any bytes already pending, so an app that re-enters the alt screen in the
 * same burst would lose its mouse. At input time the state is current.
 */
import type { Terminal } from '@xterm/xterm';

const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);
const MOUSE_TRACKING_MODES = new Set([9, 1000, 1001, 1002, 1003]);
/** Tracking and encodings off: what a TUI should have sent on its way out. */
export const MOUSE_MODES_OFF = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
/** One or more mouse reports and nothing else: SGR (1006), urxvt (1015) or X10. */
// eslint-disable-next-line no-control-regex
const MOUSE_REPORTS_RE = /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[\d+;\d+;\d+M|\x1b\[M[\s\S]{3})+$/;

export function isMouseReport(data: string): boolean {
  return MOUSE_REPORTS_RE.test(data);
}

function paramList(params: (number | number[])[]): number[] {
  return params.flatMap((p) => (Array.isArray(p) ? p : [p]));
}

export interface AltScreenMouseGuard {
  /** Pass `term.onData` through this: null means "do not send". */
  filterInput: (data: string) => string | null;
  dispose: () => void;
}

export function installAltScreenMouseReset(term: Terminal): AltScreenMouseGuard {
  let stale = false;
  // Both return false: xterm still applies the mode change itself.
  const onReset = term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
    if (paramList(params).some((p) => ALT_SCREEN_MODES.has(p)) && term.modes.mouseTrackingMode !== 'none') {
      stale = true;
    }
    return false;
  });
  const onSet = term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
    if (paramList(params).some((p) => MOUSE_TRACKING_MODES.has(p))) stale = false;
    return false;
  });
  return {
    filterInput(data) {
      if (!stale || !isMouseReport(data)) return data;
      stale = false;
      term.write(MOUSE_MODES_OFF);
      return null;
    },
    dispose() {
      onReset.dispose();
      onSet.dispose();
    },
  };
}
