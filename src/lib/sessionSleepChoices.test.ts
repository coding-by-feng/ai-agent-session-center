import { describe, expect, it } from 'vitest';
import { SLEEP_CHOICES, sleepChoiceLabel } from './sessionSleepChoices';

describe('sleepChoiceLabel', () => {
  it('labels every choice in minutes, hours or days', () => {
    expect(SLEEP_CHOICES.map(sleepChoiceLabel)).toEqual([
      'Off — never',
      'After 15 min idle',
      'After 30 min idle',
      'After 1 hour idle',
      'After 2 hours idle',
      'After 4 hours idle',
      'After 1 day idle',
      'After 2 days idle',
      'After 3 days idle',
      'After 7 days idle',
    ]);
  });

  it('keeps the choices in ascending order with off first', () => {
    expect([...SLEEP_CHOICES]).toEqual([...SLEEP_CHOICES].sort((a, b) => a - b));
    expect(SLEEP_CHOICES[0]).toBe(0);
  });
});
