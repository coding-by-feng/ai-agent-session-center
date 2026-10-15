import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as resources from '../src/types/cloudResources.js';
import * as projects from '../src/types/cloudProjects.js';
import * as notes from '../src/types/skillNotesSync.js';
import { normalizeTag } from '../src/lib/skillNotes.js';
import resourceFixture from './fixtures/cloud-resource-contracts.json';
import projectFixture from './fixtures/cloud-project-contracts.json';
import notesFixture from './fixtures/cloud-notes-contracts.json';
// Canonical JSON copies originate in BE/contracts/fixtures. No production sibling imports.
const client = { ...resources, ...projects, ...notes };
function contractCases(s: typeof client) {
  it('accepts canonical publication, immutable result, head and conflict envelopes', () => {
    expect(s.BeginUploadSchema.parse(resourceFixture.beginUpload)).toEqual(
      resourceFixture.beginUpload,
    );
    expect(s.BeginUploadResultSchema.parse(resourceFixture.beginUploadResponse.data)).toEqual(
      resourceFixture.beginUploadResponse.data,
    );
    expect(s.ResourceVersionSchema.parse(resourceFixture.commitResponse.data)).toEqual(
      resourceFixture.commitResponse.data,
    );
    expect(s.ResourceHeadSchema.parse(resourceFixture.headResponse.data)).toEqual(
      resourceFixture.headResponse.data,
    );
    for (const f of [
      resourceFixture.versionConflict,
      resourceFixture.versionInUse,
      projectFixture.versionConflict,
    ])
      expect(s.ResourceErrorDetailsSchema.parse(f.error.details)).toEqual(f.error.details);
  });
  it('accepts canonical project revisions and metadata-only note mutation/record', () => {
    for (const f of [projectFixture.create, projectFixture.update])
      expect(s.ProjectMutationSchema.parse(f)).toEqual(f);
    expect(s.ProjectRecordSchema.parse(projectFixture.deleteResponse.data)).toEqual(
      projectFixture.deleteResponse.data,
    );
    expect(s.NoteMutationSchema.parse(notesFixture.mutation)).toEqual(notesFixture.mutation);
    expect(s.NoteRecordSchema.parse(notesFixture.record)).toEqual(notesFixture.record);
    expect(s.NoteResultSchema.parse(notesFixture.tagLimitConflict)).toMatchObject({
      error: { code: 'tag_limit_conflict' },
      proposedTags: notesFixture.tagLimitConflict.proposedTags,
    });
  });
  it('rejects absolute/traversing resource paths and notes content/account/credential fields', () => {
    for (const path of ['/private/data', 'C:\\Users\\file', '../escape', 'a/../../escape'])
      expect(
        s.PackageManifestSchema.safeParse({
          ...resourceFixture.beginUpload.manifest,
          files: [{ ...resourceFixture.beginUpload.manifest.files[0], path }],
        }).success,
      ).toBe(false);
    for (const extra of ['content', 'path', 'token', 'accountId', 'backendOrigin'])
      expect(
        s.NoteMutationSchema.safeParse({ ...notesFixture.mutation, [extra]: 'forbidden' }).success,
      ).toBe(false);
  });
}
describe('AASC canonical cloud contracts', () => {
  contractCases(client);
  it('normalizes canonical tags identically', () => {
    for (const f of notesFixture.normalization) expect(normalizeTag(f.raw)).toBe(f.tag);
  });
});
const beRoot = process.env.AASC_TEST_BE_ROOT;
describe.skipIf(!beRoot)('configured backend canonical contract parity', () => {
  let backend: typeof client;
  beforeAll(async () => {
    backend = await import(/* @vite-ignore */ resolve(beRoot!, 'src/contracts/v1.ts'));
  });
  // Getter proxy defers schema resolution until beforeAll without importing any BE service/startup.
  contractCases(
    new Proxy({} as typeof client, { get: (_, k) => backend[k as keyof typeof client] }),
  );
  it('uses identical reviewed fixture copies from the configured repository', async () => {
    for (const [name, value] of [
      ['resources', resourceFixture],
      ['projects', projectFixture],
      ['skill-notes', notesFixture],
    ] as const)
      expect(
        JSON.parse(
          await readFile(resolve(beRoot!, 'contracts/fixtures/' + name + '.json'), 'utf8'),
        ),
      ).toEqual(value);
  });
});
