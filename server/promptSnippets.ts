// promptSnippets.ts — the saved-prompt library, kept on the Mac (AASC-20).
//
// Saved prompts lived in each browser's IndexedDB, so the phone and every other
// window had their own library. The Mac now holds the one list: every change
// answers with the whole list and broadcasts it (`snippets_update`) with a
// revision, and a client keeps whichever revision is newest — so a broadcast
// that arrives after a newer HTTP reply can't roll the list back. The list is
// small (capped), so whole-list replies cost nothing and need no merge.
//
// Prompt text never leaves the Mac: this is a local table, not a cloud service
// (backend roadmap: prompts stay off the backend).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';

export interface PromptSnippetRecord {
  id: number;
  text: string;
  label: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

export interface PromptSnippetList {
  revision: number;
  snippets: PromptSnippetRecord[];
}

/** At most this many saved prompts; the library is curated, not a history. */
export const MAX_SNIPPETS = 500;
export const MAX_SNIPPET_TEXT = 64 * 1024;
export const MAX_SNIPPET_LABEL = 120;

export interface PromptSnippetStore {
  list(): PromptSnippetRecord[];
  findByText(text: string): PromptSnippetRecord | null;
  insert(rec: Omit<PromptSnippetRecord, 'id'>): number;
  setLabel(id: number, label: string): boolean;
  markUsed(id: number, at: number): boolean;
  remove(id: number): boolean;
  count(): number;
}

/** Newest first, the order the picker shows. */
const byNewest = (a: PromptSnippetRecord, b: PromptSnippetRecord): number => b.createdAt - a.createdAt || b.id - a.id;

export function memorySnippetStore(): PromptSnippetStore {
  const rows = new Map<number, PromptSnippetRecord>();
  let nextId = 1;
  return {
    list: () => [...rows.values()].map((r) => ({ ...r })).sort(byNewest),
    findByText: (text) => {
      const hit = [...rows.values()].find((r) => r.text === text);
      return hit ? { ...hit } : null;
    },
    insert: (rec) => {
      const id = nextId++;
      rows.set(id, { ...rec, id });
      return id;
    },
    setLabel: (id, label) => {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, { ...row, label });
      return true;
    },
    markUsed: (id, at) => {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, { ...row, useCount: row.useCount + 1, lastUsedAt: at });
      return true;
    },
    remove: (id) => rows.delete(id),
    count: () => rows.size,
  };
}

interface SnippetRow {
  id: number;
  text: string;
  label: string;
  use_count: number;
  last_used_at: number | null;
  created_at: number;
}

const fromRow = (r: SnippetRow): PromptSnippetRecord => ({
  id: r.id,
  text: r.text,
  label: r.label,
  useCount: r.use_count,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
});

export function sqliteSnippetStore(db: Database.Database): PromptSnippetStore {
  db.exec(`CREATE TABLE IF NOT EXISTS prompt_snippets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL DEFAULT '',
    use_count INTEGER NOT NULL DEFAULT 0,
    last_used_at INTEGER,
    created_at INTEGER NOT NULL
  )`);
  const stmts = {
    list: db.prepare('SELECT * FROM prompt_snippets ORDER BY created_at DESC, id DESC'),
    byText: db.prepare('SELECT * FROM prompt_snippets WHERE text = ?'),
    insert: db.prepare(`INSERT INTO prompt_snippets (text, label, use_count, last_used_at, created_at)
      VALUES (@text, @label, @useCount, @lastUsedAt, @createdAt)`),
    label: db.prepare('UPDATE prompt_snippets SET label = ? WHERE id = ?'),
    used: db.prepare('UPDATE prompt_snippets SET use_count = use_count + 1, last_used_at = ? WHERE id = ?'),
    remove: db.prepare('DELETE FROM prompt_snippets WHERE id = ?'),
    count: db.prepare('SELECT COUNT(*) AS n FROM prompt_snippets'),
  };
  return {
    list: () => (stmts.list.all() as SnippetRow[]).map(fromRow),
    findByText: (text) => {
      const row = stmts.byText.get(text) as SnippetRow | undefined;
      return row ? fromRow(row) : null;
    },
    insert: (rec) => Number(stmts.insert.run(rec).lastInsertRowid),
    setLabel: (id, label) => stmts.label.run(label, id).changes > 0,
    markUsed: (id, at) => stmts.used.run(at, id).changes > 0,
    remove: (id) => stmts.remove.run(id).changes > 0,
    count: () => (stmts.count.get() as { n: number }).n,
  };
}

