import { describe, it, expect } from 'vitest';
import {
  EFFORT_LEVELS,
  DEFAULT_EFFORT_LEVEL,
  normalizeEffortLevel,
} from './remoteControlName';

describe('EFFORT_LEVELS', () => {
  it('matches Claude Code\'s canonical effort set (low → ultracode)', () => {
    expect([...EFFORT_LEVELS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);
  });

  it('does not include the removed legacy "min" level', () => {
    expect(EFFORT_LEVELS as readonly string[]).not.toContain('min');
  });

  it('defaults to high', () => {
    expect(DEFAULT_EFFORT_LEVEL).toBe('high');
  });
});

describe('normalizeEffortLevel', () => {
  it('passes through every valid level unchanged', () => {
    for (const level of EFFORT_LEVELS) {
      expect(normalizeEffortLevel(level)).toBe(level);
    }
  });

  it('coerces a stale "min" (old saved pref) back to the default', () => {
    expect(normalizeEffortLevel('min')).toBe(DEFAULT_EFFORT_LEVEL);
  });

  it('coerces an unknown value back to the default', () => {
    expect(normalizeEffortLevel('turbo')).toBe(DEFAULT_EFFORT_LEVEL);
  });

  it('returns the default for undefined (no saved pref)', () => {
    expect(normalizeEffortLevel(undefined)).toBe(DEFAULT_EFFORT_LEVEL);
  });

  it('returns the default for an empty string', () => {
    expect(normalizeEffortLevel('')).toBe(DEFAULT_EFFORT_LEVEL);
  });

  it('is case-sensitive — does not normalize "HIGH" to "high"', () => {
    expect(normalizeEffortLevel('HIGH')).toBe(DEFAULT_EFFORT_LEVEL);
  });
});
