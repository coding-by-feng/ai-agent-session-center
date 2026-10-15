import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import log from '../logger.js';
import {
  ResourceVersionSchema,
  ResourceDependencySchema,
  type CloudJob,
  type PublicationPlan,
  type InstallPlan,
  type InstallDecisions,
  type ResourceVersion,
  type ResourceRef,
} from '../../src/types/cloudResources.js';
import type { ResourceSelection } from '../../src/types/resourceSelection.js';
import type { ResourceCatalogService } from '../resourceCatalog.js';
import type { AdapterRoots } from '../resourcePackages/adapters.js';
import { resourceDestination } from '../resourcePackages/adapters.js';
import { CloudError, type CloudConnector } from './types.js';
import {
  accountKey,
  assertCloudBinding,
  abortCheck,
  type CloudBinding,
  type RetryDelay,
} from './binding.js';
import { createJobStore, type JobStore } from './jobStore.js';
import { preparePublication, type PrivatePublication } from './publication.js';
import { exactClosure } from './packageFiles.js';
import { createInstaller, type ReviewedInstall } from './install.js';
import { safeParents } from './installFs.js';
import {
  createJobRunners,
  safeError,
  type PrivateInstall,
  type PrivateDownload,
  type JobInput,
} from './jobRunners.js';
import { publicReceipt, type InstallReceipt } from './receipts.js';
import { EXPORT_TTL_MS, removeExport, sweepExports } from './download.js';
import type { CloudAliasesService } from './aliases.js';
export interface ResourceJobsOptions {
  cloud: CloudConnector;
  catalog: ResourceCatalogService;
  roots: AdapterRoots;
  directory: string;
  getCloudAliases?: () => Promise<CloudAliasesService>;
  delay?: RetryDelay;
  store?: JobStore;
}
export type ResourceJobs = Awaited<ReturnType<typeof createResourceJobs>>;
export async function createResourceJobs(options: ResourceJobsOptions) {
  const { cloud, catalog, roots } = options,
    store = options.store ?? (await createJobStore(options.directory)),
    installer = createInstaller(store);
  const { publish, install, download, reconcileInstallations } = createJobRunners(
    options,
    store,
    installer,
  );
  const controllers = new Map<string, AbortController>(),
    running = new Map<string, Promise<void>>();
  // Prepared ZIPs: deleted once served, and swept when stale (at open, on each new
  // download and on a timer). Only `<directory>/exports` is ever touched.
  const exportsDir = join(store.directory, 'exports');
  const sweepStale = async () => {
    for (const id of await sweepExports(exportsDir, { keep: (id) => running.has(id) }))
      if (!running.has(id)) store.remove('download', id);
  };
  const sweepSafely = () =>
    sweepStale().catch((error) =>
      log.warn('cloud', `Could not sweep prepared downloads: ${(error as Error).message}`),
    );
  await sweepSafely();
  const sweeper = setInterval(() => void sweepSafely(), EXPORT_TTL_MS / 4);
  sweeper.unref?.();
  let queue = Promise.resolve();
  let projectOwner:
    | {
        cancel(id: string): CloudJob;
        retry(id: string, binding: CloudBinding): Promise<CloudJob>;
        wait(id: string): Promise<CloudJob>;
        close(): Promise<void>;
      }
    | undefined;
  const isProjectJob = (id: string) => ['get-project', 'pull-project'].includes(getJob(id).kind);
  const bind = (binding: CloudBinding) => assertCloudBinding(cloud, binding);
  function getJob(id: string) {
    const saved = store.getJob(id);
    if (!saved) throw new CloudError('not_found', 'Cloud job was not found.', 404);
    return saved.job;
  }
  function start(
    kind: CloudJob['kind'],
    steps: CloudJob['steps'],
    binding: CloudBinding,
    input: JobInput,
  ): CloudJob {
    bind(binding);
    const job: CloudJob = { id: randomUUID(), kind, state: 'queued', steps };
    store.saveJob(job, binding, input);
    dispatch(job, binding, input);
    return job;
  }
  function dispatch(job: CloudJob, binding: CloudBinding, input: JobInput) {
    const c = new AbortController();
    const detach = cloud.onStop(() => c.abort());
    controllers.set(job.id, c);
    const check = () => {
      abortCheck(c.signal);
      bind(binding);
    };
    const execute = async () => {
      const save = () => store.saveJob(job, binding, input);
      try {
        check();
        job.state = 'running';
        save();
        if (job.kind === 'publish') await publish(job, input, check, c.signal, save);
        else if (job.kind === 'install') await install(job, input, check, c.signal, save);
        else if (job.kind === 'download') await download(job, input, check, c.signal, save);
        const failed = job.steps.some((s) => s.state === 'failed');
        job.state = failed
          ? job.steps.some((s) => s.state === 'complete')
            ? 'partial'
            : 'failed'
          : 'complete';
      } catch (error) {
        input.errorCode = error instanceof CloudError ? error.code : 'local_error';
        const step =
          job.steps.find((s) => s.state === 'running') ??
          job.steps.find((s) => s.state === 'pending');
        if (step) {
          step.state = 'failed';
          step.error = safeError(error);
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
    };
    const work = queue.then(execute);
    queue = work.catch(() => {});
    running.set(job.id, work);
  }
  const api = {
    store,
    attachProjectJobs(owner: NonNullable<typeof projectOwner>) {
      if (projectOwner) throw new Error('Project jobs already attached');
      projectOwner = owner;
    },
    enqueue<T>(operation: () => Promise<T>): Promise<T> {
      const work = queue.then(operation);
      queue = work.then(
        () => {},
        () => {},
      );
      return work;
    },
    async associateProject(
      input: import('./jobStore.js').ProjectAssociation,
      binding: CloudBinding,
    ) {
      bind(binding);
      const value = z
        .object({
          cloudProjectId: z.uuid(),
          localProjectId: z.string().min(1).max(1024),
          path: z.string().min(1),
          version: z.number().int().positive().safe(),
        })
        .strict()
        .parse(input);
      await safeParents(value.path);
      const { realpath, lstat } = await import('node:fs/promises');
      if (!(await lstat(value.path)).isDirectory() || (await realpath(value.path)) !== value.path)
        throw new CloudError(
          'project_mapping_required',
          'Choose an existing canonical local project directory.',
          409,
        );
      bind(binding);
      store.associateProject(binding, value);
    },
    projectAssociation(localProjectId: string, binding: CloudBinding) {
      bind(binding);
      return store.project(binding, localProjectId);
    },
    async listResources(
      query: { cursor?: string; limit?: number; projectId?: string },
      binding: CloudBinding,
    ) {
      bind(binding);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query))
        if (value !== undefined) params.set(key, String(value));
      const data = await cloud.client.request(
        'GET',
        '/v1/resources' + (params.size ? '?' + params : ''),
      );
      bind(binding);
      return z
        .object({ items: z.array(ResourceVersionSchema).max(100), nextCursor: z.uuid().nullable() })
        .strict()
        .parse(data);
    },
    async buildPublicationPlan(
      selection: ResourceSelection,
      binding: CloudBinding,
    ): Promise<PublicationPlan> {
      bind(binding);
      await reconcileInstallations(binding, () => bind(binding));
      bind(binding);
      const plan = await preparePublication({
        selection,
        binding,
        cloud,
        store,
        resources: catalog.publicationInternals(),
        roots,
      });
      bind(binding);
      store.put('publish-plan', plan.public.id, plan);
      return plan.public;
    },
    async publishPlan(id: string, binding: CloudBinding): Promise<CloudJob> {
      bind(binding);
      const plan = store.get<PrivatePublication & { jobId?: string }>('publish-plan', id);
      if (!plan) throw new CloudError('not_found', 'Publication review was not found.', 404);
      bind(plan.binding);
      if (!plan.items.length || plan.public.blocked.length)
        throw new CloudError(
          'publication_blocked',
          'Resolve blocked resources and review publication again.',
          409,
        );
      if (plan.jobId) return getJob(plan.jobId);
      const job = start(
        'publish',
        plan.items.map((i) => ({ id: i.catalogId, label: i.manifest.name, state: 'pending' })),
        binding,
        { planId: id },
      );
      plan.jobId = job.id;
      store.put('publish-plan', id, plan);
      return job;
    },
    async planInstall(
      input: ResourceRef & { localProjectId?: string },
      binding: CloudBinding,
    ): Promise<InstallPlan> {
      return api.planInstallMany(
        {
          refs: [{ resourceId: input.resourceId, version: input.version }],
          localProjectId: input.localProjectId,
        },
        binding,
      );
    },
    async planInstallMany(
      input: { refs: ResourceRef[]; localProjectId?: string },
      binding: CloudBinding,
    ): Promise<InstallPlan> {
      bind(binding);
      z.array(ResourceDependencySchema).max(2000).parse(input.refs);
      const check = () => bind(binding);
      const versions = await exactClosure(
        cloud.client,
        input.refs,
        check,
        new AbortController().signal,
      );
      const plan: PrivateInstall = { public: { id: randomUUID(), items: [] }, binding, items: [] };
      for (const version of versions) {
        const m = version.manifest;
        let review: ReviewedInstall | undefined, reason: string | undefined;
        try {
          const mapping = input.localProjectId
            ? store.project(binding, input.localProjectId)
            : null;
          if (m.scope === 'project' && (!mapping || mapping.cloudProjectId !== m.projectId))
            throw new CloudError(
              'project_mapping_required',
              'Map this cloud project to a local checkout first.',
              409,
            );
          const destination = resourceDestination(m, roots, mapping?.path);
          review = await installer.review(m, version.version, destination);
        } catch (error) {
          reason = safeError(error);
        }
        plan.items.push({ version, review });
        const files = review
          ? m.files.map((f) => {
              const local = review!.destination.files.find(
                (p) => p.manifestPath === f.path,
              )!.localPath;
              const old = review!.before?.files.find((p) => p.path === local);
              return {
                path: f.path,
                change: !old
                  ? ('add' as const)
                  : old.sha256 === f.sha256 && old.mode === f.mode
                    ? ('same' as const)
                    : ('change' as const),
              };
            })
          : [];
        plan.public.items.push({
          id: m.resourceId,
          resourceId: m.resourceId,
          version: version.version,
          destinationLabel: review?.destination.label ?? `${m.agent} ${m.scope} / ${m.name}`,
          action: !review
            ? 'blocked'
            : !review.before
              ? 'add'
              : files.every((f) => f.change === 'same')
                ? 'same'
                : 'replace',
          reason,
          files,
        });
      }
      // Two exact identities cannot claim overlapping owned destinations in one review.
      const overlaps = new Set<number>();
      for (let a = 0; a < plan.items.length; a++)
        for (let b = a + 1; b < plan.items.length; b++) {
          const left = plan.items[a].review?.destination.path.toLowerCase(),
            right = plan.items[b].review?.destination.path.toLowerCase();
          if (
            left &&
            right &&
            (left === right || left.startsWith(right + '/') || right.startsWith(left + '/'))
          ) {
            overlaps.add(a);
            overlaps.add(b);
          }
        }
      for (const index of overlaps) {
        plan.items[index].review = undefined;
        plan.public.items[index].action = 'blocked';
        plan.public.items[index].reason =
          'Two resource identities claim overlapping local destinations. Choose a separate mapping.';
      }
      bind(binding);
      store.put('install-plan', plan.public.id, plan);
      return plan.public;
    },
    async runInstall(
      id: string,
      decisions: InstallDecisions,
      binding: CloudBinding,
    ): Promise<CloudJob> {
      bind(binding);
      const plan = store.get<PrivateInstall>('install-plan', id);
      if (!plan) throw new CloudError('not_found', 'Installation review was not found.', 404);
      bind(plan.binding);
      if (Object.keys(decisions).some((id) => !plan.public.items.some((i) => i.id === id)))
        throw new CloudError('invalid_request', 'Unknown install decision.', 400);
      for (const item of plan.public.items) {
        if (item.action === 'replace' && !decisions[item.id])
          throw new CloudError(
            'review_required',
            'Choose Keep local, Replace with backup, or Skip for each replacement.',
            409,
          );
        if (item.action === 'blocked' && decisions[item.id] !== 'skip')
          throw new CloudError(
            'installation_blocked',
            'Resolve or skip blocked destinations.',
            409,
          );
      }
      if (plan.jobId) return getJob(plan.jobId);
      const job = start(
        'install',
        plan.items.map((i) => ({
          id: i.version.manifest.resourceId,
          label: i.version.manifest.name,
          state: 'pending',
        })),
        binding,
        { planId: id, decisions },
      );
      plan.jobId = job.id;
      store.put('install-plan', id, plan);
      return job;
    },
    async download(ref: ResourceRef, binding: CloudBinding) {
      bind(binding);
      ResourceDependencySchema.parse(ref);
      await sweepSafely();
      bind(binding);
      const id = randomUUID();
      store.put('download-plan', id, { binding, ref });
      return start(
        'download',
        [{ id: ref.resourceId, label: 'Prepare portable ZIP', state: 'pending' }],
        binding,
        { planId: id },
      );
    },
    downloadFile(id: string, binding: CloudBinding) {
      bind(binding);
      const value = store.get<{ path: string; binding: CloudBinding }>('download', id);
      if (!value || getJob(id).state !== 'complete')
        throw new CloudError('not_found', 'Prepared download is unavailable.', 404);
      bind(value.binding);
      return value.path;
    },
    /** The ZIP streamed completely: it was for one save, so delete it and its record. */
    async downloadServed(id: string) {
      z.uuid().parse(id);
      await removeExport(exportsDir, id);
      store.remove('download', id);
    },
    getJob,
    /**
     * Job read and cancel. The reviewed binding must be the current connection (409, like
     * every bound route; no backend round trip, so it works offline), and the job must belong
     * to that backend and account in any generation: another account's job is a missing one.
     */
    accountJob(id: string, binding: CloudBinding): CloudJob {
      bind(binding);
      const saved = store.getJob(id);
      if (!saved || accountKey(saved.binding) !== accountKey(binding))
        throw new CloudError('not_found', 'Cloud job was not found.', 404);
      return saved.job;
    },
    cancel(id: string): CloudJob {
      if (isProjectJob(id)) {
        if (!projectOwner)
          throw new CloudError('review_required', 'Project jobs are unavailable.', 409);
        return projectOwner.cancel(id);
      }
      const job = getJob(id);
      controllers.get(id)?.abort();
      if (['queued', 'running', 'interrupted'].includes(job.state) && !controllers.has(id)) {
        const saved = store.getJob(id)!;
        const cancelled: CloudJob = { ...saved.job, state: 'cancelled' };
        store.saveJob(cancelled, saved.binding, saved.private);
        return cancelled;
      }
      return job;
    },
    async retry(id: string, binding: CloudBinding): Promise<CloudJob> {
      // Another backend+account's job answers like a missing one, before anything else.
      api.accountJob(id, binding);
      if (isProjectJob(id)) {
        bind(binding);
        if (!projectOwner)
          throw new CloudError('review_required', 'Project jobs are unavailable.', 409);
        return projectOwner.retry(id, binding);
      }
      bind(binding);
      const saved = store.getJob(id);
      if (!saved) throw new CloudError('not_found', 'Cloud job was not found.', 404);
      bind(saved.binding);
      if (running.has(id)) return saved.job;
      const input = saved.private as JobInput;
      if (
        (!['interrupted', 'cancelled', 'partial', 'failed'].includes(saved.job.state) &&
          !(
            saved.job.kind === 'install' &&
            saved.job.state === 'complete' &&
            saved.job.steps.some((s) => s.attention)
          )) ||
        (input.errorCode && !['offline', 'cancelled', 'rate_limited'].includes(input.errorCode))
      )
        throw new CloudError(
          'review_required',
          'Create a fresh review before retrying this job.',
          409,
        );
      delete input.errorCode;
      for (const step of saved.job.steps)
        if (step.state !== 'complete') {
          step.state = 'pending';
          delete step.error;
        }
      saved.job.state = 'queued';
      store.saveJob(saved.job, binding, input);
      dispatch(saved.job, binding, input);
      return saved.job;
    },
    async restore(id: string, binding: CloudBinding) {
      bind(binding);
      const r = store.get<InstallReceipt>('receipt', id);
      if (!r) throw new CloudError('not_found', 'Install receipt was not found.', 404);
      bind(r.binding);
      const operation = queue.then(async () => {
        bind(binding);
        bind(r.binding);
        return publicReceipt(await installer.restore(id));
      });
      queue = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    async wait(id: string): Promise<CloudJob> {
      if (isProjectJob(id) && projectOwner) return projectOwner.wait(id);
      await running.get(id);
      return getJob(id);
    },
    async close() {
      clearInterval(sweeper);
      await projectOwner?.close();
      for (const c of controllers.values()) c.abort();
      await queue;
      if (!options.store) store.close();
    },
  };
  return api;
}
