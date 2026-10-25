// tools/cloudProjectWrite.ts — the cloud toolset's P6 project record writes (plan 2026-10-25, C3 Task 6): save a folder
// as a project (`cloud_project_create`), change a saved project's name, description or resource pins
// (`cloud_project_update`), choose the GitHub account this Mac uses for it (`cloud_project_set_account`), link a folder
// to it (`cloud_project_associate`) and take it off the account (`cloud_project_remove`). Filed under `cloud` by
// cloudP6.ts.
//
// Every one changes what the account or this Mac holds, so only a global central may call it (P6-4), within the call
// budget (P6-15), which a call spends only once its own checks (folder, name, description) pass, just before its first
// cloud call (P6-40). Create and update rewrite the account's records in the cloud (outward) and remove takes one away
// (destructive): each waits for the person. Its card names the account it acts as and what changes; its fingerprint
// holds the account and the record's version, so an account switched or a record changed after the allow runs nothing
// (CHANGED); and its run sends as the account the card named (cloudWrite.ts `approvedAccount`, P6-6). Set_account and
// associate are marks on this Mac and name the live account (`liveAccount`). A folder a central names obeys the folder
// rule (cloudWrite.ts `cloudFolder`, P6-14); no refusal repeats it.
//
// Create needs `GET /projects/candidates` and the `localPath` field, set_account its own route, and remove its own
// route: only newer builds have them (P6-11). Each answers UNAVAILABLE before anything changes: create and remove before
// any card (remove tells a newer build by its `GET /projects/:id/local` answer, which there always has a `path` key, as
// push does), set_account at its one call.
// A record is sent whole, as the route's strict schema reads it: the fields it knows, read loosely from what the route
// answered, never what a central passed beyond its own changes.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CanonicalCloudIdSchema, ResourceDependencySchema } from '../../../src/types/cloudResources.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { bindingHeaders, CLOUD, cloudRouteMissing, type CloudBinding } from './cloudCall.js';
import { localOf, projectOf, type ProjectView } from './cloudProjects.js';
import {
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
} from './cloudWrite.js';
import { defineTool, isRecord, nonEmptyString, seg } from './define.js';
import { assertGlobal } from './resourceWrite.js';
import { records, str, whole } from './shape.js';

const NAME_MAX = 256;
const DESCRIPTION_MAX = 4_096;
const PINS_MAX = 2_000;

const CLOUD_ID = CanonicalCloudIdSchema.describe('A saved project’s id (cloud_project_list gives them).');
const FOLDER = z
  .string()
  .min(1)
  .max(4_096)
  .describe('The folder: an absolute path, or one starting with ~/, inside the person’s home folder (not in ~/Library or a hidden folder).');
/** A GitHub login as GitHub allows it: letters, digits and single inner hyphens, 1 to 39. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

const BUDGET_RULE = `At most ${CLOUD_CALLS_PER_MINUTE} cloud changes a minute (BUDGET).`;

/** Only a global central changes what the account holds (P6-4). */
const globalOnly = (ctx: ToolContext): void =>
  assertGlobal(ctx, 'changes what this Mac holds in AASC Cloud', 'the cloud account, ~/.claude and ~/.codex belong to the whole Mac');

/** The checks of a write with nothing else to check here: global, then the budget (P6-40). */
function projectCall(ctx: ToolContext): void {
  globalOnly(ctx);
  spendCloudCall(ctx);
}

const changedSinceCard = (): ToolError =>
  new ToolError('INVALID', 'That changed; call again.', 'Call the tool again: the person is asked about it as it is now.');

const notAProject = (): ToolError =>
  new ToolError('UPSTREAM', 'AASC Cloud answered with a project of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');

// ---------------------------------------------------------------------------
// Names and descriptions (P3-38's hidden characters)
// ---------------------------------------------------------------------------

// A name is one line: no format character, control character or line separator at all.
// eslint-disable-next-line no-control-regex
const HIDDEN_IN_NAME = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u001F\u007F-\u009F\u{E0000}-\u{E007F}]/u;
// A description may hold line breaks and tabs; nothing else the person cannot see.
// eslint-disable-next-line no-control-regex
const HIDDEN_IN_DESCRIPTION = /[\p{Cf}\p{Zl}\p{Zp}\u0000-\u0008\u000B-\u001F\u007F-\u009F\u{E0000}-\u{E007F}]/u;

