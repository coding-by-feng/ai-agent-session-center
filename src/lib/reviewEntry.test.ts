// Found on a real iPhone (Oct 2026): an "Explain → In English" popup showed in Review as
// "Explain (learning) → 简体中文". The chip always named the native language, whatever the mode.
import { describe, it, expect } from 'vitest';
import { reviewEntryLanguage } from './reviewEntry';

const row = (mode: Parameters<typeof reviewEntryLanguage>[0]['mode']) => ({ mode, nativeLanguage: '简体中文', learningLanguage: 'English' });

describe('reviewEntryLanguage', () => {
  it('names the language the popup answered in', () => {
    expect(reviewEntryLanguage(row('explain-learning'))).toBe('English');
    expect(reviewEntryLanguage(row('translate-selection-learning'))).toBe('English');
    for (const mode of ['explain-native', 'vocab-native', 'translate-selection-native', 'translate-answer', 'translate-file'] as const) {
      expect(reviewEntryLanguage(row(mode)), mode).toBe('简体中文');
    }
  });

  it('names none for a custom prompt', () => {
    expect(reviewEntryLanguage(row('custom'))).toBeNull();
  });
});
