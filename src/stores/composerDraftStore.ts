/**
 * composerDraftStore — what the phone's composer holds for each session before
 * it is sent (AASC-41 / AASC-42 / AASC-44).
 *
 * Others put text into a draft: the chat's "Pull back" on a queued prompt, a
 * diff line's "Comment" ("src/ui/icons.tsx:41 — "). The composer reads and edits
 * the same draft, so the text is waiting there when you get back to the chat.
 * Kept in localStorage on this phone (never credentials), so a draft survives a
 * reload or the app being closed; storage failures leave it in memory only.
 *
 * Phone-only (src/__tests__/phoneChunkBoundary.test.ts).
 */
import { create } from 'zustand';

const STORAGE_KEY = 'aasc.composerDrafts';

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

function save(drafts: Record<string, string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
  } catch {
    /* private mode or full: the draft lives in memory only */
  }
}

interface ComposerDraftState {
  drafts: Record<string, string>;
  setDraft: (sessionId: string, text: string) => void;
  /** Add `text` on a line of its own after what is there. */
  appendToDraft: (sessionId: string, text: string) => void;
  /** A session re-keyed (/clear, a resume): its draft follows the new id (after any draft already there). */
  moveDraft: (oldId: string, newId: string) => void;
}

/** `text` after `draft`, on a new line unless the draft is empty or already ends one. */
export function appendedDraft(draft: string, text: string): string {
  if (!draft) return text;
  return draft.endsWith('\n') ? `${draft}${text}` : `${draft}\n${text}`;
}

function withDraft(drafts: Record<string, string>, sessionId: string, text: string): Record<string, string> {
  if (text) return { ...drafts, [sessionId]: text };
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== sessionId));
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  drafts: load(),
  setDraft: (sessionId, text) =>
    set((s) => {
      if ((s.drafts[sessionId] ?? '') === text) return s;
      const drafts = withDraft(s.drafts, sessionId, text);
      save(drafts);
      return { drafts };
    }),
  appendToDraft: (sessionId, text) =>
    set((s) => {
      if (!text.trim()) return s;
      const drafts = withDraft(s.drafts, sessionId, appendedDraft(s.drafts[sessionId] ?? '', text));
      save(drafts);
      return { drafts };
    }),
  moveDraft: (oldId, newId) =>
    set((s) => {
      const moving = s.drafts[oldId];
      if (!moving || oldId === newId) return s;
      const drafts = withDraft(withDraft(s.drafts, oldId, ''), newId, appendedDraft(s.drafts[newId] ?? '', moving));
      save(drafts);
      return { drafts };
    }),
}));
