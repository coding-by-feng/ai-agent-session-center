/**
 * composerDraftStore — the phone composer's unsent text, per session (AASC-41/42).
 * Kept in localStorage on this phone (not credentials), so a draft survives a reload.
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
  /** Add to the end of the draft on its own line (a quoted reference, a snippet). */
  appendToDraft: (sessionId: string, text: string) => void;
}

function withDraft(drafts: Record<string, string>, sessionId: string, text: string): Record<string, string> {
  if (text) return { ...drafts, [sessionId]: text };
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== sessionId));
}

export const useComposerDraftStore = create<ComposerDraftState>((set) => ({
  drafts: load(),
  setDraft: (sessionId, text) => set((s) => {
    const drafts = withDraft(s.drafts, sessionId, text);
    save(drafts);
    return { drafts };
  }),
  appendToDraft: (sessionId, text) => set((s) => {
    const addition = text.trim();
    if (!addition) return s;
    const base = (s.drafts[sessionId] ?? '').trimEnd();
    const drafts = withDraft(s.drafts, sessionId, base ? `${base}\n${addition}` : addition);
    save(drafts);
    return { drafts };
  }),
}));
