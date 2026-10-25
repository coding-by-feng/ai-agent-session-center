// tools/cloudProjectGit.ts — the cloud toolset's P6 project checkout writes (plan 2026-10-25, C4 Task 8):
// `cloud_project_get_copy` clones a saved project from GitHub into a new folder; `cloud_project_check` fetches it;
// `cloud_project_pull` fast-forwards it; `cloud_project_push` pushes it; `cloud_project_resources_plan` and
// `cloud_project_retry_resources` review and install the resources a clone was given. Filed under `cloud` by cloudP6.ts.
//
// Each changes what this Mac holds (a checkout, its refs, ~/.claude and ~/.codex) or what GitHub holds: only a global
// central (P6-4), within the call budget (P6-15), which a call spends only once its own checks pass, just before its
// first cloud call (P6-40). The folder a clone goes into follows the folder rule (P6-14); a clone installs the record's
// own pins unless the central names others (P6-43). A pull waits while any session on this Mac works in the checkout,
// below it or in a folder that holds it, in any central's scope or none, because its files change under each one (P6-13,
// P6-42). A push leaves the Mac, so it waits for the person (P6-12): only a checkout that
// is only ahead gets a card, the card names the repository, the commit count and the GitHub account, and the
// fingerprint holds the folder, the branch, the count, the account, the reviewed AASC Cloud account and, when the route
// gives one, the HEAD (P6-26): commits added after the allow run nothing (CHANGED). Its body is `{}`: the route never
// forces. A resources plan and its retry take only this central's own job and plan (P6-7); a replace needs a decision
// and the card shows each (P6-16). Check and push exist only in newer builds (P6-11): elsewhere UNAVAILABLE, before any
// card. No refusal repeats an id, a path or a name the caller sent.

import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import { ownsJob, planOf, rememberJob, rememberPlan } from '../cloudMemo.js';
import { normalizeFolder } from '../paths.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { isLocalSession, isWithin } from '../scope.js';
import { ToolError } from '../types.js';
import { bindingHeaders, CLOUD, type CloudBinding } from './cloudCall.js';
import { jobOf, jobStarted, type JobView } from './cloudJob.js';
import { localOf, projectOf, type ProjectView } from './cloudProjects.js';
import {
  accountKeyOf,
  approvedAccount,
  cardDetail,
  cardDigest,
  CLOUD_CALLS_PER_MINUTE,
  CLOUD_RULES,
  cloudFolder,
  cloudSend,
  cloudWriteBody,
  liveAccount,
  reviewAccount,
  short,
  spendCloudCall,
  type ReviewedAccount,
} from './cloudWrite.js';
import { defineTool, fence, isRecord, nonEmptyString, oneLine, plural, seg } from './define.js';
import { assertGlobal } from './resourceWrite.js';
import { fenced, records, str, whole } from './shape.js';

