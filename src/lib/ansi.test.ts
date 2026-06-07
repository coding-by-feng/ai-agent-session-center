import { describe, it, expect } from 'vitest';
import { stripAnsi, cleanCapturedOutput } from './ansi';

describe('stripAnsi', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('drops standalone carriage returns but keeps newlines', () => {
    expect(stripAnsi('a\rb\nc')).toBe('ab\nc');
  });

  it('leaves box-drawing glyphs alone (it is ANSI-only)', () => {
    expect(stripAnsi('│ hi │')).toBe('│ hi │');
  });
});

describe('cleanCapturedOutput', () => {
  it('strips box-drawing / block chrome but keeps the inner text', () => {
    expect(cleanCapturedOutput('│ hello │').trim()).toBe('hello');
    expect(cleanCapturedOutput('╭───╮\n│ x │\n╰───╯').replace(/\s+/g, ' ').trim()).toBe('x');
  });

  it('strips Braille "thinking" spinner glyphs', () => {
    expect(cleanCapturedOutput('⠋⠙⠹ Working… done').trim()).toBe('Working… done');
  });

  it('strips ANSI then chrome together', () => {
    expect(cleanCapturedOutput('\x1b[2m│\x1b[0m answer').trim()).toBe('answer');
  });

  it('collapses 3+ blank lines to 2 and trims trailing spaces', () => {
    expect(cleanCapturedOutput('a   \n\n\n\nb')).toBe('a\n\nb');
  });

  it('preserves normal prose and single newlines', () => {
    expect(cleanCapturedOutput('line one\nline two')).toBe('line one\nline two');
  });

  it('returns empty string for empty input', () => {
    expect(cleanCapturedOutput('')).toBe('');
  });
});