function checkName(name: string): void {
  if (HIDDEN_IN_NAME.test(name)) {
    throw new ToolError('INVALID', 'A project name cannot hold hidden or control characters.', 'Pass the name as plain text on one line.');
  }
  if (name !== name.trim()) {
    throw new ToolError('INVALID', 'A project name cannot start or end with a space.', 'Pass the name without spaces around it.');
  }
}

function checkDescription(description: string): void {
  if (HIDDEN_IN_DESCRIPTION.test(description)) {
    throw new ToolError(
      'INVALID',
      'A description cannot hold hidden or control characters (line breaks and tabs are fine).',
      'Pass the description as plain text.',
    );
  }
}

// ---------------------------------------------------------------------------
// A record as the route reads it
// ---------------------------------------------------------------------------

interface Repository {
  provider: 'github';
  owner: string;
  name: string;
  url: string;
  branch: string;
}

interface Pin {
  resourceId: string;
  version: number;
}

/** A project record with only the fields the route's strict schema knows. */
interface RecordValue {
  id: string;
  version: number;
  name: string;
  repository: Repository;
  description: string;
  resources: Pin[];
  deleted: boolean;
}

/** A repository read loosely; null when any field is missing. */
function repositoryOf(raw: unknown): Repository | null {
  const repo = isRecord(raw) ? raw : {};
  const owner = nonEmptyString(repo.owner);
  const name = nonEmptyString(repo.name);
  const url = nonEmptyString(repo.url);
  const branch = nonEmptyString(repo.branch);
  if (owner === null || name === null || url === null || branch === null) return null;
  return { provider: 'github', owner, name, url, branch };
}

/** A record read loosely; null without an id or a repository. */
function recordOf(raw: unknown): RecordValue | null {
  if (!isRecord(raw)) return null;
  const id = nonEmptyString(raw.id);
  const repository = repositoryOf(raw.repository);
  if (id === null || repository === null) return null;
  return {
    id,
    version: whole(raw.version),
    name: str(raw.name) ?? '',
    repository,
    description: str(raw.description) ?? '',
    resources: records(raw.resources).flatMap((r) => {
      const resourceId = nonEmptyString(r.resourceId);
      return resourceId === null ? [] : [{ resourceId, version: whole(r.version) }];
    }),
    deleted: raw.deleted === true,
  };
}

/**
 * Owner, repository and branch for a card or a summary: what a repository and a ref are made of, nothing else, a long
 * name or branch cut with `…` (owner 39 as GitHub allows, name 60, branch 40), so the longest create summary with the
 * longest account label stays within the card's 300 characters (at most 262).
 */
const repoText = (r: { owner: string; name: string; branch: string }): string => {
  const safe = (s: string, max: number): string => {
    const kept = s.replace(/[^A-Za-z0-9_./-]/g, '_');
    return kept.length > max ? `${kept.slice(0, max - 1)}…` : kept;
  };
  return `${safe(r.owner, 39)}/${safe(r.name, 60)}@${safe(r.branch, 40)}`;
};

/** GET as the account the card names (the reviewed binding), never a re-read of the live one. */
const readAs = (ctx: ToolContext, path: string, binding: CloudBinding) =>
  ctx.client.get(path, undefined, { headers: bindingHeaders(binding), signal: ctx.signal });

/** `GET /projects/:id` as `binding`: the record, NOT_FOUND as the route says it. */
async function readRecord(ctx: ToolContext, id: string, binding: CloudBinding): Promise<RecordValue> {
  const found = recordOf(cloudWriteBody(await readAs(ctx, `${CLOUD}/projects/${seg(id)}`, binding)));
  if (found === null || found.id !== id) throw notAProject();
  return found;
}

/** A live record: a removed one is INVALID. */
function notRemoved(rec: RecordValue, doing: string): RecordValue {
  if (rec.deleted) {
    throw new ToolError('INVALID', `That project was removed from the account, so it cannot be ${doing}.`, 'cloud_project_list lists the projects the account holds.');
  }
  return rec;
}

/** The project view a write answers, from what the route answered. */
function viewOf(body: unknown): ProjectView {
  const project = projectOf(body);
  if (project === null) throw notAProject();
  return project;
}

/** A card's rows for a text that may run over several lines: the label, then each line (cardDetail cuts by row). */
const textRows = (label: string, text: string): string[] => [label, ...(text === '' ? ['(none)'] : text.split('\n'))];

