/**
 * phoneAiStore — which phone surfaces take AI popups now, and the ask that is
 * open (AASC-57). Phone-only.
 *
 * A surface whose selected text can start a popup (the Chat, a popup's answer, the
 * terminal's text, a project file) mounts one PhoneSelectionAi for its scope id; that
 * registers the scope while AI popups are on for its session. Anything else on the
 * surface (an answer's "Ask AI", the file's toolbar button, the terminal's button) asks
 * through here instead of owning a second sheet: `ask(scope, selection)` opens that
 * scope's actions sheet, with the selection or, with none, the whole-content choices
 * (the last answer, the whole file).
 */
import { create } from 'zustand';

export interface PhoneAiSelection {
  text: string;
  /** The passage the text was selected from, for context. */
  contextLine?: string;
}

export interface PhoneAiAsk {
  scopeId: string;
  selection: PhoneAiSelection | null;
}

interface PhoneAiState {
  /** Scopes taking AI popups now, with how many surfaces registered each. */
  scopes: Record<string, number>;
  /** The ask whose actions sheet is open, or null. */
  pending: PhoneAiAsk | null;
  /** Register a scope; returns the unregister. */
  register: (scopeId: string) => () => void;
  ask: (scopeId: string, selection: PhoneAiSelection | null) => void;
  /** Close the sheet of `scopeId` (any scope when omitted). */
  clear: (scopeId?: string) => void;
}

export const usePhoneAiStore = create<PhoneAiState>((set, get) => ({
  scopes: {},
  pending: null,

  register: (scopeId) => {
    set((s) => ({ scopes: { ...s.scopes, [scopeId]: (s.scopes[scopeId] ?? 0) + 1 } }));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      set((s) => {
        const left = (s.scopes[scopeId] ?? 1) - 1;
        const scopes = Object.fromEntries(Object.entries(s.scopes).filter(([id]) => id !== scopeId));
        const pending = left <= 0 && s.pending?.scopeId === scopeId ? null : s.pending;
        return { scopes: left > 0 ? { ...scopes, [scopeId]: left } : scopes, pending };
      });
    };
  },

  ask: (scopeId, selection) => {
    if (!get().scopes[scopeId]) return;
    set({ pending: { scopeId, selection } });
  },

  clear: (scopeId) => set((s) => (scopeId === undefined || s.pending?.scopeId === scopeId ? { pending: null } : s)),
}));

/** Does this scope take AI popups now? */
export function usePhoneAiScopeOn(scopeId: string): boolean {
  return usePhoneAiStore((s) => (s.scopes[scopeId] ?? 0) > 0);
}
