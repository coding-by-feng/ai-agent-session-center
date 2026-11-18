import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPtyResizeSettler, PTY_RESIZE_SETTLE_MS } from './ptyResizeSettle';

describe('createPtyResizeSettler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits long enough for a window drag to finish', () => {
    expect(PTY_RESIZE_SETTLE_MS).toBeGreaterThanOrEqual(400);
  });

  it('sends one resize for a slow drag with pauses, at the final size', () => {
    const send = vi.fn();
    const settler = createPtyResizeSettler(send);
    // A drag that pauses 250 ms between steps: the old 200 ms debounce sent all three.
    settler.request(120, 40);
    vi.advanceTimersByTime(250);
    settler.request(110, 40);
    vi.advanceTimersByTime(250);
    settler.request(96, 40);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(96, 40);
  });

  it('sends again for a later, separate resize', () => {
    const send = vi.fn();
    const settler = createPtyResizeSettler(send);
    settler.request(100, 30);
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    settler.request(80, 30);
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS);
    expect(send.mock.calls).toEqual([[100, 30], [80, 30]]);
  });

  it('drops a pending resize on cancel (terminal switched or disposed)', () => {
    const send = vi.fn();
    const settler = createPtyResizeSettler(send);
    settler.request(90, 30);
    settler.cancel();
    vi.advanceTimersByTime(PTY_RESIZE_SETTLE_MS * 2);
    expect(send).not.toHaveBeenCalled();
  });
});
