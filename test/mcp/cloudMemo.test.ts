// test/mcp/cloudMemo.test.ts — the plans and jobs a central made itself (server/mcp/cloudMemo.ts, P6-7): a run takes only
// a plan its own plan tool made in the last 30 minutes, and a cancel, retry or restore only a job (or a step's receipt)
// it started in the last 24 hours. Each central has its own; at most 50 of each kind, the oldest dropped.
import { afterEach, describe, expect, it } from 'vitest';
import {
  heldCentrals,
  JOB_TTL_MS,
  MEMO_MAX,
  ownsJob,
  ownsReceipt,
  PLAN_TTL_MS,
  planOf,
  rememberJob,
  rememberPlan,
  resetCloudMemo,
  type MemoPlan,
} from '../../server/mcp/cloudMemo.js';

const T0 = 1_700_000_000_000;
const KEY = 'https://api.example.test|acct|3';

const plan = (planId: string, kind: MemoPlan['kind'] = 'publish', at = T0): MemoPlan => ({ kind, planId, accountKey: KEY, plan: { id: planId }, at });

afterEach(() => {
  resetCloudMemo();
});

describe('plans', () => {
  it('planOf finds only this central’s plan of this kind within 30 minutes', () => {
    rememberPlan('c1', plan('p1'));
    rememberPlan('c1', plan('p2', 'install'));

    expect(planOf('c1', 'p1', 'publish', T0 + PLAN_TTL_MS)).toMatchObject({ planId: 'p1', accountKey: KEY, plan: { id: 'p1' } });
    expect(planOf('c2', 'p1', 'publish', T0)).toBeNull();
    expect(planOf('c1', 'p1', 'install', T0)).toBeNull();
    expect(planOf('c1', 'p2', 'install', T0)).not.toBeNull();
    expect(planOf('c1', 'p1', 'publish', T0 + PLAN_TTL_MS + 1)).toBeNull();
    expect(planOf('c1', 'nope', 'publish', T0)).toBeNull();
    expect(PLAN_TTL_MS).toBe(30 * 60_000);
  });

  it('the 51st plan drops the oldest', () => {
    for (let i = 0; i <= MEMO_MAX; i += 1) rememberPlan('c1', plan(`p${i}`, 'publish', T0 + i));

    expect(MEMO_MAX).toBe(50);
    expect(planOf('c1', 'p0', 'publish', T0 + 100)).toBeNull();
    expect(planOf('c1', 'p1', 'publish', T0 + 100)).not.toBeNull();
    expect(planOf('c1', `p${MEMO_MAX}`, 'publish', T0 + 100)).not.toBeNull();
  });

  it('the cap is per kind: 50 publish plans leave an install plan alone', () => {
    rememberPlan('c1', plan('install-1', 'install'));
    for (let i = 0; i <= MEMO_MAX; i += 1) rememberPlan('c1', plan(`p${i}`));

    expect(planOf('c1', 'install-1', 'install', T0)).not.toBeNull();
  });

  it('a plan remembered again replaces the earlier one with that id', () => {
    rememberPlan('c1', plan('p1'));
    rememberPlan('c1', { ...plan('p1'), plan: { id: 'p1', again: true }, at: T0 + 10 });

    expect(planOf('c1', 'p1', 'publish', T0 + 10)?.plan).toEqual({ id: 'p1', again: true });
  });

  it('keeps the project job a resources plan belongs to', () => {
    rememberPlan('c1', { ...plan('r1', 'project-resources'), projectJobId: 'job-1' });

    expect(planOf('c1', 'r1', 'project-resources', T0)?.projectJobId).toBe('job-1');
  });
});

