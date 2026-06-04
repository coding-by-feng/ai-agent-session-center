import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  customFloatLabel,
  floatLabel,
  type SpawnFloatingArgs,
} from '../server/floatingPrompt.js';

function args(overrides: Partial<SpawnFloatingArgs>): SpawnFloatingArgs {
  return {
    originSessionId: 'sess-1',
    mode: 'custom',
    nativeLanguage: '简体中文',
    learningLanguage: 'English',
    ...overrides,
  };
}

describe('floatingPrompt — custom mode', () => {
  describe('buildPrompt', () => {
    it('composes the custom prompt FIRST, then the selection in a fenced block', () => {
      const out = buildPrompt(
        args({ customPrompt: 'Refactor this for clarity', selection: 'const x = 1' }),
        null,
      );
      expect(out).not.toBeNull();
      const text = out as string;
      // Instruction leads, selection follows in a """ fence.
      expect(text).toContain('Refactor this for clarity');
      expect(text).toContain('Selected text:');
      expect(text).toContain('"""');
      expect(text).toContain('const x = 1');
      expect(text.indexOf('Refactor this for clarity')).toBeLessThan(text.indexOf('const x = 1'));
    });

    it('includes the surrounding context line when provided', () => {
      const out = buildPrompt(
        args({
          customPrompt: 'Explain this regex',
          selection: '\\d{2}:\\d{2}',
          contextLine: 'const re = /\\d{2}:\\d{2}/;',
        }),
        null,
      );
      expect(out).toContain('const re = /\\d{2}:\\d{2}/;');
    });

    it('trims the custom prompt', () => {
      const out = buildPrompt(
        args({ customPrompt: '   summarize   ', selection: 'foo' }),
        null,
      );
      expect(out).toContain('summarize');
      expect(out).not.toContain('   summarize   ');
    });

    it('returns null when the custom prompt is missing or blank', () => {
      expect(buildPrompt(args({ customPrompt: '', selection: 'foo' }), null)).toBeNull();
      expect(buildPrompt(args({ customPrompt: '   ', selection: 'foo' }), null)).toBeNull();
      expect(buildPrompt(args({ selection: 'foo' }), null)).toBeNull();
    });

    it('returns null when the selection is missing (custom mode is selection-anchored)', () => {
      expect(buildPrompt(args({ customPrompt: 'do something' }), null)).toBeNull();
    });
  });

  describe('labels', () => {
    it('floatLabel returns a generic "Custom" for the custom mode', () => {
      expect(floatLabel('custom', '简体中文', 'English')).toBe('Custom');
    });

    it('customFloatLabel derives a short, single-line snippet from the prompt', () => {
      expect(customFloatLabel('refactor')).toBe('Custom: refactor');
      // Collapses whitespace/newlines.
      expect(customFloatLabel('refactor\n  this   thing')).toBe('Custom: refactor this thing');
      // Truncates long prompts with an ellipsis.
      const long = customFloatLabel('a'.repeat(50));
      expect(long.startsWith('Custom: ')).toBe(true);
      expect(long.endsWith('…')).toBe(true);
      expect(long.length).toBeLessThan('Custom: '.length + 30);
      // Empty falls back to plain "Custom".
      expect(customFloatLabel('   ')).toBe('Custom');
    });
  });
});
