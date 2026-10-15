// test/processMonitorPendingRequest.test.ts — AASC-43: an agent process that died with a dialog
// open ends its session, and the waiting request goes with it: nothing is asking any more.
//
// Never signals a real process: every process.kill answers "no such process" here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Session } from '../src/types/session.js';

vi.mock('../server/sshManager.js', () => ({
  getTerminalForSession: () => null,
  getTerminalByPtyPid: () => null,
}));

const { startMonitoring, stopMonitoring } = await import('../server/processMonitor.js');
const { PROCESS_CHECK_INTERVAL } = await import('../server/config.js');

afterEach(() => {
  stopMonitoring();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('process monitor', () => {
  it('a dead agent process ends the session and clears its waiting request', async () => {
    vi.useFakeTimers();
    vi.spyOn(process, 'kill').mockImplementation((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as typeof process.kill);
    const session = {
      sessionId: 'pm-1', status: 'approval', source: 'ssh', cachedPid: 4_000_000, terminalId: null,
      events: [], subagents: [],
      pendingRequest: { id: 'r1', kind: 'permission', cli: 'claude', tool: 'Bash', input: { command: 'ls' }, raisedAt: 1, source: 'permission_request' },
    } as unknown as Session;
    const broadcast = vi.fn(async () => {});
    startMonitoring(new Map([['pm-1', session]]), new Map([[4_000_000, 'pm-1']]), vi.fn(), vi.fn(), broadcast);
    await vi.advanceTimersByTimeAsync(PROCESS_CHECK_INTERVAL + 10);
    expect(session.status).toBe('ended');
    expect(session.pendingRequest).toBeNull();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ session: expect.objectContaining({ pendingRequest: null }) }));
  });
});
