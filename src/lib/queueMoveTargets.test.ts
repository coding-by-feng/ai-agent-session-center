import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { queueMoveTargets } from './queueMoveTargets';

const sess = (id: string, over: Partial<Session> = {}) =>
  ({ sessionId: id, title: '', projectName: '', status: 'idle', lastActivityAt: 0, ...over }) as unknown as Session;

describe('queueMoveTargets', () => {
  it('names each session as every list does, with its folder only when that adds something', () => {
    const targets = queueMoveTargets([
      sess('a', { title: 'Exmouth KRT Codex', projectName: 'exmouth' }),
      sess('b', { projectName: 'agent-manager' }),
      sess('c', { title: 'Docs', projectName: 'docs' }),
      sess('d'),
    ], 'from');
    expect(targets).toEqual([
      { id: 'b', name: 'agent-manager' },
      { id: 'c', name: 'Docs' },
      { id: 'a', name: 'Exmouth KRT Codex', project: 'exmouth' },
      { id: 'd', name: 'Unnamed' },
    ]);
  });

  it('offers only live sessions, never the one the prompt is in', () => {
    const targets = queueMoveTargets([
      sess('from', { title: 'Here' }),
      sess('ended', { title: 'Ended', status: 'ended' }),
      sess('popup', { title: 'Translate', isFloating: true }),
      sess('live', { title: 'Live', status: 'working' }),
    ], 'from');
    expect(targets.map((t) => t.id)).toEqual(['live']);
  });

  it('sorts by name A→Z (case and numbers read naturally), then folder, then the most recent', () => {
    const targets = queueMoveTargets([
      sess('codex10', { title: 'Codex 10' }),
      sess('zoe', { title: 'zoe' }),
      sess('codex2', { title: 'Codex 2' }),
      sess('twin-old', { title: 'Central', projectName: 'exmouth', lastActivityAt: 100 }),
      sess('twin-new', { title: 'Central', projectName: 'exmouth', lastActivityAt: 900 }),
      sess('central-aasc', { title: 'Central', projectName: 'aasc' }),
      sess('apple', { title: 'apple' }),
    ], 'from');
    expect(targets.map((t) => t.id)).toEqual(['apple', 'central-aasc', 'twin-new', 'twin-old', 'codex2', 'codex10', 'zoe']);
  });
});
