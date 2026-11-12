/** Metadata comes first; local checkout mappings never cross the backend boundary. */
import { randomUUID, createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import {
  ProjectRecordSchema,
  ProjectMutationSchema,
  ProjectListSchema,
  GetProjectSchema,
  GithubLoginSchema,
  type LocalProject,
  type ProjectCandidate,
  type ProjectFolders,
  type ProjectRecord,
  type GetProjectInput,
  type CheckoutState,
} from '../../src/types/cloudProjects.js';
import {
  ResourceDependencySchema,
  type CloudJob,
  type InstallDecisions,
} from '../../src/types/cloudResources.js';
import { assertCloudBinding, accountKey, abortCheck, type CloudBinding } from './binding.js';
import { CloudError, type CloudConnector } from './types.js';
import type { ResourceJobs } from './resourceJobs.js';
import {
  createGitOperations,
  type GitAccount,
  type GitOperations,
  type CloneIntent,
} from './git.js';
import { createGithubAccounts, type GithubAccountsService } from './githubAccounts.js';
import { safeError } from './jobRunners.js';
import { assertSafeFolderName, confinedProjectPath } from './projectPaths.js';
import { githubFolders, rankFolders, scanFolders } from './projectFolders.js';
import { createProjectMeta } from './projectMeta.js';
import type { ProjectActivity } from '../knownProjects.js';
export interface CheckoutMapping {
  projectId: string;
  canonicalRemote: string;
  localRoot: string;
  branch: string;
  localProjectId: string;
  version: number;
}
interface ProjectInput {
  project: ProjectRecord;
  destination: string;
  transport: 'https' | 'ssh';
  refs: GetProjectInput['resourceVersions'];
  /** The GitHub login chosen for this project here (AASC-63); resolved when the job runs. */
  account?: string;
  errorCode?: string;
  cloneIntent?: CloneIntent;
  resourcePlanId?: string;
  resourceJobId?: string;
  decisions?: InstallDecisions;
}
export interface ProjectJobsOptions {
  cloud: CloudConnector;
  resources: ResourceJobs;
  git?: GitOperations;
  activeProjectPaths?: () => string[];
  /** The home folder project paths are confined to (projectPaths.ts). Default os.homedir(). */
  home?: string;
  /** Folders "Save a project" looks at for a GitHub origin: the catalog's projects (AASC-63). */
  candidatePaths?: () => string[];
  /** The GitHub CLI's accounts. Default: the real CLI. */
  accounts?: GithubAccountsService;
  /** Sessions per folder over the last 30 days: the Projects tab ranks folders by it. */
  projectActivity?: () => readonly ProjectActivity[];
  /** Resolves once candidatePaths can answer: the catalog's first scan after a start. */
  candidatesReady?: () => Promise<void>;
}
const PROJECT_JOB_KINDS = ['get-project', 'pull-project', 'push-project'];
/** How long one scan of the candidate folders answers the folders list and auto-linking. */
const CANDIDATE_CACHE_MS = 30_000;
/** An automatic Check (the Projects tab opening) skips a project fetched this recently. */
const AUTO_CHECK_FRESH_MS = 10 * 60_000;
/** Saving or linking a folder records metadata only: a live agent working in it does not block it. */
const LINK_CHECK = { ignoreAgents: true } as const;
/** Why a folder cannot be linked, in the words the Projects tab shows next to it (Oct 26 2026). */
const UNLINKABLE: Partial<Record<CheckoutState, string>> = {
  missing: 'That folder is no longer on this Mac. Refresh the list.',
  'wrong-remote':
    "That folder's GitHub remote or branch no longer matches. Refresh the list and try again.",
  detached: 'That folder is not on a branch. Switch it to a branch, then save.',
  busy: 'A Git operation (merge, rebase or lock) is in progress in that folder. Finish it, then save.',
};
function refuseUnlinkable(state: CheckoutState) {
  const reason = UNLINKABLE[state];
  if (reason) throw new CloudError('checkout_mismatch', reason, 409);
}
export async function createProjectJobs(options: ProjectJobsOptions) {
  const { cloud, resources } = options,
    store = resources.store,
    home = options.home ?? homedir(),
    accounts =
      options.accounts ??
      createGithubAccounts({ untrusted: () => options.candidatePaths?.() ?? [] });
  const git =
    options.git ??
    (await createGitOperations({
      directory: join(store.directory, 'git'),
      activeProjectPaths: options.activeProjectPaths,
    }));
  const bind = (b: CloudBinding) => assertCloudBinding(cloud, b);
  const key = (id: string, b: CloudBinding) => JSON.stringify([accountKey(b), z.uuid().parse(id)]);
  const mapping = (id: string, b: CloudBinding) =>
    store.get<CheckoutMapping>('checkout', key(id, b));
  const controllers = new Map<string, AbortController>(),
    running = new Map<string, Promise<void>>();
  /** When each project was last fetched (or tried) here, so an automatic Check skips a fresh one. */
  const fetchedAt = new Map<string, number>();
  // Previews can await metadata/filesystem work while another request starts or changes a job.
  // Count every owner save so even a change-and-return-to-same-state invalidates the old preview.
  const jobRevisions = new Map<string, number>();
  const saveJob = (...args: Parameters<typeof store.saveJob>) => {
    store.saveJob(...args);
    jobRevisions.set(args[0].id, (jobRevisions.get(args[0].id) ?? 0) + 1);
  };
  let queue = Promise.resolve();
  const localId = (path: string) =>
    `${basename(path)}-${createHash('sha1').update(path).digest('hex').slice(0, 8)}`;
  async function listProjects(query: { cursor?: string; limit?: number }, binding: CloudBinding) {
    bind(binding);
    const q = z
      .object({ cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100).optional() })
      .strict()
      .parse(query);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) params.set(k, String(v));
    const data = ProjectListSchema.parse(
      await cloud.client.request('GET', '/v1/projects' + (params.size ? '?' + params : '')),
    );
    bind(binding);
    for (const p of data.items) store.put('project-record', key(p.id, binding), p);
    return data;
  }
  /** The first live saved project the cloud lists that `match` takes, or null. */
  async function findRecord(binding: CloudBinding, match: (p: ProjectRecord) => boolean) {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const page = await listProjects({ limit: 100, ...(cursor ? { cursor } : {}) }, binding);
      const p = page.items.find((p) => !p.deleted && match(p));
      if (p) return p;
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor))
        throw new CloudError('invalid_response', 'Project pagination is invalid.', 502);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return null;
  }
  async function getRecord(id: string, binding: CloudBinding) {
    bind(binding);
    z.uuid().parse(id);
    const p = await findRecord(binding, (p) => p.id === id);
    if (!p) throw new CloudError('not_found', 'Cloud project was not found.', 404);
    return p;
  }
  const linkTaken = () =>
    new CloudError(
      'association_conflict',
      'This project or local checkout already has a different mapping.',
      409,
    );
  /** This project's checkout mapping here, unless its folder is gone (moved or deleted). */
  async function liveMapping(id: string, binding: CloudBinding) {
    const m = mapping(id, binding);
    return m && (await lstat(m.localRoot).catch(() => null)) ? m : null;
  }
  /** Removed here (its record says so) or on another device (the cloud has no record of it). */
  async function projectGone(id: string, binding: CloudBinding) {
    if (store.get<ProjectRecord>('project-record', key(id, binding))?.deleted) return true;
    try {
      await getRecord(id, binding);
      return false;
    } catch (e) {
      if (e instanceof CloudError && e.code === 'not_found') return true;
      throw e;
    }
  }
  /**
   * Linking `path` to `project` would take a link still in use: the folder is another live
   * project's checkout, or the project's checkout is another folder that is still there. A link
   * to a project that is gone, or to a folder that is gone, gives way (code review, Oct 29 2026).
   */
  async function linkConflict(project: ProjectRecord, path: string, binding: CloudBinding) {
    const prior = resources.projectAssociation(localId(path), binding);
    if (
      prior &&
      prior.cloudProjectId !== project.id &&
      !(await projectGone(prior.cloudProjectId, binding))
    )
      return true;
    const mapped = mapping(project.id, binding);
    return !!mapped && mapped.localRoot !== path && !!(await liveMapping(project.id, binding));
  }
  /** This Mac forgets a project's checkout: its mapping and that folder's association. */
  function forgetLink(id: string, binding: CloudBinding) {
    const m = mapping(id, binding);
    if (m) store.dissociateProject(binding, m.localProjectId);
    store.remove('checkout', key(id, binding));
  }
  async function associateChecked(project: ProjectRecord, path: string, binding: CloudBinding) {
    bind(binding);
    await confinedProjectPath(path, home);
    refuseUnlinkable((await git.inspectCheckout(path, project, LINK_CHECK)).state);
    const id = localId(path);
    if (await linkConflict(project, path, binding)) throw linkTaken();
    // What is left is a link to a project that is gone, or this project's to a folder that is gone.
    const prior = resources.projectAssociation(id, binding);
    if (prior && prior.cloudProjectId !== project.id) forgetLink(prior.cloudProjectId, binding);
    const mapped = mapping(project.id, binding);
    if (mapped && mapped.localRoot !== path) forgetLink(project.id, binding);
    await resources.associateProject(
      { cloudProjectId: project.id, localProjectId: id, path, version: project.version },
      binding,
    );
    bind(binding);
    const value: CheckoutMapping = {
      projectId: project.id,
      canonicalRemote: project.repository.url,
      localRoot: path,
      branch: project.repository.branch,
      localProjectId: id,
      version: project.version,
    };
    store.put('checkout', key(project.id, binding), value);
    store.put('project-record', key(project.id, binding), project);
    return value;
  }
  let associationQueue = Promise.resolve();
  function associate(project: ProjectRecord, path: string, binding: CloudBinding) {
    const work = associationQueue.then(() => associateChecked(project, path, binding));
    associationQueue = work.then(
      () => {},
      () => {},
    );
    return work;
  }
  function ensureNoActiveProject(id: string, binding: CloudBinding) {
    if (
      store
        .list<import('./jobStore.js').SavedJob>('job')
        .some(
          (s) =>
            PROJECT_JOB_KINDS.includes(s.job.kind) &&
            ['queued', 'running'].includes(s.job.state) &&
            accountKey(s.binding) === accountKey(binding) &&
            (s.private as ProjectInput).project.id === id,
        )
    )
      throw new CloudError('busy', 'Wait for this project job to finish or cancel it first.', 409);
  }
  function saved(id: string) {
    const s = store.getJob(z.uuid().parse(id));
    if (!s || !PROJECT_JOB_KINDS.includes(s.job.kind))
      throw new CloudError('not_found', 'Project job was not found.', 404);
    return s;
  }
  /** A job driven with a reviewed binding: another backend+account's job is a missing one. */
  function owned(id: string, binding: CloudBinding) {
    bind(binding);
    const s = saved(id);
    if (accountKey(s.binding) !== accountKey(binding))
      throw new CloudError('not_found', 'Project job was not found.', 404);
    return s;
  }
  /** Every write through a saved mapping re-checks today's folder rule first. */
  async function confinedMapping(m: CheckoutMapping) {
    await confinedProjectPath(m.localRoot, home);
    return m;
  }
  function dispatch(job: CloudJob, input: ProjectInput, binding: CloudBinding) {
    const c = new AbortController(),
      detach = cloud.onStop(() => c.abort());
    controllers.set(job.id, c);
    const check = () => {
      abortCheck(c.signal);
      bind(binding);
    };
    const save = () => saveJob(job, binding, input);
    const work = queue.then(async () => {
      try {
        check();
        job.state = 'running';
        save();
        const step = job.steps.find((s) => s.id === 'git')!;
        if (step.state !== 'complete') {
          if (job.kind === 'pull-project')
            job.steps.find((s) => s.id === 'fetch')!.state = 'running';
          else step.state = 'running';
          save();
          await resources.enqueue(async () => {
            check();
            const account = input.account ? await accounts.account(input.account) : undefined;
            check();
            if (job.kind === 'push-project')
              await git.push(input.destination, input.project, c.signal, check, account);
            else if (job.kind === 'get-project') {
              if (input.cloneIntent)
                await git.recoverPublishedClone(
                  input.destination,
                  input.project,
                  input.cloneIntent,
                  check,
                );
              else
                await git.clone(
                  input.destination,
                  input.project,
                  input.transport,
                  c.signal,
                  check,
                  (intent) => {
                    input.cloneIntent = intent;
                    save();
                  },
                  account,
                );
            } else
              await git.pull(
                input.destination,
                input.project,
                c.signal,
                check,
                () => {
                  job.steps.find((s) => s.id === 'fetch')!.state = 'complete';
                  step.state = 'running';
                  save();
                },
                account,
              );
            check();
            await associate(input.project, input.destination, binding);
            // Clone, Pull and Push each leave refs/remotes current: the tab's next Check skips it.
            fetchedAt.set(key(input.project.id, binding), Date.now());
            if (job.kind === 'get-project') rescan();
          });
          step.state = 'complete';
          save();
        }
        if (input.refs.length) {
          const step = job.steps[1];
          step.state = 'running';
          save();
          check();
          const m = mapping(input.project.id, binding);
          if (!m)
            throw new CloudError(
              'project_mapping_required',
              'Map this checkout before installing resources.',
              409,
            );
          // One combined closure/overlap review precedes every resource write.
          const plan = input.resourcePlanId
            ? store.get<{ public: import('../../src/types/cloudResources.js').InstallPlan }>(
                'install-plan',
                input.resourcePlanId,
              )?.public
            : await resources.planInstallMany(
                { refs: input.refs, localProjectId: m.localProjectId },
                binding,
              );
          if (!plan)
            throw new CloudError('review_required', 'Review the project resources again.', 409);
          input.resourcePlanId = plan.id;
          save();
          check();
          if (plan.items.some((i) => i.action === 'blocked'))
            throw new CloudError(
              'installation_blocked',
              'Resolve conflicting or blocked project resources and review again.',
              409,
            );
          const child = await resources.runInstall(plan.id, input.decisions ?? {}, binding);
          input.resourceJobId = child.id;
          save();
          const stop = () => resources.cancel(child.id);
          c.signal.addEventListener('abort', stop, { once: true });
          let result;
          try {
            if (c.signal.aborted) resources.cancel(child.id);
            check();
            result = await resources.wait(child.id);
          } finally {
            c.signal.removeEventListener('abort', stop);
          }
          check();
          if (result.state !== 'complete' || result.steps.some((s) => s.state !== 'complete'))
            throw new CloudError(
              'resource_install_failed',
              'Checkout is ready; some resources still need attention.',
              409,
            );
          step.state = 'complete';
          if (result.steps.some((s) => s.attention))
            step.attention = 'Resources installed; catalog or alias follow-up needs attention.';
          save();
        }
        if (!input.refs.length) {
          const skipped = job.steps.find((s) => s.id === 'resources');
          if (skipped) skipped.state = 'skipped';
        }
        job.state = 'complete';
      } catch (e) {
        input.errorCode = e instanceof CloudError ? e.code : 'local_error';
        const step =
          job.steps.find((s) => s.state === 'running') ??
          job.steps.find((s) => s.state === 'pending');
        if (step) {
          step.state = 'failed';
          step.error = safeError(e);
        }
        job.state = c.signal.aborted
          ? 'cancelled'
          : job.steps.some((s) => s.state === 'complete')
            ? 'partial'
            : 'failed';
      } finally {
        save();
        detach();
        controllers.delete(job.id);
        running.delete(job.id);
      }
    });
    queue = work.catch(() => {});
    running.set(job.id, work);
  }
  const accountFor = (id: string, binding: CloudBinding) =>
    store.get<string>('project-account', key(id, binding));
  // Listing the projects asks each unlinked one to link itself, and the tab lists the folders on
  // every visit: one scan serves them all for a little while ("Save a project" reads fresh, and a
  // Save, Link, Remove or Clone reads them again). With no connection the folders route needs no
  // binding, so asks with none share one scan too (security review, Oct 29 2026).
  let scanned: { at: number; account: string; found: ReturnType<typeof scanAll> } | null = null;
  function cachedScan(binding: CloudBinding | null) {
    const account = binding ? accountKey(binding) : '';
    if (!scanned || scanned.account !== account || Date.now() - scanned.at > CANDIDATE_CACHE_MS)
      scanned = { at: Date.now(), account, found: scanAll(binding) };
    const current = scanned;
    current.found.catch(() => {
      if (scanned === current) scanned = null;
    });
    return current.found;
  }
  const cachedCandidates = async (binding: CloudBinding) =>
    githubFolders(await cachedScan(binding));
  /** A link changed: the next list reads the folders again. */
  const rescan = () => {
    scanned = null;
  };
  /** Every catalog folder on this device (projectFolders.ts), each matched with its saved project. */
  /** Without a binding (no connection) no folder is matched to a saved project. */
  async function scanAll(binding: CloudBinding | null) {
    await options.candidatesReady?.();
    const found = await scanFolders({
      paths: options.candidatePaths?.() ?? [],
      home,
      saved: binding
        ? store.valuesFor<ProjectRecord>('project-record', binding).filter((p) => !p.deleted)
        : [],
      readOrigin: (root) => git.readOrigin(root),
    });
    if (binding) bind(binding);
    return found;
  }
  const meta = createProjectMeta(cloud);
  /**
   * A saved project with no checkout mapped here links itself to the one folder on this device
   * with its repository and branch, so no device ever picks a folder by hand. None, or more than
   * one, and it stays "not on this device".
   */
  async function autoLink(id: string, binding: CloudBinding) {
    const p = store.get<ProjectRecord>('project-record', key(id, binding));
    if (!p || p.deleted || !options.candidatePaths) return null;
    const matches = (await cachedCandidates(binding)).filter(
      (c) => c.repository.url === p.repository.url && c.repository.branch === p.repository.branch,
    );
    if (matches.length !== 1) return null;
    try {
      return await associate(p, matches[0].path, binding);
    } catch {
      return null;
    }
  }
  function start(
    kind: 'get-project' | 'pull-project' | 'push-project',
    input: ProjectInput,
    binding: CloudBinding,
  ) {
    bind(binding);
    const job: CloudJob = {
      id: randomUUID(),
      kind,
      state: 'queued',
      steps: [
        ...(kind === 'pull-project'
          ? [{ id: 'fetch', label: 'Fetch allowed branch', state: 'pending' as const }]
          : []),
        {
          id: 'git',
          label:
            kind === 'get-project'
              ? 'Clone from GitHub'
              : kind === 'push-project'
                ? 'Push commits to GitHub'
                : 'Fast-forward checkout',
          state: 'pending',
        },
        ...(input.refs.length
          ? [{ id: 'resources', label: 'Install selected resources', state: 'pending' as const }]
          : []),
      ],
    };
    saveJob(job, binding, input);
    dispatch(job, input, binding);
    return job;
  }
  const api = {
    listProjects,
    getRecord,
    async saveProject(
      mutation: z.infer<typeof ProjectMutationSchema>,
      binding: CloudBinding,
      local?: { path: string },
    ) {
      bind(binding);
      const body = ProjectMutationSchema.parse(mutation);
      if (
        body.value.deleted ||
        (body.baseVersion === null
          ? body.value.version !== 1
          : body.value.version !== body.baseVersion)
      )
        throw new CloudError('invalid_request', 'Use the reviewed project revision.', 400);
      // A folder to link is checked before anything reaches the cloud: a refused folder leaves
      // no record behind (security review, Oct 23 2026), nor one still another project's
      // checkout (code review, Oct 29 2026). The link itself still runs after.
      if (local) {
        await confinedProjectPath(local.path, home);
        refuseUnlinkable((await git.inspectCheckout(local.path, body.value, LINK_CHECK)).state);
        if (await linkConflict(body.value, local.path, binding)) throw linkTaken();
        bind(binding);
      }
      // One record per repository and branch: a second would stand for the same checkout. Read
      // from the cloud, since a project removed on another device is still stored here.
      const { url, branch } = body.value.repository;
      const twin =
        body.baseVersion === null &&
        (await findRecord(
          binding,
          (r) => r.id !== body.value.id && r.repository.url === url && r.repository.branch === branch,
        ));
      bind(binding);
      if (twin)
        throw new CloudError(
          'already_saved',
          `${twin.name} is already saved with this repository and branch.`,
          409,
        );
      const p = ProjectRecordSchema.parse(
        await cloud.client.request(
          body.baseVersion === null ? 'POST' : 'PUT',
          body.baseVersion === null ? '/v1/projects' : `/v1/projects/${body.value.id}`,
          body,
        ),
      );
      bind(binding);
      if (p.id !== body.value.id || p.version !== (body.baseVersion ?? 0) + 1 || p.deleted)
        throw new CloudError('invalid_response', 'Project acknowledgment is invalid.', 502);
      store.put('project-record', key(p.id, binding), p);
      rescan();
      if (local) await associate(p, local.path, binding);
      return p;
    },
    async associateProject(id: string, path: string, binding: CloudBinding) {
      bind(binding);
      const real = await confinedProjectPath(path, home);
      const p = await getRecord(id, binding);
      await associate(p, real, binding);
      rescan();
      return api.localProject(id, binding);
    },
    async localProject(id: string, binding: CloudBinding): Promise<LocalProject> {
      bind(binding);
      const account = accountFor(id, binding);
      // A checkout moved or deleted here holds the project no longer: the folder left with its
      // repository links by itself, as on a new device (code review, Oct 29 2026).
      const m = (await liveMapping(id, binding)) ?? (await autoLink(id, binding));
      if (!m)
        return {
          state: 'missing',
          branch: null,
          openUrl: null,
          localProjectId: null,
          path: null,
          ahead: null,
          behind: null,
          account,
          agentActive: false,
        };
      const p = store.get<ProjectRecord>('project-record', key(id, binding));
      if (!p) throw new CloudError('review_required', 'Refresh project metadata.', 409);
      // The Git state reads past a live agent (Oct 29 2026): the folders agents work in are the
      // recent ones, and "In use" told nothing. Pull and Push still refuse while one works there.
      const state = await git.inspectCheckout(m.localRoot, p, LINK_CHECK);
      bind(binding);
      return {
        ...state,
        agentActive: git.agentActive(m.localRoot),
        openUrl:
          state.state === 'missing' || state.state === 'wrong-remote'
            ? null
            : `/project-browser?path=${encodeURIComponent(m.localRoot)}`,
        localProjectId: m.localProjectId,
        path: m.localRoot,
        account,
      };
    },
    githubAccounts: () => accounts.list(),
    /** Folders on this device whose origin is on GitHub, marked with the saved project's id. */
    async candidates(binding: CloudBinding): Promise<{ items: ProjectCandidate[] }> {
      bind(binding);
      rescan(); // "Save a project" reads fresh
      return { items: await cachedCandidates(binding) };
    },
    /**
     * Every catalog folder on this device, GitHub or not, most used first (Oct 29 2026), with the
     * home folder they all sit in, so the tab can write `~/code/app`. `null` (no connection): the
     * same folders, none matched to a saved project.
     */
    async folders(binding: CloudBinding | null): Promise<ProjectFolders> {
      if (binding) bind(binding);
      const found = await cachedScan(binding);
      return { home, items: rankFolders(found, options.projectActivity?.() ?? []) };
    },
    /** Saved projects' ♥ and tags (projectMeta.ts); `available: false` on an older AASC Cloud. */
    projectMeta: (binding: CloudBinding) => meta.list(binding),
    changeProjectMeta: (id: string, change: unknown, binding: CloudBinding) =>
      meta.change(id, change, binding),
    /** Remove from the cloud list. The record is deleted; no folder, mapping or Git is touched. */
    async removeProject(id: string, binding: CloudBinding) {
      bind(binding);
      const p = await getRecord(id, binding);
      const removed = ProjectRecordSchema.parse(
        await cloud.client.request('DELETE', `/v1/projects/${p.id}`, {
          baseVersion: p.version,
          mutationId: randomUUID(),
        }),
      );
      bind(binding);
      if (removed.id !== p.id || removed.version !== p.version + 1 || !removed.deleted)
        throw new CloudError('invalid_response', 'Project acknowledgment is invalid.', 502);
      store.put('project-record', key(p.id, binding), removed);
      // The folder stays; it is just no project's checkout here now, so it can be saved again.
      forgetLink(p.id, binding);
      store.remove('project-account', key(p.id, binding));
      rescan();
      return removed;
    },
    /** Which GitHub account this device uses for a project; null is this Mac's own Git sign-in. */
    async setAccount(id: string, login: string | null, binding: CloudBinding) {
      bind(binding);
      z.uuid().parse(id);
      if (login === null) store.remove('project-account', key(id, binding));
      else {
        const chosen = await accounts.account(GithubLoginSchema.parse(login));
        bind(binding);
        store.put('project-account', key(id, binding), chosen.login);
      }
      return api.localProject(id, binding);
    },
    /**
     * Check: fetch from GitHub with the project's account, so ahead/behind are current. `auto`
     * (the Projects tab opening) skips a project fetched or tried here in the last 10 minutes and
     * an SSH checkout (a key that asks, a security key or a confirming agent, would ask on every
     * visit), and reads the record saved here instead of paging the cloud for it.
     */
    async checkProject(id: string, binding: CloudBinding, opts: { auto?: boolean } = {}) {
      bind(binding);
      const local = await api.localProject(id, binding); // links an existing checkout first
      const fresh = () => {
        const last = fetchedAt.get(key(id, binding));
        return !!opts.auto && last !== undefined && Date.now() - last < AUTO_CHECK_FRESH_MS;
      };
      if (fresh()) return local;
      const m = mapping(id, binding);
      if (!m) throw new CloudError('project_mapping_required', 'Clone this project first.', 409);
      await confinedMapping(m);
      if (opts.auto && (await git.sshTransport(m.localRoot))) return local;
      const saved = opts.auto
        ? store.get<ProjectRecord>('project-record', key(id, binding))
        : undefined;
      const p = saved && !saved.deleted ? saved : await getRecord(id, binding);
      ensureNoActiveProject(id, binding);
      const login = accountFor(id, binding);
      const c = new AbortController(),
        detach = cloud.onStop(() => c.abort());
      try {
        await resources.enqueue(async () => {
          bind(binding);
          if (fresh()) return; // a check of it finished while this one waited
          try {
            const account = login ? await accounts.account(login) : undefined;
            await git.fetch(m.localRoot, p, c.signal, account);
          } finally {
            // A dead network or a refused sign-in is not tried again on every visit; a cancel is.
            if (!c.signal.aborted) fetchedAt.set(key(id, binding), Date.now());
          }
        });
      } finally {
        detach();
      }
      return api.localProject(id, binding);
    },
    async pushProject(id: string, binding: CloudBinding) {
      bind(binding);
      const m = mapping(id, binding);
      if (!m) throw new CloudError('project_mapping_required', 'Clone this project first.', 409);
      await confinedMapping(m);
      const p = await getRecord(id, binding);
      if (p.repository.url !== m.canonicalRemote || p.repository.branch !== m.branch)
        throw new CloudError(
          'checkout_mismatch',
          'Project repository metadata changed; review the mapping.',
          409,
        );
      ensureNoActiveProject(id, binding);
      return start(
        'push-project',
        {
          project: p,
          destination: m.localRoot,
          transport: 'https',
          refs: [],
          account: accountFor(id, binding) ?? undefined,
        },
        binding,
      );
    },
    async getProject(id: string, input: z.input<typeof GetProjectSchema>, binding: CloudBinding) {
      bind(binding);
      const parsed = GetProjectSchema.parse(input);
      // The clone's parent may be home itself; the new folder's name may not look secret.
      await confinedProjectPath(parsed.parentPath, home, { allowHome: true });
      await assertSafeFolderName(parsed.directoryName, parsed.parentPath, home);
      bind(binding);
      ensureNoActiveProject(id, binding);
      // A mapping whose folder is gone does not block a fresh clone; the clone replaces it.
      if (await liveMapping(id, binding))
        throw new CloudError(
          'association_conflict',
          'This cloud project is already mapped. Open or pull its checkout.',
          409,
        );
      const p = await getRecord(id, binding);
      if (
        parsed.resourceVersions.some(
          (ref) =>
            !p.resources.some((r) => r.resourceId === ref.resourceId && r.version === ref.version),
        )
      )
        throw new CloudError('version_conflict', 'Review the project resource pins again.', 409);
      ensureNoActiveProject(id, binding);
      if (await liveMapping(id, binding))
        throw new CloudError(
          'association_conflict',
          'This project was mapped while preparing the action.',
          409,
        );
      return start(
        'get-project',
        {
          project: p,
          destination: join(parsed.parentPath, parsed.directoryName),
          transport: parsed.transport,
          refs: parsed.resourceVersions,
          account: accountFor(id, binding) ?? undefined,
        },
        binding,
      );
    },
    async pullProject(id: string, binding: CloudBinding) {
      bind(binding);
      const m = mapping(id, binding);
      if (!m)
        throw new CloudError(
          'project_mapping_required',
          'Get or associate this project first.',
          409,
        );
      await confinedMapping(m);
      const p = await getRecord(id, binding);
      if (p.repository.url !== m.canonicalRemote || p.repository.branch !== m.branch)
        throw new CloudError(
          'checkout_mismatch',
          'Project repository metadata changed; review the mapping.',
          409,
        );
      ensureNoActiveProject(id, binding);
      return start(
        'pull-project',
        {
          project: p,
          destination: m.localRoot,
          transport: 'https',
          refs: [],
          account: accountFor(id, binding) ?? undefined,
        },
        binding,
      );
    },
    async resourcePlan(
      id: string,
      binding: CloudBinding,
      resourceVersions?: GetProjectInput['resourceVersions'],
    ) {
      const s = owned(id, binding);
      const revision = jobRevisions.get(id) ?? 0;
      const snapshot = JSON.stringify(s);
      bind(s.binding);
      const input = s.private as ProjectInput;
      if (s.job.kind !== 'get-project' || s.job.steps[0].state !== 'complete' || running.has(id))
        throw new CloudError('review_required', 'Wait for a completed checkout first.', 409);
      const m = mapping(input.project.id, binding);
      if (!m)
        throw new CloudError('project_mapping_required', 'Associate the checkout first.', 409);
      await confinedMapping(m);
      let refs = input.refs;
      if (resourceVersions) {
        const current = await getRecord(input.project.id, binding);
        refs = z.array(ResourceDependencySchema).max(2000).parse(resourceVersions);
        if (
          refs.some(
            (ref) =>
              !current.resources.some(
                (r) => r.resourceId === ref.resourceId && r.version === ref.version,
              ),
          )
        )
          throw new CloudError('version_conflict', 'Review the latest project resource pins.', 409);
      }
      const p = await resources.planInstallMany(
        { refs, localProjectId: m.localProjectId },
        binding,
      );
      bind(binding);
      const current = saved(id);
      bind(current.binding);
      if (
        running.has(id) ||
        (jobRevisions.get(id) ?? 0) !== revision ||
        JSON.stringify(current) !== snapshot
      )
        throw new CloudError(
          'review_required',
          'This project job changed while preparing the resource review. Wait for it to finish and review again.',
          409,
        );
      // No await between the compare and save: never replace execution state with the old snapshot.
      const currentInput = current.private as ProjectInput;
      currentInput.refs = refs;
      currentInput.resourcePlanId = p.id;
      delete currentInput.resourceJobId;
      delete currentInput.decisions;
      saveJob(current.job, current.binding, currentInput);
      return p;
    },
    async retryResources(
      id: string,
      binding: CloudBinding,
      review?: { planId: string; decisions: InstallDecisions },
    ) {
      const s = owned(id, binding);
      bind(s.binding);
      if (running.has(id)) return s.job;
      const input = s.private as ProjectInput;
      if (
        s.job.kind !== 'get-project' ||
        s.job.steps[0].state !== 'complete' ||
        !s.job.steps.some((step) => step.id === 'resources')
      )
        throw new CloudError(
          'review_required',
          'A completed checkout with selected resources is required.',
          409,
        );
      if (review) {
        if (input.resourcePlanId !== review.planId)
          throw new CloudError('review_required', 'Use the latest resource review.', 409);
        input.decisions = review.decisions;
      } else {
        delete input.resourcePlanId;
        delete input.decisions;
      }
      delete input.errorCode;
      delete input.resourceJobId;
      s.job.steps[1] = { id: 'resources', label: 'Install selected resources', state: 'pending' };
      s.job.state = 'queued';
      saveJob(s.job, binding, input);
      dispatch(s.job, input, binding);
      return s.job;
    },
    cancel(id: string) {
      const s = saved(id);
      controllers.get(id)?.abort();
      if (!controllers.has(id) && ['interrupted', 'queued', 'running'].includes(s.job.state)) {
        const cancelled: CloudJob = { ...s.job, state: 'cancelled' };
        saveJob(cancelled, s.binding, s.private);
        return cancelled;
      }
      return s.job;
    },
    async retry(id: string, binding: CloudBinding) {
      const s = owned(id, binding);
      bind(s.binding);
      if (running.has(id)) return s.job;
      if (s.job.steps[0].state === 'complete') return api.retryResources(id, binding);
      const input = s.private as ProjectInput;
      if (
        s.job.kind === 'get-project' &&
        input.cloneIntent &&
        ['failed', 'interrupted', 'cancelled'].includes(s.job.state)
      ) {
        s.job.state = 'queued';
        for (const step of s.job.steps)
          if (step.state !== 'complete') {
            step.state = 'pending';
            delete step.error;
          }
        delete input.errorCode;
        saveJob(s.job, binding, input);
        dispatch(s.job, input, binding);
        return s.job;
      }
      throw new CloudError(
        'review_required',
        'Inspect the destination and create a fresh project action.',
        409,
      );
    },
    async wait(id: string) {
      await running.get(id);
      return saved(id).job;
    },
    async close() {
      for (const c of controllers.values()) c.abort();
      await queue;
      await associationQueue;
    },
  };
  resources.attachProjectJobs(api);
  return api;
}
export type ProjectJobs = Awaited<ReturnType<typeof createProjectJobs>>;
