// test/mcp/startPending.test.ts — one rule for "has this session reported that it started?" (Ruling P4-58,
// heardTerminals.ts `startPending`): the never-started marker (`startHeard: false`) or a terminal AASC has not heard a
// hook from (none since it opened, or since AASC restarted). The prompt route already refuses such a card for a
// central (P4-50); the router passes over it, its card says `started: false` (Ruling 66: a fact a central acts on is in
// data), and auto-send is not turned on for it. Nothing here reaches a terminal or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetTerminalHeard, noteTerminalHeard, startPending } from '../../server/heardTerminals.js';
import { eligible } from '../../server/mcp/router.js';
import { toSessionCard } from '../../server/mcp/scope.js';
import { createWorkerRegistry } from '../../server/mcp/workers.js';
import { queueWorld, standardRows, worker as queueWorker } from './queueToolFixtures.js';
import { A, AGENT, B, go, reuseOf, worker } from './routerFixtures.js';
import { dataOf, makeCtx, makeSession, NOW, unheard } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

// toolHarness's makeSession hears the terminal it names (a live card's CLI has spoken); `unheard` undoes that.
const noted: string[] = [];
/** Notes the terminals heard, as a hook from each would; forgotten after the test. */
const hear = (...terminalIds: string[]): void => {
  for (const id of terminalIds) {
    noteTerminalHeard(id);
    noted.push(id);
  }
};
afterEach(() => {
  for (const id of noted.splice(0)) forgetTerminalHeard(id);
});

describe('startPending', () => {
  it('is true for the marker or an unheard terminal, false for a heard one or no terminal', () => {
    hear('t-heard');

    expect(startPending({ startHeard: false, terminalId: 't-heard' })).toBe(true);
    expect(startPending({ terminalId: 't-unheard' })).toBe(true);
    expect(startPending({ startHeard: true, terminalId: 't-unheard' })).toBe(true);
    expect(startPending({ terminalId: 't-heard' })).toBe(false);
    expect(startPending({ terminalId: null })).toBe(false);
    expect(startPending({ terminalId: '' })).toBe(false);
    expect(startPending({ startHeard: false, terminalId: null })).toBe(true);
  });
});

describe('the router and an unheard terminal', () => {
  it('route() passes over an idle card whose terminal is unheard', async () => {
    // A tmux session that outlived an AASC restart: idle, no marker, no hook since AASC came back.
    const survivor = unheard(worker(A, AGENT, { lastActivityAt: NOW }));
    const heard = worker(B, AGENT);

    const r = await go({ sessions: [survivor, heard] }).result;

    expect(reuseOf(r)).toBe(B);
    expect(r.runnersUp).toEqual([expect.objectContaining({ sessionId: A, skipped: 'has not reported that it started' })]);
  });

  it('gives the marker’s reason for an unheard terminal, and none once it is heard', () => {
    const { ctx } = makeCtx();
    const s = unheard(worker(A, AGENT));

    expect(eligible(s, ctx, { folder: AGENT })).toBe('has not reported that it started');
    hear(s.terminalId!);
    expect(eligible(s, ctx, { folder: AGENT })).toBeNull();
    expect(eligible({ ...s, startHeard: false }, ctx, { folder: AGENT })).toBe('has not reported that it started');
  });
});

describe('the session card says started', () => {
  it('session_get shows started:false for an unheard terminal, true once heard', async () => {
    const s = unheard(makeSession('s-surv-111', { terminalId: 't-surv', status: 'idle', cliSource: 'claude' }));
    const { ctx } = makeCtx({ sessions: [s] });

    expect(await dataOf('session_get', { id: 's-surv-111' }, ctx)).toMatchObject({ card: { status: 'idle', started: false } });
    hear('t-surv');
    expect(await dataOf('session_get', { id: 's-surv-111' }, ctx)).toMatchObject({ card: { status: 'idle', started: true } });
  });

  it('a card with the marker is not started, though its terminal is heard', () => {
    const s = makeSession('s-mark', { terminalId: 't-mark', status: 'idle', startHeard: false });
    hear('t-mark');

    expect(toSessionCard(s, []).started).toBe(false);
    expect(toSessionCard({ ...s, startHeard: undefined }, []).started).toBe(true);
  });
});

describe('queue_set_auto_send and an unheard terminal', () => {
  it('refuses auto-send on for an own worker whose terminal AASC has not heard from', async () => {
    const workers = createWorkerRegistry({ controller: () => null });
    workers.add({ centralId: 'central-1', terminalId: 'term-s1', openedAt: NOW - 60_000, folder: '/a/proj', cli: 'claude' });
    const w = queueWorld({ sessions: [unheard(queueWorker('s1', { status: 'idle' }))], workers, rows: standardRows() });

    await w.call('queue_set_auto_send', { id: 's1', autoSend: false });
    const err = await w.refused('queue_set_auto_send', { id: 's1', autoSend: true });
    expect(err.code).toBe('UNAVAILABLE');
    expect(err.message).toBe('The session has not reported that it started.');
    expect(w.store.rows.get('s1')?.automation).toMatchObject({ autoSend: false });

    hear('term-s1');
    await w.call('queue_set_auto_send', { id: 's1', autoSend: true });
    expect(w.store.rows.get('s1')?.automation).toMatchObject({ autoSend: true });
  });
});
