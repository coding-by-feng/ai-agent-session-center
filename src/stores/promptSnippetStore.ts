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

interface PromptSnippetState {
  snippets: PromptSnippet[];
  loaded: boolean;

  loadFromDb: () => Promise<void>;

  /** Keep `text` as a snippet. Trims first; a blank string is a no-op. An
   *  exact duplicate is NOT re-added — the existing row's id comes back with
   *  `duplicate: true` so the caller can say so instead of silently doing
   *  nothing. */
  save: (text: string, label?: string) => Promise<SaveSnippetResult>;

  /** Forget a snippet. */
  remove: (id: number) => Promise<void>;

  /** Rename (or clear the name of) a snippet. Blank clears back to ''. */
  setLabel: (id: number, label: string) => Promise<void>;

  /** Record an insertion — bumps useCount + lastUsedAt so "most used"
   *  ordering reflects reality. Fire-and-forget from the UI. */
  touch: (id: number) => Promise<void>;

  /** True when this exact (trimmed) text is already kept — drives the filled
   *  state of the 🔖 button, mirroring the ★/☆ pattern on queue rows. */
  hasText: (text: string) => boolean;
}

function rowToSnippet(row: {
  id?: number;
  text: string;
  label?: string;
  useCount?: number;
  lastUsedAt?: number;
  createdAt: number;
}): PromptSnippet | null {
  if (row.id == null) return null;
  return {
    id: row.id,
    text: row.text,
    label: row.label ?? '',
    useCount: row.useCount ?? 0,
    lastUsedAt: row.lastUsedAt ?? null,
    createdAt: row.createdAt,
  };
}

export const usePromptSnippetStore = create<PromptSnippetState>((set, get) => ({
  snippets: [],
  loaded: false,

  loadFromDb: async () => {
    try {
      const rows = await db.promptSnippets.orderBy('createdAt').reverse().toArray();
      const snippets = rows
        .map(rowToSnippet)
        .filter((s): s is PromptSnippet => s !== null);
      set({ snippets, loaded: true });
    } catch {
      // Match the other stores: a failed hydrate must still flip `loaded` so
      // the UI renders an empty library instead of hanging on a spinner.
      set({ loaded: true });
    }
  },

  save: async (text, label = '') => {
    const trimmed = text.trim();
    if (!trimmed) return { id: null, duplicate: false };

    // Dedupe on exact trimmed text. Without this, hitting 🔖 twice on the same
    // compose box (easy to do — the button doesn't move) quietly builds a
    // library of identical rows.
    const existing = get().snippets.find((s) => s.text === trimmed);
    if (existing) return { id: existing.id, duplicate: true };

    const now = Date.now();
    const trimmedLabel = label.trim();
    try {
      const newId = await db.promptSnippets.add({
        text: trimmed,
        label: trimmedLabel,
        useCount: 0,
        createdAt: now,
      });
      const snippet: PromptSnippet = {
        id: newId as number,
        text: trimmed,
        label: trimmedLabel,
        useCount: 0,
        lastUsedAt: null,
        createdAt: now,
      };
      // Newest first, so a just-kept snippet is visible without scrolling.
      set((s) => ({ snippets: [snippet, ...s.snippets] }));
      return { id: snippet.id, duplicate: false };
    } catch {
      return { id: null, duplicate: false };
    }
  },

  remove: async (id) => {
    try {
      await db.promptSnippets.delete(id);
    } catch {
      // Fall through — dropping it from memory keeps the UI honest even if the
      // write failed, and the next load reconciles.
    }
    set((s) => ({ snippets: s.snippets.filter((snippet) => snippet.id !== id) }));
  },

  setLabel: async (id, label) => {
    const next = label.trim();
    const current = get().snippets.find((s) => s.id === id);
    if (!current || current.label === next) return;
    try {
      await db.promptSnippets.update(id, { label: next });
    } catch {
      return;
    }
    set((s) => ({
      snippets: s.snippets.map((snippet) =>
        snippet.id === id ? { ...snippet, label: next } : snippet,
      ),
    }));
  },

  touch: async (id) => {
    const current = get().snippets.find((s) => s.id === id);
    if (!current) return;
    const now = Date.now();
    const useCount = current.useCount + 1;
    try {
      await db.promptSnippets.update(id, { useCount, lastUsedAt: now });
    } catch {
      return;
    }
    set((s) => ({
      snippets: s.snippets.map((snippet) =>
        snippet.id === id ? { ...snippet, useCount, lastUsedAt: now } : snippet,
      ),
    }));
  },

  hasText: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    return get().snippets.some((s) => s.text === trimmed);
  },
}));
