// tools/cloudSync.ts — the cloud toolset's P6 sync writes (plan 2026-10-25, Task 4): `cloud_recheck` asks AASC Cloud
// again where this Mac stands; `cloud_sync_now` uploads what changed here and downloads what changed in the cloud;
// `cloud_sync_set` stops or resumes syncing one resource on this Mac. Filed under `cloud` by cloudP6.ts.
//
// Each changes what the account or ~/.claude and ~/.codex hold, so each is for a global central only (P6-4) and within
// the call budget (P6-15). A sync leaves the Mac and writes into ~/.claude and ~/.codex, so it is `outward`: its card is
// made from the sync list read as the account the person reviews (cloudWrite.ts `reviewAccount`, P6-6), and says what
// would move by the route's own rules (main server/cloud/resourceJobs.ts `syncNow`): a change here or a conflict chosen
// "mine" goes up; a newer cloud copy, a resource only in the cloud or a conflict chosen "cloud" comes down; memory only
// when the central listed it; nothing stopped, removed, blocked or outside `only`. A download over a copy on this Mac
// replaces it with a backup (main syncStatus.ts `syncInstallDecisions`), and the card counts those. What the moving
// items depend on moves with them (new dependencies go up, pinned versions come down), which the sync list cannot
// show item by item: the card and the description say so in fixed words. An upload sends the copy on disk when the
// person allows (the route builds it then), so the card cannot pin its content: it says that too. The fingerprint
// holds each moving item's state and versions, so a list that moved after the allow runs nothing (CHANGED). The run
// posts exactly what the central asked as the account the card named, and answers each job's steps (fenced). A sync
// is not idempotent (it plans afresh each call): its description says to read the sync list again before repeating a
// call that ended without an answer (P6-18).
//
// A stop or a resume is a mark on this Mac; the route's `remove` (every cloud version, on every device) is never sent
// (P6-3: the schema has no such action). The sync routes exist only in newer builds of AASC (P6-11): elsewhere each
// tool answers UNAVAILABLE before any card. Names a person or the cloud wrote are shown on the card as text; a reason
// the route skipped something is fenced as untrusted.

