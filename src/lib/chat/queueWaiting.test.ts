// queueWaiting.test.ts — how many queued prompts the queue will send on its own: the
// phone composer queues a new prompt behind them instead of sending it ahead.
import { describe, it, expect } from 'vitest';
import { queueWaiting } from './queueWaiting';

const on = { paused: false, autoSend: true };

describe('queueWaiting', () => {
  it('counts the plain prompts that are not paused', () => {
    expect(queueWaiting([{}, { type: 'once' }, { type: 'once', disabled: true }], on)).toBe(2);
    expect(queueWaiting([], on)).toBe(0);
  });

  it('leaves out loops and scheduled prompts: they fire on their own clock', () => {
    expect(queueWaiting([{ type: 'loop' }, { type: 'schedule' }], on)).toBe(0);
  });

  it('is nothing while the queue will not send by itself (paused, or Auto-send off)', () => {
    expect(queueWaiting([{}, {}], { paused: true, autoSend: true })).toBe(0);
    expect(queueWaiting([{}, {}], { paused: false, autoSend: false })).toBe(0);
  });
});
