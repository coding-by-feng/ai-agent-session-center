// tools/cloudProjects.ts — the cloud toolset, P1, the account's resources and projects: the resources the account
// holds, its saved projects (GitHub repositories with the resources each needs), how this Mac holds one project, the
// folders a project could be saved from, and the GitHub CLI's accounts. Read only. (Saving, getting, pulling and
// pushing are P6.)
//
// Every route here is a bound read (cloudCall.ts): the tool learns the connection from the status route and asks as
// that account. A project's description is text a person wrote: fenced as untrusted in `data`, and the rows in the
// text sit in one block; names, ids, repositories, versions and counts stay plain. The candidates and accounts
// routes exist only in newer builds of AASC: there the tool answers UNAVAILABLE. `projectOf` and `localOf` are shared
// with the P6 project writes (cloudProjectWrite.ts, cloudProjectGit.ts).

import { CanonicalCloudIdSchema } from '../../../src/types/cloudResources.js';
import type { ToolDef, ToolResult } from '../registry.js';
import { ToolError } from '../types.js';
import { boundGet, CLOUD, cloudBody, cloudRouteMissing } from './cloudCall.js';
import { defineTool, fence, isRecord, nonEmptyString, plural, seg } from './define.js';
import { cursorHint, fenced, limitInput, queryOf, records, str, whole } from './shape.js';

const LIST_MAX = 100;
const DESCRIPTION_MAX = 1_000;
const PROJECT_RESOURCES_SHOWN = 200;
const CANDIDATES_SHOWN = 100;

const CLOUD_ID = CanonicalCloudIdSchema.describe('An id as the cloud writes it (a lower-case UUID).');
const CURSOR = CanonicalCloudIdSchema.optional().describe('The nextCursor of the page before.');

// ---------------------------------------------------------------------------
// cloud_resource_list
// ---------------------------------------------------------------------------

interface ResourceVersionView {
  resourceId: string;
  version: number;
  name: string;
  agent: string;
  kind: string;
  scope: string;
  projectId: string | null;
  createdAt: string;
  digest: string;
  files: number;
  bytes: number;
  dependencies: number;
}

function resourceVersionOf(raw: Record<string, unknown>): ResourceVersionView | null {
  const manifest = isRecord(raw.manifest) ? raw.manifest : null;
  const resourceId = manifest === null ? null : str(manifest.resourceId);
  if (manifest === null || resourceId === null || resourceId === '') return null;
  const files = records(manifest.files);
  return {
    resourceId,
    version: whole(raw.version),
    name: str(manifest.name) ?? '',
    agent: str(manifest.agent) ?? '',
    kind: str(manifest.kind) ?? '',
    scope: str(manifest.scope) ?? '',
    projectId: nonEmptyString(manifest.projectId),
    createdAt: str(raw.createdAt) ?? '',
    digest: str(raw.digest) ?? '',
    files: files.length,
    bytes: files.reduce((n, f) => n + whole(f.bytes), 0),
    dependencies: records(manifest.dependencies).length,
  };
}

