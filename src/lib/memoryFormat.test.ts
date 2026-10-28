import { describe, expect, it } from 'vitest';
import { formatMemory } from './memoryFormat';
import { ASLEEP, displayStatus, statusLabel } from './sessionStatusStyle';

describe('formatMemory', () => {
  it('shows MB below a gigabyte and GB above', () => {
    expect(formatMemory(312 * 1024 * 1024)).toBe('≈ 312 MB');
    expect(formatMemory(1.5 * 1024 ** 3)).toBe('≈ 1.5 GB');
    expect(formatMemory(10.6 * 1024 ** 3)).toBe('≈ 11 GB');
    expect(formatMemory(0)).toBe('≈ 0 MB');
  });
});

describe('displayStatus — asleep', () => {
  it('shows Asleep over ended and over a proceed reminder', () => {
    expect(displayStatus({ status: 'ended', asleepAt: 1 })).toBe(ASLEEP);
    expect(displayStatus({ status: 'waiting', pendingProceedAt: 1, asleepAt: 1 })).toBe(ASLEEP);
    expect(statusLabel(ASLEEP)).toBe('Asleep');
    expect(displayStatus({ status: 'ended' })).toBe('ended');
  });
});
