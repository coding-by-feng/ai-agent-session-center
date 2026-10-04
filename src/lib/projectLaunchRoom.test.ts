import { describe, it, expect } from 'vitest';
import { roomForNewProjectSession } from './projectLaunchRoom';
import type { Room } from '@/stores/roomStore';

const room = (id: string, sessionIds: string[]): Room => ({
  id,
  name: id.toUpperCase(),
  sessionIds,
  collapsed: false,
  createdAt: 0,
});

const none = new Set<string>();

describe('roomForNewProjectSession', () => {
  it('joins the room its project\'s sessions share', () => {
    const rooms = [room('ops', ['a', 'b']), room('sms', ['c'])];
    expect(roomForNewProjectSession(['a', 'b'], rooms, none)).toBe('ops');
  });

  it('joins that room even when a stray session of the project has none', () => {
    const rooms = [room('ops', ['a'])];
    expect(roomForNewProjectSession(['a', 'stray'], rooms, none)).toBe('ops');
  });

  it('has no room to give when none of the project\'s sessions is in one', () => {
    const rooms = [room('ops', ['x'])];
    expect(roomForNewProjectSession(['a', 'b'], rooms, none)).toBeNull();
    expect(roomForNewProjectSession(['a'], [], none)).toBeNull();
  });

  it('has none for an empty project', () => {
    expect(roomForNewProjectSession([], [room('ops', ['a'])], none)).toBeNull();
  });

  it('ignores rooms that hold none of the project\'s sessions', () => {
    const rooms = [room('empty', []), room('ops', ['a']), room('elsewhere', ['z'])];
    expect(roomForNewProjectSession(['a'], rooms, none)).toBe('ops');
  });

  describe('a project spread over two rooms', () => {
    const rooms = [room('ops', ['a']), room('sms', ['b'])];

    it('is a guess nobody should make unprompted, so with no room filter it joins neither', () => {
      expect(roomForNewProjectSession(['a', 'b'], rooms, none)).toBeNull();
    });

    it('joins the first of them the room filter shows, so the new session is not hidden by it', () => {
      expect(roomForNewProjectSession(['a', 'b'], rooms, new Set(['sms']))).toBe('sms');
      expect(roomForNewProjectSession(['a', 'b'], rooms, new Set(['ops', 'sms']))).toBe('ops');
    });

    it('joins neither when the filter shows neither (the frame could not have been on screen)', () => {
      expect(roomForNewProjectSession(['a', 'b'], rooms, new Set(['other']))).toBeNull();
    });
  });

  it('does not look at the filter when one room is unambiguous', () => {
    expect(roomForNewProjectSession(['a'], [room('ops', ['a'])], new Set(['sms']))).toBe('ops');
  });
});
