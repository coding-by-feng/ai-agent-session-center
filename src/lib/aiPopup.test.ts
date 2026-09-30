import { describe, it, expect } from 'vitest';
import { isAiPopupEnabled } from './aiPopup';

describe('isAiPopupEnabled', () => {
  it('defaults to ENABLED when the flag was never set', () => {
    // Every session that exists today is in this state. Reading the raw
    // field instead would make undefined falsy and switch the AI popup off
    // for all of them — the exact regression this helper exists to prevent.
    expect(isAiPopupEnabled({})).toBe(true);
  });

  it('is enabled when explicitly true', () => {
    expect(isAiPopupEnabled({ aiPopupEnabled: true })).toBe(true);
  });

  it('is disabled ONLY on an explicit false', () => {
    expect(isAiPopupEnabled({ aiPopupEnabled: false })).toBe(false);
  });

  it('treats a SQLite NULL as never-set, i.e. enabled', () => {
    expect(isAiPopupEnabled({ aiPopupEnabled: null })).toBe(true);
  });

  it('defaults to enabled for a missing session', () => {
    // The terminal can render before its session record arrives; flickering
    // the popup off in that window is worse than defaulting on.
    expect(isAiPopupEnabled(null)).toBe(true);
    expect(isAiPopupEnabled(undefined)).toBe(true);
  });
});
