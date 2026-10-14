import type { NoteMutation, NoteRecord } from '@/types/skillNotesSync';
import { normalizeTag, type SkillNotes } from './skillNotes';
export const blankRecord = (key: string): NoteRecord => ({
  key,
  value: { fav: false, tags: [] },
  version: 1,
  deleted: false,
  tagDots: [],
});
/** Pending operations never advance the acknowledged version. */
export function projectNote(base: NoteRecord | null, ops: NoteMutation[]): NoteRecord {
  let r: NoteRecord = structuredClone(base ?? blankRecord(ops[0].key));
  for (const op of ops) {
    if (op.delete) {
      r = { ...r, deleted: true, value: { fav: false, tags: [] }, tagDots: [] };
      continue;
    }
    // Keep an unresolved pre-delete operation visible without silently restoring the server record.
    if (r.deleted) r = { ...r, deleted: false, value: { fav: false, tags: [] }, tagDots: [] };
    const removed = new Set(op.removeTagDots ?? []);
    const dots = new Map(r.tagDots.map((t) => [t.tag, t.dots.filter((d) => !removed.has(d))]));
    for (const a of op.addTags ?? []) {
      const tag = normalizeTag(a.tag);
      if (tag && !removed.has(a.dot)) {
        const ds = dots.get(tag) ?? [];
        if (!ds.includes(a.dot)) ds.push(a.dot);
        dots.set(tag, ds);
      }
    }
    const tagDots = [...dots]
      .filter(([, d]) => d.length)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([tag, ds]) => ({ tag, dots: ds.sort() }));
    const value = { ...r.value, tags: tagDots.map((t) => t.tag) };
    if (op.set?.fav !== undefined) value.fav = op.set.fav;
    if (op.set?.abbr !== undefined) {
      if (op.set.abbr) value.abbr = op.set.abbr;
      else delete value.abbr;
    }
    if (op.set?.cli !== undefined) {
      if (op.set.cli && value.abbr) value.cli = true;
      else delete value.cli;
    }
    if (!value.abbr) delete value.cli;
    r = { ...r, value, tagDots };
  }
  return r;
}
export function notesProjection(records: NoteRecord[]): SkillNotes {
  return Object.fromEntries(
    records
      .filter((r) => !r.deleted && (r.value.fav || r.value.tags.length || r.value.abbr))
      .map((r) => [r.key, r.value]),
  );
}