import { z } from 'zod';
import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import { rememberJob } from '../cloudMemo.js';
import type { ConfirmAsk, ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { bindingHeaders, CLOUD, readStatus, type CloudBinding, type CloudState } from './cloudCall.js';
import { jobOf, type JobView } from './cloudJob.js';
import {
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
import { defineTool, fence, isRecord, nonEmptyString, oneLine, plural } from './define.js';
import { assertGlobal } from './resourceWrite.js';
import { fenced, num, records, str } from './shape.js';

const IDS_MAX = 200;
const NAME_MAX = 120;
const REASON_MAX = 500;

const RESOURCE = CanonicalCloudIdSchema.describe('A cloud resource id, as cloud_sync_status shows it.');

/** Only a global central changes what the account holds (P6-4). */
const globalOnly = (ctx: ToolContext): void =>
  assertGlobal(ctx, 'changes what this Mac holds in AASC Cloud', 'the cloud account, ~/.claude and ~/.codex belong to the whole Mac');

const BUDGET_WORDS = 'At most 20 cloud changes a minute (BUDGET).';

// ---------------------------------------------------------------------------
// cloud_recheck
// ---------------------------------------------------------------------------

const STATE_WORDS: Readonly<Record<CloudState, string>> = {
  connected: 'connected',
  disconnected: 'not connected',
  offline: 'signed in, but the backend is not answering (offline)',
  revoked: 'no longer accepted (revoked): it has to be reconnected',
  unknown: 'in a state this build does not know',
};

const cloudRecheck = defineTool({
  name: 'cloud_recheck',
  toolset: 'cloud',
  title: 'Recheck AASC Cloud',
  description:
    'Asks AASC Cloud again whether it still accepts this Mac, as the person’s Recheck button does, and answers the ' +
    'connection as cloud_status does: state, connected, the connection and the last error (fenced as untrusted data). ' +
    `Nothing is synced, published or installed. ${CLOUD_RULES.global} ${BUDGET_WORDS}`,
  risk: 'write',
  phase: 6,
  input: {},
  async run(_args, ctx) {
    globalOnly(ctx);
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const status = readStatus(cloudWriteBody(await cloudSend(ctx, 'post', `${CLOUD}/recheck`, {}, binding)));
    const { connection } = status;
    const data = {
      state: status.state,
      connected: status.state === 'connected' && connection !== null,
      connection,
      lastError: status.lastError === null ? null : fenced('aasc', 'cloud-error', status.lastError, REASON_MAX).value,
    };
    const lead = `Rechecked AASC Cloud: this Mac is ${STATE_WORDS[status.state]}.`;
    return {
      data,
      summary: status.lastError === null ? lead : `${lead}\n${fence('aasc', 'cloud', `last error: ${oneLine(status.lastError, 200)}`)}`,
      activity: [{ summary: `Rechecked AASC Cloud: ${status.state}`, detail: { state: status.state } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_sync_now
// ---------------------------------------------------------------------------

const MISSING_SYNC = { what: 'This build of AASC cannot sync.', hint: 'cloud_resource_list and cloud_publish_plan work here.' };

interface SyncItem {
  resourceId: string;
  name: string;
  agent: string;
  kind: string;
  state: string;
  cloudVersion: number | null;
  syncedVersion: number | null;
  memory: boolean;
  /** This Mac holds a copy (the sync list names its catalog id): a download replaces it with a backup. */
  local: boolean;
}

function syncItemOf(raw: Record<string, unknown>): SyncItem | null {
  const resourceId = nonEmptyString(raw.resourceId);
  if (resourceId === null) return null;
  return {
    resourceId,
    name: str(raw.name) ?? '',
    agent: str(raw.agent) ?? '',
    kind: str(raw.kind) ?? '',
    state: str(raw.state) ?? '',
    cloudVersion: num(raw.cloudVersion),
    syncedVersion: num(raw.syncedVersion),
    memory: raw.memory === true,
    local: nonEmptyString(raw.catalogId) !== null,
  };
}

type Choice = 'mine' | 'cloud';

interface SyncArgs {
  only?: string[];
  choices?: Record<string, Choice>;
  memory?: string[];
}

interface Moving {
  item: SyncItem;
  direction: 'up' | 'down';
  /** For a conflict: what the central chose. */
  choice: Choice | null;
}

/** Why an item stays, by the route's own order of checks (main resourceJobs.ts `syncNow`). */
type Held = 'synced' | 'stopped' | 'removed' | 'notAsked' | 'blocked' | 'memoryNotListed' | 'conflictWithoutChoice' | 'unknown';

/** Where one item goes in a sync with these arguments: up, down, or why it stays. */
function placeOf(item: SyncItem, args: SyncArgs, only: ReadonlySet<string> | null, memory: ReadonlySet<string>): Moving | Held {
  if (item.state === 'synced') return 'synced';
  if (item.state === 'stopped' || item.state === 'removed') return item.state;
  if (only !== null && !only.has(item.resourceId)) return 'notAsked';
  if (item.state === 'blocked') return 'blocked';
  if (item.memory && !memory.has(item.resourceId)) return 'memoryNotListed';
  if (item.state === 'local-changed') return { item, direction: 'up', choice: null };
  if (item.state === 'cloud-newer' || item.state === 'cloud-only') return { item, direction: 'down', choice: null };
  if (item.state !== 'conflict') return 'unknown';
  const choice = args.choices?.[item.resourceId];
  if (choice === undefined) return 'conflictWithoutChoice';
  return { item, direction: choice === 'mine' ? 'up' : 'down', choice };
}

interface SyncReview {
  moving: Moving[];
  counts: Record<string, number>;
}

/** A download over a copy on this Mac: the route replaces it, keeping a backup. */
const replacesCopy = (m: Moving): boolean => m.direction === 'down' && m.item.local;

/** What a sync with these arguments would move, from the sync list as the route answered it. */
function syncReview(body: unknown, args: SyncArgs): SyncReview {
  const items = records(isRecord(body) ? body.items : []).flatMap((raw) => {
    const item = syncItemOf(raw);
    return item === null ? [] : [item];
  });
  const only = args.only === undefined ? null : new Set(args.only);
  const memory = new Set(args.memory ?? []);
  const held: Record<Held, number> = {
    synced: 0,
    stopped: 0,
    removed: 0,
    notAsked: 0,
    blocked: 0,
    memoryNotListed: 0,
    conflictWithoutChoice: 0,
    unknown: 0,
  };
  const moving: Moving[] = [];
  for (const item of items) {
    const place = placeOf(item, args, only, memory);
    if (typeof place === 'string') held[place] += 1;
    else moving.push(place);
  }
  const up = moving.filter((m) => m.direction === 'up').length;
  return {
    moving,
    counts: {
      items: items.length,
      up,
      down: moving.length - up,
      replaces: moving.filter(replacesCopy).length,
      memory: moving.filter((m) => m.item.memory).length,
      ...held,
    },
  };
}

const version = (v: number | null): string => (v === null ? '–' : `v${v}`);

/**
 * One card line per moving item: direction, agent, kind, name (as written), versions, why it moves when chosen, and
 * whether it replaces this Mac's copy.
 */
function syncRow(moving: Moving): string {
  const { item, direction, choice } = moving;
  const parts = [
    `- ${direction}`,
    `${oneLine(item.agent, 20)} ${oneLine(item.kind, 20)} ${oneLine(item.name, NAME_MAX)}`,
    `synced ${version(item.syncedVersion)}, cloud ${version(item.cloudVersion)}`,
    item.memory ? 'memory' : null,
    choice === null ? null : `conflict: ${choice === 'mine' ? 'keep this Mac’s' : 'use the cloud’s'}`,
    replacesCopy(moving) ? 'replaces this Mac’s copy (backup kept)' : null,
  ];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

/** The sync list as `account` reads it: UNAVAILABLE in a build without the route. */
async function readSyncList(ctx: ToolContext, binding: CloudBinding): Promise<unknown> {
  const answer = await ctx.client.get(`${CLOUD}/sync-status`, undefined, { headers: bindingHeaders(binding), signal: ctx.signal });
  return cloudWriteBody<unknown>(answer, MISSING_SYNC);
}

/** What moves beyond the listed items (main resourceJobs.ts `syncNow`): fixed words for the description and the card. */
const DEPENDENCY_WORDS =
  'What they depend on moves with them: new dependencies go up; pinned versions come down, replacing a local copy with a backup.';

/** The card's first detail line: an upload is built from disk when the person allows, and what moves with the items. */
const CARD_NOTE = `An upload sends the copy on disk when the person allows. ${DEPENDENCY_WORDS}`;

/**
 * The card for a sync: what moves, as whom, whether it writes into ~/.claude and ~/.codex, how many local copies it
 * replaces and which are memory (P6-8), and that dependencies move too. About 240 characters at most with the longest
 * account label, so the last clause stays whole.
 */
function syncCard(account: ReviewedAccount, review: SyncReview, args: SyncArgs): ConfirmAsk {
  const { moving, counts } = review;
  const writes = counts.down > 0 ? ' (writes into ~/.claude / ~/.codex)' : '';
  const replaces = counts.replaces > 0 ? `, replaces ${counts.replaces} with a backup` : '';
  const memory = counts.memory > 0 ? `, ${plural(counts.memory, 'memory resource')}` : '';
  const sorted = <T>(entries: readonly T[]): T[] => [...entries].sort();
  return {
    summary:
      `AASC Cloud: sync ${plural(moving.length, 'resource')} as ${account.label}: ${counts.up} up, ${counts.down} down` +
      `${writes}${replaces}${memory}; what they depend on moves with them`,
    detail: cardDetail([CARD_NOTE, ...moving.map(syncRow)]),
    fingerprint: `sync:${account.key}:${cardDigest({
      moving: moving.map((m) => [m.item.resourceId, m.item.state, m.item.cloudVersion, m.item.syncedVersion, m.direction, m.item.local]),
      choices: sorted(Object.entries(args.choices ?? {}).map(([id, c]) => `${id}=${c}`)),
      memory: sorted(args.memory ?? []),
      only: args.only === undefined ? null : sorted(args.only),
    })}`,
  };
}

/** The most step rows a sync's answer lists. */
const STEPS_MAX = 40;

/** "publish · alpha-skill": one row per step of each job, as the route named it (cloud or person text, for a fence). */
function stepRows(rawJobs: readonly Record<string, unknown>[]): string[] {
  return rawJobs.flatMap((raw) => {
    const job = jobOf(raw);
    if (job === null) return [];
    return records(raw.steps).flatMap((s) => (nonEmptyString(s.id) === null ? [] : [`${job.kind} · ${oneLine(str(s.label) ?? '', NAME_MAX)}`]));
  });
}

/** What the route answered for a sync: the jobs it queued, their steps, and what it left out (reasons fenced). */
function syncResultOf(body: unknown): {
  jobs: JobView[];
  steps: string[];
  skipped: Array<{ resourceId: string; name: string; reason: string }>;
  said: string[];
} {
  const answer = isRecord(body) ? body : {};
  const rawJobs = records(answer.jobs);
  const jobs = rawJobs.flatMap((raw) => {
    const job = jobOf(raw);
    return job === null ? [] : [job];
  });
  const left = records(answer.skipped).flatMap((s) => {
    const resourceId = nonEmptyString(s.resourceId);
    return resourceId === null ? [] : [{ resourceId, name: str(s.name) ?? '', reason: str(s.reason) ?? '' }];
  });
  return {
    jobs,
    steps: stepRows(rawJobs),
    skipped: left.map((s) => ({
      resourceId: s.resourceId,
      name: s.name,
      reason: fenced(`cloud-resource:${s.resourceId}`, 'sync-skipped', s.reason, REASON_MAX).value,
    })),
    said: left.map((s) => `${oneLine(s.name, NAME_MAX)} · ${oneLine(s.reason, 200)}`),
  };
}

const ID_LIST = z.array(RESOURCE).min(1).max(IDS_MAX);

const cloudSyncNow = defineTool({
  name: 'cloud_sync_now',
  toolset: 'cloud',
  title: 'Sync with AASC Cloud',
  description:
    'Syncs this Mac with AASC Cloud, as the person’s Sync now does: a resource changed here (local-changed) is uploaded, ' +
    'one newer in the cloud (cloud-newer) or only there (cloud-only) is downloaded into ~/.claude and ~/.codex. A ' +
    'download over a copy on this Mac replaces it, keeping a backup. An upload sends the copy on disk when the person ' +
    `allows, not as it was when the card was made. ${DEPENDENCY_WORDS} A ` +
    'conflict moves only with a choice (choices: mine uploads this Mac’s copy, cloud downloads the cloud’s); a memory ' +
    'resource only when listed in memory; with only, nothing else moves. Stopped, removed and blocked resources never ' +
    `move. cloud_sync_status shows the list first. ${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card shows what ` +
    'moves, which way, what it replaces, and the account; it runs only as that account, and if the list or the account ' +
    `changes before the person allows it nothing runs (call it again). ${CLOUD_RULES.job} It answers up to two jobs (an ` +
    'upload and a download) in data.jobIds, with their steps, and what it left out, with why, in data.skipped. If a ' +
    'call ended without an answer, read ' +
    `cloud_sync_status before calling it again. ${CLOUD_RULES.newer} ${BUDGET_WORDS}`,
  risk: 'outward',
  phase: 6,
  input: {
    only: ID_LIST.optional().describe('Move only these resources (1 to 200 cloud resource ids); everything else stays as it is.'),
    choices: z
      .record(RESOURCE, z.enum(['mine', 'cloud']))
      .refine((r) => Object.keys(r).length <= IDS_MAX, `At most ${IDS_MAX} choices.`)
      .optional()
      .describe('For a resource in conflict: mine (upload this Mac’s copy) or cloud (download the cloud’s).'),
    memory: z.array(RESOURCE).max(IDS_MAX).optional().describe('Memory resources that may sync this time; any other memory stays.'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    globalOnly(ctx);
    spendCloudCall(ctx);
    const account = await reviewAccount(ctx);
    const review = syncReview(await readSyncList(ctx, account.binding), args);
    if (review.moving.length === 0) {
      throw new ToolError('INVALID', 'Nothing would sync.', 'cloud_sync_status shows each resource’s state; a conflict needs a choice, memory needs to be listed.', review.counts);
    }
    return syncCard(account, review, args);
  },
  async run(args, ctx) {
    const account = approvedAccount(ctx);
    // Not MISSING_SYNC: the card's read of the sync list found the routes, so a 400 here is the route's own refusal.
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/sync-now`, args, account.binding));
    const { jobs, steps, skipped, said } = syncResultOf(body);
    const { centralId } = ctx.central;
    for (const job of jobs) rememberJob(centralId, job, account.key, ctx.now());
    const jobIds = jobs.map((j) => j.id);
    const data = { jobs, jobIds, skipped, next: jobs.length === 0 ? null : 'cloud_job_get' };
    const started =
      jobs.length === 0
        ? 'Synced with AASC Cloud: nothing was queued.'
        : `Synced with AASC Cloud as ${account.label}: ${jobs.map((j) => `cloud job ${j.id} (${j.kind}) is ${j.state}`).join('; ')}. Follow ${jobs.length === 1 ? 'it' : 'each'} with cloud_job_get (waitSec up to 45).`;
    const shown = steps.length > STEPS_MAX ? [...steps.slice(0, STEPS_MAX), `… and ${steps.length - STEPS_MAX} more`] : steps;
    const stepWords = steps.length === 0 ? '' : `\n${plural(steps.length, 'step')}:\n${fence('aasc', 'cloud-sync-steps', shown.join('\n'))}`;
    const left = skipped.length === 0 ? '' : `\n${plural(skipped.length, 'resource')} left out:\n${fence('aasc', 'cloud-sync-skipped', said.join('\n'))}`;
    return {
      data,
      summary: `${started}${stepWords}${left}`,
      activity: [
        {
          summary: `Synced with AASC Cloud: ${plural(jobs.length, 'job')}, ${skipped.length} left out`,
          detail: { jobs: jobs.length, skipped: skipped.length, ...Object.fromEntries(jobs.map((j, i) => [`job${i + 1}`, `${short(j.id)} ${j.kind}`])) },
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_sync_set
// ---------------------------------------------------------------------------

const cloudSyncSet = defineTool({
  name: 'cloud_sync_set',
  toolset: 'cloud',
  title: 'Stop or resume syncing a resource',
  description:
    'Stops syncing one resource on this Mac (stop: nothing of it moves here until resumed; its files and the cloud copy ' +
    'stay), or syncs it again (resume). It is a mark on this Mac only, and never removes anything from the cloud. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.newer} ${BUDGET_WORDS}`,
  risk: 'write',
  phase: 6,
  input: {
    resourceId: RESOURCE,
    action: z.enum(['stop', 'resume']).describe('stop: stop syncing it on this Mac; resume: sync it again.'),
  },
  async run(args, ctx) {
    globalOnly(ctx);
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    cloudWriteBody(await cloudSend(ctx, 'post', `${CLOUD}/sync-control`, { resourceId: args.resourceId, action: args.action }, binding), {
      what: 'This build of AASC cannot stop or resume syncing a resource.',
      hint: 'cloud_sync_status shows the sync list where a build has one.',
    });
    const done = args.action === 'stop' ? 'Stopped syncing' : 'Resumed syncing';
    return {
      data: { resourceId: args.resourceId, action: args.action },
      summary: `${done} cloud resource ${args.resourceId} on this Mac.`,
      activity: [{ summary: `${done} cloud resource ${short(args.resourceId)}`, detail: { resourceId: args.resourceId, action: args.action } }],
    };
  },
});

export const cloudSyncTools: readonly ToolDef[] = [cloudRecheck, cloudSyncNow, cloudSyncSet];
