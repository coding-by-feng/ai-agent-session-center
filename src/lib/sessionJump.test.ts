import { describe, it, expect, beforeEach } from 'vitest';
import { resolveJumpInput, jumpToSessionNumber } from './sessionJump';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

describe('resolveJumpInput — what the typed digits point at', () => {
  it('nothing typed yet', () => {
    expect(resolveJumpInput('', 23)).toEqual({ n: null, valid: false, canGrow: true });
  });

  it('"1" of 23 can still become 10–19, so it waits', () => {
    expect(resolveJumpInput('1', 23)).toEqual({ n: 1, valid: true, canGrow: true });
  });

  it('"13" of 23 cannot grow (no #130), so it is final', () => {
    expect(resolveJumpInput('13', 23)).toEqual({ n: 13, valid: true, canGrow: false });
  });

  it('"3" of 23 is final at once: there is no #30', () => {
    expect(resolveJumpInput('3', 23)).toEqual({ n: 3, valid: true, canGrow: false });
  });

  it('"2" of 23 waits: #20–23 exist', () => {
    expect(resolveJumpInput('2', 23).canGrow).toBe(true);
  });

  it('with 9 sessions or fewer every digit is final', () => {
    expect(resolveJumpInput('5', 9)).toEqual({ n: 5, valid: true, canGrow: false });
  });

  it('out of range is invalid and cannot grow into anything valid', () => {
    expect(resolveJumpInput('45', 23)).toEqual({ n: 45, valid: false, canGrow: false });
    expect(resolveJumpInput('3', 0)).toEqual({ n: 3, valid: false, canGrow: false });
  });
});

describe('jumpToSessionNumber', () => {
  const mk = (id: string, title: string): Session =>
    ({ sessionId: id, title, projectName: 'p', status: 'idle', lastActivityAt: 0, events: [], promptHistory: [] } as unknown as Session);

  beforeEach(() => {
    const sessions = [mk('a', 'alpha'), mk('b', 'bravo'), mk('c', 'charlie')];
    useSessionStore.setState({ sessions: new Map(sessions.map((x) => [x.sessionId, x])), selectedSessionId: null, previousSessionId: null });
    useUiStore.setState({ detailPanelMinimized: false });
  });

  it('opens the session with that badge number', () => {
    expect(jumpToSessionNumber(2)).toBe(true);
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
  });

  it('the session already open (minimized) is un-minimized, not re-selected', () => {
    useSessionStore.getState().selectSession('c');
    useUiStore.setState({ detailPanelMinimized: true });
    const prev = useSessionStore.getState().previousSessionId;
    expect(jumpToSessionNumber(3)).toBe(true);
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
    expect(useSessionStore.getState().previousSessionId).toBe(prev);
  });

  it('a number with no session changes nothing', () => {
    expect(jumpToSessionNumber(9)).toBe(false);
    expect(jumpToSessionNumber(0)).toBe(false);
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });
});
