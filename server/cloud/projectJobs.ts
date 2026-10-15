/** Metadata comes first; local checkout mappings never cross the backend boundary. */
import { randomUUID, createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { z } from 'zod';
import {
  ProjectRecordSchema,
  ProjectMutationSchema,
  ProjectListSchema,
  GetProjectSchema,
  type ProjectRecord,
  type GetProjectInput,
} from '../../src/types/cloudProjects.js';
import {
  ResourceDependencySchema,
  type CloudJob,
  type InstallDecisions,
} from '../../src/types/cloudResources.js';
import { assertCloudBinding, accountKey, abortCheck, type CloudBinding } from './binding.js';
import { CloudError, type CloudConnector } from './types.js';
import type { ResourceJobs } from './resourceJobs.js';
import { createGitOperations, type GitOperations, type CloneIntent } from './git.js';
import { safeError } from './jobRunners.js';
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
}
export async function createProjectJobs(options: ProjectJobsOptions) {
  const { cloud, resources } = options,
    store = resources.store;
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
  async function getRecord(id: string, binding: CloudBinding) {
    bind(binding);
    z.uuid().parse(id);
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let n = 0; n < 1000; n++) {
      const page = await listProjects({ limit: 100, ...(cursor ? { cursor } : {}) }, binding);
      const p = page.items.find((p) => p.id === id && !p.deleted);
      if (p) return p;
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor))
        throw new CloudError('invalid_response', 'Project pagination is invalid.', 502);
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new CloudError('not_found', 'Cloud project was not found.', 404);
  }
  async function associateChecked(project: ProjectRecord, path: string, binding: CloudBinding) {
    bind(binding);
    const inspected = await git.inspectCheckout(path, project);
    if (['missing', 'wrong-remote', 'detached', 'busy'].includes(inspected.state))
      throw new CloudError(
        'checkout_mismatch',
        'Choose a canonical checkout with this remote and branch.',
        409,
      );
    const id = localId(path),
      prior = resources.projectAssociation(id, binding),
      mapped = mapping(project.id, binding);
    if ((prior && prior.cloudProjectId !== project.id) || (mapped && mapped.localRoot !== path))
      throw new CloudError(
        'association_conflict',
        'This project or local checkout already has a different mapping.',
        409,
      );
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
            ['get-project', 'pull-project'].includes(s.job.kind) &&
            ['queued', 'running'].includes(s.job.state) &&
            accountKey(s.binding) === accountKey(binding) &&
            (s.private as ProjectInput).project.id === id,
        )
    )
      throw new CloudError('busy', 'Wait for this project job to finish or cancel it first.', 409);
  }
  function saved(id: string) {
    const s = store.getJob(z.uuid().parse(id));
    if (!s || !['get-project', 'pull-project'].includes(s.job.kind))
      throw new CloudError('not_found', 'Project job was not found.', 404);
    return s;
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
            if (job.kind === 'get-project') {
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
                );
            } else
              await git.pull(input.destination, input.project, c.signal, check, () => {
                job.steps.find((s) => s.id === 'fetch')!.state = 'complete';
                step.state = 'running';
                save();
              });
            check();
            await associate(input.project, input.destination, binding);
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
  function start(kind: 'get-project' | 'pull-project', input: ProjectInput, binding: CloudBinding) {
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
          label: kind === 'get-project' ? 'Get checkout' : 'Fast-forward checkout',
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
      if (local) await associate(p, local.path, binding);
      return p;
    },
    async associateProject(id: string, path: string, binding: CloudBinding) {
      const p = await getRecord(id, binding);
      await associate(p, path, binding);
      return api.localProject(id, binding);
    },
    async localProject(id: string, binding: CloudBinding) {
      bind(binding);
      const m = mapping(id, binding);
      if (!m)
        return { state: 'missing' as const, branch: null, openUrl: null, localProjectId: null };
      const p = store.get<ProjectRecord>('project-record', key(id, binding));
      if (!p) throw new CloudError('review_required', 'Refresh project metadata.', 409);
      const state = await git.inspectCheckout(m.localRoot, p);
      bind(binding);
      return {
        ...state,
        openUrl:
          state.state === 'missing' || state.state === 'wrong-remote'
            ? null
            : `/project-browser?path=${encodeURIComponent(m.localRoot)}`,
        localProjectId: m.localProjectId,
      };
    },
    async getProject(id: string, input: GetProjectInput, binding: CloudBinding) {
      bind(binding);
      const parsed = GetProjectSchema.parse(input);
      ensureNoActiveProject(id, binding);
      if (mapping(id, binding))
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
      if (mapping(id, binding))
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
        { project: p, destination: m.localRoot, transport: 'https', refs: [] },
        binding,
      );
    },
    async resourcePlan(
      id: string,
      binding: CloudBinding,
      resourceVersions?: GetProjectInput['resourceVersions'],
    ) {
      bind(binding);
      const s = saved(id);
      const revision = jobRevisions.get(id) ?? 0;
      const snapshot = JSON.stringify(s);
      bind(s.binding);
      const input = s.private as ProjectInput;
      if (s.job.kind !== 'get-project' || s.job.steps[0].state !== 'complete' || running.has(id))
        throw new CloudError('review_required', 'Wait for a completed checkout first.', 409);
      const m = mapping(input.project.id, binding);
      if (!m)
        throw new CloudError('project_mapping_required', 'Associate the checkout first.', 409);
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
      bind(binding);
      const s = saved(id);
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
        s.job.state = 'cancelled';
        saveJob(s.job, s.binding, s.private);
      }
      return s.job;
    },
    async retry(id: string, binding: CloudBinding) {
      bind(binding);
      const s = saved(id);
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
