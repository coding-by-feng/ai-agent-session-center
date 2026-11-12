/**
 * A card the PostToolUse-timeout guess moved to "approval" goes back to "working" when its terminal
 * shows the live working spinner (Nov 12 2026: CiciNotes sat on "Approval needed" with its alert for
 * a whole turn while Claude printed "Concocting… (8m 10s · ↓ 39.6k tokens)"). The spinner used to be
 * read once, when the timer fired; nothing looked again until the next hook. A real dialog — from
 * PermissionRequest or a permission Notification — is never undone this way.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startAutoIdle, stopAutoIdle } from '../server/autoIdleManager.js';
import { timerApprovalDisproved } from '../server/dialogCloseWatch.js';
import { resetTerminalActivity } from '../server/terminalActivity.js';
import type { Session } from '../src/types/session.js';

const T0 = 1_800_000_000_000;
const SPINNER = '\u001b[38;5;174m✻\u001b[39m Concocting… (8m 10s · ↓ 39.6k tokens)';
const DIALOG = 'Bash command\n  rm -rf build\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel';

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'approval',
    approvalSource: 'timer',
    lastActivityAt: T0,
    terminalId: 'term-1',
    animationState: 'Waiting',
    emote: null,
    pendingTool: 'Bash',
    pendingToolDetail: 'xcodebuild -version',
    waitingDetail: 'Approve Bash: xcodebuild -version',
    pendingRequest: { id: 'r1', source: 'timer' },
    ...over,
  } as unknown as Session;
}

describe('timerApprovalDisproved', () => {
  it('only a timer guess with the spinner drawn after any dialog line', () => {
    expect(timerApprovalDisproved(makeSession(), `● Bash(xcodebuild)\n${SPINNER}`)).toBe(true);
    expect(timerApprovalDisproved(makeSession(), `${SPINNER}\n${DIALOG}`)).toBe(false);
    expect(timerApprovalDisproved(makeSession(), 'no spinner here')).toBe(false);
    expect(timerApprovalDisproved(makeSession(), null)).toBe(false);
    expect(timerApprovalDisproved(makeSession({ approvalSource: 'permission_request' } as Partial<Session>), SPINNER)).toBe(false);
    expect(timerApprovalDisproved(makeSession({ approvalSource: 'notification' } as Partial<Session>), SPINNER)).toBe(false);
    expect(timerApprovalDisproved(makeSession({ status: 'input' } as Partial<Session>), SPINNER)).toBe(false);
  });
});

describe('the auto-idle sweep releases a disproved timer guess', () => {
  let sessions: Map<string, Session>;
  let screen: string | null;
  const onChange = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    resetTerminalActivity();
    onChange.mockReset();
    screen = SPINNER;
    sessions = new Map();
  });
  afterEach(() => {
    stopAutoIdle();
    vi.useRealTimers();
  });

  it('back to working on the next tick, announced once, the running tool kept', () => {
    const s = makeSession();
    sessions.set(s.sessionId, s);
    startAutoIdle(sessions, onChange, () => screen);
    vi.advanceTimersByTime(10_000);
    expect(s.status).toBe('working');
    expect(s.animationState).toBe('Running');
    expect(s.approvalSource).toBeNull();
    expect(s.pendingRequest).toBeNull();
    expect(s.waitingDetail).toBeNull();
    expect(s.pendingTool).toBe('Bash');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toEqual([s]);
    vi.advanceTimersByTime(10_000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('a real dialog on screen, or a PermissionRequest approval, stays', () => {
    const guessedRight = makeSession({ sessionId: 'a' });
    const real = makeSession({ sessionId: 'b', approvalSource: 'permission_request' } as Partial<Session>);
    sessions.set('a', guessedRight);
    sessions.set('b', real);
    const tails: Record<string, string> = { a: `${SPINNER}\n${DIALOG}`, b: SPINNER };
    startAutoIdle(sessions, onChange, (sess) => tails[sess.sessionId]);
    vi.advanceTimersByTime(10_000);
    expect(guessedRight.status).toBe('approval');
    expect(real.status).toBe('approval');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('without a terminal reader nothing changes', () => {
    const s = makeSession();
    sessions.set(s.sessionId, s);
    startAutoIdle(sessions, onChange);
    vi.advanceTimersByTime(10_000);
    expect(s.status).toBe('approval');
  });
});

describe('cost', () => {
  afterEach(() => { stopAutoIdle(); vi.useRealTimers(); });
  it('reads the screen only for a timer-guess approval', () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const read = vi.fn(() => SPINNER);
    const sessions = new Map<string, Session>([
      ['w', makeSession({ sessionId: 'w', status: 'working', approvalSource: null } as Partial<Session>)],
      ['p', makeSession({ sessionId: 'p', approvalSource: 'permission_request' } as Partial<Session>)],
      ['t', makeSession({ sessionId: 't' })],
    ]);
    startAutoIdle(sessions, () => {}, read);
    vi.advanceTimersByTime(10_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0][0]).toMatchObject({ sessionId: 't' });
  });
});
