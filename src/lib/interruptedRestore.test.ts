// interruptedRestore.test.ts — the reminder to continue sessions a quit interrupted.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const send = vi.hoisted(() => vi.fn(async () => true));
const toast = vi.hoisted(() => vi.fn());
const sessions = vi.hoisted(() => ({ map: new Map<string, unknown>() }));

vi.mock('@/lib/terminalSend', () => ({ sendPromptToTerminal: send }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ sessions: sessions.map }) },
}));

import {
  CONTINUE_AFTER_RESTART_PROMPT,
  READY_SETTLE_MS,
  READY_TIMEOUT_MS,
  continueInterrupted,
  getInterruptedOffer,
  isReadyToContinue,
  offerInterrupted,
  pickInterrupted,
  dismissInterrupted,
  subscribeInterrupted,
} from './interruptedRestore';

const snap = (status: string | undefined, title = 'T') =>
  ({ originalSessionId: `o-${title}`, title, status, sshConfig: { command: 'claude' } }) as never;

describe('pickInterrupted', () => {
  it('keeps only sessions whose saved status was mid-turn', () => {
    const picked = pickInterrupted([
      { terminalId: 't1', snap: snap('working', 'A') },
      { terminalId: 't2', snap: snap('prompting', 'B') },
      { terminalId: 't3', snap: snap('approval', 'C') },
      { terminalId: 't4', snap: snap('idle', 'D') },
      { terminalId: 't5', snap: snap('waiting', 'E') },
      { terminalId: 't6', snap: snap('input', 'F') },
      { terminalId: 't7', snap: snap('ended', 'G') },
      { terminalId: 't8', snap: snap(undefined, 'H') },
    ]);
    expect(picked).toEqual([
      { terminalId: 't1', title: 'A', status: 'working' },
      { terminalId: 't2', title: 'B', status: 'prompting' },
      { terminalId: 't3', title: 'C', status: 'approval' },
    ]);
  });

  it('names an untitled session by its project folder, or as untitled', () => {
    const picked = pickInterrupted([
      { terminalId: 't1', snap: { title: '', status: 'working', sshConfig: { workingDir: '/Users/k/proj/sms-ops' } } as never },
      { terminalId: 't2', snap: { title: '', status: 'working' } as never },
    ]);
    expect(picked.map((p) => p.title)).toEqual(['sms-ops', 'Untitled session']);
  });
});

describe('isReadyToContinue', () => {
  const restoreAt = 1_000_000;
  const started = (status: string, at: number) =>
    ({ status, events: [{ type: 'SessionStart', timestamp: at }] }) as never;

  it('waits for the resumed CLI to start after the restore and settle', () => {
    expect(isReadyToContinue(started('idle', restoreAt + 10), restoreAt, restoreAt + 10 + READY_SETTLE_MS)).toBe(true);
    expect(isReadyToContinue(started('idle', restoreAt + 10), restoreAt, restoreAt + 10 + READY_SETTLE_MS - 1)).toBe(false);
  });

  it('ignores a SessionStart from before the restore', () => {
    expect(isReadyToContinue(started('idle', restoreAt - 1), restoreAt, restoreAt + 60_000)).toBe(false);
  });

  it('is not ready while busy, asking a question, or with no start at all', () => {
    expect(isReadyToContinue(started('working', restoreAt + 10), restoreAt, restoreAt + 60_000)).toBe(false);
    expect(isReadyToContinue(started('input', restoreAt + 10), restoreAt, restoreAt + 60_000)).toBe(false);
    expect(isReadyToContinue({ status: 'idle', events: [] } as never, restoreAt, restoreAt + 60_000)).toBe(false);
    expect(isReadyToContinue(undefined, restoreAt, restoreAt + 60_000)).toBe(false);
  });

  it('counts the start even when an idle-prompt notification follows it', () => {
    const s = { status: 'waiting', events: [{ type: 'SessionStart', timestamp: restoreAt + 5 }, { type: 'Notification', timestamp: restoreAt + 6 }] };
    expect(isReadyToContinue(s as never, restoreAt, restoreAt + 5 + READY_SETTLE_MS)).toBe(true);
  });
});

