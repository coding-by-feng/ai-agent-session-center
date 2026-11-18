import { describe, expect, it } from 'vitest';
import {
  CLOSE_QUIET_CHOICES,
  DEFAULT_CLOSE_QUIET_MINUTES,
  closeReasonLabel,
  formatQuiet,
  isCloseQuietChoice,
  quietChoiceLabel,
} from './closeSuggestions';

const MIN = 60_000;

describe('close suggestion labels', () => {
  it('offers the default among its choices', () => {
    expect(CLOSE_QUIET_CHOICES).toContain(DEFAULT_CLOSE_QUIET_MINUTES);
    expect(isCloseQuietChoice(240)).toBe(true);
    expect(isCloseQuietChoice(7)).toBe(false);
    expect(isCloseQuietChoice('60')).toBe(false);
  });

  it.each([
    [30, '30 min'],
    [60, '1 hour'],
    [240, '4 hours'],
    [1440, '1 day'],
  ])('labels the %i-minute choice', (minutes, label) => {
    expect(quietChoiceLabel(minutes)).toBe(label);
  });

  it.each([
    [0, '0 min'],
    [59 * MIN, '59 min'],
    [60 * MIN, '1 h'],
    [192 * MIN, '3 h 12 min'],
    [24 * 60 * MIN, '1 day'],
    [(49 * 60 + 30) * MIN, '2 days 1 h'],
  ])('formats %i ms of quiet', (ms, text) => {
    expect(formatQuiet(ms)).toBe(text);
  });

  it('names the reason with the quiet time', () => {
    // Since Nov 18 2026 the quiet time runs from the last prompt, and the label says so.
    expect(closeReasonLabel({ reason: 'idle', quietMs: 192 * MIN })).toBe('Last prompt 3 h 12 min ago');
    expect(closeReasonLabel({ reason: 'unused', quietMs: 120 * MIN })).toBe('No prompt yet · started 2 h ago');
  });
});