const textSchema = z.string().max(MAX_SNIPPET_TEXT).transform((s) => s.trim()).pipe(z.string().min(1));
const labelSchema = z.string().max(MAX_SNIPPET_LABEL).transform((s) => s.trim());
const saveSchema = z.object({ text: textSchema, label: labelSchema.optional() });
const labelBodySchema = z.object({ label: labelSchema });
const importSchema = z.object({
  snippets: z.array(z.object({
    text: textSchema,
    label: labelSchema.optional(),
    useCount: z.number().int().min(0).max(1_000_000).optional(),
    lastUsedAt: z.number().int().positive().nullish(),
    createdAt: z.number().int().positive().optional(),
  })).max(MAX_SNIPPETS),
});

export interface PromptSnippetRouterDeps {
  /** The store, opened on first use (the SQLite handle may not exist at import time). */
  store: () => PromptSnippetStore;
  /** Send the new list to every connected window and device. */
  broadcast: (list: PromptSnippetList) => void;
  now?: () => number;
}

export function createPromptSnippetRouter(deps: PromptSnippetRouterDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  // Monotonic across restarts: never behind the clock, never repeated.
  let revision = 0;
  const bump = (): number => {
    revision = Math.max(revision + 1, now());
    return revision;
  };
  const current = (): PromptSnippetList => ({ revision: revision || bump(), snippets: deps.store().list() });
  const changed = (): PromptSnippetList => {
    bump();
    const list = current();
    deps.broadcast(list);
    return list;
  };
  const idOf = (req: Request): number | null => {
    const id = Number(req.params.id);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  };
  const invalid = (res: Response, error: string): void => {
    res.status(400).json({ success: false, error });
  };

  router.get('/snippets', (_req, res) => {
    res.json({ success: true, ...current() });
  });

  router.post('/snippets', (req, res) => {
    const body = saveSchema.safeParse(req.body);
    if (!body.success) { invalid(res, 'A saved prompt needs text (at most 64 KB) and an optional name'); return; }
    const existing = deps.store().findByText(body.data.text);
    if (existing) {
      res.json({ success: true, id: existing.id, duplicate: true, ...current() });
      return;
    }
    if (deps.store().count() >= MAX_SNIPPETS) {
      res.status(409).json({ success: false, error: `At most ${MAX_SNIPPETS} saved prompts; remove one first` });
      return;
    }
    const id = deps.store().insert({ text: body.data.text, label: body.data.label ?? '', useCount: 0, lastUsedAt: null, createdAt: now() });
    res.json({ success: true, id, duplicate: false, ...changed() });
  });

  router.patch('/snippets/:id', (req, res) => {
    const id = idOf(req);
    const body = labelBodySchema.safeParse(req.body);
    if (id === null || !body.success) { invalid(res, 'A name is at most 120 characters'); return; }
    if (!deps.store().setLabel(id, body.data.label)) { res.status(404).json({ success: false, error: 'No such saved prompt' }); return; }
    res.json({ success: true, ...changed() });
  });

  router.post('/snippets/:id/use', (req, res) => {
    const id = idOf(req);
    if (id === null || !deps.store().markUsed(id, now())) { res.status(404).json({ success: false, error: 'No such saved prompt' }); return; }
    res.json({ success: true, ...changed() });
  });

  router.delete('/snippets/:id', (req, res) => {
    const id = idOf(req);
    if (id === null) { invalid(res, 'Bad id'); return; }
    // Deleting what is already gone is not an error: two windows may remove it at once.
    const removed = deps.store().remove(id);
    res.json({ success: true, ...(removed ? changed() : current()) });
  });

  /**
   * A browser's own library from before this change (IndexedDB), merged in once
   * by text: a prompt the Mac already holds is left as it is, and anything over
   * the cap is left out and counted.
   */
  router.post('/snippets/import', (req, res) => {
    const body = importSchema.safeParse(req.body);
    if (!body.success) { invalid(res, 'Not a list of saved prompts'); return; }
    let added = 0;
    let skipped = 0;
    for (const s of body.data.snippets) {
      if (deps.store().findByText(s.text)) continue;
      if (deps.store().count() >= MAX_SNIPPETS) { skipped++; continue; }
      deps.store().insert({
        text: s.text,
        label: s.label ?? '',
        useCount: s.useCount ?? 0,
        lastUsedAt: s.lastUsedAt ?? null,
        createdAt: s.createdAt ?? now(),
      });
      added++;
    }
    res.json({ success: true, added, skipped, ...(added > 0 ? changed() : current()) });
  });

  return router;
}
