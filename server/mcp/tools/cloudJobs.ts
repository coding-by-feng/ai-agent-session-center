// tools/cloudJobs.ts — the cloud toolset's P6 job tools (plan 2026-10-25, Task 3): `cloud_job_get` reads a cloud job and
// can wait for it to settle; `cloud_job_cancel` and `cloud_job_retry` act on a job this central started. Filed under
// `cloud` by cloudP6.ts.
//
// A read is open to every central that has the toolset, and to any job of the account, as P1's cloud reads are (P6-7);
// one of the central's own jobs is remembered again as it is read, so a receipt a step gained since is the central's to
// restore (until 24 hours from the job's start: a read never restarts that clock, cloudMemo.ts). A cancel or a retry changes what the account holds: only a global central (P6-4), only its own job from the
// last 24 hours (P6-7: another's is NOT_FOUND, and nothing is called), within the call budget (P6-15), spent only once
// those checks pass and right before the first cloud call (P6-40). A retry runs the
// job's steps again, off the Mac and into ~/.claude and ~/.codex, so it is `outward` and waits for the person: its card
// names the job, how many of its steps are left and the account, and lists those steps; the fingerprint holds the job's
// state and every step's state, so a job that moved after the allow runs nothing (CHANGED); and its run posts as the
// account the card named (cloudWrite.ts `approvedAccount`, P6-6). No refusal repeats the job id.

import { z } from 'zod';
import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import { ownsJob, rememberJob } from '../cloudMemo.js';
import type { ConfirmAsk, ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { CLOUD } from './cloudCall.js';
import { JOB_WAIT_MAX_SEC, jobOf, jobStarted, readJob, waitForJob, type JobView } from './cloudJob.js';
import {
  accountKeyOf,
  approvedAccount,
  cardDetail,
  cardDigest,
  CLOUD_RULES,
  cloudSend,
  cloudWriteBody,
  liveAccount,
  reviewAccount,
  short,
  spendCloudCall,
} from './cloudWrite.js';
import { defineTool, fence, isRecord, oneLine, plain, plural, seg } from './define.js';
import { assertGlobal } from './resourceWrite.js';
import { records, str } from './shape.js';

const JOB_ID = CanonicalCloudIdSchema.describe('A cloud job id (data.jobId of the tool that started it, or cloud_job_get’s).');

/** The states a job can be retried from (the route's own rule). */
const RETRYABLE: ReadonlySet<string> = new Set(['interrupted', 'cancelled', 'partial', 'failed']);

const LABEL_MAX = 120;
const ERROR_MAX = 160;

/** Only a global central changes what the account holds (P6-4). */
const globalOnly = (ctx: ToolContext): void =>
  assertGlobal(ctx, 'changes what this Mac holds in AASC Cloud', 'the cloud account, ~/.claude and ~/.codex belong to the whole Mac');

/** P6-7: a job this central did not start in the last 24 hours, in words that never repeat its id. */
const notOwnJob = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That is not a job you started (or it is over 24 hours old).',
    'Only a job your own cloud tool started can be cancelled or retried; cloud_job_get reads any job.',
  );

/** A job's answer that is no job. */
const notAJob = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a job of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

/**
 * The checks of a cancel or a retry, in the one order every P6 tool keeps (P6-40): what is refused here (not global,
 * not its own job) never reached the cloud, so it spends none of the budget; then the budget, right before the first
 * cloud call (the status read), so a BUDGET calls nothing.
 */
function ownJobCall(ctx: ToolContext, jobId: string): void {
  globalOnly(ctx);
  if (!ownsJob(ctx.central.centralId, jobId, ctx.now())) throw notOwnJob();
  spendCloudCall(ctx);
}

/** A job's steps as rows for the text: AASC's words and ids only (labels and errors are in `data`, fenced). */
function stepRows(job: JobView): string[] {
  return job.steps.map((s) =>
    [s.state, plain(s.id, 80), s.error === null ? null : 'has an error', s.attention === null ? null : 'needs attention', s.receiptId === null ? null : `receipt ${s.receiptId}`]
      .filter((p): p is string => p !== null)
      .join(' · '),
  );
}

/** How many steps are in each state, e.g. "1 complete, 2 pending". */
function tally(job: JobView): string {
  const counts = new Map<string, number>();
  for (const s of job.steps) counts.set(s.state, (counts.get(s.state) ?? 0) + 1);
  return [...counts].map(([state, n]) => `${n} ${state}`).join(', ');
}

/** The job's text: a lead line, then its steps in one block. */
function jobText(lead: string, job: JobView): string {
  const rows = stepRows(job);
  return rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-job', rows.join('\n'))}`;
}

// ---------------------------------------------------------------------------
// cloud_job_get
// ---------------------------------------------------------------------------

