import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDialogCloseWatch, dialogClosedAndBusy, DIALOG_CLOSE_CHECKS_MS } from '../server/dialogCloseWatch.js';

const SPINNER = '\x1b[38;5;174m✽ Flummoxing… (6m 41s · ↓ 10.3k tokens)\x1b[0m\r\n❯ ';
const DIALOG = 'Do you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel';

function setup(initial: { waiting: boolean; tail: string | null }) {
  const state = { ...initial };
  const release = vi.fn(() => {
    if (!state.waiting) return false;
    state.waiting = false;
    return true;
  });
  const watch = createDialogCloseWatch({
    isAwaitingAnswer: () => state.waiting,
    readTail: () => state.tail,
    release,
  });
  return { state, release, watch };
}

describe('dialogClosedAndBusy', () => {
  it('is true when the spinner was drawn after the dialog', () => {
    expect(dialogClosedAndBusy(DIALOG + SPINNER)).toBe(true);
  });
  it('is false while the dialog is drawn after the last spinner (stale spinner underneath)', () => {
    expect(dialogClosedAndBusy(SPINNER + DIALOG)).toBe(false);
  });
  it('knows the question footer and Codex approvals', () => {
    expect(dialogClosedAndBusy(SPINNER + 'Enter to select · ↑/↓ to navigate · Esc to cancel')).toBe(false);
    expect(dialogClosedAndBusy(SPINNER + 'Allow command?\n› 1. Yes  Press enter to confirm or esc to cancel')).toBe(false);
  });
  // Recorded from Claude Code 2.1.316 (Nov 2): with escapes stripped, cursor moves leave
  // words glued together, and the full spinner line is rare (only changed characters are redrawn).
  const BEFORE_DIALOG = '❯ \r\n⏸manualmodeon·esctointerrupt·←1agent◐medium·/effort\r\nii\r\n✻hk\r\n';
  const REAL_DIALOG = '⏺Bash(sleep 15 &&touchprobe-two.txt)  ⎿  Waiting…\r\nDoyouwanttoproceed?\r\n❯1.Yes\r\n4.No\r\n\r\nEsctocancel·Tabtoamend\r\n';
  const AFTER_ANSWER = '\x1b(B\x0f Runn✳ Dilly-dallying… (1s · ↓ 27 tokens)──❯ ── ⏸ manual mode on · esc to interrupt · ← 1 agent◐ medium\r\n✢2\r\n\r\n·\r\n';
  it('reads a real Claude screen: open dialog no, answered yes', () => {
    expect(dialogClosedAndBusy(BEFORE_DIALOG + REAL_DIALOG)).toBe(false);
    expect(dialogClosedAndBusy(BEFORE_DIALOG + REAL_DIALOG + AFTER_ANSWER)).toBe(true);
  });
  it('takes the footer alone as busy (the spinner line may be partly redrawn)', () => {
    expect(dialogClosedAndBusy(REAL_DIALOG + '⏸manualmodeon·esctointerrupt·←1agent')).toBe(true);
  });
  it('is false with no spinner at all, or no output', () => {
    expect(dialogClosedAndBusy('❯ ')).toBe(false);
    expect(dialogClosedAndBusy(null)).toBe(false);
  });
});

describe('dialogCloseWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releases at the first check once the working spinner is back', () => {
    const { release, watch } = setup({ waiting: true, tail: DIALOG + SPINNER });
    watch.noteInput('t1');
    vi.advanceTimersByTime(DIALOG_CLOSE_CHECKS_MS[0] - 1);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledWith('t1');
    vi.advanceTimersByTime(10_000);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('keeps checking while the screen catches up', () => {
    const { state, release, watch } = setup({ waiting: true, tail: DIALOG });
    watch.noteInput('t1');
    vi.advanceTimersByTime(DIALOG_CLOSE_CHECKS_MS[0]);
    expect(release).not.toHaveBeenCalled();
    state.tail = SPINNER;
    vi.advanceTimersByTime(DIALOG_CLOSE_CHECKS_MS[1] - DIALOG_CLOSE_CHECKS_MS[0]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('never releases while the dialog is still on screen (option moves, a second queued dialog)', () => {
    const { release, watch } = setup({ waiting: true, tail: SPINNER + DIALOG });
    watch.noteInput('t1');
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });

  it('ignores typing into a session that is not waiting', () => {
    const { release, watch } = setup({ waiting: false, tail: SPINNER });
    watch.noteInput('t1');
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });

  it('stands down when a hook ended the wait first', () => {
    const { state, release, watch } = setup({ waiting: true, tail: DIALOG });
    watch.noteInput('t1');
    state.waiting = false;
    state.tail = SPINNER;
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });

  it('restarts the checks from the latest keystroke', () => {
    const { state, release, watch } = setup({ waiting: true, tail: DIALOG });
    watch.noteInput('t1');
    vi.advanceTimersByTime(300);
    watch.noteInput('t1'); // Enter after an arrow key
    state.tail = SPINNER;
    vi.advanceTimersByTime(DIALOG_CLOSE_CHECKS_MS[0] - 1);
    expect(release).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('stopAll drops pending checks', () => {
    const { release, watch } = setup({ waiting: true, tail: SPINNER });
    watch.noteInput('t1');
    watch.stopAll();
    vi.advanceTimersByTime(10_000);
    expect(release).not.toHaveBeenCalled();
  });
});
