// queueAutomationDiff.test.ts — which changes of the per-session queue switches are
// somebody's decision (and so worth saving), and which are bookkeeping.
import { describe, it, expect } from 'vitest';
import { automationIntentChanged } from './queueAutomationDiff';
import { DEFAULT_AUTOMATION, type QueueAutomationConfig } from '@/stores/queueStore';

const cfg = (over: Partial<QueueAutomationConfig> = {}): QueueAutomationConfig => ({ ...DEFAULT_AUTOMATION, ...over });
const map = (...entries: Array<[string, QueueAutomationConfig]>) => new Map(entries);

describe('automationIntentChanged', () => {
  it('is true when a switch is flipped on a session that already had a config', () => {
    expect(automationIntentChanged(map(['a', cfg()]), map(['a', cfg({ autoSend: false })]))).toBe(true);
  });

  it('is true when a session gets its first config (the first click on a switch)', () => {
    expect(automationIntentChanged(map(), map(['a', cfg({ autoSend: false })]))).toBe(true);
  });

  it('is false for a re-key: the config moves to a new id unchanged', () => {
    const off = cfg({ autoSend: false });
    expect(automationIntentChanged(map(['term-1', off]), map(['hook-1', { ...off }]))).toBe(false);
  });

  it('is true when the re-key also carries a change', () => {
    expect(automationIntentChanged(map(['term-1', cfg({ autoSend: false })]), map(['hook-1', cfg({ autoSend: true })]))).toBe(true);
  });

  it('is true when a re-key happens while a different session is toggled', () => {
    const off = cfg({ autoSend: false });
    const before = map(['term-1', off]);
    const after = map(['hook-1', { ...off }], ['b', cfg({ paused: true })]);
    expect(automationIntentChanged(before, after)).toBe(true);
  });

  it('is false when the same value is installed again under a new object (a sync echo)', () => {
    expect(automationIntentChanged(map(['a', cfg({ autoSend: false })]), map(['a', cfg({ autoSend: false })]))).toBe(false);
  });

  it('is false for identical maps and for a pure removal', () => {
    const m = map(['a', cfg({ autoSend: false })]);
    expect(automationIntentChanged(m, m)).toBe(false);
    expect(automationIntentChanged(m, map())).toBe(false);
  });

  it('pairs each moved entry with its own removal, so two re-keys in one update are still not an edit', () => {
    const off = cfg({ autoSend: false });
    const paused = cfg({ paused: true });
    expect(
      automationIntentChanged(map(['t1', off], ['t2', paused]), map(['h1', { ...off }], ['h2', { ...paused }])),
    ).toBe(false);
  });
});
