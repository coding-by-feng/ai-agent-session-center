import { randomUUID } from 'node:crypto';
import { isWithin } from '../fsSafe.js';
import { cloudPublicationBlocker } from '../resourcePackages/policy.js';
import { readPublicationPacket, type TransferPacket } from '../resourcePackages/packet.js';
import {
  publicationPaths,
  resourceDestination,
  type AdapterRoots,
} from '../resourcePackages/adapters.js';
import { resourceIsSelected, type ResourceSelection } from '../../src/types/resourceSelection.js';
import {
  PackageManifestSchema,
  ResourceHeadSchema,
  type PackageManifest,
  type PublicationPlan,
} from '../../src/types/cloudResources.js';
import type { InternalResource } from '../resourceScanner.js';
import type { CloudConnector } from './types.js';
import { CloudError } from './types.js';
import { assertCloudBinding, type CloudBinding } from './binding.js';
import { installedAssociationKey, type InstalledAssociation, type JobStore } from './jobStore.js';
export interface PrivatePublication {
  public: PublicationPlan;
  binding: CloudBinding;
  items: {
    catalogId: string;
    manifest: PackageManifest;
    sourceDigest: string;
    baseVersion: number | null;
    mutationId: string;
    dependencies: string[];
    upload?: { uploadId: string; missingHashes: string[]; phase: 'uploading' | 'committing' };
  }[];
}
export async function preparePublication(options: {
  selection: ResourceSelection;
  binding: CloudBinding;
  cloud: CloudConnector;
  store: JobStore;
  resources: InternalResource[];
  roots: AdapterRoots;
}): Promise<PrivatePublication> {
  const { selection, binding, cloud, store, resources, roots } = options;
  assertCloudBinding(cloud, binding);
  const plan: PrivatePublication = {
    public: { id: randomUUID(), items: [], blocked: [] },
    binding,
    items: [],
  };
  const visited = new Set<string>(),
    visiting = new Set<string>();
  const explicit = (r: InternalResource) => {
    let last;
    for (const rule of selection) if (rule.resourceId === r.summary.id) last = rule.include;
    return last === true;
  };
  async function visit(r: InternalResource) {
    const id = r.summary.id;
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new CloudError('dependency_cycle', 'Publication dependencies contain a cycle.', 409);
    visiting.add(id);
    try {
      const blocker = cloudPublicationBlocker(r.summary);
      if (blocker) throw new Error(blocker);
      if (r.summary.type === 'memory' && !explicit(r))
        throw new Error('Select this memory file explicitly before reviewing publication.');
      const project =
        r.summary.scope === 'project' && r.summary.projectId
          ? store.project(binding, r.summary.projectId)
          : null;
      if (r.summary.scope === 'project' && !project)
        throw new Error(
          'Save or associate cloud project metadata first, then review these project resources again.',
        );
      const packet = await readPublicationPacket(r);
      const dependencies: PrivatePublication['items'] = [];
      for (const path of packet.dependencies) {
        const dep = resources.find(
          (x) =>
            x.realPath &&
            (x.realPath === path || (x.entry.kind === 'package' && isWithin(x.realPath, path))),
        );
        if (!dep) throw new Error('A referenced local dependency is missing from the catalog.');
        await visit(dep);
        const item = plan.items.find((x) => x.catalogId === dep.summary.id);
        if (!item)
          throw new Error('A dependency is blocked. Resolve it before publishing this resource.');
        dependencies.push(item);
      }
      const installed = store.get<InstalledAssociation>(
        'installed-association',
        installedAssociationKey(binding, r.entry.absPath),
      );
      if (installed && !installed.associated)
        throw new CloudError(
          'association_pending',
          'Finish this installed resource identity association by refreshing the catalog and retrying its install job before publishing.',
          409,
        );
      const resourceId = store.resourceId(binding, id);
      assertCloudBinding(cloud, binding);
      let baseVersion: number | null = null;
      try {
        const head = ResourceHeadSchema.parse(
          await cloud.client.request('GET', `/v1/resources/${resourceId}/head`),
        );
        if (head.resourceId !== resourceId) throw new Error('Invalid cloud head.');
        baseVersion = head.headVersion;
      } catch (e) {
        if (!(e instanceof CloudError) || e.code !== 'not_found') throw e;
      }
      assertCloudBinding(cloud, binding);
      const paths = publicationPaths(
        r,
        packet.files.map((f) => f.path),
        roots,
        project?.path,
      );
      const manifest: PackageManifest = {
        resourceId,
        agent: r.summary.agent,
        kind:
          r.summary.type === 'instructions'
            ? 'instruction'
            : (r.summary.type as PackageManifest['kind']),
        name: r.summary.name,
        scope: r.summary.scope,
        projectId: project?.cloudProjectId ?? null,
        files: packet.files.map((f, i) => ({
          path: paths[i],
          sha256: f.hash,
          bytes: Buffer.from(f.content, 'base64').length,
          mode: f.mode as 420 | 493,
        })),
        dependencies: dependencies.map((d) => ({
          resourceId: d.manifest.resourceId,
          version: (d.baseVersion ?? 0) + 1,
        })),
      };
      PackageManifestSchema.parse(manifest);
      const mapped = resourceDestination(manifest, roots, project?.path);
      if (mapped.path !== r.entry.absPath)
        throw new Error('Source placement is not represented by this portable adapter.');
      plan.items.push({
        catalogId: id,
        manifest,
        sourceDigest: packet.hash,
        baseVersion,
        mutationId: randomUUID(),
        dependencies: dependencies.map((d) => d.catalogId),
      });
    } catch (error) {
      if (
        error instanceof CloudError &&
        ['connection_changed', 'offline', 'revoked', 'forbidden'].includes(error.code)
      )
        throw error;
      plan.public.blocked.push({
        catalogId: id,
        reason:
          error instanceof CloudError
            ? error.message
            : // Only our own plain Error refusals carry reviewed text; a ZodError (it names the
              // backend's keys), a TypeError or an fs error (it carries `code`) never crosses.
              error instanceof Error && error.constructor === Error && !('code' in error)
              ? error.message
              : 'Resource cannot be published.',
      });
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const r of resources.filter((r) => resourceIsSelected(r.summary, selection))) await visit(r);
  plan.public.items = plan.items.map(({ catalogId, manifest, sourceDigest, baseVersion }) => ({
    catalogId,
    manifest,
    sourceDigest,
    baseVersion,
  }));
  return plan;
}
export async function recheckPublication(
  item: PrivatePublication['items'][number],
  resources: InternalResource[],
): Promise<TransferPacket> {
  const r = resources.find((r) => r.summary.id === item.catalogId);
  if (!r)
    throw new CloudError(
      'source_changed',
      'Source is no longer in the catalog. Review publication again.',
      409,
    );
  const packet = await readPublicationPacket(r);
  if (packet.hash !== item.sourceDigest)
    throw new CloudError(
      'source_changed',
      'Source changed after review. Review publication again.',
      409,
    );
  return packet;
}
