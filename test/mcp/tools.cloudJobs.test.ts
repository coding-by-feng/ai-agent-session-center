// test/mcp/tools.cloudJobs.test.ts — the P6 job tools (server/mcp/tools/cloudJobs.ts): `cloud_job_get` reads any job of
// the account and can wait for it to settle (polling, P6-9); `cloud_job_cancel` and `cloud_job_retry` act only on a job
// this central started (P6-7), only for a global central (P6-4), within the call budget (P6-15). A retry leaves the Mac
// again, so it waits for the person: its card names the job, the steps left and the account, and it runs only as the
// account the card named (P6-6). The polls run on fake timers; /api is a fake client; nothing reaches a route.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownsJob, ownsReceipt, rememberJob, resetCloudMemo } from '../../server/mcp/cloudMemo.js';
import { resetCloudBudget } from '../../server/mcp/tools/cloudWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { ACCOUNT, BACKEND, CLOUD_HEADERS, cloudFail } from './cloudFixtures.js';
import { PUSH_JOB } from './cloudMainShapes.js';
import { askAndRun, askOf, cloudCtx, switchAccount } from './cloudWriteKit.js';
import { envelope, NOW, run, runRefused, type ApiCall } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const JOB = '9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f';
const OTHER_JOB = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const RECEIPT = 'a1b2c3d4-0000-4000-8000-000000000001';
const KEY_A = `${BACKEND}|${ACCOUNT}|3`;
const JOB_PATH = `/resources/cloud/jobs/${JOB}`;

const job = (state: string, over: Record<string, unknown> = {}) => ({
  id: JOB,
  kind: 'install',
  state,
  steps: [
    { id: 's1', label: 'alpha-skill', state: 'complete', receiptId: RECEIPT },
    { id: 's2', label: 'beta-skill', state: 'failed', error: 'The backend refused it.' },
    { id: 's3', label: 'gamma-skill', state: 'pending' },
  ],
  ...over,
});

/** This central (central-1, as cloudCtx makes it) started JOB. */
const own = (id = JOB): void => rememberJob('central-1', { id, steps: [] }, KEY_A, NOW);

const failureOf = async (p: Promise<unknown>): Promise<ToolError> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
};

const posts = (calls: ApiCall[]): ApiCall[] => calls.filter((c) => c.method === 'POST');

afterEach(() => {
  resetCloudMemo();
  resetCloudBudget();
  vi.useRealTimers();
});

describe('cloud_job_get', () => {
  it('job_get with waitSec 0 answers at once', async () => {
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('running')) } });

    const result = await run('cloud_job_get', { jobId: JOB }, h.ctx);

    expect(result.data).toMatchObject({ settled: false, job: { id: JOB, kind: 'install', state: 'running' } });
    expect(h.client.calls.filter((c) => c.path === JOB_PATH)).toEqual([{ method: 'GET', path: JOB_PATH, headers: CLOUD_HEADERS }]);
    expect(result.summary).toContain(JOB);
  });

  it('with waitSec 10 it answers when the job completes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: () => envelope(job((reads += 1) >= 3 ? 'complete' : 'running')) } });

    const p = run('cloud_job_get', { jobId: JOB, waitSec: 10 }, h.ctx);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await p;

    expect(result.data).toMatchObject({ settled: true, job: { state: 'complete' } });
    expect(reads).toBe(3);
  });

  it('job_get from a room central works (not global-only), and reads a job it did not start', async () => {
    const h = cloudCtx({ kind: 'room', routes: { [`GET ${JOB_PATH}`]: envelope(job('complete')) } });

    expect((await run('cloud_job_get', { jobId: JOB }, h.ctx)).data).toMatchObject({ settled: true });
  });

  it('reads main’s push-project job', async () => {
    const id = (PUSH_JOB as { id: string }).id;
    const h = cloudCtx({ routes: { [`GET /resources/cloud/jobs/${id}`]: envelope(PUSH_JOB) } });

    expect((await run('cloud_job_get', { jobId: id }, h.ctx)).data).toMatchObject({ job: { kind: 'push-project' } });
  });

  it('a read of an own job remembers the receipts it has gained', async () => {
    own();
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('partial')) } });

    await run('cloud_job_get', { jobId: JOB }, h.ctx);

    expect(ownsReceipt('central-1', RECEIPT, NOW)).toBe(true);
  });

  it('a read of a job it did not start remembers nothing', async () => {
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('partial')) } });

    await run('cloud_job_get', { jobId: JOB }, h.ctx);

    expect(ownsJob('central-1', JOB, NOW)).toBe(false);
    expect(ownsReceipt('central-1', RECEIPT, NOW)).toBe(false);
  });

  it('waitSec past 45 is refused by the schema', async () => {
    const h = cloudCtx();

    await expect(run('cloud_job_get', { jobId: JOB, waitSec: 46 }, h.ctx)).rejects.toThrow(/Arguments refused/);
  });
});

