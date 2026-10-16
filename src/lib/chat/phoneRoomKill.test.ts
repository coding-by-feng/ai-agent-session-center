// phoneRoomKill.test.ts — AASC-55 (decision 3a): killing a room from the phone stops only the room's
// sessions shared with the phone, one after another, and never says how many hidden ones the room has.
//
// fetch is mocked and the terminal close is mocked: nothing here reaches a real kill route or process
// (see .claude/rules/known-issues.md — a real /kill once killed live sessions).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@/types';

vi.mock('@/lib/terminalTransport', () => ({ closeManagedTerminal: vi.fn(async () => undefined) }));

import { closeManagedTerminal } from '@/lib/terminalTransport';
import { killSharedRoomSessions, roomKillSummary, sharedRoomTargets } from './phoneRoomKill';

const session = (sessionId: string, over: Partial<Session> = {}): Session =>
  ({ sessionId, status: 'idle', remoteVisible: true, ...over }) as Session;

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(closeManagedTerminal).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

const killUrls = () => fetchMock.mock.calls.map(([url]) => String(url));

describe('sharedRoomTargets', () => {
  // The room as the phone has it may still name an id its store never got (a stale list), and on the Mac
  // itself the store holds every session.
  const room = { sessionIds: ['shared', 'hidden', 'not-flagged', 'ended', 'unknown'] };
  const sessions = new Map<string, Session>([
    ['shared', session('shared')],
    ['hidden', session('hidden', { remoteVisible: false })],
    ['not-flagged', session('not-flagged', { remoteVisible: undefined })],
    ['ended', session('ended', { status: 'ended' })],
  ]);

  it('on a remote phone: only live sessions it has that are shared with it', () => {
    expect(sharedRoomTargets(room, sessions, true).map((s) => s.sessionId)).toEqual(['shared']);
  });

  it('on the Mac: every live session in the room it has', () => {
    expect(sharedRoomTargets(room, sessions, false).map((s) => s.sessionId)).toEqual(['shared', 'hidden', 'not-flagged']);
  });
});

describe('killSharedRoomSessions', () => {
  it('kills only the targets, one after another, through the hardened single kill', async () => {
    const order: string[] = [];
    let inFlight = 0;
    fetchMock.mockImplementation(async (url: string) => {
      inFlight += 1;
      expect(inFlight).toBe(1); // never two kills at once
      order.push(url);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response(JSON.stringify({ ok: true, terminalId: null }), { status: 200 });
    });
    const room = { sessionIds: ['a', 'hidden', 'b'] };
    const sessions = new Map<string, Session>([
      ['a', session('a')],
      ['b', session('b')],
      ['hidden', session('hidden', { remoteVisible: false })],
    ]);
    const result = await killSharedRoomSessions(sharedRoomTargets(room, sessions, true));
    expect(result).toEqual({ killed: 2, failed: 0 });
    expect(order).toEqual(['/api/sessions/a/kill', '/api/sessions/b/kill']);
    expect(killUrls().some((u) => u.includes('hidden'))).toBe(false);
  });

  it('counts a refusal or a network error as a survivor and keeps going', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 404 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, terminalId: 'term-1' }), { status: 200 }));
    const result = await killSharedRoomSessions([session('a'), session('b'), session('c')]);
    expect(result).toEqual({ killed: 1, failed: 2 });
    expect(killUrls()).toEqual(['/api/sessions/a/kill', '/api/sessions/b/kill', '/api/sessions/c/kill']);
    expect(closeManagedTerminal).toHaveBeenCalledWith('term-1');
  });

  it('kills nothing for an empty room', async () => {
    expect(await killSharedRoomSessions([])).toEqual({ killed: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('roomKillSummary', () => {
  it('says how many it killed, and on a remote phone that unshared sessions were left running, with no count', () => {
    expect(roomKillSummary('Mobile', { killed: 3, failed: 0 }, true))
      .toBe('Killed 3 in “Mobile”. Sessions not shared with this phone were left running.');
    expect(roomKillSummary('Mobile', { killed: 2, failed: 1 }, false)).toBe('Killed 2 in “Mobile” · 1 couldn’t be stopped.');
    expect(roomKillSummary('Mobile', { killed: 0, failed: 1 }, false)).toBe('Couldn’t stop 1 session in “Mobile”.');
    expect(roomKillSummary('Mobile', { killed: 3, failed: 0 }, true)).not.toMatch(/\d+ (?:session|not shared)/);
  });
});