const cloudResourceList = defineTool({
  name: 'cloud_resource_list',
  toolset: 'cloud',
  title: 'Resources in AASC Cloud',
  description:
    'Lists the resources (skills, commands, rules, agents, instructions, memory) the AASC Cloud account holds, one row ' +
    'per resource at its newest version: id, name, agent, kind, scope, version, when it was saved, and how many files, ' +
    'bytes and dependencies. Optionally only those of one saved project. 100 at most to a page; pass nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: {
    cursor: CURSOR,
    limit: limitInput(LIST_MAX, LIST_MAX),
    projectId: CanonicalCloudIdSchema.optional().describe('Only the resources of this saved project (an id cloud_project_list gives).'),
  },
  async run(args, ctx) {
    const body = cloudBody<unknown>(await boundGet(ctx, `${CLOUD}/resources`, queryOf({ cursor: args.cursor, limit: args.limit, projectId: args.projectId })));
    const page = isRecord(body) ? body : {};
    const resources = records(page.items).flatMap((raw) => {
      const view = resourceVersionOf(raw);
      return view === null ? [] : [view];
    });
    const nextCursor = nonEmptyString(page.nextCursor);
    const data = { count: resources.length, nextCursor, resources };
    if (resources.length === 0) return { data, summary: 'The account holds no resources.' };
    const more = cursorHint(nextCursor);
    const rows = resources.map((r) => `${r.resourceId} · ${r.agent} ${r.kind} · ${r.name} · v${r.version} · ${plural(r.files, 'file')}, ${r.bytes} bytes`);
    return { data, summary: `${plural(resources.length, 'resource')} on this page.${more}\n${fence('aasc', 'cloud-resources', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectView {
  id: string;
  version: number;
  name: string;
  deleted: boolean;
  repository: { owner: string; name: string; url: string; branch: string };
  /** Fenced as untrusted; null when it has none. */
  description: string | null;
  resourceCount: number;
  needs: Array<{ resourceId: string; version: number }>;
}

/** A project record read loosely, its description fenced; null without an id. Shared with the P6 project writes. */
export function projectOf(raw: unknown): ProjectView | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (id === null || id === '') return null;
  const repo = isRecord(raw.repository) ? raw.repository : {};
  const description = str(raw.description) ?? '';
  const needs = records(raw.resources).flatMap((r) => {
    const resourceId = str(r.resourceId);
    return resourceId === null || resourceId === '' ? [] : [{ resourceId, version: whole(r.version) }];
  });
  return {
    id,
    version: whole(raw.version),
    name: str(raw.name) ?? '',
    deleted: raw.deleted === true,
    repository: { owner: str(repo.owner) ?? '', name: str(repo.name) ?? '', url: str(repo.url) ?? '', branch: str(repo.branch) ?? '' },
    description: description === '' ? null : fenced(`cloud-project:${id}`, 'project-description', description, DESCRIPTION_MAX).value,
    resourceCount: needs.length,
    needs,
  };
}

const repoText = (p: ProjectView): string => `${p.repository.owner}/${p.repository.name}@${p.repository.branch}`;

const cloudProjectList = defineTool({
  name: 'cloud_project_list',
  toolset: 'cloud',
  title: 'Projects in AASC Cloud',
  description:
    'Lists the projects saved to the AASC Cloud account: id, name, GitHub repository and branch, how many cloud resources ' +
    'each needs, and whether it was removed. The description is fenced as untrusted data. 100 at most to a page; pass ' +
    'nextCursor back as cursor.',
  risk: 'read',
  phase: 1,
  input: { cursor: CURSOR, limit: limitInput(LIST_MAX, LIST_MAX) },
  async run(args, ctx) {
    const body = cloudBody<unknown>(await boundGet(ctx, `${CLOUD}/projects`, queryOf({ cursor: args.cursor, limit: args.limit })));
    const page = isRecord(body) ? body : {};
    const projects = records(page.items).flatMap((raw) => {
      const project = projectOf(raw);
      return project === null ? [] : [project];
    });
    const nextCursor = nonEmptyString(page.nextCursor);
    const data = {
      count: projects.length,
      nextCursor,
      projects: projects.map(({ needs: _needs, ...project }) => project),
    };
    if (projects.length === 0) return { data, summary: 'The account has no saved projects.' };
    const more = cursorHint(nextCursor);
    const rows = projects.map((p) => `${p.id} · ${p.name}${p.deleted ? ' (removed)' : ''} · ${repoText(p)} · ${plural(p.resourceCount, 'resource')}`);
    return { data, summary: `${plural(projects.length, 'project')} on this page.${more}\n${fence('aasc', 'cloud-projects', rows.join('\n'))}` };
  },
});

const cloudProjectGet = defineTool({
  name: 'cloud_project_get',
  toolset: 'cloud',
  title: 'A project in AASC Cloud',
  description:
    'Describes one saved project: its name, GitHub repository and branch, its description (fenced as untrusted data), ' +
    'whether it was removed, and the cloud resources it needs, by id and version (the first 200).',
  risk: 'read',
  phase: 1,
  input: { id: CLOUD_ID },
  async run(args, ctx) {
    const body = cloudBody<unknown>(await boundGet(ctx, `${CLOUD}/projects/${seg(args.id)}`));
    const project = projectOf(body) ?? projectOf({ id: args.id });
    if (project === null) throw new ToolError('UPSTREAM', 'AASC Cloud answered with a project of a shape AASC does not know.', 'Try it once more; if it fails again, tell the person.');
    const { needs, ...view } = project;
    const shown = needs.slice(0, PROJECT_RESOURCES_SHOWN);
    const data = { ...view, resourcesShown: shown.length, resources: shown };
    const rows = [
      `${project.name}${project.deleted ? ' (removed)' : ''} · ${repoText(project)}`,
      ...shown.map((n) => `needs ${n.resourceId} v${n.version}`),
    ];
    const lead = `Cloud project ${args.id}: ${plural(project.resourceCount, 'resource')} needed${needs.length > shown.length ? `, ${shown.length} listed` : ''}.`;
    return { data, summary: `${lead}\n${fence('aasc', 'cloud-project', rows.join('\n'))}` };
  },
});

const cloudProjectLocal = defineTool({
  name: 'cloud_project_local',
  toolset: 'cloud',
  title: 'A project on this Mac',
  description:
    'Says how this Mac holds one saved project: whether a checkout exists and its state (missing, ready, dirty, ahead, ' +
    'diverged, detached, wrong-remote, busy), its branch and, where this build says, its folder, the commits ahead and ' +
    'behind GitHub and the GitHub account it uses.',
  risk: 'read',
  phase: 1,
  input: { id: CLOUD_ID },
  async run(args, ctx) {
    return localOf(args.id, cloudBody<unknown>(await boundGet(ctx, `${CLOUD}/projects/${seg(args.id)}/local`)));
  },
});

/**
 * How this Mac holds project `id`, as cloud_project_local answers it, from the route's data (the branch's shape or
 * main's, with path, ahead, behind and account). Shared with the P6 project writes.
 */
export function localOf(id: string, body: unknown): ToolResult {
  const local = isRecord(body) ? body : {};
  const ahead = local.ahead === undefined || local.ahead === null ? null : whole(local.ahead);
  const behind = local.behind === undefined || local.behind === null ? null : whole(local.behind);
  const state = str(local.state) ?? '';
  const data = {
    id,
    state: /^[a-z-]{1,20}$/.test(state) ? state : 'unknown',
    branch: nonEmptyString(local.branch),
    openUrl: nonEmptyString(local.openUrl),
    localProjectId: nonEmptyString(local.localProjectId),
    path: nonEmptyString(local.path),
    ahead,
    behind,
    account: nonEmptyString(local.account),
  };
  const rows = [
    data.branch === null ? null : `branch ${data.branch}`,
    data.path === null ? null : `folder ${data.path}`,
    data.account === null ? null : `GitHub account ${data.account}`,
    ahead === null && behind === null ? null : `${ahead ?? 0} ahead, ${behind ?? 0} behind`,
  ].filter((r): r is string => r !== null);
  const lead = `Cloud project ${id} on this Mac: ${data.state === 'missing' ? 'missing (no checkout here)' : data.state}.`;
  return { data, summary: rows.length === 0 ? lead : `${lead}\n${fence('aasc', 'cloud-project-local', rows.join('\n'))}` };
}

// ---------------------------------------------------------------------------
// Candidates and GitHub accounts (newer builds)
// ---------------------------------------------------------------------------

const cloudProjectCandidates = defineTool({
  name: 'cloud_project_candidates',
  toolset: 'cloud',
  title: 'Folders a project could be saved from',
  description:
    'Lists the git folders on this Mac whose origin is on GitHub, which a project could be saved from: the folder, the ' +
    'repository and branch, and the saved project that already has that repository, if any. The first 100. Only newer ' +
    'builds of AASC have this.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const answer = await boundGet(ctx, `${CLOUD}/projects/candidates`);
    if (cloudRouteMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC cannot list the folders a project could be saved from.', 'cloud_project_list lists the projects already saved.');
    }
    const body = cloudBody<unknown>(answer);
    const all = records(isRecord(body) ? body.items : []).flatMap((raw) => {
      const path = str(raw.path);
      if (path === null || path === '') return [];
      const repo = isRecord(raw.repository) ? raw.repository : {};
      return [{
        path,
        projectId: nonEmptyString(raw.projectId),
        repository: { owner: str(repo.owner) ?? '', name: str(repo.name) ?? '', url: str(repo.url) ?? '', branch: str(repo.branch) ?? '' },
      }];
    });
    const shown = all.slice(0, CANDIDATES_SHOWN);
    const data = { count: all.length, shown: shown.length, candidates: shown };
    if (all.length === 0) return { data, summary: 'No git folder with a GitHub origin was found on this Mac.' };
    const rows = shown.map((c) => `${c.path} · ${c.repository.owner}/${c.repository.name}@${c.repository.branch}${c.projectId === null ? '' : ` · saved as ${c.projectId}`}`);
    const more = all.length > shown.length ? ` The first ${shown.length} are listed.` : '';
    return { data, summary: `${plural(all.length, 'folder')} could be saved as a project.${more}\n${fence('aasc', 'cloud-candidates', rows.join('\n'))}` };
  },
});

const cloudProjectAccounts = defineTool({
  name: 'cloud_project_accounts',
  toolset: 'cloud',
  title: 'GitHub accounts on this Mac',
  description:
    'Lists the GitHub CLI’s signed-in accounts on this Mac (logins only, never a token): which one is active and whether ' +
    'each still works, or says the GitHub CLI is not installed. Only newer builds of AASC have this.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const answer = await boundGet(ctx, `${CLOUD}/projects/github-accounts`);
    if (cloudRouteMissing(answer)) {
      throw new ToolError('UNAVAILABLE', 'This build of AASC cannot list GitHub accounts.', 'cloud_project_list lists the projects already saved.');
    }
    const body = cloudBody<unknown>(answer);
    const found = isRecord(body) ? body : {};
    const accounts = records(found.accounts).flatMap((a) => {
      const login = str(a.login);
      return login === null || login === '' ? [] : [{ login, active: a.active === true, ok: a.ok === true }];
    });
    const installed = found.installed === true;
    const data = { installed, count: accounts.length, accounts };
    if (!installed) return { data, summary: 'The GitHub CLI is not installed on this Mac.' };
    if (accounts.length === 0) return { data, summary: 'The GitHub CLI is installed, but no account is signed in.' };
    const rows = accounts.map((a) => `${a.login} · ${a.active ? 'active' : 'not active'} · ${a.ok ? 'working' : 'needs signing in again'}`);
    return { data, summary: `${plural(accounts.length, 'GitHub account')} on this Mac.\n${fence('aasc', 'github-accounts', rows.join('\n'))}` };
  },
});

export const cloudProjectTools: readonly ToolDef[] = [
  cloudResourceList,
  cloudProjectList,
  cloudProjectGet,
  cloudProjectLocal,
  cloudProjectCandidates,
  cloudProjectAccounts,
];