describe('the offer channel', () => {
  afterEach(() => dismissInterrupted());

  it('holds the offer for a modal that mounts later, and tells subscribers', () => {
    const seen: unknown[] = [];
    const off = subscribeInterrupted(() => seen.push(getInterruptedOffer()));
    offerInterrupted({ items: [{ terminalId: 't1', title: 'A', status: 'working' }], restoreStartedAt: 5 });
    expect(getInterruptedOffer()?.items).toHaveLength(1);
    dismissInterrupted();
    expect(getInterruptedOffer()).toBeNull();
    expect(seen).toHaveLength(2);
    off();
  });

  it('never offers an empty list', () => {
    offerInterrupted({ items: [], restoreStartedAt: 5 });
    expect(getInterruptedOffer()).toBeNull();
  });
});

describe('continueInterrupted', () => {
  const restoreAt = 2_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(restoreAt);
    send.mockClear();
    toast.mockClear();
    sessions.map = new Map();
  });
  afterEach(() => vi.useRealTimers());

  const live = (id: string, terminalId: string, status: string, startAt: number | null) => ({
    sessionId: id,
    terminalId,
    status,
    events: startAt === null ? [] : [{ type: 'SessionStart', timestamp: startAt }],
  });

  it('sends the prompt to each session once it is ready, by terminal id, with Enter', async () => {
    // t1 is ready soon; t2 re-keys to a new session id first, then becomes ready later.
    sessions.map.set('term-1', live('term-1', 't1', 'idle', restoreAt + 100));
    const run = continueInterrupted(
      [
        { terminalId: 't1', title: 'A', status: 'working' },
        { terminalId: 't2', title: 'B', status: 'prompting' },
      ],
      restoreAt,
    );
    await vi.advanceTimersByTimeAsync(READY_SETTLE_MS + 1_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('t1', CONTINUE_AFTER_RESTART_PROMPT, true);

    sessions.map.set('uuid-2', live('uuid-2', 't2', 'idle', Date.now()));
    await vi.advanceTimersByTimeAsync(READY_SETTLE_MS + 1_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('t2', CONTINUE_AFTER_RESTART_PROMPT, true);

    const result = await run;
    expect(result).toEqual({ sent: ['A', 'B'], skipped: [] });
    expect(toast).toHaveBeenCalledWith('Sent "continue" to 2 sessions.', 'success');
  });

  it('gives up on a session that never finishes resuming, and says which', async () => {
    sessions.map.set('term-1', live('term-1', 't1', 'working', null));
    const run = continueInterrupted([{ terminalId: 't1', title: 'Slow one', status: 'working' }], restoreAt);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 2_000);
    const result = await run;
    expect(send).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: [], skipped: ['Slow one'] });
    expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('Slow one'),
      'warning',
      expect.any(Number),
    );
  });

  it('counts a session as skipped when the terminal write fails', async () => {
    send.mockResolvedValueOnce(false);
    sessions.map.set('term-1', live('term-1', 't1', 'idle', restoreAt + 1));
    const run = continueInterrupted([{ terminalId: 't1', title: 'A', status: 'working' }], restoreAt);
    await vi.advanceTimersByTimeAsync(READY_SETTLE_MS + 1_000);
    expect(await run).toEqual({ sent: [], skipped: ['A'] });
  });

  it('sends nothing to a session that went away', async () => {
    const run = continueInterrupted([{ terminalId: 'gone', title: 'Gone', status: 'working' }], restoreAt);
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 2_000);
    expect(send).not.toHaveBeenCalled();
    expect((await run).skipped).toEqual(['Gone']);
  });
});
