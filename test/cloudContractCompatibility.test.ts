import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as notes from '../src/types/skillNotesSync.js';
import { normalizeTag } from '../src/lib/skillNotes.js';
import notesFixture from './fixtures/cloud-notes-contracts.json';
// Canonical JSON copy originates in the backend's contracts/fixtures. No production sibling imports.
type NotesContract = Pick<typeof notes, 'NoteMutationSchema' | 'NoteRecordSchema' | 'NoteResultSchema'>;
function contractCases(s: NotesContract) {
  it('accepts the canonical metadata-only note mutation, record and conflict', () => {
    expect(s.NoteMutationSchema.parse(notesFixture.mutation)).toEqual(notesFixture.mutation);
    expect(s.NoteRecordSchema.parse(notesFixture.record)).toEqual(notesFixture.record);
    expect(s.NoteResultSchema.parse(notesFixture.tagLimitConflict)).toMatchObject({
      error: { code: 'tag_limit_conflict' },
      proposedTags: notesFixture.tagLimitConflict.proposedTags,
    });
  });
  it('rejects notes content, account and credential fields', () => {
    for (const extra of ['content', 'path', 'token', 'accountId', 'backendOrigin'])
      expect(
        s.NoteMutationSchema.safeParse({ ...notesFixture.mutation, [extra]: 'forbidden' }).success,
      ).toBe(false);
  });
}
describe('AASC canonical notes contract', () => {
  contractCases(notes);
  it('normalizes canonical tags identically', () => {
    for (const f of notesFixture.normalization) expect(normalizeTag(f.raw)).toBe(f.tag);
  });
});
const beRoot = process.env.AASC_TEST_BE_ROOT;
describe.skipIf(!beRoot)('configured backend canonical notes contract parity', () => {
  let backend: NotesContract;
  beforeAll(async () => {
    backend = await import(/* @vite-ignore */ resolve(beRoot!, 'src/contracts/v1.ts'));
  });
  // Getter proxy defers schema resolution until beforeAll without importing any backend service.
  contractCases(
    new Proxy({} as NotesContract, { get: (_, k) => backend[k as keyof NotesContract] }),
  );
  it('uses an identical reviewed fixture copy from the configured repository', async () => {
    expect(
      JSON.parse(await readFile(resolve(beRoot!, 'contracts/fixtures/skill-notes.json'), 'utf8')),
    ).toEqual(notesFixture);
  });
});
