/**
 * composerDraftStore — what the phone's composer holds for each session before
 * it is sent (AASC-41 / AASC-44 / AASC-42).
 *
 * Others put text into a draft: the chat's "Pull back" on a queued prompt, a
 * diff line's "Comment" ("src/ui/icons.tsx:41 — "). The composer reads and edits
 * the same draft, so the text is waiting there when you get back to the chat.
 * In memory only, like the queue's compose drafts.
 *
 * Phone-only (src/__tests__/phoneChunkBoundary.test.ts).
 */
import { create } from 'zustand';

interface ComposerDraftState {
  drafts: Record<string, string>;
  setDraft: (sessionId: string, text: string) => void;
  /** Add `text` on a line of its own after what is there. */
  appendToDraft: (sessionId: string, text: string) => void;
}

/** `text` after `draft`, on a new line unless the draft is empty or already ends one. */
export function appendedDraft(draft: string, text: string): string {
  if (!draft) return text;
  return draft.endsWith('\n') ? `${draft}${text}` : `${draft}\n${text}`;
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  drafts: {},
  setDraft: (sessionId, text) =>
    set((s) => {
      if ((s.drafts[sessionId] ?? '') === text) return s;
      const drafts = { ...s.drafts };
      if (text) drafts[sessionId] = text;
      else delete drafts[sessionId];
      return { drafts };
    }),
  appendToDraft: (sessionId, text) =>
    set((s) => (text ? { drafts: { ...s.drafts, [sessionId]: appendedDraft(s.drafts[sessionId] ?? '', text) } } : s)),
}));
