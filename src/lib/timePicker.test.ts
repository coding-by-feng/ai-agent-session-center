import { describe, it, expect } from 'vitest';
import { parseHHMM, formatHHMM, type Ampm } from './timePicker';

describe('parseHHMM', () => {
  it('parses midnight', () => {
    expect(parseHHMM('00:00')).toEqual({ hour: 12, minute: 0, ampm: 'AM' });
  });
  it('parses noon', () => {
    expect(parseHHMM('12:00')).toEqual({ hour: 12, minute: 0, ampm: 'PM' });
  });
  it('parses 1 PM', () => {
    expect(parseHHMM('13:00')).toEqual({ hour: 1, minute: 0, ampm: 'PM' });
  });
  it('parses 11:59 PM', () => {
    expect(parseHHMM('23:59')).toEqual({ hour: 11, minute: 59, ampm: 'PM' });
  });
  it('parses 9:30 AM', () => {
    expect(parseHHMM('09:30')).toEqual({ hour: 9, minute: 30, ampm: 'AM' });
  });
  it('parses 9:00 AM with single-digit hour', () => {
    expect(parseHHMM('9:00')).toEqual({ hour: 9, minute: 0, ampm: 'AM' });
  });
  it('returns null for empty string', () => {
    expect(parseHHMM('')).toBeNull();
  });
  it('returns null for undefined / null', () => {
    expect(parseHHMM(undefined)).toBeNull();
    expect(parseHHMM(null)).toBeNull();
  });
  it('returns null for malformed strings', () => {
    expect(parseHHMM('not a time')).toBeNull();
    expect(parseHHMM('25:00')).toBeNull();
    expect(parseHHMM('12:60')).toBeNull();
  });
});

describe('formatHHMM', () => {
  it('formats 12 AM (midnight) → 00:00', () => {
    expect(formatHHMM(12, 0, 'AM')).toBe('00:00');
  });
  it('formats 12 PM (noon) → 12:00', () => {
    expect(formatHHMM(12, 0, 'PM')).toBe('12:00');
  });
  it('formats 1 AM → 01:00', () => {
    expect(formatHHMM(1, 0, 'AM')).toBe('01:00');
  });
  it('formats 1 PM → 13:00', () => {
    expect(formatHHMM(1, 0, 'PM')).toBe('13:00');
  });
  it('formats 11:59 PM → 23:59', () => {
    expect(formatHHMM(11, 59, 'PM')).toBe('23:59');
  });
  it('formats minute with leading zero', () => {
    expect(formatHHMM(9, 5, 'AM')).toBe('09:05');
  });
  it('clamps invalid minutes', () => {
    expect(formatHHMM(9, -5, 'AM')).toBe('09:00');
    expect(formatHHMM(9, 99, 'AM')).toBe('09:59');
  });
});

describe('parseHHMM ↔ formatHHMM round-trip', () => {
  // Every hour from 00 to 23 should round-trip cleanly.
  const samples: Array<{ hhmm: string; parts: { hour: number; minute: number; ampm: Ampm } }> = [
    { hhmm: '00:00', parts: { hour: 12, minute: 0, ampm: 'AM' } },
    { hhmm: '00:30', parts: { hour: 12, minute: 30, ampm: 'AM' } },
    { hhmm: '01:15', parts: { hour: 1, minute: 15, ampm: 'AM' } },
    { hhmm: '06:00', parts: { hour: 6, minute: 0, ampm: 'AM' } },
    { hhmm: '11:59', parts: { hour: 11, minute: 59, ampm: 'AM' } },
    { hhmm: '12:00', parts: { hour: 12, minute: 0, ampm: 'PM' } },
    { hhmm: '12:30', parts: { hour: 12, minute: 30, ampm: 'PM' } },
    { hhmm: '13:00', parts: { hour: 1, minute: 0, ampm: 'PM' } },
    { hhmm: '17:45', parts: { hour: 5, minute: 45, ampm: 'PM' } },
    { hhmm: '23:59', parts: { hour: 11, minute: 59, ampm: 'PM' } },
  ];
  for (const s of samples) {
    it(`round-trips ${s.hhmm}`, () => {
      const parsed = parseHHMM(s.hhmm);
      expect(parsed).toEqual(s.parts);
      expect(formatHHMM(s.parts.hour, s.parts.minute, s.parts.ampm)).toBe(s.hhmm);
    });
  }
});