const cloudJobGet = defineTool({
  name: 'cloud_job_get',
  toolset: 'cloud',
  title: 'A cloud job',
  description:
    'Reads one AASC Cloud job (a publish, an install, a sync, a project clone, pull or push): its kind, state and each ' +
    'step’s state, label, error and receipt id (labels, errors and attention notes fenced as untrusted data). It reads ' +
    'any job of the account, not only yours. Pass waitSec (0 to 45, default 0) to wait for it: it asks every second ' +
    'and answers as soon as the job settles. data.settled is true once the job has ended: complete, partial, failed, ' +
    'cancelled or interrupted; false while it is queued or running, so call it again. A receipt id is what ' +
    'cloud_install_restore takes. Changes nothing.',
  risk: 'read',
  phase: 6,
  input: {
    jobId: JOB_ID,
    waitSec: z.number().int().min(0).max(JOB_WAIT_MAX_SEC).optional().describe(`How long to wait for it to settle, 0 to ${JOB_WAIT_MAX_SEC} seconds (default 0).`),
  },
  async run(args, ctx) {
    const binding = await liveAccount(ctx);
    const job = await waitForJob(ctx, args.jobId, binding, (args.waitSec ?? 0) * 1_000);
    const { centralId } = ctx.central;
    if (ownsJob(centralId, job.id, ctx.now())) {
      rememberJob(centralId, job, accountKeyOf(binding), ctx.now());
    }
    const data = { job, settled: job.settled };
    const where = job.settled ? 'it has ended' : 'still going: call cloud_job_get again';
    const steps = job.steps.length === 0 ? 'no steps' : `${plural(job.steps.length, 'step')} (${tally(job)})`;
    return { data, summary: jobText(`Cloud job ${job.id} (${job.kind}) is ${job.state}, ${where}; ${steps}.`, job) };
  },
});

// ---------------------------------------------------------------------------
// cloud_job_cancel
// ---------------------------------------------------------------------------

const cloudJobCancel = defineTool({
  name: 'cloud_job_cancel',
  toolset: 'cloud',
  title: 'Cancel a cloud job',
  description:
    'Asks AASC Cloud to cancel a job you started: a step already done stays done, the rest do not run. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.ownJob} Another job is NOT_FOUND. It answers the job as it is now ` +
    '(follow it with cloud_job_get). At most 20 cloud changes a minute (BUDGET).',
  risk: 'write',
  phase: 6,
  input: { jobId: JOB_ID },
  async run(args, ctx) {
    ownJobCall(ctx, args.jobId);
    const binding = await liveAccount(ctx);
    const job = jobOf(cloudWriteBody(await cloudSend(ctx, 'post', `${CLOUD}/jobs/${seg(args.jobId)}/cancel`, {}, binding)));
    if (job === null) throw notAJob();
    rememberJob(ctx.central.centralId, job, accountKeyOf(binding), ctx.now());
    return {
      data: { job },
      summary: jobText(`Asked AASC Cloud to cancel job ${job.id} (${job.kind}): it is ${job.state} now.`, job),
      activity: [{ summary: `Cancelled cloud job ${short(job.id)} (${job.kind}): ${job.state}`, detail: { jobId: job.id, kind: job.kind, state: job.state } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_job_retry
// ---------------------------------------------------------------------------

/** The raw steps of a job, by id: the words the card shows (the confirmation book marks hidden characters itself). */
function rawSteps(raw: unknown): Map<string, { label: string; error: string }> {
  const steps = isRecord(raw) ? records(raw.steps) : [];
  return new Map(steps.map((s) => [str(s.id) ?? '', { label: str(s.label) ?? '', error: str(s.error) ?? '' }]));
}

const cloudJobRetry = defineTool({
  name: 'cloud_job_retry',
  toolset: 'cloud',
  title: 'Retry a cloud job',
  description:
    'Runs the steps of a job you started again, those not yet complete: an interrupted, cancelled, partial or failed ' +
    'job only (any other is INVALID). It sends things to AASC Cloud and may write into ~/.claude and ~/.codex, as the ' +
    `job did. ${CLOUD_RULES.global} ${CLOUD_RULES.ownJob} ${CLOUD_RULES.waits} The card shows the job, how many steps ` +
    'are left and the account; it runs only as that account, and if the job or the account changes before the person ' +
    `allows it nothing runs (call it again). ${CLOUD_RULES.job} A 409 review_required means the plan behind the job is ` +
    'out of date: make a new plan instead. At most 20 cloud changes a minute (BUDGET).',
  risk: 'outward',
  phase: 6,
  input: { jobId: JOB_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    ownJobCall(ctx, args.jobId);
    const account = await reviewAccount(ctx);
    const { view: job, raw } = await readJob(ctx, args.jobId, account.binding);
    if (!RETRYABLE.has(job.state)) {
      throw new ToolError(
        'INVALID',
        'Only an interrupted, cancelled, partial or failed job can be retried.',
        'cloud_job_get says where it stands; wait for it to end.',
        { state: job.state },
      );
    }
    const words = rawSteps(raw);
    const left = job.steps.filter((s) => s.state !== 'complete');
    const detail = left.map((s) => {
      const said = words.get(s.id) ?? { label: '', error: '' };
      const label = said.label === '' ? plain(s.id, 80) : oneLine(said.label, LABEL_MAX);
      return `- ${label} (${s.state})${said.error === '' ? '' : `: ${oneLine(said.error, ERROR_MAX)}`}`;
    });
    return {
      summary: `AASC Cloud: retry job ${short(job.id)} (${job.kind}, ${left.length} of ${job.steps.length} steps left) as ${account.label}`,
      detail: cardDetail(detail),
      fingerprint: `retry:${job.id}:${account.key}:${job.state}:${cardDigest(job.steps.map((s) => [s.id, s.state]))}`,
    };
  },
  async run(args, ctx) {
    const account = approvedAccount(ctx);
    const job = jobOf(cloudWriteBody(await cloudSend(ctx, 'post', `${CLOUD}/jobs/${seg(args.jobId)}/retry`, {}, account.binding)));
    if (job === null) throw notAJob();
    rememberJob(ctx.central.centralId, job, account.key, ctx.now());
    return jobStarted(job, 'Retried a cloud job');
  },
});

export const cloudJobTools: readonly ToolDef[] = [cloudJobGet, cloudJobCancel, cloudJobRetry];