describe('cloud_job_cancel', () => {
  it('posts {} for its own job, as the live account, and answers the job', async () => {
    own();
    const h = cloudCtx({ routes: { [`POST ${JOB_PATH}/cancel`]: envelope(job('cancelled')) } });

    const result = await run('cloud_job_cancel', { jobId: JOB }, h.ctx);

    expect(posts(h.client.calls)).toEqual([{ method: 'POST', path: `${JOB_PATH}/cancel`, body: {}, headers: CLOUD_HEADERS }]);
    expect(result.data).toMatchObject({ job: { id: JOB, state: 'cancelled' } });
    expect(result.activity?.[0].detail).toMatchObject({ jobId: JOB, state: 'cancelled' });
  });

  it('a room central’s cancel is DENIED', async () => {
    own();
    const h = cloudCtx({ kind: 'room' });

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx)).code).toBe('DENIED');
    expect(h.client.calls).toEqual([]);
  });
});

describe('a job this central did not start', () => {
  it('cancel and retry of a job this central did not start are NOT_FOUND, and they call nothing', async () => {
    own(OTHER_JOB);
    // Another central's job is not this one's either.
    rememberJob('central-2', { id: JOB, steps: [] }, KEY_A, NOW);
    const h = cloudCtx();

    const cancel = await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx);
    const retry = await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB }));

    for (const err of [cancel, retry]) {
      expect(err.code).toBe('NOT_FOUND');
      expect(err.message).toMatch(/not a job you started/);
    }
    expect(h.client.calls).toEqual([]);
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('a job of its own older than 24 hours is NOT_FOUND', async () => {
    rememberJob('central-1', { id: JOB, steps: [] }, KEY_A, NOW - 24 * 60 * 60_000 - 1);
    const h = cloudCtx();

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx)).code).toBe('NOT_FOUND');
  });
});

