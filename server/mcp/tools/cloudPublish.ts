// tools/cloudPublish.ts — the cloud toolset's P6 publish and install writes (plan 2026-10-25, Task 5):
// `cloud_publish_plan` and `cloud_publish_run` send Library resources to AASC Cloud; `cloud_install_plan` and
// `cloud_install_run` bring a cloud resource into ~/.claude and ~/.codex; `cloud_install_restore` puts back what an
// install replaced. Filed under `cloud` by cloudP6.ts.
//
// Each is for a global central only (P6-4) and within the call budget (P6-15), which counts a call only once its local
// checks passed, just before its first cloud call (P6-40). A plan is the review: its tool sends nothing to the
// cloud's resources (an install plan writes nothing), names the live binding (cloudWrite.ts `liveAccount`), and is
// remembered as this central's own, with the account it was made as and, for an install, the project it was made for
// (cloudMemo.ts, P6-7). A run takes only such a plan, made within 30 minutes, and only while the same account is
// connected; anything else is refused before any card, as is a publish plan with blocked items (P6-17: never skipped
// silently) and an install with a replacement the central left undecided (P6-16). A blocked install item is sent as
// `skip`, and the card says so. A run leaves the Mac, so it is `outward` and waits for the person: its card names the
// plan, the account, the counts, memory resources, replacements and where an install writes (P6-8: ~/.claude and
// ~/.codex for global items, the project for project items; instruction files, since the plan names no other kinds),
// and lists the items; the fingerprint holds the plan's items and the decisions sent, so the recheck after the allow
// is CHANGED when the account switched (P6-6). The run posts as the account the card named. A restore takes only a
// receipt a step of this central's own job gave (P6-7).
//
// The route answers a plan's first job to every later run of it, whatever decisions come with it (P6-44). So this
// module remembers each run it started (`planRuns`): a later run with the same decisions answers that job with no card
// and sends nothing; one with other decisions is INVALID before any card.
//
// Names a person or the cloud wrote are shown on the card as text; a destination is fenced as untrusted in `data`, as
// is a reason something is blocked, and the text's rows sit in one fenced block. No refusal repeats a plan, item or
// receipt id the central sent.

import { z } from 'zod';
import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import type { InternalResponse } from '../client.js';
import { PLAN_TTL_MS, planOf, rememberJob, rememberPlan, ownsReceipt, type MemoPlan } from '../cloudMemo.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { CLOUD } from './cloudCall.js';
import { JOB_WAIT_MAX_SEC, jobOf, jobStarted } from './cloudJob.js';
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
  type ReviewedAccount,
} from './cloudWrite.js';
import { defineTool, fence, isRecord, nonEmptyString, oneLine, plain, plural, seg } from './define.js';
import { HEX16 } from './resourceFiles.js';
import { assertGlobal } from './resourceWrite.js';
import { fenced, num, records, str } from './shape.js';

const SELECTION_MAX = 50;
const NAME_MAX = 120;
const REASON_MAX = 500;
const LOCAL_PROJECT_MAX = 1_024;

const BUDGET_WORDS = 'At most 20 cloud changes a minute (BUDGET).';

const PLAN_ID = CanonicalCloudIdSchema.describe('data.planId of the plan tool you called.');

/** Only a global central changes what the account holds (P6-4). */
const globalOnly = (ctx: ToolContext): void =>
  assertGlobal(ctx, 'changes what this Mac holds in AASC Cloud', 'the cloud account, ~/.claude and ~/.codex belong to the whole Mac');

/** P6-7: a plan this central did not make, or made over 30 minutes ago, in words that never repeat its id. */
const notOwnPlan = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That is not a plan you made (or it is over 30 minutes old): make a new one.',
    'Call the plan tool again, then run the planId it answers.',
  );

const otherAccount = (): ToolError =>
  new ToolError('INVALID', 'That plan was made as another account: make a new one.', 'Call cloud_status, then the plan tool again.');

const notAJob = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a job of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

const notAPlan = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a plan of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

type RunKind = 'publish' | 'install';

/** The first checks of a run, before any cloud call or budget: global, then this central's own plan of this kind. */
function ownPlan(ctx: ToolContext, planId: string, kind: RunKind): MemoPlan {
  globalOnly(ctx);
  const plan = planOf(ctx.central.centralId, planId, kind, ctx.now());
  if (plan === null) throw notOwnPlan();
  return plan;
}

/** The reviewed account, which must be the one the plan was made as. */
async function planAccount(ctx: ToolContext, plan: MemoPlan): Promise<ReviewedAccount> {
  const account = await reviewAccount(ctx);
  if (account.key !== plan.accountKey) throw otherAccount();
  return account;
}

