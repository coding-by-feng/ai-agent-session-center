/**
 * promptSnippetStore — a curated library of reusable prompt TEXT.
 *
 * Users click 🔖 on text they've decided is worth keeping (the queue compose
 * box, a MAIN prompt, a single chain step, or a row in the picker's RECENT
 * tab), and it becomes a snippet they can insert into any prompt box later.
 *
 * Why this is NOT part of queueHistoryStore:
 * - Different granularity: a history entry is a whole QueueItem (type,
 *   interval, before/after chains, images) applied as a NEW queue row. A
 *   snippet is bare text appended into a box that's already being typed.
 * - Different lifecycle: a snippet has no source session, no `historyId`
 *   back-reference on any live item, and nothing to reset on apply.
 * - Mixing them would put whole-loop patterns in a list the user opened to
 *   pick a one-line prompt.
 *
 * The library is curated on purpose: nothing writes here automatically. Raw
 * prompt history stays a read-only view over `sessionStore` (the picker's
 * RECENT tab) — only an explicit 🔖 promotes text into this table. That's the
 * whole point: "not all history selectable, just the ones we find useful."
 *
 * Kept on the Mac (AASC-20): the server's `prompt_snippets` table is the one
 * library, so the phone and every desktop window see the same. Each change
 * answers with the whole list and a revision, and `snippets_update` broadcasts
 * it; the store keeps whichever revision is newest. A browser's old IndexedDB
 * library is imported once.
 */

import { create } from 'zustand';
import { db } from '@/lib/db';

export interface PromptSnippet {
  id: number;
  /** The reusable prompt text, always stored trimmed. */
  text: string;
  /** Short display name. `''` when unnamed — the UI falls back to `text`. */
  label: string;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
}

/** Outcome of a save attempt, so the caller can toast the right message. */
export interface SaveSnippetResult {
  /** Id of the snippet now holding this text (existing one on a duplicate). */
  id: number | null;
  /** True when an identical snippet already existed and nothing was written. */
  duplicate: boolean;
}

/** The Mac's library, as every snippet route and `snippets_update` carries it. */
export interface SnippetList {
  revision: number;
  snippets: PromptSnippet[];
}

interface PromptSnippetState {
  snippets: PromptSnippet[];
  loaded: boolean;
  /** Revision of the list held; an older one (a late broadcast) is ignored. */
  revision: number;

  /** Load the Mac's library, importing this browser's old IndexedDB one once. */
  loadFromDb: () => Promise<void>;

  /** Take a list from the Mac if it is newer than the one held. */
  applyServerList: (list: SnippetList) => void;

  /** Keep `text` as a snippet. Trims first; a blank string is a no-op. An
   *  exact duplicate is reported, not re-added. */
  save: (text: string, label?: string) => Promise<SaveSnippetResult>;

  /** Forget a snippet. */
  remove: (id: number) => Promise<void>;

  /** Rename (or clear the name of) a snippet. Blank clears back to ''. */
  setLabel: (id: number, label: string) => Promise<void>;

  /** Record an insertion — bumps useCount + lastUsedAt so "most used"
   *  ordering works. */
  touch: (id: number) => Promise<void>;

  /** True when this exact (trimmed) text is already kept — drives the filled
   *  bookmark icon. */
  hasText: (text: string) => boolean;
}

/** Set once this browser's IndexedDB library has been offered to the Mac. */
export const SNIPPETS_IMPORTED_KEY = 'aasc.snippets.importedToMac.v1';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function isSnippet(value: unknown): value is PromptSnippet {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  return typeof s.id === 'number' && typeof s.text === 'string' && typeof s.label === 'string'
    && typeof s.useCount === 'number' && typeof s.createdAt === 'number'
    && (s.lastUsedAt === null || typeof s.lastUsedAt === 'number');
}

/** A server reply with a usable list, or null (an error, an old server, a malformed body). */
async function listFrom(res: Response): Promise<(SnippetList & Record<string, unknown>) | null> {
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.revision !== 'number' || !Array.isArray(body.snippets)) return null;
  return { ...body, revision: body.revision, snippets: body.snippets.filter(isSnippet) };
}