describe('cloud_job_retry', () => {
  it('retry of a running job is INVALID before any card', async () => {
    own();
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('running')) } });

    const err = await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB }));

    expect(err).toMatchObject({ code: 'INVALID', message: 'Only an interrupted, cancelled, partial or failed job can be retried.' });
    expect(err.data).toMatchObject({ state: 'running' });
    expect(posts(h.client.calls)).toEqual([]);
  });

  it('retry asks, then posts once allowed, and remembers the new job', async () => {
    own();
    const h = cloudCtx({
      routes: {
        [`GET ${JOB_PATH}`]: envelope(job('partial')),
        [`POST ${JOB_PATH}/retry`]: envelope(job('queued', { id: OTHER_JOB })),
      },
    });

    const { ask, result } = await askAndRun(h, 'cloud_job_retry', { jobId: JOB });

    expect(ask.summary).toBe('AASC Cloud: retry job 9f8e7d6c (install, 2 of 3 steps left) as 0b1f6d5e');
    expect(ask.detail).toBe('- beta-skill (failed): The backend refused it.\n- gamma-skill (pending)');
    expect(ask.fingerprint).toMatch(new RegExp(`^retry:${JOB}:${KEY_A.replace(/[.|]/g, '\\$&')}:partial:[0-9a-f]{40}$`));
    expect(posts(h.client.calls)).toEqual([{ method: 'POST', path: `${JOB_PATH}/retry`, body: {}, headers: CLOUD_HEADERS }]);
    expect(result.data).toMatchObject({ jobId: OTHER_JOB, next: 'cloud_job_get' });
    expect(ownsJob('central-1', OTHER_JOB, NOW)).toBe(true);
  });

  it('cloud_job_retry after an account switch is CHANGED', async () => {
    own();
    const h = cloudCtx({
      routes: {
        [`GET ${JOB_PATH}`]: envelope(job('failed')),
        [`POST ${JOB_PATH}/retry`]: envelope(job('queued')),
      },
    });

    const err = await failureOf(askAndRun(h, 'cloud_job_retry', { jobId: JOB }, () => switchAccount(h, 'B')));

    expect(err.message).toBe('What you asked about changed after the person was asked, so nothing was done.');
    expect(posts(h.client.calls)).toEqual([]);
  });

  it('a step that moved after the allow is CHANGED', async () => {
    own();
    let reads = 0;
    const h = cloudCtx({
      routes: {
        [`GET ${JOB_PATH}`]: () => envelope(job('partial', reads++ === 0 ? {} : { steps: [{ id: 's1', label: 'alpha-skill', state: 'complete' }] })),
        [`POST ${JOB_PATH}/retry`]: envelope(job('queued')),
      },
    });

    await expect(askAndRun(h, 'cloud_job_retry', { jobId: JOB })).rejects.toMatchObject({ code: 'INVALID' });
    expect(posts(h.client.calls)).toEqual([]);
  });

  it('run without the person’s allow is INVALID and posts nothing', async () => {
    own();
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('failed')) } });

    const err = await runRefused('cloud_job_retry', { jobId: JOB }, h.ctx);

    expect(err).toMatchObject({ code: 'INVALID', message: 'That changed; call again.' });
    expect(posts(h.client.calls)).toEqual([]);
  });

  it('the 409 review_required from retry says make a new plan, with cloudCode', async () => {
    own();
    const h = cloudCtx({
      routes: {
        [`GET ${JOB_PATH}`]: envelope(job('failed')),
        [`POST ${JOB_PATH}/retry`]: cloudFail(409, 'review_required', 'Create a fresh review before retrying.'),
      },
    });

    const err = await failureOf(askAndRun(h, 'cloud_job_retry', { jobId: JOB }));

    expect(err.message).toBe('Create a fresh review before retrying.');
    expect(err.hint).toMatch(/make a new plan/i);
    expect(err.data).toEqual({ cloudCode: 'review_required' });
  });

  it('a room or project central’s retry is DENIED before any call', async () => {
    own();
    for (const kind of ['room', 'project'] as const) {
      const h = cloudCtx({ kind });
      expect((await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB }))).code).toBe('DENIED');
      expect(h.client.calls).toEqual([]);
    }
  });

  it('no refusal repeats the job id', async () => {
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('running')) } });
    const refusals = [
      await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx),
      await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB })),
    ];
    own();
    refusals.push(await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB })));
    refusals.push(await runRefused('cloud_job_retry', { jobId: JOB }, h.ctx));
    refusals.push(await runRefused('cloud_job_cancel', { jobId: JOB }, cloudCtx({ kind: 'project' }).ctx));

    for (const err of refusals) {
      expect(`${err.message} ${err.hint ?? ''} ${JSON.stringify(err.data ?? {})}`).not.toContain(JOB);
      expect(`${err.message} ${err.hint ?? ''}`).not.toContain(JOB.slice(0, 8));
    }
  });
});

