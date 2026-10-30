/**
 * codexReadyWatch: when a trusted local Codex card may leave `connecting` before the 30 s timeout. Pure: the output
 * is fed through a fake tap, nothing touches a terminal or a process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODEX_READY_POLL_MS,
  CODEX_READY_QUIET_MS,
  showsCodexInput,
  watchCodexReady,
  type CodexReadyWatchDeps,
} from '../server/codexReadyWatch.js';

/** Codex 0.165's idle screen as its PTY printed it (cursor moves, dim placeholder, the `?` hint). */
const CODEX_IDLE =
  '\x1b[2m⠈⠙⠛⠿⠿⠿⠿⠛⠉\x1b[24;1H\x1b[22m \x1b[25;1H \x1b[26;1H \x1b[27;1H\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything'
  + '\x1b[28;1H\x1b[22m \x1b[29;1H \x1b[30;1H  \x1b[1m?\x1b[22m for shortcuts\x1b[39m\x1b[49m\x1b[0m\x1b[27;3H\x1b[?25h\x1b[?2026l';

describe('showsCodexInput', () => {
  it('reads the real idle screen as its input row', () => {
    expect(showsCodexInput(CODEX_IDLE)).toBe(true);
  });

  it('is not fooled by a menu, a press-Enter notice or a screen without the glyph', () => {
    expect(showsCodexInput('Update available!\r\n\x1b[1m›\x1b[22m 1. Update now\r\n  2. Skip')).toBe(false);
    expect(showsCodexInput('› 1. Yes, continue\x1b[5;3H  2. No, quit')).toBe(false);
    expect(showsCodexInput('Try the new model\x1b[4;1H›\x1b[0m Press enter to continue')).toBe(false);
    expect(showsCodexInput('Loading…')).toBe(false);
  });

  it('takes the last glyph: an input row drawn after a dismissed menu counts', () => {
    expect(showsCodexInput(`› 1. Update now\x1b[2J${CODEX_IDLE}`)).toBe(true);
  });
});

describe('watchCodexReady', () => {
  let state: { connecting: boolean; atInput: boolean };
  let emit: (chunk: string) => void;
  const untap = vi.fn();
  const onReady = vi.fn();
  const atInput = vi.fn(() => state.atInput);

  const deps = (): CodexReadyWatchDeps => ({
    stillConnecting: () => state.connecting,
    atInput,
    tapOutput: (listener) => {
      emit = listener;
      return untap;
    },
    onReady,
  });

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    state = { connecting: true, atInput: true };
    onReady.mockReset();
    untap.mockReset();
    atInput.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once, after the input row has been quiet for the quiet window, and lets go of the tap', () => {
    watchCodexReady(deps());
    emit(CODEX_IDLE);
    vi.advanceTimersByTime(CODEX_READY_QUIET_MS - CODEX_READY_POLL_MS);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CODEX_READY_POLL_MS);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(untap).toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for new output to settle', () => {
    watchCodexReady(deps());
    emit(CODEX_IDLE);
    vi.advanceTimersByTime(1_000);
    emit('\x1b[1;1H ');
    vi.advanceTimersByTime(1_000);
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CODEX_READY_QUIET_MS);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('never fires before any output, on a menu, or away from the input', () => {
    const runs: Array<() => void> = [
      () => {},
      () => emit('› 1. Update now  2. Skip'),
      () => { state.atInput = false; emit(CODEX_IDLE); },
    ];
    for (const run of runs) {
      state = { connecting: true, atInput: true };
      const cancel = watchCodexReady(deps());
      run();
      vi.advanceTimersByTime(5_000);
      cancel();
    }
    expect(onReady).not.toHaveBeenCalled();
  });

  it('reads the trust record only once the screen has settled on an input row', () => {
    watchCodexReady(deps());
    emit('› 1. Update now');
    vi.advanceTimersByTime(5_000);
    emit(CODEX_IDLE);
    vi.advanceTimersByTime(CODEX_READY_QUIET_MS - CODEX_READY_POLL_MS);
    expect(atInput).not.toHaveBeenCalled();
  });

  it('stops by itself once the card left connecting, and on cancel', () => {
    watchCodexReady(deps());
    emit(CODEX_IDLE);
    state.connecting = false;
    vi.advanceTimersByTime(CODEX_READY_POLL_MS);
    expect(untap).toHaveBeenCalledTimes(1);
    state.connecting = true;
    vi.advanceTimersByTime(5_000);
    expect(onReady).not.toHaveBeenCalled();

    const cancel = watchCodexReady(deps());
    emit(CODEX_IDLE);
    cancel();
    vi.advanceTimersByTime(5_000);
    expect(onReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
