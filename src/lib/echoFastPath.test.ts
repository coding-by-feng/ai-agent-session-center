import { describe, it, expect } from 'vitest';
import { ECHO_CREDITS, ECHO_MAX_BASE64, ECHO_WINDOW_MS, grantEchoCredit, takeEchoCredit } from './echoFastPath';

describe('echoFastPath', () => {
  it('lets a small chunk right after a key take the fast path', () => {
    const d = takeEchoCredit(grantEchoCredit(1000), 1010, 8, false);
    expect(d.fast).toBe(true);
  });

  it('uses up its credits, then falls back to the frame batch', () => {
    let credit = grantEchoCredit(0);
    for (let i = 0; i < ECHO_CREDITS; i++) {
      const d = takeEchoCredit(credit, 5, 8, false);
      expect(d.fast).toBe(true);
      credit = d.credit!;
      if (i === ECHO_CREDITS - 1) expect(d.credit).toBeNull();
    }
    expect(takeEchoCredit(null, 6, 8, false).fast).toBe(false);
  });

  it('expires after the window', () => {
    const d = takeEchoCredit(grantEchoCredit(0), ECHO_WINDOW_MS + 1, 8, false);
    expect(d).toEqual({ fast: false, credit: null });
  });

  it('keeps big chunks and a hidden window on the batch without spending the credit', () => {
    const credit = grantEchoCredit(0);
    expect(takeEchoCredit(credit, 1, ECHO_MAX_BASE64 + 1, false)).toEqual({ fast: false, credit });
    expect(takeEchoCredit(credit, 1, 8, true)).toEqual({ fast: false, credit });
  });

  it('never fast-paths output that no key asked for', () => {
    expect(takeEchoCredit(null, 0, 8, false).fast).toBe(false);
  });
});