describe('the budget', () => {
  it('the 21st cancel in a minute is BUDGET', async () => {
    own();
    const h = cloudCtx({ routes: { [`POST ${JOB_PATH}/cancel`]: envelope(job('cancelled')) } });

    for (let i = 0; i < 20; i += 1) await run('cloud_job_cancel', { jobId: JOB }, h.ctx);

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx)).code).toBe('BUDGET');
  });

  it('a cancel or retry refused before the cloud (DENIED, not its own job) spends none of the budget (P6-40)', async () => {
    const room = cloudCtx({ kind: 'room' });
    const global = cloudCtx({ routes: { [`POST ${JOB_PATH}/cancel`]: envelope(job('cancelled')) } });
    // Both are central-1, the one budget.
    expect(room.ctx.central.centralId).toBe(global.ctx.central.centralId);
    for (let i = 0; i < 25; i += 1) {
      expect((await runRefused('cloud_job_cancel', { jobId: JOB }, room.ctx)).code).toBe('DENIED');
      expect((await failureOf(askOf(room, 'cloud_job_retry', { jobId: JOB }))).code).toBe('DENIED');
      expect((await runRefused('cloud_job_cancel', { jobId: JOB }, global.ctx)).code).toBe('NOT_FOUND');
      expect((await failureOf(askOf(global, 'cloud_job_retry', { jobId: JOB }))).code).toBe('NOT_FOUND');
    }
    expect([...room.client.calls, ...global.client.calls]).toEqual([]);

    own();
    for (let i = 0; i < 20; i += 1) await run('cloud_job_cancel', { jobId: JOB }, global.ctx);

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, global.ctx)).code).toBe('BUDGET');
  });

  it('the budget is spent right before the first cloud call: a BUDGET cancel or retry calls nothing', async () => {
    own();
    const h = cloudCtx({ routes: { [`POST ${JOB_PATH}/cancel`]: envelope(job('cancelled')) } });
    for (let i = 0; i < 20; i += 1) await run('cloud_job_cancel', { jobId: JOB }, h.ctx);
    const before = h.client.calls.length;

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx)).code).toBe('BUDGET');
    expect((await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB }))).code).toBe('BUDGET');
    expect(h.client.calls).toHaveLength(before);
    expect(h.confirmBook.pending()).toEqual([]);
  });

  it('a retry counts in its confirm, before its first cloud call (the status read)', async () => {
    own();
    const h = cloudCtx({ routes: { [`GET ${JOB_PATH}`]: envelope(job('running')) } });

    // Refused on the job's state, which only the cloud says: it reached the cloud, so it counts.
    for (let i = 0; i < 20; i += 1) {
      expect((await failureOf(askOf(h, 'cloud_job_retry', { jobId: JOB }))).code).toBe('INVALID');
    }

    expect((await runRefused('cloud_job_cancel', { jobId: JOB }, h.ctx)).code).toBe('BUDGET');
  });
});

describe('the descriptions', () => {
  it('carry the rules each tool is under (Ruling 65)', async () => {
    const { allTools } = await import('../../server/mcp/registry.js');
    const byName = (name: string) => allTools().find((t) => t.name === name);

    expect(byName('cloud_job_get')).toMatchObject({ risk: 'read', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_job_cancel')).toMatchObject({ risk: 'write', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_job_retry')).toMatchObject({ risk: 'outward', phase: 6, toolset: 'cloud' });
    expect(byName('cloud_job_get')?.description).toMatch(/any job of the account/);
    expect(byName('cloud_job_get')?.description).toMatch(/settled/);
    for (const name of ['cloud_job_cancel', 'cloud_job_retry']) {
      const text = byName(name)?.description ?? '';
      expect(text).toContain('Only a global central may do this; a room or project central is DENIED.');
      expect(text).toContain('Only a job you started yourself (in the last 24 hours).');
    }
    expect(byName('cloud_job_retry')?.description).toContain(
      'It waits for the person on the Mac first (an AASC card): NEEDS_CONFIRMATION means call confirm_wait with data.confirmId.',
    );
  });
});