describe('jobs and receipts', () => {
  const job = { id: 'job-1', steps: [{ receiptId: 'rcpt-1' }, { receiptId: null }, {}] };

  it('ownsJob and ownsReceipt hold for 24 hours, per central', () => {
    rememberJob('c1', job, KEY, T0);

    expect(ownsJob('c1', 'job-1', T0 + JOB_TTL_MS)).toBe(true);
    expect(ownsReceipt('c1', 'rcpt-1', T0 + JOB_TTL_MS)).toBe(true);
    expect(ownsJob('c2', 'job-1', T0)).toBe(false);
    expect(ownsReceipt('c2', 'rcpt-1', T0)).toBe(false);
    expect(ownsJob('c1', 'job-1', T0 + JOB_TTL_MS + 1)).toBe(false);
    expect(ownsReceipt('c1', 'rcpt-1', T0 + JOB_TTL_MS + 1)).toBe(false);
    expect(ownsJob('c1', 'job-2', T0)).toBe(false);
    expect(JOB_TTL_MS).toBe(24 * 60 * 60_000);
  });

  it('a job remembered again keeps the receipts it had and gains the new ones', () => {
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-1' }] }, KEY, T0);
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-2' }] }, KEY, T0 + 5);

    expect(ownsReceipt('c1', 'rcpt-1', T0 + 5)).toBe(true);
    expect(ownsReceipt('c1', 'rcpt-2', T0 + 5)).toBe(true);
  });

  it('a job remembered again still counts its 24 hours from when it was first remembered', () => {
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-1' }] }, KEY, T0);
    // A read of the job (or a retry) a minute before its 24 hours are up brings a new receipt.
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-2' }] }, 'https://api.example.test|other|9', T0 + JOB_TTL_MS - 60_000);

    expect(ownsJob('c1', 'job-1', T0 + JOB_TTL_MS)).toBe(true);
    expect(ownsReceipt('c1', 'rcpt-2', T0 + JOB_TTL_MS)).toBe(true);
    expect(ownsJob('c1', 'job-1', T0 + JOB_TTL_MS + 1)).toBe(false);
    expect(ownsReceipt('c1', 'rcpt-1', T0 + JOB_TTL_MS + 1)).toBe(false);
    expect(ownsReceipt('c1', 'rcpt-2', T0 + JOB_TTL_MS + 1)).toBe(false);
  });

  it('a job remembered after its 24 hours is remembered afresh, without the receipts it had', () => {
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-1' }] }, KEY, T0);
    // The tools ask ownsJob first, so only a job started anew under the same id would come here.
    rememberJob('c1', { id: 'job-1', steps: [{ receiptId: 'rcpt-2' }] }, KEY, T0 + JOB_TTL_MS + 1);

    expect(ownsJob('c1', 'job-1', T0 + JOB_TTL_MS + 1)).toBe(true);
    expect(ownsReceipt('c1', 'rcpt-1', T0 + JOB_TTL_MS + 1)).toBe(false);
    expect(ownsReceipt('c1', 'rcpt-2', T0 + JOB_TTL_MS + 1)).toBe(true);
  });

  it('the 51st job drops the oldest, with its receipts', () => {
    for (let i = 0; i <= MEMO_MAX; i += 1) rememberJob('c1', { id: `job-${i}`, steps: [{ receiptId: `rcpt-${i}` }] }, KEY, T0 + i);

    expect(ownsJob('c1', 'job-0', T0 + 100)).toBe(false);
    expect(ownsReceipt('c1', 'rcpt-0', T0 + 100)).toBe(false);
    expect(ownsJob('c1', 'job-1', T0 + 100)).toBe(true);
  });

  it('every write forgets what has run out, for every central: a revoked central’s memo goes within 24 hours', () => {
    // c1 started a job and c2 made a plan; then neither calls again (revoked, or gone quiet).
    rememberJob('c1', job, KEY, T0);
    rememberPlan('c2', plan('p1'));
    // c4 keeps a live job next to a plan that has run out.
    rememberPlan('c4', plan('p4', 'publish', T0));
    rememberJob('c4', { id: 'job-4', steps: [] }, KEY, T0 + 1);

    expect(heldCentrals()).toEqual(['c1', 'c2', 'c4']);

    // Any central's write, a day later.
    rememberJob('c3', { id: 'job-3', steps: [] }, KEY, T0 + JOB_TTL_MS + 1);

    expect(heldCentrals()).toEqual(['c3', 'c4']);
    expect(ownsJob('c4', 'job-4', T0 + JOB_TTL_MS + 1)).toBe(true);
    expect(planOf('c4', 'p4', 'publish', T0)).toBeNull();
  });

  it('a plan write forgets what has run out too', () => {
    rememberPlan('c1', plan('p1', 'publish', T0));
    rememberPlan('c2', plan('p2', 'publish', T0 + PLAN_TTL_MS + 1));

    expect(heldCentrals()).toEqual(['c2']);
  });

  it('resetCloudMemo forgets everything (an AASC restart)', () => {
    rememberJob('c1', job, KEY, T0);
    rememberPlan('c1', plan('p1'));
    resetCloudMemo();

    expect(ownsJob('c1', 'job-1', T0)).toBe(false);
    expect(planOf('c1', 'p1', 'publish', T0)).toBeNull();
  });
});
