import { describe, it, expect } from 'vitest';
import { createTurnGate, QUIET_MS } from '../../server/voice/turnGate.js';

describe('createTurnGate (Nov 22 2026: no spoken update over the person)', () => {
  it('sends at once when nobody has spoken', () => {
    const gate = createTurnGate();
    expect(gate.push({ kind: 'status', finished: ['Image Blaster'], needsUser: [] }, 1_000)).toEqual([
      { delegationId: null, content: 'AASC update: "Image Blaster" has finished.' },
    ]);
    expect(gate.pending()).toBe(0);
  });

  it('holds an update while the person is talking, and through a short hesitation', () => {
    const gate = createTurnGate();
    gate.heard(1_000);
    expect(gate.push({ kind: 'status', finished: ['Image Blaster'], needsUser: [] }, 1_200)).toEqual([]);
    expect(gate.pending()).toBe(1);
    // A one-second pause, then more words: still the same turn.
    expect(gate.due(2_000)).toEqual([]);
    gate.heard(2_100);
    expect(gate.due(2_100 + QUIET_MS - 1)).toEqual([]);
    expect(gate.nextCheckAt()).toBe(2_100 + QUIET_MS);
    expect(gate.due(2_100 + QUIET_MS)).toEqual([{ delegationId: null, content: 'AASC update: "Image Blaster" has finished.' }]);
    expect(gate.pending()).toBe(0);
    expect(gate.nextCheckAt()).toBeNull();
  });

  it('never drops a held update, however long the person talks', () => {
    const gate = createTurnGate();
    gate.heard(0);
    gate.push({ kind: 'status', finished: ['A'], needsUser: [] }, 100);
    for (let t = 1_000; t <= 120_000; t += 1_000) {
      gate.heard(t);
      expect(gate.due(t)).toEqual([]);
    }
    expect(gate.due(120_000 + QUIET_MS)).toHaveLength(1);
  });

  it('gives held answers first, in order, each for its own delegation, then one merged status line', () => {
    const gate = createTurnGate();
    gate.heard(0);
    gate.push({ kind: 'status', finished: ['A'], needsUser: [] }, 10);
    gate.push({ kind: 'answer', delegationId: 'd1', content: 'First answer.' }, 20);
    gate.push({ kind: 'status', finished: [], needsUser: ['B'] }, 30);
    gate.push({ kind: 'answer', delegationId: 'd2', content: 'Second answer.' }, 40);
    gate.push({ kind: 'status', finished: ['B', 'C'], needsUser: [] }, 50);
    expect(gate.due(QUIET_MS)).toEqual([
      { delegationId: 'd1', content: 'First answer.' },
      { delegationId: 'd2', content: 'Second answer.' },
      // B's newest state wins (it finished after needing the person); each title once.
      { delegationId: null, content: 'AASC update: "A", "B", "C" have finished.' },
    ]);
  });

  it('says both kinds in one line', () => {
    const gate = createTurnGate();
    gate.heard(0);
    gate.push({ kind: 'status', finished: ['A'], needsUser: ['B', 'C'] }, 10);
    expect(gate.due(QUIET_MS)[0].content).toBe('AASC update: "A" has finished. "B", "C" need the user\'s answer.');
  });

  it('forgets nothing it has not said, and clear() drops what is held (the call ended)', () => {
    const gate = createTurnGate();
    gate.heard(0);
    gate.push({ kind: 'answer', delegationId: 'd1', content: 'x' }, 1);
    gate.clear();
    expect(gate.pending()).toBe(0);
    expect(gate.due(QUIET_MS)).toEqual([]);
  });
});