const CLOUD_ID = CanonicalCloudIdSchema.describe('A saved project’s id (cloud_project_list).');
const JOB_ID = CanonicalCloudIdSchema.describe('The id of a get-project job you started (data.jobId of cloud_project_get_copy).');
const PINS = z
  .array(z.object({ resourceId: CanonicalCloudIdSchema, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict())
  .max(2_000);
const DECISION = z.enum(['keep-local', 'replace-with-backup', 'skip']);

const BUDGET = `At most ${CLOUD_CALLS_PER_MINUTE} cloud changes a minute (BUDGET).`;

/** The states of a session that is doing something in its folder. */
const WORKING: ReadonlySet<string> = new Set(['working', 'prompting', 'approval', 'input']);
/** The GitHub login rule (main src/types/cloudProjects.ts GithubLoginSchema). */
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const REASON_MAX = 500;
const NAME_MAX = 120;

/** Only a global central works with the account's projects and this Mac's checkouts (P6-4). */
const globalOnly = (ctx: ToolContext): void =>
  assertGlobal(ctx, 'works with AASC Cloud projects and their checkouts', 'the cloud account, the checkouts and their GitHub accounts belong to the whole Mac');

/** The checks of a tool with nothing else to check here: global, then the budget (P6-40). */
function firstChecks(ctx: ToolContext): void {
  globalOnly(ctx);
  spendCloudCall(ctx);
}

const projectPath = (id: string): string => `${CLOUD}/projects/${seg(id)}`;
const projectJobPath = (jobId: string): string => `${CLOUD}/projects/jobs/${seg(jobId)}`;

const LOCAL_HINT = 'cloud_project_local says how this Mac holds it.';

/** P6-7: a job this central did not start in the last 24 hours, in words that never repeat its id. */
const notOwnJob = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That is not a job you started (or it is over 24 hours old).',
    'Only a get-project job your own cloud_project_get_copy started can have its resources planned or retried.',
  );

/** P6-7: a plan this central's own cloud_project_resources_plan did not make for this job within 30 minutes. */
const notOwnPlan = (): ToolError =>
  new ToolError(
    'NOT_FOUND',
    'That is not a plan you made (or it is over 30 minutes old): make a new one.',
    'Call cloud_project_resources_plan for the job, then pass its planId.',
  );

const notAJob = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a job of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

/** The job a job-starting route answered, remembered as this central's own. */
function ownStarted(ctx: ToolContext, body: unknown, accountKey: string): JobView {
  const job = jobOf(body);
  if (job === null) throw notAJob();
  rememberJob(ctx.central.centralId, job, accountKey, ctx.now());
  return job;
}

// ---------------------------------------------------------------------------
// How this Mac holds a project
// ---------------------------------------------------------------------------

interface Checkout {
  state: string;
  branch: string | null;
  /** The folder: the route's `path`, else the one its `openUrl` names (the branch has no `path`). */
  path: string | null;
  ahead: number | null;
  behind: number | null;
  /** The GitHub login the project uses here; null for this Mac's own Git sign-in. */
  account: string | null;
  /** The checkout's HEAD when the route gives one (`head` or `headSha`, P6-26); null otherwise. */
  head: string | null;
}

/** The folder a `/project-browser?path=…` link names, when it is absolute. */
function pathFromOpenUrl(openUrl: unknown): string | null {
  const url = nonEmptyString(openUrl);
  if (url === null || !url.startsWith('/project-browser?')) return null;
  const path = new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('path');
  return path !== null && path !== '' && isAbsolute(path) ? path : null;
}

const countOf = (v: unknown): number | null => (v === undefined || v === null ? null : whole(v));

/** `GET /projects/:id/local` as `binding`: the route's answer as it gave it (an object; anything else reads as `{}`). */
async function readLocal(ctx: ToolContext, id: string, binding: CloudBinding): Promise<Record<string, unknown>> {
  const body = cloudWriteBody<unknown>(
    await ctx.client.get(`${projectPath(id)}/local`, undefined, { headers: bindingHeaders(binding), signal: ctx.signal }),
  );
  return isRecord(body) ? body : {};
}

function checkoutOf(local: Record<string, unknown>): Checkout {
  const state = str(local.state) ?? '';
  return {
    state: /^[a-z-]{1,20}$/.test(state) ? state : 'unknown',
    branch: nonEmptyString(local.branch),
    path: nonEmptyString(local.path) ?? pathFromOpenUrl(local.openUrl),
    ahead: countOf(local.ahead),
    behind: countOf(local.behind),
    account: nonEmptyString(local.account),
    head: nonEmptyString(local.head) ?? nonEmptyString(local.headSha),
  };
}

const noCheckout = (code: 'INVALID' | 'UNAVAILABLE'): ToolError =>
  new ToolError(
    code,
    'That project has no checkout here: cloud_project_get_copy or cloud_project_associate first.',
    'cloud_project_get_copy clones it into a new folder; cloud_project_associate links a folder that holds it.',
  );

const folderUnknown = (): ToolError => new ToolError('UNAVAILABLE', 'AASC could not tell where that checkout is.', LOCAL_HINT);

/**
 * Is any session on this Mac working in `folder`, below it, or in a folder that holds it (a session at ~/code works in
 * ~/code/proj too)? Every session, whatever the central's scope (P6-13, P6-42). By the paths' words only: a symlinked
 * folder is not resolved (tools touch no file system), and the route confines the real path again.
 */
function workingIn(ctx: ToolContext, folder: string): boolean {
  const root = normalizeFolder(folder);
  return ctx.sessions().some((s) => {
    if (!WORKING.has(s.status) || !isLocalSession(s) || typeof s.projectPath !== 'string' || s.projectPath.trim() === '') return false;
    const at = normalizeFolder(s.projectPath);
    return isWithin(at, root) || isWithin(root, at);
  });
}

// ---------------------------------------------------------------------------
// cloud_project_get_copy
// ---------------------------------------------------------------------------

const notAProject = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a project of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

/** `GET /projects/:id` as `binding`: the project, or UPSTREAM when the answer is not one. */
async function readProject(ctx: ToolContext, id: string, binding: CloudBinding): Promise<ProjectView> {
  const project = projectOf(cloudWriteBody(await ctx.client.get(projectPath(id), undefined, { headers: bindingHeaders(binding), signal: ctx.signal })));
  if (project === null) throw notAProject();
  return project;
}

/** P6-43: the pins the project's record holds now, as the UI sends them; a removed project is INVALID. */
async function ownPins(ctx: ToolContext, id: string, binding: CloudBinding): Promise<Array<{ resourceId: string; version: number }>> {
  const project = await readProject(ctx, id, binding);
  if (project.deleted) {
    throw new ToolError('INVALID', 'That project was removed from the account, so it cannot be copied.', 'cloud_project_list lists the projects the account holds.');
  }
  return project.needs.map((p) => ({ resourceId: p.resourceId, version: p.version }));
}

const cloudProjectGetCopy = defineTool({
  name: 'cloud_project_get_copy',
  toolset: 'cloud',
  title: 'Get a copy of a cloud project',
  description:
    'Gets a saved project onto this Mac: AASC clones its GitHub repository (over https) into a new folder named ' +
    'directoryName inside parentFolder, links that folder to the project, and installs there the resources the project ' +
    'pins (its own pins, read from the account, unless resourceVersions names others; [] installs none). A removed ' +
    'project is INVALID. parentFolder is absolute or starts with ~/, in the person’s home ' +
    'folder (the home folder itself is allowed), not in ~/Library or a hidden folder; anything else is INVALID. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.job} When the resources need a decision, plan them with ` +
    `cloud_project_resources_plan for that job. ${BUDGET}`,
  risk: 'write',
  phase: 6,
  input: {
    id: CLOUD_ID,
    parentFolder: z.string().min(1).max(4_096).describe('The folder the new folder goes into: absolute, or starting with ~/.'),
    directoryName: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
      .refine((s) => !s.endsWith('.') && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s))
      .describe('The new folder’s name: letters, digits, . _ -, starting with a letter or digit.'),
    resourceVersions: PINS.optional().describe('The resources to install (id and version); default the project’s own pins, [] none.'),
  },
  async run(args, ctx) {
    globalOnly(ctx);
    const parentPath = await cloudFolder(args.parentFolder, { allowHome: true });
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const resourceVersions = args.resourceVersions ?? (await ownPins(ctx, args.id, binding));
    const body = { parentPath, directoryName: args.directoryName, transport: 'https', resourceVersions };
    const job = ownStarted(ctx, cloudWriteBody(await cloudSend(ctx, 'post', `${projectPath(args.id)}/get`, body, binding)), accountKeyOf(binding));
    return jobStarted(job, 'Started getting a copy of a cloud project');
  },
});