// ---------------------------------------------------------------------------
// cloud_project_create
// ---------------------------------------------------------------------------

interface CreateReview {
  folder: string;
  repository: Repository;
  name: string;
  description: string;
}

/** What a create's `confirm` reviewed on a call's context: what its `run` sends. */
const createReviews = new WeakMap<ToolContext, CreateReview>();

const NO_CANDIDATES = {
  what: 'This build of AASC cannot save a project.',
  hint: 'cloud_project_list lists the projects already saved; the person can save one in RESOURCES → Cloud.',
};

const cloudProjectCreate = defineTool({
  name: 'cloud_project_create',
  toolset: 'cloud',
  title: 'Save a project to AASC Cloud',
  description:
    'Saves a git folder on this Mac whose origin is on GitHub as a project in the AASC Cloud account, and links the ' +
    'folder to it on this Mac. The folder must be one cloud_project_candidates lists (any other is NOT_FOUND; one ' +
    'already saved is INVALID, naming its project id); the repository and branch come from it, the name defaults to ' +
    'the repository’s, and the project starts with no resources (cloud_project_update pins them; cloud_project_set_account ' +
    'chooses its GitHub account). The folder must be inside the person’s home folder, not in ~/Library or a hidden ' +
    `folder. ${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card names the repository and the account; it runs only as ` +
    `that account, and if anything changes before the person allows it nothing runs (call it again). ${CLOUD_RULES.newer} ` +
    BUDGET_RULE,
  risk: 'outward',
  phase: 6,
  input: {
    folder: FOLDER,
    name: z.string().min(1).max(NAME_MAX).optional().describe('The project’s name (default: the repository’s name).'),
    description: z.string().max(DESCRIPTION_MAX).optional().describe('What the project is, for the person (line breaks are fine).'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    globalOnly(ctx);
    const folder = await cloudFolder(args.folder);
    if (args.name !== undefined) checkName(args.name);
    if (args.description !== undefined) checkDescription(args.description);
    spendCloudCall(ctx);
    const account = await reviewAccount(ctx);
    const answer = await readAs(ctx, `${CLOUD}/projects/candidates`, account.binding);
    if (cloudRouteMissing(answer)) throw new ToolError('UNAVAILABLE', NO_CANDIDATES.what, NO_CANDIDATES.hint);
    const body = cloudWriteBody<unknown>(answer);
    const candidate = records(isRecord(body) ? body.items : []).find((c) => str(c.path) === folder);
    if (candidate === undefined) {
      throw new ToolError(
        'NOT_FOUND',
        'That folder is not a git folder with a GitHub origin AASC lists (cloud_project_candidates).',
        'cloud_project_candidates lists the folders that can be saved: pass one of their paths.',
      );
    }
    const saved = nonEmptyString(candidate.projectId);
    if (saved !== null) {
      const projectId = CanonicalCloudIdSchema.safeParse(saved).success ? saved : 'unknown';
      throw new ToolError(
        'INVALID',
        `That folder is already saved as project ${projectId}.`,
        'cloud_project_update changes a saved project; cloud_project_associate links another folder to it.',
        { projectId },
      );
    }
    const repository = repositoryOf(candidate.repository);
    if (repository === null) throw notAProject();
    const name = args.name ?? repository.name;
    checkName(name);
    const description = args.description ?? '';
    createReviews.set(ctx, { folder, repository, name, description });
    return {
      summary: `AASC Cloud: save ${repoText(repository)} as a project as ${account.label} and link this Mac's folder`,
      detail: cardDetail([`Name: ${name}`, `Folder: ${folder}`, ...textRows('Description:', description)]),
      fingerprint: `create:${account.key}:${cardDigest([folder, repository, name, description])}`,
    };
  },
  async run(_args, ctx): Promise<ToolResult> {
    const account = approvedAccount(ctx);
    const review = createReviews.get(ctx);
    if (review === undefined) throw changedSinceCard();
    const { folder, repository, name, description } = review;
    const value = { id: randomUUID(), version: 1, name, repository, description, resources: [], deleted: false };
    const sent = await cloudSend(ctx, 'post', `${CLOUD}/projects`, { localPath: folder, mutationId: randomUUID(), baseVersion: null, value }, account.binding);
    // No missing-route reading here: confirm already proved the route, so a 400 is about what was sent (INVALID).
    const project = viewOf(cloudWriteBody(sent));
    return {
      data: { project },
      summary: `Saved ${repoText(repository)} to AASC Cloud as project ${project.id} (v${project.version}), linked to this Mac’s folder.`,
      activity: [
        {
          summary: `Saved cloud project ${short(project.id)} (${repoText(repository)})`,
          detail: { projectId: project.id, version: project.version, repository: repoText(repository) },
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_project_update
// ---------------------------------------------------------------------------

interface UpdateArgs {
  name?: string;
  description?: string;
  resources?: Pin[];
}

const pinKey = (p: Pin): string => `${p.resourceId} v${p.version}`;
const samePins = (a: readonly Pin[], b: readonly Pin[]): boolean =>
  a.length === b.length && JSON.stringify(a.map(pinKey).sort()) === JSON.stringify(b.map(pinKey).sort());

/** The record with the central's changes, at its own version; and which fields those changes touch. */
function updated(current: RecordValue, args: UpdateArgs): { value: RecordValue; fields: string[] } {
  const name = args.name !== undefined && args.name !== current.name ? args.name : null;
  const description = args.description !== undefined && args.description !== current.description ? args.description : null;
  const resources = args.resources !== undefined && !samePins(current.resources, args.resources) ? args.resources.map((p) => ({ ...p })) : null;
  const value: RecordValue = {
    ...current,
    ...(name === null ? {} : { name }),
    ...(description === null ? {} : { description }),
    ...(resources === null ? {} : { resources }),
    version: current.version,
  };
  const fields = [name === null ? null : 'name', description === null ? null : 'description', resources === null ? null : 'resources'];
  return { value, fields: fields.filter((f): f is string => f !== null) };
}

/** Each changed field, old → new; pins as the ones added (+) and the ones taken away (−). */
function updateRows(current: RecordValue, value: RecordValue): string[] {
  const rows: string[] = [];
  if (value.name !== current.name) rows.push(`Name: ${current.name} → ${value.name}`);
  if (value.description !== current.description) {
    rows.push(...textRows('Description was:', current.description), ...textRows('Description becomes:', value.description));
  }
  if (value.resources !== current.resources) {
    const before = new Set(current.resources.map(pinKey));
    const after = new Set(value.resources.map(pinKey));
    rows.push(
      'Resources:',
      ...value.resources.filter((p) => !before.has(pinKey(p))).map((p) => `+ ${pinKey(p)}`),
      ...current.resources.filter((p) => !after.has(pinKey(p))).map((p) => `− ${pinKey(p)}`),
    );
  }
  return rows;
}

/** What an update's `confirm` reviewed on a call's context: the version and the record its `run` must send. */
const updateReviews = new WeakMap<ToolContext, { version: number; digest: string }>();

const cloudProjectUpdate = defineTool({
  name: 'cloud_project_update',
  toolset: 'cloud',
  title: 'Change a project in AASC Cloud',
  description:
    'Changes a saved project’s name, description or the cloud resources it needs (resources replaces the whole list: ' +
    'each resource id once, with the version to pin). Pass at least one; a change to what it already is is INVALID. ' +
    `It rewrites the project’s record in the account for every device. ${CLOUD_RULES.global} ${CLOUD_RULES.waits} ` +
    'The card shows each field’s old and new value and the account; it runs only as that account, and if the project ' +
    'or the account changes before the person allows it nothing runs (call it again). A removed project is INVALID. ' +
    BUDGET_RULE,
  risk: 'outward',
  phase: 6,
  input: {
    id: CLOUD_ID,
    name: z.string().min(1).max(NAME_MAX).optional().describe('The new name.'),
    description: z.string().max(DESCRIPTION_MAX).optional().describe('The new description (line breaks are fine; empty clears it).'),
    resources: z
      .array(ResourceDependencySchema)
      .max(PINS_MAX)
      .refine((pins) => new Set(pins.map((p) => p.resourceId)).size === pins.length, 'Each resource once.')
      .optional()
      .describe('The whole list of resources the project needs, each { resourceId, version } once (it replaces the list).'),
  },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    globalOnly(ctx);
    if (args.name === undefined && args.description === undefined && args.resources === undefined) {
      throw new ToolError('INVALID', 'Nothing to change.', 'Pass name, description or resources.');
    }
    if (args.name !== undefined) checkName(args.name);
    if (args.description !== undefined) checkDescription(args.description);
    spendCloudCall(ctx);
    const account = await reviewAccount(ctx);
    const current = notRemoved(await readRecord(ctx, args.id, account.binding), 'changed');
    const { value, fields } = updated(current, args);
    if (fields.length === 0) throw new ToolError('INVALID', 'That is already so.', 'cloud_project_get shows the project as it is.');
    const digest = cardDigest(value);
    updateReviews.set(ctx, { version: current.version, digest });
    return {
      summary: `AASC Cloud: update project ${short(current.id)} (v${current.version}) as ${account.label}: ${fields.join(', ')}`,
      detail: cardDetail(updateRows(current, value)),
      fingerprint: `update:${current.id}:v${current.version}:${account.key}:${digest}`,
    };
  },
  async run(args, ctx): Promise<ToolResult> {
    const account = approvedAccount(ctx);
    const review = updateReviews.get(ctx);
    if (review === undefined) throw changedSinceCard();
    const current = notRemoved(await readRecord(ctx, args.id, account.binding), 'changed');
    const { value, fields } = updated(current, args);
    if (current.version !== review.version || cardDigest(value) !== review.digest) throw changedSinceCard();
    const sent = await cloudSend(ctx, 'put', `${CLOUD}/projects/${seg(args.id)}`, { mutationId: randomUUID(), baseVersion: current.version, value }, account.binding);
    const project = viewOf(cloudWriteBody(sent));
    return {
      data: { project },
      summary: `Changed the ${fields.join(', ')} of cloud project ${project.id}: it is v${project.version} now.`,
      activity: [
        {
          summary: `Changed cloud project ${short(project.id)}: ${fields.join(', ')}`,
          detail: { projectId: project.id, version: project.version, fields: fields.join(',') },
        },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_project_set_account and cloud_project_associate
// ---------------------------------------------------------------------------

/** A write's answer as cloud_project_local's view: `data.local`, its summary after the write's own lead. */
function localAnswer(id: string, body: unknown, lead: string): ToolResult {
  const view = localOf(id, body);
  return { data: { local: view.data }, summary: `${lead}\n${view.summary}` };
}

const cloudProjectSetAccount = defineTool({
  name: 'cloud_project_set_account',
  toolset: 'cloud',
  title: 'Choose a project’s GitHub account',
  description:
    'Chooses the GitHub account this Mac uses for a saved project (its clone, pull and push): a login the GitHub CLI ' +
    'is signed in with (cloud_project_accounts lists them), or null for this Mac’s own Git sign-in. It is a mark on this ' +
    'Mac only, and answers how this Mac now holds the project, as cloud_project_local does. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.newer} ${BUDGET_RULE}`,
  risk: 'write',
  phase: 6,
  input: {
    id: CLOUD_ID,
    login: z.string().regex(LOGIN).nullable().describe('A GitHub login (as cloud_project_accounts lists it), or null for this Mac’s own Git sign-in.'),
  },
  async run(args, ctx): Promise<ToolResult> {
    projectCall(ctx);
    const binding = await liveAccount(ctx);
    const sent = await cloudSend(ctx, 'put', `${CLOUD}/projects/${seg(args.id)}/account`, { login: args.login }, binding);
    const body = cloudWriteBody<unknown>(sent, {
      what: 'This build of AASC cannot choose a project’s GitHub account.',
      hint: 'cloud_project_local shows the account the project uses; the person can choose one in RESOURCES → Cloud.',
    });
    const lead = args.login === null ? 'This Mac now uses its own Git sign-in for the project.' : `This Mac now uses the GitHub account ${args.login} for the project.`;
    return {
      ...localAnswer(args.id, body, lead),
      activity: [{ summary: `Set the GitHub account of cloud project ${short(args.id)}`, detail: { projectId: args.id, login: args.login } }],
    };
  },
});

const cloudProjectAssociate = defineTool({
  name: 'cloud_project_associate',
  toolset: 'cloud',
  title: 'Link a folder to a project',
  description:
    'Links a folder on this Mac to a saved project: a git checkout of the project’s GitHub repository and branch, ' +
    'inside the person’s home folder and not in ~/Library or a hidden folder (any other is INVALID; a checkout of ' +
    'another remote or branch is refused with cloudCode checkout_mismatch). It is a mark on this Mac only, and answers ' +
    `how this Mac now holds the project, as cloud_project_local does. ${CLOUD_RULES.global} ${BUDGET_RULE}`,
  risk: 'write',
  phase: 6,
  input: { id: CLOUD_ID, folder: FOLDER },
  async run(args, ctx): Promise<ToolResult> {
    globalOnly(ctx);
    const folder = await cloudFolder(args.folder);
    spendCloudCall(ctx);
    const binding = await liveAccount(ctx);
    const body = cloudWriteBody<unknown>(await cloudSend(ctx, 'post', `${CLOUD}/projects/${seg(args.id)}/associate`, { path: folder }, binding));
    return {
      ...localAnswer(args.id, body, 'Linked the folder to the project on this Mac.'),
      activity: [{ summary: `Linked a folder to cloud project ${short(args.id)}`, detail: { projectId: args.id } }],
    };
  },
});

// ---------------------------------------------------------------------------
// cloud_project_remove
// ---------------------------------------------------------------------------

const NO_REMOVE = {
  what: 'This build of AASC cannot remove a project.',
  hint: 'Nothing was removed; the person can remove it in RESOURCES → Cloud on a newer build of AASC.',
};

const cloudProjectRemove = defineTool({
  name: 'cloud_project_remove',
  toolset: 'cloud',
  title: 'Remove a project from AASC Cloud',
  description:
    'Takes a saved project off the AASC Cloud account, for every device: no folder, checkout or GitHub repository is ' +
    'touched, and the resources it pinned stay in the account. An already removed project is INVALID. ' +
    `${CLOUD_RULES.global} ${CLOUD_RULES.waits} The card names the project, its version and the account; it runs only ` +
    'as that account, and if the project or the account changes before the person allows it nothing runs (call it ' +
    `again). ${CLOUD_RULES.newer} On an older build it is UNAVAILABLE before any card. ${BUDGET_RULE}`,
  risk: 'destructive',
  phase: 6,
  input: { id: CLOUD_ID },
  async confirm(args, ctx): Promise<ConfirmAsk> {
    projectCall(ctx);
    const account = await reviewAccount(ctx);
    const current = await readRecord(ctx, args.id, account.binding);
    if (current.deleted) throw new ToolError('INVALID', 'That project is already removed from the account.', 'cloud_project_list lists the projects the account holds.');
    // P6-11: a build with the remove route answers `/local` with a `path` key, null when there is no checkout here; the
    // branch's answer never has one (cloudMainShapes.ts LOCAL_BRANCH).
    const local = cloudWriteBody<unknown>(await readAs(ctx, `${CLOUD}/projects/${seg(args.id)}/local`, account.binding));
    if (!isRecord(local) || !('path' in local)) throw new ToolError('UNAVAILABLE', NO_REMOVE.what, NO_REMOVE.hint);
    return {
      summary:
        `AASC Cloud: remove project ${short(current.id)} (v${current.version}) from the account for every device as ` +
        `${account.label}: no folder, checkout or GitHub repository is touched`,
      detail: cardDetail([`Name: ${current.name}`, `Repository: ${repoText(current.repository)}`]),
      fingerprint: `remove:${current.id}:v${current.version}:${account.key}`,
    };
  },
  async run(args, ctx): Promise<ToolResult> {
    const account = approvedAccount(ctx);
    const sent = await cloudSend(ctx, 'post', `${CLOUD}/projects/${seg(args.id)}/remove`, {}, account.binding);
    const project = viewOf(cloudWriteBody(sent, NO_REMOVE));
    if (!project.deleted) {
      throw new ToolError('UPSTREAM', 'AASC Cloud did not say the project was removed.', 'cloud_project_get shows where it stands; tell the person.');
    }
    return {
      data: { id: project.id, version: project.version, deleted: true },
      summary: `Removed cloud project ${project.id} from the account (v${project.version}); no folder, checkout or GitHub repository was touched.`,
      activity: [{ summary: `Removed cloud project ${short(project.id)}`, detail: { projectId: project.id, version: project.version } }],
    };
  },
});

export const cloudProjectWriteTools: readonly ToolDef[] = [
  cloudProjectCreate,
  cloudProjectUpdate,
  cloudProjectSetAccount,
  cloudProjectAssociate,
  cloudProjectRemove,
];
