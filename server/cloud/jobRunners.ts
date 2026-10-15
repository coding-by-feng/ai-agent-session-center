/** Focused execution only; resourceJobs owns queue admission and reviewed plan APIs. */
import { join } from 'node:path';
import { BeginUploadResultSchema, type CloudJob } from '../../src/types/cloudResources.js';
import type { ResourceJobsOptions } from './resourceJobs.js';
import { installedAssociationKey, type InstalledAssociation, type JobStore } from './jobStore.js';
import { CloudError } from './types.js';
import { accountKey as bindingKey, assertCloudBinding, retryRateLimit } from './binding.js';
import { recheckPublication, type PrivatePublication } from './publication.js';
import {
  canonicalManifest,
  exactClosure,
  cacheVersionFiles,
  validatedVersion,
} from './packageFiles.js';
import type { createInstaller } from './install.js';
import { assertAnchors, assertDestination, readSafeFile } from './installFs.js';
import { prepareDownload } from './download.js';
import type { CloudBinding } from './binding.js';
import type {
  InstallPlan,
  InstallDecisions,
  ResourceVersion,
  ResourceRef,
} from '../../src/types/cloudResources.js';
import type { ReviewedInstall } from './install.js';
export interface PrivateInstall {
  public: InstallPlan;
  binding: CloudBinding;
  items: { version: ResourceVersion; review?: ReviewedInstall }[];
  jobId?: string;
}
export interface PrivateDownload {
  binding: CloudBinding;
  ref: ResourceRef;
}
export interface JobInput {
  planId: string;
  decisions?: InstallDecisions;
  errorCode?: string;
}
export function safeError(error: unknown) {
  return error instanceof CloudError
    ? error.message
    : 'The local resource could not be safely prepared. Rescan and review the source or destination.';
}
export function createJobRunners(
  options: ResourceJobsOptions,
  store: JobStore,
  installer: ReturnType<typeof createInstaller>,
) {
  const { cloud, catalog } = options;
  async function reconcileInstalled(
    record: InstalledAssociation,
    check: () => void,
  ): Promise<string | undefined> {
    try {
      check();
      assertCloudBinding(cloud, record.binding);
      catalog.startScan();
      await catalog.whenIdle();
      check();
      if (catalog.getCatalog().state !== 'ready')
        throw new CloudError(
          'catalog_unavailable',
          'Package installed; refresh the catalog and retry this job to finish its identity association and aliases.',
          409,
        );
      const { review } = record,
        m = review.manifest;
      await assertAnchors(review.anchors);
      await assertDestination(review.destination.root, review.destination.path, record.after);
      const targets = catalog
        .publicationInternals()
        .filter(
          (r) =>
            r.entry.absPath === review.destination.path &&
            r.summary.agent === m.agent &&
            r.summary.scope === m.scope &&
            r.summary.type === (m.kind === 'instruction' ? 'instructions' : m.kind),
        );
      if (targets.length !== 1)
        throw new CloudError(
          'catalog_unavailable',
          'Package installed; its exact catalog target is unavailable. Refresh the catalog and retry this job.',
          409,
        );
      check();
      const target = targets[0];
      store.associateResource(record.binding, target.summary.id, m.resourceId, review.version);
      record.associated = true;
      store.put(
        'installed-association',
        installedAssociationKey(record.binding, review.destination.path),
        record,
      );
      if (['skill', 'command'].includes(target.summary.type) && options.getCloudAliases) {
        const aliases = await options.getCloudAliases();
        check();
        assertCloudBinding(cloud, record.binding);
        const statuses = await aliases.retryAcknowledgedTarget(
          `${target.summary.agent}:${target.summary.name}`,
        );
        if (statuses.some((s) => !['installed', 'disabled'].includes(s.state)))
          return 'Package installed; review the device alias status.';
      }
    } catch (error) {
      return error instanceof CloudError
        ? error.message
        : 'Package installed; refresh the catalog and retry its identity association and aliases.';
    }
  }
  async function reconcileInstallations(binding: CloudBinding, check: () => void) {
    for (const record of store.list<InstalledAssociation>('installed-association'))
      if (!record.associated && bindingKey(record.binding) === bindingKey(binding))
        await reconcileInstalled(record, check);
  }
  async function publish(
    job: CloudJob,
    input: JobInput,
    check: () => void,
    signal: AbortSignal,
    save: () => void,
  ) {
    const plan = store.get<PrivatePublication>('publish-plan', input.planId)!;
    // Verify all reviewed sources before any upload begins, including its dependency closure.
    for (const item of plan.items) {
      check();
      await recheckPublication(item, catalog.publicationInternals());
    }
    for (const item of plan.items) {
      const step = job.steps.find((s) => s.id === item.catalogId)!;
      if (step.state === 'complete') continue;
      if (
        item.dependencies.some((id) => job.steps.find((s) => s.id === id)?.state !== 'complete')
      ) {
        step.state = 'failed';
        step.error = 'A dependency failed; this resource was not published.';
        save();
        continue;
      }
      check();
      step.state = 'running';
      save();
      const packet = await recheckPublication(item, catalog.publicationInternals());
      const request = <T>(method: string, path: string, body?: unknown) => {
        let attempts = 0;
        return retryRateLimit(
          async () => {
            if (attempts++ > 0) await recheckPublication(item, catalog.publicationInternals());
            check();
            return cloud.client.request<T>(method, path, body, signal);
          },
          check,
          signal,
          options.delay,
        );
      };
      if (!item.upload) {
        const upload = BeginUploadResultSchema.parse(
          await request('POST', '/v1/resources/uploads', {
            manifest: item.manifest,
            baseVersion: item.baseVersion,
            mutationId: item.mutationId,
          }),
        );
        const hashes = new Set(item.manifest.files.map((f) => f.sha256));
        if (upload.missingHashes.some((h) => !hashes.has(h)))
          throw new CloudError('invalid_response', 'Cloud requested an unreviewed file.', 502);
        item.upload = {
          uploadId: upload.uploadId,
          missingHashes: upload.missingHashes,
          phase: 'uploading',
        };
        store.put('publish-plan', input.planId, plan);
      }
      const upload = item.upload;
      // Persist commit intent before dispatch: lost responses replay immutable commit receipts.
      // A committed begin result can retain stale missingHashes; never PUT after commit intent.
      if (upload.phase === 'uploading') {
        for (const hash of upload.missingHashes) {
          check();
          const file = packet.files.find((f) => f.hash === hash)!;
          await request(
            'PUT',
            `/v1/resources/uploads/${upload.uploadId}/files/${hash}`,
            Buffer.from(file.content, 'base64'),
          );
        }
        await recheckPublication(item, catalog.publicationInternals());
        check();
        upload.phase = 'committing';
        store.put('publish-plan', input.planId, plan);
      }
      await recheckPublication(item, catalog.publicationInternals());
      check();
      const result = validatedVersion(
        await request('POST', `/v1/resources/uploads/${upload.uploadId}/commit`, {}),
        { resourceId: item.manifest.resourceId, version: (item.baseVersion ?? 0) + 1 },
      );
      // Valid schema + digest still must describe exactly the reviewed publication.
      if (
        JSON.stringify(canonicalManifest(result.manifest)) !==
        JSON.stringify(canonicalManifest(item.manifest))
      )
        throw new CloudError('invalid_response', 'Cloud publication differs from the review.', 502);
      store.put('published', JSON.stringify([bindingKey(plan.binding), item.catalogId]), {
        resourceId: result.manifest.resourceId,
        version: result.version,
      });
      step.state = 'complete';
      save();
    }
  }
  async function install(
    job: CloudJob,
    input: JobInput,
    check: () => void,
    signal: AbortSignal,
    save: () => void,
  ) {
    const plan = store.get<PrivateInstall>('install-plan', input.planId)!;
    for (const item of plan.items) {
      const m = item.version.manifest,
        step = job.steps.find((s) => s.id === m.resourceId)!;
      if (step.state === 'complete') {
        const record =
          item.review &&
          store.get<InstalledAssociation>(
            'installed-association',
            installedAssociationKey(plan.binding, item.review.destination.path),
          );
        if (record && record.review.id === item.review?.id)
          step.attention = await reconcileInstalled(record, check);
        else
          step.attention =
            'Package identity changed after this job. Review the current installation.';
        save();
        continue;
      }
      const decision = input.decisions?.[m.resourceId];
      if (decision === 'skip' || decision === 'keep-local') {
        step.state = 'skipped';
        save();
        continue;
      }
      if (
        m.dependencies.some(
          (d) => job.steps.find((s) => s.id === d.resourceId)?.state !== 'complete',
        )
      ) {
        step.state = 'failed';
        step.error = 'A dependency was not installed; this resource was left unchanged.';
        save();
        continue;
      }
      if (!item.review) {
        step.state = 'failed';
        step.error = 'Resolve the blocked destination and review again.';
        save();
        continue;
      }
      check();
      step.state = 'running';
      save();
      try {
        let after = item.review.before;
        if (plan.public.items.find((p) => p.id === m.resourceId)?.action === 'same') {
          await assertAnchors(item.review.anchors);
          await assertDestination(
            item.review.destination.root,
            item.review.destination.path,
            item.review.before,
          );
        } else {
          const paths = await cacheVersionFiles({
            directory: join(store.directory, 'blobs'),
            version: item.version,
            client: cloud.client,
            check,
            signal,
            delay: options.delay,
          });
          const receipt = await installer.install(
            item.review,
            plan.binding,
            (hash) => readSafeFile(paths.get(hash)!),
            check,
          );
          after = receipt.after;
          step.receiptId = receipt.id;
        }
        const record: InstalledAssociation = {
          binding: plan.binding,
          review: item.review,
          after: after!,
          associated: false,
        };
        store.put(
          'installed-association',
          installedAssociationKey(plan.binding, item.review.destination.path),
          record,
        );
        step.state = 'complete';
        save(); // Package success and pending association survive catalog failure/restart.
        step.attention = await reconcileInstalled(record, check);
        save();
      } catch (error) {
        if (
          error instanceof CloudError &&
          ['connection_changed', 'cancelled', 'offline', 'revoked', 'forbidden'].includes(
            error.code,
          )
        )
          throw error;
        step.state = 'failed';
        step.error = safeError(error);
        input.errorCode = error instanceof CloudError ? error.code : 'local_error';
        save();
      }
    }
  }
  async function download(
    job: CloudJob,
    input: JobInput,
    check: () => void,
    signal: AbortSignal,
    save: () => void,
  ) {
    const plan = store.get<PrivateDownload>('download-plan', input.planId)!;
    check();
    job.steps[0].state = 'running';
    save();
    const versions = await exactClosure(cloud.client, plan.ref, check, signal);
    const paths = new Map<string, string>();
    for (const version of versions) {
      const cached = await cacheVersionFiles({
        directory: join(store.directory, 'blobs'),
        version,
        client: cloud.client,
        check,
        signal,
        delay: options.delay,
      });
      for (const [hash, path] of cached) paths.set(hash, path);
    }
    check();
    const path = await prepareDownload(
      join(store.directory, 'exports', job.id),
      versions,
      paths,
      signal,
    );
    check();
    store.put('download', job.id, { path, binding: plan.binding });
    job.steps[0].state = 'complete';
    save();
  }
  return { publish, install, download, reconcileInstallations };
}