// ---------------------------------------------------------------------------
// cloud_project_check
// ---------------------------------------------------------------------------

const cloudProjectCheck = defineTool({
  name: 'cloud_project_check',
  toolset: 'cloud',
  title: 'Check a project against GitHub',
  description:
    'Fetches a saved project’s checkout on this Mac from GitHub, as the project’s GitHub account, and says how it ' +
    'stands now: its state, branch, folder and the commits ahead and behind. It moves the checkout’s remote-tracking ' +
    'refs, never its files or branch. cloud_project_local says the same without fetching. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.newer} ${BUDGET}`,
  risk: 'write',
  phase: 6,
  input: { id: CLOUD_ID },
  async run(args, ctx) {
    firstChecks(ctx);
    const binding = await liveAccount(ctx);
    const body = cloudWriteBody(await cloudSend(ctx, 'post', `${projectPath(args.id)}/check`, {}, binding), {
      what: 'This build of AASC cannot check a project against GitHub.',
      hint: 'cloud_project_local says how this Mac holds it, as of the last fetch.',
    });
    const local = localOf(args.id, body);
    const state = isRecord(local.data) ? (str(local.data.state) ?? 'unknown') : 'unknown';
    return {
      data: { local: local.data },
      summary: local.summary,
      activity: [{ summary: `Checked cloud project ${short(args.id)} against GitHub: ${state}`, detail: { projectId: args.id, state } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_project_pull
// ---------------------------------------------------------------------------

const cloudProjectPull = defineTool({
  name: 'cloud_project_pull',
  toolset: 'cloud',
  title: 'Pull a project from GitHub',
  description:
    'Pulls a saved project’s checkout on this Mac from GitHub: the route only fast-forwards, so a checkout with ' +
    'changes or commits of its own is left as it is (the job says so). It is refused with BUSY while any session on ' +
    'this Mac is working, prompting, waiting for an approval or for input in the checkout, a folder below it or a ' +
    'folder that holds it (whatever central it belongs to): wait for it to finish. A project with no checkout here is INVALID. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.job} ${BUDGET}`,
  risk: 'write',
  phase: 6,
  input: { id: CLOUD_ID },
  async run(args, ctx) {
    firstChecks(ctx);
    const binding = await liveAccount(ctx);
    const checkout = checkoutOf(await readLocal(ctx, args.id, binding));
    if (checkout.state === 'missing') throw noCheckout('INVALID');
    if (checkout.path === null) throw folderUnknown();
    if (workingIn(ctx, checkout.path)) {
      throw new ToolError(
        'BUSY',
        'A session is working in that checkout: wait for it to finish.',
        'session_list shows which; call cloud_project_pull again once it is idle.',
      );
    }
    const job = ownStarted(ctx, cloudWriteBody(await cloudSend(ctx, 'post', `${projectPath(args.id)}/pull`, {}, binding)), accountKeyOf(binding));
    return jobStarted(job, 'Started a pull from GitHub');
  },
});

// ---------------------------------------------------------------------------
// cloud_project_push
// ---------------------------------------------------------------------------

const cannotPush = (): ToolError =>
  new ToolError('UNAVAILABLE', 'This build of AASC cannot push a project.', 'cloud_project_local says how far ahead the checkout is; the person can push it themselves.');

/** P6-12: a checkout that is not only ahead gets no card. */
function refuseUnlessAhead(state: string): void {
  switch (state) {
    case 'ahead':
      return;
    case 'ready':
      throw new ToolError('INVALID', 'Nothing to push.', 'The checkout has no commits GitHub lacks; cloud_project_check fetches first.');
    case 'diverged':
      throw new ToolError(
        'INVALID',
        'GitHub has commits this checkout lacks: cloud_project_pull first. AASC never forces a push.',
        'If the pull cannot fast-forward, the person has to merge or rebase the checkout themselves.',
      );
    case 'dirty':
      throw new ToolError('INVALID', 'Commit first.', 'The checkout has changes that are not committed; AASC pushes commits only.');
    case 'missing':
      throw noCheckout('UNAVAILABLE');
    case 'busy':
      throw new ToolError('UNAVAILABLE', 'AASC is already working in that checkout.', 'Wait for its job (cloud_job_get), then ask again.');
    case 'detached':
      throw new ToolError('UNAVAILABLE', 'That checkout is not on a branch.', LOCAL_HINT);
    case 'wrong-remote':
      throw new ToolError('UNAVAILABLE', 'That checkout’s origin is not the project’s GitHub repository.', LOCAL_HINT);
    default:
      throw new ToolError('UNAVAILABLE', 'AASC could not tell how that checkout stands.', LOCAL_HINT);
  }
}

/** The push the person is asked about: what the card says and what its fingerprint holds. */
async function pushAsk(ctx: ToolContext, id: string, account: ReviewedAccount): Promise<ConfirmAsk> {
  const local = await readLocal(ctx, id, account.binding);
  // A build whose local route has no counts (the branch) cannot push either (P6-11).
  if (!('ahead' in local) || !('path' in local)) throw cannotPush();
  const checkout = checkoutOf(local);
  refuseUnlessAhead(checkout.state);
  const { ahead, path, account: login } = checkout;
  if (ahead === null || ahead < 1 || path === null) {
    throw new ToolError('UNAVAILABLE', 'AASC could not tell what that checkout would push.', LOCAL_HINT);
  }
  if (login !== null && !GITHUB_LOGIN.test(login)) {
    throw new ToolError('UPSTREAM', 'AASC answered with a GitHub account of a shape it does not know.', 'Try it once more; if it fails again, tell the person.');
  }
  const project = await readProject(ctx, id, account.binding);
  const branch = checkout.branch ?? project.repository.branch;
  // Cut so the whole summary, login and "never forced" included, fits the card's 300 characters for the longest inputs
  // (owner 39 as GitHub allows, name 60, branch 40: at most 271).
  const repo = `${oneLine(project.repository.owner, 39)}/${oneLine(project.repository.name, 60)}@${oneLine(branch, 40)}`;
  const who = login === null ? 'as this Mac’s own Git sign-in' : `as GitHub account ${login}`;
  return {
    summary: `GitHub: push ${plural(ahead, 'commit')} of ${repo} from this Mac (${who}) — never forced`,
    detail: cardDetail([
      `Folder: ${path}`,
      `Branch: ${branch}`,
      `${plural(ahead, 'commit')} ahead, ${checkout.behind ?? 0} behind`,
      `AASC Cloud account: ${account.label}`,
    ]),
    fingerprint: [`push:${id}`, account.key, path, branch, String(ahead), login ?? '-', ...(checkout.head === null ? [] : [checkout.head])].join(':'),
  };
}

const cloudProjectPush = defineTool({
  name: 'cloud_project_push',
  toolset: 'cloud',
  title: 'Push a project to GitHub',
  description:
    'Pushes the commits of a saved project’s checkout on this Mac to its GitHub repository, as the project’s GitHub ' +
    'account (or this Mac’s own Git sign-in). It never forces: only a checkout that is only ahead of GitHub can be ' +
    'pushed. A ready checkout is INVALID (nothing to push), a dirty one INVALID (commit first), a diverged one INVALID ' +
    '(cloud_project_pull first); a missing, detached, busy or wrong-remote one UNAVAILABLE. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card shows the repository, the number of commits and the GitHub ` +
    'account; if a commit is added, the account changes or the checkout moves before the person allows it, nothing is ' +
    `pushed (call it again). ${CLOUD_RULES.job} ${CLOUD_RULES.newer} ${BUDGET}`,
  risk: 'outward',
  phase: 6,
  input: { id: CLOUD_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    firstChecks(ctx);
    return pushAsk(ctx, args.id, await reviewAccount(ctx));
  },
  async run(args, ctx) {
    const account = approvedAccount(ctx);
    const body = cloudWriteBody(await cloudSend(ctx, 'post', `${projectPath(args.id)}/push`, {}, account.binding), {
      what: 'This build of AASC cannot push a project.',
      hint: 'cloud_project_local says how far ahead the checkout is; the person can push it themselves.',
    });
    return jobStarted(ownStarted(ctx, body, account.key), 'Started a push to GitHub');
  },
});

// ---------------------------------------------------------------------------
// The resources of a clone
// ---------------------------------------------------------------------------

interface PlanItemView {
  id: string;
  resourceId: string;
  version: number;
  /** AASC's words for where it goes (an agent, a scope and the resource's name): fenced as untrusted (C-8). */
  destination: string;
  action: string;
  /** Fenced as untrusted; null when the plan gives none. */
  reason: string | null;
  files: { add: number; change: number; remove: number; same: number };
}

/** An item as this file reads it: the view `data` carries, and the destination on one line for a card or a fenced row. */
interface PlanItem extends PlanItemView {
  label: string;
}

/** What `data` carries of an item: everything but the unfenced label. */
const viewOfItem = (i: PlanItem): PlanItemView => ({
  id: i.id,
  resourceId: i.resourceId,
  version: i.version,
  destination: i.destination,
  action: i.action,
  reason: i.reason,
  files: i.files,
});

/** An install plan's items, read loosely: those with an id. */
function planItemsOf(raw: unknown): PlanItem[] {
  const planId = isRecord(raw) ? (str(raw.id) ?? '') : '';
  return records(isRecord(raw) ? raw.items : []).flatMap((item): PlanItem[] => {
    const id = nonEmptyString(item.id);
    if (id === null) return [];
    const files = { add: 0, change: 0, remove: 0, same: 0 };
    for (const f of records(item.files)) {
      const change = str(f.change);
      if (change === 'add' || change === 'change' || change === 'remove' || change === 'same') files[change] += 1;
    }
    const action = str(item.action) ?? '';
    const reason = nonEmptyString(item.reason);
    const label = oneLine(str(item.destinationLabel) ?? '', NAME_MAX);
    return [
      {
        id,
        resourceId: str(item.resourceId) ?? '',
        version: whole(item.version),
        destination: fenced(`cloud-plan:${planId}`, 'plan-item-destination', label, NAME_MAX).value,
        label,
        action: /^[a-z-]{1,20}$/.test(action) ? action : 'unknown',
        reason: reason === null ? null : fenced(`cloud-plan:${planId}`, 'plan-item-reason', reason, REASON_MAX).value,
        files,
      },
    ];
  });
}

const fileCounts = (f: PlanItemView['files']): string => `files +${f.add} ~${f.change} -${f.remove} =${f.same}`;

const cloudProjectResourcesPlan = defineTool({
  name: 'cloud_project_resources_plan',
  toolset: 'cloud',
  title: 'Plan the resources of a cloned project',
  description:
    'Plans installing the resources of a project you cloned (a get-project job from cloud_project_get_copy whose ' +
    'checkout is complete) into that checkout: for each, where it goes, whether it is added, replaces a different ' +
    'local copy, is the same already or is blocked, and its file counts (destinations and reasons fenced as untrusted ' +
    'data). Pass ' +
    'resourceVersions to plan other pins of the project. Nothing is installed: pass data.planId to ' +
    'cloud_project_retry_resources, with a decision (keep-local, replace-with-backup or skip) for every id in ' +
    `data.needsDecision. ${CLOUD_RULES.global} ${CLOUD_RULES.ownJob} Another job is NOT_FOUND. ${BUDGET}`,
  risk: 'write',
  phase: 6,
  input: {
    jobId: JOB_ID,
    resourceVersions: PINS.optional().describe('The project’s pins to plan (id and version); default the ones the job was given.'),
  },
  async run(args, ctx) {
    globalOnly(ctx);
    const { centralId } = ctx.central;
    if (!ownsJob(centralId, args.jobId, ctx.now())) throw notOwnJob();
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const sent = args.resourceVersions === undefined ? {} : { resourceVersions: args.resourceVersions };
    const raw = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${projectJobPath(args.jobId)}/resources-plan`, sent, binding));
    const planId = isRecord(raw) ? nonEmptyString(raw.id) : null;
    if (planId === null) {
      throw new ToolError('UPSTREAM', 'AASC Cloud answered with a plan of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');
    }
    rememberPlan(centralId, { kind: 'project-resources', planId, accountKey: accountKeyOf(binding), plan: raw, projectJobId: args.jobId, at: ctx.now() });
    const items = planItemsOf(raw);
    const needsDecision = items.filter((i) => i.action === 'replace').map((i) => i.id);
    const blocked = items.filter((i) => i.action === 'blocked').map((i) => i.id);
    // A destination names a resource the cloud holds: the rows sit inside one fenced block (C-8, Ruling P6-41).
    const rows = items.map((i) => `${i.id} · ${i.action} · ${i.label} · v${i.version} · ${fileCounts(i.files)}`);
    const lead =
      `Planned ${plural(items.length, 'resource')} for project job ${args.jobId} (plan ${planId}): ` +
      `${needsDecision.length} need a decision, ${blocked.length} blocked.`;
    return {
      data: { planId, items: items.map(viewOfItem), needsDecision, blocked, next: blocked.length > 0 ? null : 'cloud_project_retry_resources' },
      summary: rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-project-plan', cardDetail(rows))}`,
      activity: [
        {
          summary: `Planned the resources of project job ${short(args.jobId)}: ${items.length} items`,
          detail: { jobId: args.jobId, planId, items: items.length, needsDecision: needsDecision.length, blocked: blocked.length },
        },
      ],
    };
  },
});

/**
 * P6-16 over a plan: every decision is for one of its items, only a replace takes keep-local or replace-with-backup (any
 * item may be skipped), every replace has a decision, and nothing is blocked.
 */
function checkDecisions(items: readonly PlanItem[], decisions: Readonly<Record<string, string>>): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  if (Object.keys(decisions).some((id) => !byId.has(id))) {
    throw new ToolError('INVALID', 'A decision names an item that is not in that plan.', 'Pass decisions only for the item ids the plan gave.');
  }
  if (Object.entries(decisions).some(([id, d]) => d !== 'skip' && byId.get(id)?.action !== 'replace')) {
    throw new ToolError(
      'INVALID',
      'Only an item that would replace a local copy takes keep-local or replace-with-backup.',
      'Pass those for the ids in data.needsDecision only; any other item can only be skipped.',
    );
  }
  const blocked = items.filter((i) => i.action === 'blocked').map((i) => i.id);
  if (blocked.length > 0) {
    // The project job refuses a plan with any blocked item, whatever is sent for it (installation_blocked).
    throw new ToolError(
      'INVALID',
      'That plan has blocked items, which a project install cannot skip.',
      'Ask the person to resolve them in AASC, then make a new plan.',
      { blocked: blocked.join(',') },
    );
  }
  const needsDecision = items.filter((i) => i.action === 'replace' && decisions[i.id] === undefined).map((i) => i.id);
  if (needsDecision.length > 0) {
    throw new ToolError(
      'INVALID',
      `${plural(needsDecision.length, 'item')} would replace a different local copy and need a decision.`,
      'Pass decisions: keep-local, replace-with-backup or skip for every id in data.needsDecision.',
      { needsDecision: needsDecision.join(',') },
    );
  }
}

/** The card's clauses for what a plan's decisions do: "; replaces R with a backup" (replace items only), "; K skipped". */
function decisionClauses(items: readonly PlanItem[], decisions: Readonly<Record<string, string>>): string {
  const replaced = items.filter((i) => i.action === 'replace' && decisions[i.id] === 'replace-with-backup').length;
  const skipped = items.filter((i) => decisions[i.id] === 'skip').length;
  return `${replaced > 0 ? `; replaces ${replaced} with a backup` : ''}${skipped > 0 ? `; ${skipped} skipped` : ''}`;
}

const NO_PLAN_DETAIL =
  'Plans afresh with the pins of the job’s last resources plan, or else the ones it was given: only additions are ' +
  'installed; any replacement stops the job (cloud_project_resources_plan lets the person decide each).';

const cloudProjectRetryResources = defineTool({
  name: 'cloud_project_retry_resources',
  toolset: 'cloud',
  title: 'Install the resources of a cloned project',
  description:
    'Installs the resources of a project you cloned into its checkout again: with planId (a plan from ' +
    'cloud_project_resources_plan for that job) as that plan and your decisions. Without planId it plans afresh: only ' +
    'additions are installed, and any replacement stops the job. ' +
    'Every item in the plan’s needsDecision needs a decision (keep-local, replace-with-backup or skip), else INVALID ' +
    'with data.needsDecision; any other item can only be skipped; a plan with blocked items is INVALID (data.blocked). ' +
    'Decisions without planId are ' +
    `INVALID. ${CLOUD_RULES.global} ${CLOUD_RULES.ownJob} ${CLOUD_RULES.ownPlan} Another job or plan is NOT_FOUND. ` +
    `${CLOUD_RULES.waits} The card names the job, the account, each item and its decision; if the account changes ` +
    `before the person allows it nothing runs (call it again). ${CLOUD_RULES.job} ${BUDGET}`,
  risk: 'outward',
  phase: 6,
  input: {
    jobId: JOB_ID,
    planId: CanonicalCloudIdSchema.optional().describe('data.planId of cloud_project_resources_plan for this job.'),
    decisions: z
      .record(CanonicalCloudIdSchema, DECISION)
      .optional()
      .describe('For each item id in the plan’s needsDecision: keep-local, replace-with-backup or skip.'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    globalOnly(ctx);
    const { centralId } = ctx.central;
    const now = ctx.now();
    if (!ownsJob(centralId, args.jobId, now)) throw notOwnJob();
    const decisions = args.decisions ?? {};
    if (args.planId === undefined && Object.keys(decisions).length > 0) {
      throw new ToolError('INVALID', 'Decisions need the plan they are for.', 'Pass the planId cloud_project_resources_plan gave with them.');
    }
    const memo = args.planId === undefined ? null : planOf(centralId, args.planId, 'project-resources', now);
    if (args.planId !== undefined && (memo === null || memo.projectJobId !== args.jobId)) throw notOwnPlan();
    const items = memo === null ? [] : planItemsOf(memo.plan);
    checkDecisions(items, decisions);
    spendCloudCall(ctx);
    const account = await reviewAccount(ctx);
    if (memo !== null && memo.accountKey !== account.key) {
      throw new ToolError('INVALID', 'That plan was made as another account: make a new one.', 'Call cloud_project_resources_plan again, then this.');
    }
    const lead = `AASC Cloud: install the resources of project job ${short(args.jobId)} into its checkout as ${account.label}`;
    const rows = items.map((i) => {
      const decision = decisions[i.id];
      return `- ${i.action}${decision === undefined ? '' : ` → ${decision}`} · ${i.label} · v${i.version} · ${fileCounts(i.files)}`;
    });
    return {
      summary: memo === null ? `${lead}: plans afresh, additions only` : `${lead}${decisionClauses(items, decisions)}`,
      // The route forgets the job's last plan and plans again from the job's pins (a resources plan may have rewritten
      // them) with no decisions (main projectJobs.ts retryResources): a replacement fails the job.
      detail: memo === null ? NO_PLAN_DETAIL : cardDetail(rows),
      fingerprint: `resources:${args.jobId}:${args.planId ?? '-'}:${account.key}:${cardDigest([items.map((i) => [i.id, i.action, i.version]), decisions])}`,
    };
  },
  async run(args, ctx): Promise<ToolResult> {
    const account = approvedAccount(ctx);
    const sent = args.planId === undefined ? {} : { review: { planId: args.planId, decisions: args.decisions ?? {} } };
    const body = cloudWriteBody(await cloudSend(ctx, 'post', `${projectJobPath(args.jobId)}/retry-resources`, sent, account.binding));
    return jobStarted(ownStarted(ctx, body, account.key), 'Started installing the resources of a cloned project');
  },
});

export const cloudProjectGitTools: readonly ToolDef[] = [
  cloudProjectGetCopy,
  cloudProjectCheck,
  cloudProjectPull,
  cloudProjectPush,
  cloudProjectResourcesPlan,
  cloudProjectRetryResources,
];
