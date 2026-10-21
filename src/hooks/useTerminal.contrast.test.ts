import { describe, it, expect } from 'vitest';
import { TERMINAL_MIN_CONTRAST_RATIO } from './useTerminal';

describe('TERMINAL_MIN_CONTRAST_RATIO', () => {
  it('keeps terminal text at WCAG AA against its cell background', () => {
    // At 1 (xterm's default) Codex table headers were unreadable on light themes.
    expect(TERMINAL_MIN_CONTRAST_RATIO).toBeGreaterThanOrEqual(4.5);
  });
});
