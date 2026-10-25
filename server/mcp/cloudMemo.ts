// cloudMemo.ts — the cloud plans and jobs each central made itself (plan 2026-10-25 P6-7), in memory.
//
// A run takes only a plan the central's own plan tool made, within PLAN_TTL_MS: never a review the person made in their
// window, nor another central's. A cancel, a retry or a restore takes only a job the central started (or a receipt one
// of that job's steps gave), within JOB_TTL_MS of when it was first remembered: a later read or retry of the job adds
// the receipts its steps gained but never restarts the clock, so a backup cannot be put back days later over newer
// edits. Reading a job is open to any job of the account; this memo is not asked. Each central keeps at most MEMO_MAX of
// each kind; the oldest is dropped. After an AASC restart the memo is empty: the central plans again.
//
// Every write forgets whatever has run out, for every central, so the memo of a central that was revoked (or never
// calls again) is gone within JOB_TTL_MS of its last entry. (The central registry has no revoke hook of its own to
// forget it sooner; a revoked central's token is gone, so nothing can use its entries meanwhile.)
//
// Entries are replaced, never edited. No text a person or the cloud wrote is kept here beyond the plan as its route
// answered it, which only the tools of the central that made it read back.

export const PLAN_TTL_MS = 30 * 60_000;
export const JOB_TTL_MS = 24 * 60 * 60_000;
/** Per central and kind; the oldest is dropped. */
export const MEMO_MAX = 50;

export type PlanKind = 'publish' | 'install' | 'project-resources';

export interface MemoPlan {
  kind: PlanKind;
  planId: string;
  /** The account the plan was made as (cloudWrite.ts `ReviewedAccount.key`): a run as another is refused. */
  accountKey: string;
  /** The plan as its route answered it. */
  plan: unknown;
  /** For a project-resources plan: the get-project job it is for. */
  projectJobId?: string;
  at: number;
}

interface MemoJob {
  jobId: string;
  /** The account the job was started as; a later read of it as another account does not change it. */
  accountKey: string;
  receiptIds: readonly string[];
  /** When the job was first remembered: what JOB_TTL_MS counts from. */
  startedAt: number;
}

interface CentralMemo {
  plans: readonly MemoPlan[];
  jobs: readonly MemoJob[];
}

const EMPTY: CentralMemo = { plans: [], jobs: [] };

/** centralId → what it made, replaced on every change. */
const memos = new Map<string, CentralMemo>();

const memoOf = (centralId: string): CentralMemo => memos.get(centralId) ?? EMPTY;

const planLive = (p: MemoPlan, now: number): boolean => now - p.at <= PLAN_TTL_MS;
const jobLive = (j: MemoJob, now: number): boolean => now - j.startedAt <= JOB_TTL_MS;

/** Forgets every central's plans and jobs that have run out by `now`, and a central left with none. */
function prune(now: number): void {
  for (const [centralId, memo] of [...memos]) {
    const plans = memo.plans.filter((p) => planLive(p, now));
    const jobs = memo.jobs.filter((j) => jobLive(j, now));
    if (plans.length === 0 && jobs.length === 0) memos.delete(centralId);
    else if (plans.length !== memo.plans.length || jobs.length !== memo.jobs.length) memos.set(centralId, { plans, jobs });
  }
}

/** Keeps the newest MEMO_MAX of `entries`, oldest first. */
const capped = <T>(entries: readonly T[]): readonly T[] => (entries.length > MEMO_MAX ? entries.slice(entries.length - MEMO_MAX) : entries);

/** Remembers a plan this central made (one with the same id is replaced). */
export function rememberPlan(centralId: string, p: MemoPlan): void {
  prune(p.at);
  const memo = memoOf(centralId);
  const others = memo.plans.filter((q) => q.planId !== p.planId);
  const sameKind = others.filter((q) => q.kind === p.kind);
  const dropped = new Set(sameKind.length >= MEMO_MAX ? sameKind.slice(0, sameKind.length - MEMO_MAX + 1) : []);
  memos.set(centralId, { ...memo, plans: [...others.filter((q) => !dropped.has(q)), { ...p }] });
}

/** This central's plan of this kind with this id, made within PLAN_TTL_MS of `now`; null otherwise. */
export function planOf(centralId: string, planId: string, kind: PlanKind, now: number): MemoPlan | null {
  const found = memoOf(centralId).plans.find((p) => p.planId === planId && p.kind === kind);
  return found !== undefined && planLive(found, now) ? found : null;
}

/**
 * Remembers a job this central started, with the receipt ids its steps give, as `accountKey` at `now`. A job remembered
 * again (a later read, a retry) keeps the receipts it had and gains the new ones; it keeps the account it was started
 * as and when, so its JOB_TTL_MS still counts from then.
 */
export function rememberJob(
  centralId: string,
  job: { id: string; steps: readonly { receiptId?: string | null }[] },
  accountKey: string,
  now: number,
): void {
  prune(now);
  const memo = memoOf(centralId);
  const earlier = memo.jobs.find((j) => j.jobId === job.id);
  const fresh = job.steps.flatMap((s) => (typeof s.receiptId === 'string' && s.receiptId !== '' ? [s.receiptId] : []));
  const entry: MemoJob =
    earlier === undefined
      ? { jobId: job.id, accountKey, receiptIds: [...new Set(fresh)], startedAt: now }
      : { ...earlier, receiptIds: [...new Set([...earlier.receiptIds, ...fresh])] };
  memos.set(centralId, { ...memo, jobs: capped([...memo.jobs.filter((j) => j.jobId !== job.id), entry]) });
}

const liveJobs = (centralId: string, now: number): readonly MemoJob[] => memoOf(centralId).jobs.filter((j) => jobLive(j, now));

/** Did this central start this job within JOB_TTL_MS of `now`? */
export function ownsJob(centralId: string, jobId: string, now: number): boolean {
  return liveJobs(centralId, now).some((j) => j.jobId === jobId);
}

/** Did a step of a job this central started (within JOB_TTL_MS) give this receipt id? */
export function ownsReceipt(centralId: string, receiptId: string, now: number): boolean {
  return liveJobs(centralId, now).some((j) => j.receiptIds.includes(receiptId));
}

/** The centrals the memo holds anything for, sorted (tests). */
export function heldCentrals(): string[] {
  return [...memos.keys()].sort();
}

/** Forgets every central's plans and jobs (tests; an AASC restart does the same). */
export function resetCloudMemo(): void {
  memos.clear();
}
