import { describe, it, expect } from 'vitest';
import { justCompleted, completionStillApplies, nextCompletionAttention } from './sessionAttention';

describe('justCompleted', () => {
  it.each(['working', 'prompting', 'approval', 'input', 'idle', 'connecting'])(
    'is true when a session moves from %s to waiting',
    (prev) => {
      expect(justCompleted(prev, 'waiting')).toBe(true);
    },
  );

  it('is false when the session was already waiting (no transition)', () => {
    expect(justCompleted('waiting', 'waiting')).toBe(false);
  });

  it('is false for the first reading of a session: nothing to compare against', () => {
    expect(justCompleted(undefined, 'waiting')).toBe(false);
  });

  it('is false from ended: a dead session coming back is not a completed turn', () => {
    expect(justCompleted('ended', 'waiting')).toBe(false);
  });

  it.each(['working', 'prompting', 'approval', 'input', 'idle', 'ended', 'connecting'])(
    'is false when the session moves to %s',
    (status) => {
      expect(justCompleted('working', status)).toBe(false);
    },
  );
});

/**
 * The green ✓ means "finished, and you have not looked yet". Auto-idle moves a finished
 * session from waiting to idle after five minutes without anyone looking, so idle must
 * not end the claim — it would vanish five minutes after every completion. A new turn,
 * a blocked tool, a dead session or a restart each replace it with the live status.
 */
describe('completionStillApplies', () => {
  it.each(['waiting', 'idle'])('%s: the completion is still unreviewed', (status) => {
    expect(completionStillApplies(status)).toBe(true);
  });

  it.each(['prompting', 'working', 'approval', 'input', 'connecting', 'ended'])(
    '%s: the live status supersedes it',
    (status) => {
      expect(completionStillApplies(status)).toBe(false);
    },
  );

  it('an unknown status does not keep a stale flag alive', () => {
    expect(completionStillApplies('something-new')).toBe(false);
  });
});

describe('nextCompletionAttention (the ✓ set, shared by the strip and the phone drawer)', () => {
  const list = (entries: Record<string, string>) =>
    new Map(Object.entries(entries).map(([id, status]) => [id, { status }]));

  it('raises the ✓ on a session that just finished while another is open', () => {
    const next = nextCompletionAttention(new Set(), list({ a: 'working', b: 'idle' }), list({ a: 'waiting', b: 'idle' }), 'b');
    expect([...next]).toEqual(['a']);
  });

  it('never on the open session, and viewing a session clears its ✓', () => {
    const raised = nextCompletionAttention(new Set(), list({ a: 'working' }), list({ a: 'waiting' }), 'a');
    expect(raised.size).toBe(0);
    const cleared = nextCompletionAttention(new Set(['a']), list({ a: 'waiting' }), list({ a: 'waiting' }), 'a');
    expect(cleared.size).toBe(0);
  });

  it('drops the ✓ when the session moves on or leaves the list', () => {
    const busy = nextCompletionAttention(new Set(['a', 'b']), list({ a: 'waiting', b: 'waiting' }), list({ a: 'working' }), 'x');
    expect(busy.size).toBe(0);
  });

  it('returns the same set when nothing changed', () => {
    const ids = new Set(['a']);
    expect(nextCompletionAttention(ids, list({ a: 'idle' }), list({ a: 'idle' }), 'x')).toBe(ids);
  });
});