// ---------------------------------------------------------------------------
// A plan's runs (P6-44)
// ---------------------------------------------------------------------------

/** A run this central started of one of its plans: the job the route answered (null until it did), the decisions sent. */
interface PlanRun {
  jobId: string | null;
  /** A digest of the decisions sent (`NO_DECISIONS` for a publish). */
  decisions: string;
  /** The account it ran as (cloudWrite.ts `ReviewedAccount.key`): a run as another account is no earlier run (RR-1). */
  accountKey: string;
  at: number;
}

/** What a publish run sends: no decisions. */
const NO_DECISIONS = 'none';

/** centralId → `${kind}:${planId}` → its run, replaced on every change. A run counts for PLAN_TTL_MS, as its plan does. */
const planRuns = new Map<string, ReadonlyMap<string, PlanRun>>();

const runKey = (kind: RunKind, planId: string): string => `${kind}:${planId}`;

/** Forgets every central's plan runs (tests; an AASC restart does the same). */
export function resetPlanRuns(): void {
  planRuns.clear();
}

/** This central's run of that plan, started within PLAN_TTL_MS; null otherwise. */
function planRunOf(ctx: ToolContext, kind: RunKind, planId: string): PlanRun | null {
  const found = planRuns.get(ctx.central.centralId)?.get(runKey(kind, planId));
  return found !== undefined && ctx.now() - found.at <= PLAN_TTL_MS ? found : null;
}

/**
 * Records this central's run of that plan (null forgets it). Like the memo (cloudMemo.ts), every write forgets the runs
 * past PLAN_TTL_MS of every central, so a central that never calls again holds nothing here for long.
 */
function recordPlanRun(ctx: ToolContext, kind: RunKind, planId: string, run: PlanRun | null): void {
  const { centralId } = ctx.central;
  const now = ctx.now();
  const key = runKey(kind, planId);
  const live = (runs: ReadonlyMap<string, PlanRun>): Array<[string, PlanRun]> => [...runs.entries()].filter(([, r]) => now - r.at <= PLAN_TTL_MS);
  for (const [other, runs] of [...planRuns.entries()]) {
    if (other === centralId) continue;
    const kept = live(runs);
    if (kept.length === 0) planRuns.delete(other);
    else if (kept.length < runs.size) planRuns.set(other, new Map(kept));
  }
  const own = live(planRuns.get(centralId) ?? new Map<string, PlanRun>()).filter(([k]) => k !== key);
  const next = run === null ? own : [...own, [key, run] as [string, PlanRun]];
  if (next.length === 0) planRuns.delete(centralId);
  else planRuns.set(centralId, new Map(next));
}

/**
 * Before a run's card, from what this central holds alone: the job of its earlier run of the plan as the plan's account
 * with the same decisions (null when there is none, when that run was as another account, or when its post had no
 * answer yet: then the card asks again). Other decisions are INVALID, since the route would answer the first job
 * whatever is sent. The caller still checks the live account (`planAccount`) before it answers that job (RR-1).
 */
function earlierJob(ctx: ToolContext, kind: RunKind, memo: MemoPlan, decisions: string): string | null {
  const earlier = planRunOf(ctx, kind, memo.planId);
  if (earlier === null || earlier.accountKey !== memo.accountKey) return null;
  if (earlier.decisions !== decisions) {
    throw new ToolError(
      'INVALID',
      'That plan already ran with other decisions: its job keeps the first ones.',
      'Follow its job with cloud_job_get, or make a new plan to decide again.',
      earlier.jobId === null ? undefined : { jobId: earlier.jobId },
    );
  }
  return earlier.jobId;
}

/** A run that needed no card: the job this central's earlier run of the plan started. Nothing is sent. */
function alreadyRunning(jobId: string, planId: string): ToolResult {
  return {
    data: { jobId, planId, next: 'cloud_job_get' },
    summary: `That plan already runs as cloud job ${jobId}: nothing was sent again. Follow it with cloud_job_get (waitSec up to ${JOB_WAIT_MAX_SEC}).`,
    activity: [{ summary: `Answered cloud job ${short(jobId)} again for plan ${short(planId)}`, detail: { jobId, planId } }],
  };
}

/**
 * A run the person allowed: recorded before the post, so a post that ends without an answer still holds the plan to
 * these decisions (the route may have started the job); forgotten when the route refuses it (a 4xx: nothing started);
 * then the job, remembered with its receipts as this central's own, answered with `next: 'cloud_job_get'`.
 */
