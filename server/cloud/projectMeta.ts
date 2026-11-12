/**
 * projectMeta — a saved project's ♥ and tags in AASC Cloud (Oct 29 2026). They sit beside the
 * project record (`GET /v1/projects/meta`, `POST /v1/projects/<id>/meta`), never in it: a Mac on an
 * older AASC parses records strictly and would lose the whole list over one new field. Each change
 * is one operation the cloud applies to whatever is there now, so two devices' edits merge without
 * a version to reconcile. A backend from before these routes reads as `available: false`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { normalizeTag } from '../../src/lib/skillNotes.js';
import {
  ProjectMetaChangeSchema,
  ProjectMetaListSchema,
  ProjectMetaSchema,
  type ProjectMeta,
  type ProjectMetas,
} from '../../src/types/cloudProjects.js';
import { assertCloudBinding, type CloudBinding } from './binding.js';
import { CloudError, type CloudConnector } from './types.js';

/** Pages of 100 read at most: 10,000 projects. */
const MAX_PAGES = 100;
const invalidPages = () =>
  new CloudError('invalid_response', 'Project tag pagination is invalid.', 502);

/** The Library's tag rule, each tag once, sorted; a tag with nothing left is refused. */
function tagList(raw: readonly string[] | undefined): string[] | undefined {
  if (!raw?.length) return undefined;
  const tags = new Set<string>();
  for (const t of raw) {
    const tag = normalizeTag(t);
    if (!tag) throw new CloudError('invalid_request', 'Use letters or digits in a tag.', 400);
    tags.add(tag);
  }
  return [...tags].sort();
}

export function createProjectMeta(cloud: CloudConnector) {
  return {
    async list(binding: CloudBinding): Promise<ProjectMetas> {
      assertCloudBinding(cloud, binding);
      const items: ProjectMeta[] = [];
      const seen = new Set<string>();
      let cursor: string | null = null;
      for (let n = 0; n < MAX_PAGES; n++) {
        const query = new URLSearchParams({ limit: '100', ...(cursor ? { cursor } : {}) });
        let page;
        try {
          page = ProjectMetaListSchema.parse(
            await cloud.client.request('GET', `/v1/projects/meta?${query}`),
          );
        } catch (error) {
          // An AASC Cloud from before Oct 29 2026 has no such route: unavailable, not broken.
          if (n === 0 && error instanceof CloudError && error.code === 'not_found')
            return { available: false, items: [] };
          throw error;
        }
        assertCloudBinding(cloud, binding);
        items.push(...page.items);
        if (!page.nextCursor) return { available: true, items };
        if (seen.has(page.nextCursor)) throw invalidPages();
        seen.add(page.nextCursor);
        cursor = page.nextCursor;
      }
      throw invalidPages();
    },
    async change(id: string, raw: unknown, binding: CloudBinding): Promise<ProjectMeta> {
      assertCloudBinding(cloud, binding);
      const projectId = z.uuid().parse(id);
      const change = ProjectMetaChangeSchema.parse(raw);
      const addTags = tagList(change.addTags),
        removeTags = tagList(change.removeTags);
      if (addTags?.some((t) => removeTags?.includes(t)))
        throw new CloudError('invalid_request', 'A tag cannot be added and removed at once.', 400);
      const meta = ProjectMetaSchema.parse(
        await cloud.client.request('POST', `/v1/projects/${projectId}/meta`, {
          mutationId: randomUUID(),
          ...(change.favorite === undefined ? {} : { favorite: change.favorite }),
          ...(addTags ? { addTags } : {}),
          ...(removeTags ? { removeTags } : {}),
        }),
      );
      assertCloudBinding(cloud, binding);
      if (meta.projectId !== projectId)
        throw new CloudError('invalid_response', 'Project tag acknowledgment is invalid.', 502);
      return meta;
    },
  };
}
export type ProjectMetaService = ReturnType<typeof createProjectMeta>;
