import { describe, it, expect } from 'vitest';
import { queueWaitReason, type QueueWaitInput } from './queueWaitReason';

const once = (disabled = false) => ({ type: 'once' as const, disabled });
const base: QueueWaitInput = {
  items: [once(), once(true)],
  autoSend: true,
  automationPaused: false,
  held: false,
  sessionStatus: 'working',
  cliName: 'Claude',
  noSender: false,
};

describe('queueWaitReason', () => {
  it('mid-turn: the next prompt goes when the agent finishes (the Nov 28 2026 screenshot)', () => {
    expect(queueWaitReason(base)).toEqual({ kind: 'busy', text: 'Sends the next prompt when Claude finishes this turn.' });
    expect(queueWaitReason({ ...base, sessionStatus: 'prompting' })?.kind).toBe('busy');
  });

  it('waiting on an approval: after you answer', () => {
    expect(queueWaitReason({ ...base, sessionStatus: 'approval', cliName: 'Codex' })).toEqual({
      kind: 'approval',
      text: 'Sends the next prompt after you answer Codex.',
    });
  });

  it('ready to send: no line', () => {
    for (const s of ['waiting', 'idle', 'input']) expect(queueWaitReason({ ...base, sessionStatus: s }), s).toBeNull();
  });

  it('every prompt switched off says so, whatever the session is doing', () => {
    const items = [once(true), once(true), once(true)];
    for (const s of ['working', 'waiting']) {
      expect(queueWaitReason({ ...base, items, sessionStatus: s })).toEqual({
        kind: 'all-off',
        text: 'All 3 prompts are switched off. Turn one on (⏻) to send it.',
      });
    }
    expect(queueWaitReason({ ...base, items: [once(true)] })?.text).toBe('The prompt is switched off. Turn it on (⏻) to send it.');
  });

  it('a phone app with no Mac window to send comes first', () => {
    expect(queueWaitReason({ ...base, noSender: true })).toEqual({
      kind: 'no-sender',
      text: 'Nothing sends until AASC is open on the Mac: the Mac sends queued prompts, not the phone.',
    });
    expect(queueWaitReason({ ...base, noSender: true, sessionStatus: 'waiting' })?.kind).toBe('no-sender');
  });

  it('stays quiet where another notice already speaks, or there is nothing to send', () => {
    expect(queueWaitReason({ ...base, autoSend: false })).toBeNull();
    expect(queueWaitReason({ ...base, automationPaused: true })).toBeNull();
    expect(queueWaitReason({ ...base, held: true })).toBeNull();
    expect(queueWaitReason({ ...base, items: [] })).toBeNull();
    // A Loop or Schedule item brings the automation status row, which covers the wait.
    expect(queueWaitReason({ ...base, items: [once(), { type: 'loop' as const, disabled: false }] })).toBeNull();
    // Ended or unknown: nothing to promise.
    expect(queueWaitReason({ ...base, sessionStatus: 'ended' })).toBeNull();
  });
});
