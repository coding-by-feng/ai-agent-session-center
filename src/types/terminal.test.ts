import { describe, it, expect } from 'vitest';
import {
  clampScrollbackLines,
  DEFAULT_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
  MAX_TERMINAL_SCROLLBACK_LINES,
  clampReplayBufferBytes,
  DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES,
// `.js` extension: src/types is compiled by tsconfig.server.json (NodeNext),
// which requires explicit extensions. Vite/Vitest resolve it back to the .ts.
} from './terminal.js';

describe('clampScrollbackLines', () => {
  it('passes through values inside the range', () => {
    expect(clampScrollbackLines(20_000)).toBe(20_000);
    expect(clampScrollbackLines(MIN_TERMINAL_SCROLLBACK_LINES)).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(clampScrollbackLines(MAX_TERMINAL_SCROLLBACK_LINES)).toBe(MAX_TERMINAL_SCROLLBACK_LINES);
  });

  it('clamps out-of-range values to the bounds', () => {
    expect(clampScrollbackLines(1)).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(clampScrollbackLines(0)).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(clampScrollbackLines(-500)).toBe(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(clampScrollbackLines(10_000_000)).toBe(MAX_TERMINAL_SCROLLBACK_LINES);
  });

  it('rounds fractional input', () => {
    expect(clampScrollbackLines(20_000.6)).toBe(20_001);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampScrollbackLines(NaN)).toBe(DEFAULT_TERMINAL_SCROLLBACK_LINES);
    expect(clampScrollbackLines(Infinity)).toBe(DEFAULT_TERMINAL_SCROLLBACK_LINES);
  });

  it('has a default inside its own clamp range', () => {
    expect(DEFAULT_TERMINAL_SCROLLBACK_LINES).toBeGreaterThanOrEqual(MIN_TERMINAL_SCROLLBACK_LINES);
    expect(DEFAULT_TERMINAL_SCROLLBACK_LINES).toBeLessThanOrEqual(MAX_TERMINAL_SCROLLBACK_LINES);
  });

  it('defaults well below the former hard-coded 100 000 lines', () => {
    expect(DEFAULT_TERMINAL_SCROLLBACK_LINES).toBeLessThan(100_000);
  });

  it('still permits the old 100 000 for users who want it', () => {
    expect(clampScrollbackLines(100_000)).toBe(100_000);
  });
});

describe('clampReplayBufferBytes', () => {
  it('falls back to the default for non-finite input', () => {
    expect(clampReplayBufferBytes(NaN)).toBe(DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES);
  });

  it('clamps a poisoned value instead of allocating gigabytes', () => {
    expect(clampReplayBufferBytes(1e12)).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
});