async function startRun(
  ctx: ToolContext,
  run: { kind: RunKind; planId: string; decisions: string; what: string },
  account: ReviewedAccount,
  send: () => Promise<InternalResponse<unknown>>,
): Promise<ToolResult> {
  recordPlanRun(ctx, run.kind, run.planId, { jobId: null, decisions: run.decisions, accountKey: account.key, at: ctx.now() });
  const answer = await send();
  if (!answer.ok && answer.status >= 400 && answer.status < 500) recordPlanRun(ctx, run.kind, run.planId, null);
  const job = jobOf(cloudWriteBody<unknown>(answer));
  if (job === null) throw notAJob();
  recordPlanRun(ctx, run.kind, run.planId, { jobId: job.id, decisions: run.decisions, accountKey: account.key, at: ctx.now() });
  rememberJob(ctx.central.centralId, job, account.key, ctx.now());
  return jobStarted(job, run.what, { planId: run.planId });
}

/**
 * What `confirm` found it needs no card for, on the call's context (one per call, like cloudWrite.ts `reviewed`): the
 * earlier job it checked against the plan and the live account. `run` answers only this, so the account check stays
 * in `confirm` and `run` reads nothing live.
 */
const noCard = new WeakMap<ToolContext, { key: string; decisions: string; jobId: string }>();

/** `confirm`'s answer for a call that needs no card: recorded on the context for its `run`. */
function answerWithoutCard(ctx: ToolContext, kind: RunKind, planId: string, decisions: string, jobId: string): null {
  noCard.set(ctx, { key: runKey(kind, planId), decisions, jobId });
  return null;
}

/**
 * For `run` of a call that needed no card (nobody allowed it): the earlier job its own `confirm` checked (P6-44, RR-1),
 * nothing sent. Null otherwise: the run then acts only as what the person allowed.
 */
function answeredAgain(ctx: ToolContext, kind: RunKind, planId: string, decisions: string): ToolResult | null {
  if (ctx.allowedByPerson()) return null;
  const found = noCard.get(ctx);
  return found !== undefined && found.key === runKey(kind, planId) && found.decisions === decisions ? alreadyRunning(found.jobId, planId) : null;
}

// ---------------------------------------------------------------------------
// The publish plan, as its route answered it
// ---------------------------------------------------------------------------

interface PublishItem {
  catalogId: string;
  name: string;
  agent: string;
  kind: string;
  scope: string;
  memory: boolean;
  baseVersion: number | null;
  files: number;
  sourceDigest: string;
}

interface PublishPlan {
  id: string;
  items: PublishItem[];
  /** Catalog ids, and why each is blocked (cloud or person text). */
  blocked: Array<{ catalogId: string; reason: string }>;
}

function publishPlanOf(raw: unknown): PublishPlan | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id);
  if (id === null) return null;
  const items = records(raw.items).flatMap((i): PublishItem[] => {
    const catalogId = nonEmptyString(i.catalogId);
    if (catalogId === null) return [];
    const m = isRecord(i.manifest) ? i.manifest : {};
    const kind = str(m.kind) ?? '';
    return [
      {
        catalogId,
        name: str(m.name) ?? '',
        agent: str(m.agent) ?? '',
        kind,
        scope: str(m.scope) ?? '',
        memory: kind === 'memory',
        baseVersion: num(i.baseVersion),
        files: records(m.files).length,
        sourceDigest: str(i.sourceDigest) ?? '',
      },
    ];
  });
  const blocked = records(raw.blocked).flatMap((b) => {
    const catalogId = nonEmptyString(b.catalogId);
    return catalogId === null ? [] : [{ catalogId, reason: str(b.reason) ?? '' }];
  });
  return { id, items, blocked };
}

// ---------------------------------------------------------------------------
// cloud_publish_plan
// ---------------------------------------------------------------------------