async function request(method: string, url: string, body?: unknown): Promise<(SnippetList & Record<string, unknown>) | null> {
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : JSON_HEADERS,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await listFrom(res);
  } catch {
    return null;
  }
}

function readImportedFlag(): boolean {
  try {
    return localStorage.getItem(SNIPPETS_IMPORTED_KEY) === '1';
  } catch {
    return true; // storage blocked: never import on every load
  }
}

function writeImportedFlag(): void {
  try {
    localStorage.setItem(SNIPPETS_IMPORTED_KEY, '1');
  } catch {
    /* the import is idempotent by text on the Mac, so a repeat costs nothing */
  }
}

async function readLocalLibrary(): Promise<PromptSnippet[]> {
  try {
    const rows = await db.promptSnippets.orderBy('createdAt').reverse().toArray();
    return rows
      .filter((r) => r.id != null && typeof r.text === 'string' && r.text.trim())
      .map((r) => ({
        id: r.id as number,
        text: r.text.trim(),
        label: r.label ?? '',
        useCount: r.useCount ?? 0,
        lastUsedAt: r.lastUsedAt ?? null,
        createdAt: r.createdAt,
      }));
  } catch {
    return [];
  }
}

export const usePromptSnippetStore = create<PromptSnippetState>((set, get) => ({
  snippets: [],
  loaded: false,
  revision: 0,

  applyServerList: (list) => {
    if (list.revision < get().revision) return;
    set({ snippets: list.snippets.map((s) => ({ ...s })), revision: list.revision, loaded: true });
  },

  loadFromDb: async () => {
    const list = await request('GET', '/api/snippets');
    if (!list) {
      // The Mac is unreachable: show this browser's own library so the picker
      // isn't empty, until the next load reaches the Mac.
      set({ snippets: await readLocalLibrary(), loaded: true });
      return;
    }
    get().applyServerList(list);
    if (readImportedFlag()) return;
    const local = await readLocalLibrary();
    if (local.length > 0) {
      const merged = await request('POST', '/api/snippets/import', {
        snippets: local.map(({ text, label, useCount, lastUsedAt, createdAt }) => ({ text, label, useCount, lastUsedAt, createdAt })),
      });
      if (!merged) return; // try again on the next load
      get().applyServerList(merged);
    }
    writeImportedFlag();
  },

  save: async (text, label = '') => {
    const trimmed = text.trim();
    if (!trimmed) return { id: null, duplicate: false };
    const existing = get().snippets.find((s) => s.text === trimmed);
    if (existing) return { id: existing.id, duplicate: true };
    const reply = await request('POST', '/api/snippets', { text: trimmed, label: label.trim() });
    if (!reply) return { id: null, duplicate: false };
    get().applyServerList(reply);
    return { id: typeof reply.id === 'number' ? reply.id : null, duplicate: reply.duplicate === true };
  },

  remove: async (id) => {
    // Gone at once on this screen; the Mac's reply (or broadcast) confirms it.
    set((s) => ({ snippets: s.snippets.filter((snippet) => snippet.id !== id) }));
    const reply = await request('DELETE', `/api/snippets/${encodeURIComponent(String(id))}`);
    if (reply) get().applyServerList(reply);
  },

  setLabel: async (id, label) => {
    const next = label.trim();
    const current = get().snippets.find((s) => s.id === id);
    if (!current || current.label === next) return;
    const reply = await request('PATCH', `/api/snippets/${encodeURIComponent(String(id))}`, { label: next });
    if (reply) get().applyServerList(reply);
  },

  touch: async (id) => {
    if (!get().snippets.some((s) => s.id === id)) return;
    const reply = await request('POST', `/api/snippets/${encodeURIComponent(String(id))}/use`);
    if (reply) get().applyServerList(reply);
  },

  hasText: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    return get().snippets.some((s) => s.text === trimmed);
  },
}));
