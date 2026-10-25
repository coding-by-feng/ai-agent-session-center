// tools/cloudJob.ts — how a P6 tool reads and follows a cloud job (plan 2026-10-25 P6-9). A publish, an install, a sync
// and every project clone, pull or push is a job in one job store (`GET /resources/cloud/jobs/:id`). A tool that starts
// one answers at once (`jobStarted`: `data.jobId`, `next: 'cloud_job_get'`), and the central follows it by polling:
// `waitForJob` asks every JOB_POLL_MS until the job settles, the wait ends (never past JOB_WAIT_MAX_SEC, by the clock
// as well as by the count of polls: a slow read eats into the wait) or the call is cancelled. Neither CLI shows a tool's
// progress notifications to its model, so there are none.
//
// A job is read loosely, from the branch's shape or main's (`push-project`): its kind, state and each step's state are
// kept only when they are words, else 'unknown'. Its id, and a step's receipt id, only when it is a canonical cloud id:
// a job with any other id is no job, and such a receipt is none, so neither reaches a text or the memo. A step's label,
// error and attention are cloud or person text (a resource's name, a backend's complaint): fenced as untrusted in `data`.

import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import type { ToolContext, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { bindingHeaders, CLOUD, type CloudBinding } from './cloudCall.js';
import { cloudWriteBody, short } from './cloudWrite.js';
import { isRecord, nonEmptyString, seg } from './define.js';
import { fenced, records, str } from './shape.js';

export const JOB_POLL_MS = 1_000;
export const JOB_WAIT_MAX_SEC = 45;

/** The states a job ends in. */
export const SETTLED: ReadonlySet<string> = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

/** The longest step label, error or attention kept. */
const STEP_TEXT_MAX = 500;
const WORD = /^[a-z-]{1,20}$/;

export interface JobStepView {
  id: string;
  /** Fenced as untrusted. */
  label: string;
  state: string;
  /** Fenced as untrusted; null when the step has none. */
  error: string | null;
  receiptId: string | null;
  /** Fenced as untrusted; null when the step has none. */
  attention: string | null;
}

export interface JobView {
  id: string;
  kind: string;
  state: string;
  settled: boolean;
  steps: JobStepView[];
}

const wordOf = (v: unknown): string => {
  const word = str(v) ?? '';
  return WORD.test(word) ? word : 'unknown';
};

/** `v` when it is a canonical cloud id (a lower-case UUID); null otherwise. */
const cloudIdOf = (v: unknown): string | null => (CanonicalCloudIdSchema.safeParse(v).success ? (v as string) : null);

/**
 * A job as the route answered it, read loosely; null when its id is no canonical cloud id. Kind and state:
 * /^[a-z-]{1,20}$/, else 'unknown'. A step's receipt id: a canonical cloud id, else null.
 */
export function jobOf(raw: unknown): JobView | null {
  if (!isRecord(raw)) return null;
  const id = cloudIdOf(raw.id);
  if (id === null) return null;
  const source = `cloud-job:${id}`;
  const text = (v: unknown, kind: string): string | null => {
    const said = nonEmptyString(v);
    return said === null ? null : fenced(source, kind, said, STEP_TEXT_MAX).value;
  };
  const steps = records(raw.steps).flatMap((s): JobStepView[] => {
    const stepId = nonEmptyString(s.id);
    if (stepId === null) return [];
    return [
      {
        id: stepId,
        label: text(s.label, 'job-step') ?? '',
        state: wordOf(s.state),
        error: text(s.error, 'job-step-error'),
        receiptId: cloudIdOf(s.receiptId),
        attention: text(s.attention, 'job-step-attention'),
      },
    ];
  });
  const state = wordOf(raw.state);
  return { id, kind: wordOf(raw.kind), state, settled: SETTLED.has(state), steps };
}

/**
 * One read of a job as `binding` (`GET /jobs/:id`): the view, and the job as the route answered it (for the words a
 * card shows unfenced, which the confirmation book marks itself). UPSTREAM for an answer that is no job.
 */
export async function readJob(ctx: ToolContext, jobId: string, binding: CloudBinding): Promise<{ view: JobView; raw: unknown }> {
  const raw = cloudWriteBody<unknown>(
    await ctx.client.get(`${CLOUD}/jobs/${seg(jobId)}`, undefined, { headers: bindingHeaders(binding), signal: ctx.signal }),
  );
  const view = jobOf(raw);
  if (view === null) {
    throw new ToolError('UPSTREAM', 'AASC Cloud answered with a job of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');
  }
  return { view, raw };
}

/** Waits `ms`, or less when `signal` aborts first: true when the whole wait passed. */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((done) => {
    const finish = (whole: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      done(whole);
    };
    const onAbort = (): void => finish(false);
    const timer = setTimeout(() => finish(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Polls `GET /jobs/:id` as `binding` every JOB_POLL_MS until the job settles, `waitMs` (at most 45 000) has passed, or
 * ctx.signal aborts; the last view. The wait is a deadline on ctx.now() from the start (a pause that would end past it
 * is not taken, so slow reads cannot stretch it) and a count of polls. A read that fails because the call was cancelled
 * answers the view before it.
 */
export async function waitForJob(ctx: ToolContext, jobId: string, binding: CloudBinding, waitMs: number): Promise<JobView> {
  const wait = Math.min(Math.max(0, waitMs), JOB_WAIT_MAX_SEC * 1_000);
  const deadline = ctx.now() + wait;
  const polls = Math.floor(wait / JOB_POLL_MS);
  let view = (await readJob(ctx, jobId, binding)).view;
  for (let i = 0; i < polls && !view.settled; i += 1) {
    if (ctx.now() + JOB_POLL_MS > deadline) break;
    if (!(await pause(JOB_POLL_MS, ctx.signal))) break;
    try {
      view = (await readJob(ctx, jobId, binding)).view;
    } catch (err) {
      if (ctx.signal.aborted) break;
      throw err;
    }
  }
  return view;
}

/**
 * What a job-starting tool answers: `data { ...extra, jobId, job, next: 'cloud_job_get' }`, a one-line summary, one
 * activity note (`extra`: at most 9 more AASC-made keys, then the job's id, kind and state). `extra` never overwrites
 * what the job says.
 */
export function jobStarted(job: JobView, what: string, extra: Record<string, string | number | null> = {}): ToolResult {
  return {
    data: { ...extra, jobId: job.id, job, next: 'cloud_job_get' },
    summary: `${what}: cloud job ${job.id} (${job.kind}) is ${job.state}. Follow it with cloud_job_get (waitSec up to ${JOB_WAIT_MAX_SEC}).`,
    activity: [
      {
        summary: `${what}: cloud job ${short(job.id)} (${job.kind}) ${job.state}`,
        detail: { ...extra, jobId: job.id, kind: job.kind, state: job.state },
      },
    ],
  };
}