const cloudPublishPlan = defineTool({
  name: 'cloud_publish_plan',
  toolset: 'cloud',
  title: 'Plan a cloud publish',
  description:
    'Reviews publishing Library resources (ids from resource_list, 1 to 50) to AASC Cloud, as the person’s Save to ' +
    'cloud review does: for each, its catalog id, name, agent, kind, scope, whether it is memory, the cloud version it ' +
    'builds on (null for new) and its file count, and what is blocked, with why (fenced as untrusted data). Nothing is ' +
    'sent to the cloud’s resources yet: run data.planId with cloud_publish_run, which asks the person first. A plan ' +
    'with blocked items cannot be run (data.next is null): fix them, then plan again. A plan lasts 30 minutes, for you ' +
    `alone. ${CLOUD_RULES.global} ${BUDGET_WORDS}`,
  risk: 'write',
  phase: 6,
  input: {
    resourceIds: z
      .array(z.string().regex(HEX16))
      .min(1)
      .max(SELECTION_MAX)
      .describe('Library resource ids as resource_list shows them (16 hex characters), 1 to 50.'),
  },
  async run(args, ctx) {
    globalOnly(ctx);
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const selection = [...new Set(args.resourceIds)].map((resourceId) => ({ resourceId, include: true }));
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/publish-plans`, { selection }, binding));
    const plan = publishPlanOf(body);
    if (plan === null) throw notAPlan();
    rememberPlan(ctx.central.centralId, { kind: 'publish', planId: plan.id, accountKey: accountKeyOf(binding), plan: body, at: ctx.now() });
    const data = {
      planId: plan.id,
      items: plan.items.map(({ sourceDigest: _digest, ...item }) => item),
      blocked: plan.blocked.map((b) => ({ catalogId: b.catalogId, reason: fenced(`catalog:${b.catalogId}`, 'publish-blocked', b.reason, REASON_MAX).value })),
      next: plan.blocked.length > 0 || plan.items.length === 0 ? null : 'cloud_publish_run',
    };
    const rows = [
      ...plan.items.map((i) => `${i.agent} ${i.kind} ${oneLine(i.name, NAME_MAX)} · ${i.baseVersion === null ? 'new' : `v${i.baseVersion} → v${i.baseVersion + 1}`} · ${plural(i.files, 'file')}${i.memory ? ' · memory' : ''}`),
      ...plan.blocked.map((b) => `blocked ${b.catalogId}: ${oneLine(b.reason, 200)}`),
    ];
    const lead =
      `Publish plan ${plan.id}: ${plural(plan.items.length, 'resource')}${plan.blocked.length === 0 ? '' : `, ${plan.blocked.length} blocked`}. ` +
      (data.next === null ? 'It cannot be run as it is.' : 'Nothing is published until cloud_publish_run, which asks the person.');
    return {
      data,
      summary: rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-publish-plan', rows.join('\n'))}`,
      activity: [{ summary: `Planned a cloud publish ${short(plan.id)}: ${plan.items.length} items, ${plan.blocked.length} blocked`, detail: { planId: plan.id, items: plan.items.length, blocked: plan.blocked.length } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_publish_run
// ---------------------------------------------------------------------------

/** One card line per item: agent, kind, name (as written), the version it makes, its files. */
const publishRow = (i: PublishItem): string =>
  `- ${oneLine(i.agent, 20)} ${oneLine(i.kind, 20)} ${oneLine(i.name, NAME_MAX)}: ${i.baseVersion === null ? 'new' : `v${i.baseVersion} → v${i.baseVersion + 1}`}, ${plural(i.files, 'file')}`;

const cloudPublishRun = defineTool({
  name: 'cloud_publish_run',
  toolset: 'cloud',
  title: 'Publish to AASC Cloud',
  description:
    'Publishes what a cloud_publish_plan reviewed: each resource’s files go to AASC Cloud as a new version. ' +
    `${CLOUD_RULES.ownPlan} Another is NOT_FOUND; a plan made as another account, or with blocked items, is INVALID ` +
    `(data.blocked). ${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card shows the plan, the account, how many ` +
    'resources and which are memory, and lists them; it runs only as that account, and if the account changes before ' +
    `the person allows it nothing runs (call it again). ${CLOUD_RULES.job} Running the same plan again answers the same ` +
    `job with no card; nothing is sent again. ${BUDGET_WORDS}`,
  risk: 'outward',
  phase: 6,
  input: { planId: PLAN_ID },
  async confirm(args, ctx): Promise<ConfirmAsk | null> {
    noCard.delete(ctx);
    const memo = ownPlan(ctx, args.planId, 'publish');
    const plan = publishPlanOf(memo.plan);
    if (plan === null) throw notOwnPlan();
    if (plan.blocked.length > 0) {
      throw new ToolError(
        'INVALID',
        'That plan has blocked resources: AASC never publishes past them.',
        'resource_get shows each one; fix them, then make a new plan with cloud_publish_plan.',
        { blocked: plan.blocked.map((b) => b.catalogId).join(','), blockedCount: plan.blocked.length },
      );
    }
    if (plan.items.length === 0) throw new ToolError('INVALID', 'That plan has nothing to publish.', 'Make a new plan with the resources to publish.');
    const earlier = earlierJob(ctx, 'publish', memo, NO_DECISIONS);
    spendCloudCall(ctx);
    const account = await planAccount(ctx, memo);
    if (earlier !== null) return answerWithoutCard(ctx, 'publish', memo.planId, NO_DECISIONS, earlier);
    const memory = plan.items.filter((i) => i.memory).length;
    return {
      summary: `AASC Cloud: publish ${plural(plan.items.length, 'resource')} (plan ${short(plan.id)}) as ${account.label}${memory > 0 ? `, ${plural(memory, 'memory resource')}` : ''}`,
      detail: cardDetail(plan.items.map(publishRow)),
      fingerprint: `publish:${plan.id}:${account.key}:${cardDigest(plan.items.map((i) => [i.catalogId, i.sourceDigest, i.baseVersion]))}`,
    };
  },
  async run(args, ctx) {
    const again = answeredAgain(ctx, 'publish', args.planId, NO_DECISIONS);
    if (again !== null) return again;
    const account = approvedAccount(ctx);
    const run = { kind: 'publish', planId: args.planId, decisions: NO_DECISIONS, what: 'Publishing to AASC Cloud' } as const;
    return startRun(ctx, run, account, () => cloudSend(ctx, 'post', `${CLOUD}/publish-plans/${seg(args.planId)}/run`, {}, account.binding));
  },
});

// ---------------------------------------------------------------------------
// The install plan, as its route answered it
// ---------------------------------------------------------------------------

const ACTIONS: ReadonlySet<string> = new Set(['add', 'replace', 'same', 'blocked']);
const FILE_CHANGES = ['add', 'change', 'remove', 'same'] as const;

type Decision = 'keep-local' | 'replace-with-backup' | 'skip';

interface InstallItem {
  id: string;
  resourceId: string;
  version: number | null;
  destination: string;
  action: string;
  reason: string;
  files: Record<(typeof FILE_CHANGES)[number], number>;
}

function installItemsOf(raw: unknown): InstallItem[] | null {
  if (!isRecord(raw) || nonEmptyString(raw.id) === null) return null;
  return records(raw.items).flatMap((i): InstallItem[] => {
    const id = nonEmptyString(i.id);
    if (id === null) return [];
    const action = str(i.action) ?? '';
    const changes = records(i.files).map((f) => str(f.change));
    const files = Object.fromEntries(FILE_CHANGES.map((c) => [c, changes.filter((x) => x === c).length])) as InstallItem['files'];
    return [
      {
        id,
        resourceId: str(i.resourceId) ?? '',
        version: num(i.version),
        destination: str(i.destinationLabel) ?? '',
        action: ACTIONS.has(action) ? action : 'unknown',
        reason: str(i.reason) ?? '',
        files,
      },
    ];
  });
}

/** The route's destination label, `${agent} ${scope} / ${path}` (resourcePackages/adapters.ts): its scope. */
const LABEL = /^(?:claude|codex|shared) (global|project) \/ /;

/** A project item goes into the project; a global one, or one whose label does not say, into ~/.claude and ~/.codex. */
const inProject = (i: InstallItem): boolean => LABEL.exec(i.destination)?.[1] === 'project';

/** The instruction files a destination can end in (adapters.ts): the one kind a destination tells. */
const INSTRUCTION_FILES: ReadonlySet<string> = new Set(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md']);

const isInstruction = (i: InstallItem): boolean => INSTRUCTION_FILES.has(i.destination.split('/').pop()?.trim() ?? '');

/** The longest destination kept, in data and in a row. */
const DESTINATION_MAX = 200;

/** "1 change, 1 remove, 1 same": the file changes an item makes, nonzero only. */
const fileWords = (i: InstallItem): string =>
  FILE_CHANGES.filter((c) => i.files[c] > 0)
    .map((c) => `${i.files[c]} ${c}`)
    .join(', ');

// ---------------------------------------------------------------------------
// cloud_install_plan
// ---------------------------------------------------------------------------

const cloudInstallPlan = defineTool({
  name: 'cloud_install_plan',
  toolset: 'cloud',
  title: 'Plan a cloud install',
  description:
    'Reviews installing one version of a cloud resource (ids and versions from cloud_resource_list) and what it depends ' +
    'on into ~/.claude and ~/.codex, or into a project (localProjectId from cloud_project_local): for each item its ' +
    'destination, its action (add, replace, same, blocked, with why it is blocked fenced as untrusted data) and its file ' +
    'changes. Nothing is written yet: run data.planId with cloud_install_run, which asks the person first. Each item ' +
    'in data.needsDecision replaces a local copy and needs a decision there (keep-local, replace-with-backup or skip); ' +
    `a blocked item is skipped. A plan lasts 30 minutes, for you alone. ${CLOUD_RULES.global} ${BUDGET_WORDS}`,
  risk: 'write',
  phase: 6,
  input: {
    resourceId: CanonicalCloudIdSchema.describe('A cloud resource id, as cloud_resource_list shows it.'),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).describe('The version to install.'),
    localProjectId: z.string().min(1).max(LOCAL_PROJECT_MAX).optional().describe('Install into this project (data.localProjectId of cloud_project_local).'),
  },
  async run(args, ctx) {
    globalOnly(ctx);
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const request = { resourceId: args.resourceId, version: args.version, ...(args.localProjectId === undefined ? {} : { localProjectId: args.localProjectId }) };
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/install-plans`, request, binding));
    const items = installItemsOf(body);
    const planId = isRecord(body) ? nonEmptyString(body.id) : null;
    if (items === null || planId === null || !isRecord(body)) throw notAPlan();
    // The plan as the route answered it, with the project it was made for: the run's card says where it writes.
    const remembered = { ...body, localProjectId: args.localProjectId ?? null };
    rememberPlan(ctx.central.centralId, { kind: 'install', planId, accountKey: accountKeyOf(binding), plan: remembered, at: ctx.now() });
    const needsDecision = items.filter((i) => i.action === 'replace').map((i) => i.id);
    const blocked = items.filter((i) => i.action === 'blocked').map((i) => i.id);
    const data = {
      planId,
      items: items.map((i) => ({
        id: i.id,
        resourceId: i.resourceId,
        version: i.version,
        destination: fenced(`cloud-install:${i.id}`, 'install-destination', i.destination, DESTINATION_MAX).value,
        action: i.action,
        reason: i.reason === '' ? null : fenced(`cloud-install:${i.id}`, 'install-blocked', i.reason, REASON_MAX).value,
        files: i.files,
      })),
      needsDecision,
      blocked,
      next: 'cloud_install_run',
    };
    const rows = items.map((i) => `${i.action} · ${oneLine(i.destination, DESTINATION_MAX)} (v${i.version ?? '–'}) · ${fileWords(i) || 'no files'}${i.reason === '' ? '' : ` · ${oneLine(i.reason, 200)}`}`);
    const lead =
      `Install plan ${planId}: ${plural(items.length, 'item')}` +
      `${needsDecision.length === 0 ? '' : `, ${needsDecision.length} needing a decision`}${blocked.length === 0 ? '' : `, ${blocked.length} blocked`}. ` +
      'Nothing is written until cloud_install_run, which asks the person.';
    return {
      data,
      summary: rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-install-plan', rows.join('\n'))}`,
      activity: [
        {
          summary: `Planned a cloud install ${short(planId)}: ${items.length} items`,
          detail: { planId, items: items.length, needsDecision: needsDecision.length, blocked: blocked.length },
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_install_run
// ---------------------------------------------------------------------------

interface InstallReview {
  items: InstallItem[];
  /** What is sent: the central's decisions for known items, and `skip` for each blocked one. */
  sent: Record<string, Decision>;
  /** The decisions sent, sorted by item id: what the fingerprint and the plan's run (P6-44) carry. */
  sorted: Array<[string, Decision]>;
  /** The project the plan was made for (cloud_install_plan's localProjectId); null for none. */
  localProjectId: string | null;
}

/**
 * P6-16, before any card: every decision is for an item of the plan; keep-local and replace-with-backup only for a
 * replacement, skip for any item (RR-2: cloudProjectGit.ts `checkDecisions` refuses the same, in the same words); every
 * replacement has one; a blocked item is sent as `skip`. INVALID otherwise, in words that never repeat an id the
 * central sent.
 */
function installReview(memo: MemoPlan, decisions: Readonly<Record<string, Decision>>): InstallReview {
  const items = installItemsOf(memo.plan);
  if (items === null) throw notOwnPlan();
  const byId = new Map(items.map((i) => [i.id, i]));
  if (Object.keys(decisions).some((id) => !byId.has(id))) {
    throw new ToolError('INVALID', 'A decision names an item that is not in that plan.', 'Use the item ids of the plan’s data.items.');
  }
  if (Object.entries(decisions).some(([id, d]) => d !== 'skip' && byId.get(id)?.action !== 'replace')) {
    throw new ToolError(
      'INVALID',
      'Only an item that would replace a local copy takes keep-local or replace-with-backup.',
      'Pass those for the ids in data.needsDecision only; any other item can only be skipped.',
    );
  }
  const undecided = items.filter((i) => i.action === 'replace' && decisions[i.id] === undefined).map((i) => i.id);
  if (undecided.length > 0) {
    throw new ToolError(
      'INVALID',
      'Each item that replaces a local copy needs a decision: keep-local, replace-with-backup or skip.',
      'Pass decisions for each id in data.needsDecision.',
      { needsDecision: undecided.join(','), needsDecisionCount: undecided.length },
    );
  }
  const sent = Object.fromEntries(
    items.flatMap((i): Array<[string, Decision]> => {
      if (i.action === 'blocked') return [[i.id, 'skip']];
      const d = decisions[i.id];
      return d === undefined ? [] : [[i.id, d]];
    }),
  );
  const sorted = Object.entries(sent).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const localProjectId = isRecord(memo.plan) ? nonEmptyString(memo.plan.localProjectId) : null;
  return { items, sent, sorted, localProjectId };
}

/** Is anything of this item written? Not when it is the same already, blocked, skipped or kept (main jobRunners.ts). */
const writesItem = (i: InstallItem, sent: Readonly<Record<string, Decision>>): boolean =>
  i.action !== 'same' && i.action !== 'blocked' && sent[i.id] !== 'skip' && sent[i.id] !== 'keep-local';

interface InstallCounts {
  /** The items it writes. */
  installs: InstallItem[];
  /** Replacements the central chose to back up. */
  replaces: number;
  /** Items skipped or kept (a blocked one is skipped). */
  skipped: number;
}

function installCounts({ items, sent }: InstallReview): InstallCounts {
  return {
    installs: items.filter((i) => writesItem(i, sent)),
    replaces: items.filter((i) => i.action === 'replace' && sent[i.id] === 'replace-with-backup').length,
    skipped: items.filter((i) => sent[i.id] === 'skip' || sent[i.id] === 'keep-local').length,
  };
}

/** Where the items it writes go: ~/.claude and ~/.codex for global items, the project for project items. */
function placesWords(installs: readonly InstallItem[], localProjectId: string | null): string {
  const project = localProjectId === null ? 'its mapped project checkout' : `project ${plain(short(localProjectId), 8)}`;
  const places = [installs.some((i) => !inProject(i)) ? '~/.claude / ~/.codex' : null, installs.some(inProject) ? project : null];
  return places.filter((p): p is string => p !== null).join(' and ');
}

/** The card's first detail line (B-7): the plan names no kinds, but a destination can tell an instruction file. */
const KINDS_NOTE = 'Kinds are not shown: a destination ending in CLAUDE.md or AGENTS.md is an instruction file.';

/** The line after it when something is skipped, kept or blocked: what needs it is not installed (main jobRunners.ts). */
const LEFT_NOTE = 'An item that needs a skipped, kept or blocked one is left unchanged.';

/**
 * The install card: how many it writes, where (P6-8), how many it replaces with a backup, skips, and how many are
 * instruction files. About 240 characters at most with the longest account label and project, so every clause stays.
 */
function installCard(memo: MemoPlan, review: InstallReview, account: ReviewedAccount): ConfirmAsk {
  const { items, sent, sorted, localProjectId } = review;
  const { installs, replaces, skipped } = installCounts(review);
  const instructions = installs.filter(isInstruction).length;
  return {
    summary:
      `AASC Cloud: install ${plural(installs.length, 'resource')} (plan ${short(memo.planId)}) as ${account.label}: ` +
      `writes into ${placesWords(installs, localProjectId)}${replaces > 0 ? `; replaces ${replaces} with a backup` : ''}` +
      `${skipped > 0 ? `; ${skipped} skipped` : ''}${instructions > 0 ? `; ${plural(instructions, 'instruction file')}` : ''}`,
    detail: cardDetail([KINDS_NOTE, ...(skipped > 0 ? [LEFT_NOTE] : []), ...items.map((i) => installRow(i, sent))]),
    fingerprint: `install:${memo.planId}:${account.key}:${cardDigest({ items: items.map((i) => [i.id, i.action, i.version]), decisions: sorted })}`,
  };
}

/** What happens to an item, as the card says it. */
function decisionWord(i: InstallItem, sent: Readonly<Record<string, Decision>>): string {
  if (i.action === 'blocked') return 'skip (blocked)';
  const d = sent[i.id];
  if (d !== undefined) return d;
  return i.action === 'same' ? 'unchanged' : 'install';
}

/** One card line per item: action, decision, destination (as written), version, file changes, why it is blocked. */
function installRow(i: InstallItem, sent: Readonly<Record<string, Decision>>): string {
  const files = fileWords(i);
  return (
    `- ${plain(i.action, 20)}, ${decisionWord(i, sent)}: ${oneLine(i.destination, DESTINATION_MAX)} (v${i.version ?? '–'})` +
    `${files === '' ? '' : ` · files: ${files}`}${i.reason === '' ? '' : `: ${oneLine(i.reason, 200)}`}`
  );
}

const DECISION = z.enum(['keep-local', 'replace-with-backup', 'skip']);

const cloudInstallRun = defineTool({
  name: 'cloud_install_run',
  toolset: 'cloud',
  title: 'Install from AASC Cloud',
  description:
    'Installs what a cloud_install_plan reviewed into ~/.claude and ~/.codex (or the project). Each item in the plan’s ' +
    'data.needsDecision replaces a local copy: pass decisions { itemId: keep-local | replace-with-backup | skip } for ' +
    'every one, or it is INVALID before any card (data.needsDecision); add and same items need none, and a blocked ' +
    'item is skipped. Any other item takes only skip: keep-local or replace-with-backup on it is INVALID. keep-local leaves this Mac’s copy as it is and installs nothing of that item; an item that needs ' +
    `a skipped, kept or blocked one is left unchanged. ${CLOUD_RULES.ownPlan} Another is NOT_FOUND; a plan made as ` +
    `another account is INVALID. ${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card shows the plan, the account, how ` +
    'many it installs and where (~/.claude and ~/.codex for global items, the project for project items), replaces ' +
    'with a backup and skips, and lists each item with its decision. The card does not show kinds: a destination ' +
    'ending in CLAUDE.md or AGENTS.md is an instruction file. It runs only as that account, and if the account ' +
    `changes before the person allows it nothing runs (call it again). ${CLOUD_RULES.job} A step’s receiptId is what ` +
    'cloud_install_restore takes. Running the same plan again answers the same job with no card; with other decisions ' +
    `it is INVALID: make a new plan to decide again. ${BUDGET_WORDS}`,
  risk: 'outward',
  phase: 6,
  input: {
    planId: PLAN_ID,
    decisions: z
      .record(CanonicalCloudIdSchema, DECISION)
      .optional()
      .describe('For each item that replaces a local copy (data.needsDecision): keep-local, replace-with-backup or skip; any other item: skip only.'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk | null> {
    noCard.delete(ctx);
    const memo = ownPlan(ctx, args.planId, 'install');
    const review = installReview(memo, args.decisions ?? {});
    if (installCounts(review).installs.length === 0) {
      throw new ToolError('INVALID', 'Nothing would be installed.', 'Every item is the same already, skipped, kept or blocked: make a new plan, or decide otherwise.');
    }
    const decisions = cardDigest(review.sorted);
    const earlier = earlierJob(ctx, 'install', memo, decisions);
    spendCloudCall(ctx);
    const account = await planAccount(ctx, memo);
    if (earlier !== null) return answerWithoutCard(ctx, 'install', memo.planId, decisions, earlier);
    return installCard(memo, review, account);
  },
  async run(args, ctx) {
    const memo = ownPlan(ctx, args.planId, 'install');
    const { sent, sorted } = installReview(memo, args.decisions ?? {});
    const decisions = cardDigest(sorted);
    const again = answeredAgain(ctx, 'install', memo.planId, decisions);
    if (again !== null) return again;
    const account = approvedAccount(ctx);
    const run = { kind: 'install', planId: memo.planId, decisions, what: 'Installing from AASC Cloud' } as const;
    return startRun(ctx, run, account, () =>
      cloudSend(ctx, 'post', `${CLOUD}/install-plans/${seg(memo.planId)}/run`, { decisions: sent }, account.binding),
    );
  },
});

// ---------------------------------------------------------------------------
// cloud_install_restore
// ---------------------------------------------------------------------------

const cloudInstallRestore = defineTool({
  name: 'cloud_install_restore',
  toolset: 'cloud',
  title: 'Restore what an install replaced',
  description:
    'Puts back the local copy an install replaced with a backup, from the step’s receiptId (cloud_job_get shows it). ' +
    `${CLOUD_RULES.ownJob} A receipt from any other job is NOT_FOUND. It answers the receipt: its state and whether it ` +
    `can still be restored. ${CLOUD_RULES.global} ${BUDGET_WORDS}`,
  risk: 'write',
  phase: 6,
  input: { installId: CanonicalCloudIdSchema.describe('A step’s receiptId from a job you started (cloud_job_get).') },
  async run(args, ctx) {
    globalOnly(ctx);
    if (!ownsReceipt(ctx.central.centralId, args.installId, ctx.now())) {
      throw new ToolError(
        'NOT_FOUND',
        'That is not a receipt from a job you started (or it is over 24 hours old).',
        'Only a receipt a step of your own install job gave can be restored; cloud_job_get shows a job’s receipts.',
      );
    }
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/installs/${seg(args.installId)}/restore`, {}, binding));
    const receipt = isRecord(body) ? body : {};
    const data = {
      id: nonEmptyString(receipt.id) ?? args.installId,
      resourceId: nonEmptyString(receipt.resourceId),
      version: num(receipt.version),
      state: plain(str(receipt.state) ?? 'unknown', 20),
      canRestore: receipt.canRestore === true,
    };
    return {
      data,
      summary: `Restored install ${data.id}: it is ${data.state} now${data.canRestore ? ', and can be restored again' : ''}.`,
      activity: [{ summary: `Restored cloud install ${short(data.id)}: ${data.state}`, detail: { installId: data.id, state: data.state } }],
    };
  },
});

export const cloudPublishTools: readonly ToolDef[] = [cloudPublishPlan, cloudPublishRun, cloudInstallPlan, cloudInstallRun, cloudInstallRestore];
