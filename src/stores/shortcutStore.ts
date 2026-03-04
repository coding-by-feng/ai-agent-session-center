/**
 * shortcutStore — Zustand store for customizable keyboard shortcuts.
 * Persists overrides to IndexedDB via db.settings.
 */
import { create } from 'zustand';
import type { KeyCombo, ShortcutActionId, ShortcutBinding } from '@/types/shortcut';
import { buildBindings, comboEquals, comboMatchesEvent } from '@/lib/shortcutKeys';
import { db } from '@/lib/db';

const DB_KEY = 'shortcutBindings';

interface ShortcutState {
  bindings: ShortcutBinding[];

  /** Replace a single shortcut's combo. Auto-persists. */
  rebind: (actionId: ShortcutActionId, combo: KeyCombo) => void;

  /** Reset one shortcut to its default combo. Auto-persists. */
  resetOne: (actionId: ShortcutActionId) => void;

  /** Reset all shortcuts to defaults. Auto-persists. */
  resetAll: () => void;

  /**
   * Check if a combo conflicts with an existing binding.
   * Returns the conflicting binding's actionId, or null.
   */
  getConflict: (combo: KeyCombo, excludeActionId: ShortcutActionId) => ShortcutBinding | null;

  /** Find which action a KeyboardEvent maps to (if any). */
  findActionForEvent: (e: KeyboardEvent) => ShortcutActionId | null;

  /** Load persisted overrides from IndexedDB (called on startup). */
  loadFromDb: (overrides: Partial<Record<ShortcutActionId, KeyCombo>>) => void;
}

function persistOverrides(bindings: ShortcutBinding[]): void {
  const overrides: Partial<Record<ShortcutActionId, KeyCombo>> = {};
  for (const b of bindings) {
    if (!comboEquals(b.combo, b.defaultCombo)) {
      overrides[b.actionId] = b.combo;
    }
  }
  // Only store non-default overrides
  const hasOverrides = Object.keys(overrides).length > 0;
  db.settings.put({
    key: DB_KEY,
    value: hasOverrides ? JSON.stringify(overrides) : JSON.stringify({}),
    updatedAt: Date.now(),
  }).catch(() => {
    // IndexedDB not available — silently ignore
  });
}

export const useShortcutStore = create<ShortcutState>((set, get) => ({
  bindings: buildBindings(),

  rebind(actionId, combo) {
    set((s) => {
      const bindings = s.bindings.map((b) =>
        b.actionId === actionId ? { ...b, combo: { ...combo } } : b,
      );
      persistOverrides(bindings);
      return { bindings };
    });
  },

  resetOne(actionId) {
    set((s) => {
      const bindings = s.bindings.map((b) =>
        b.actionId === actionId ? { ...b, combo: { ...b.defaultCombo } } : b,
      );
      persistOverrides(bindings);
      return { bindings };
    });
  },

  resetAll() {
    const bindings = buildBindings();
    persistOverrides(bindings);
    set({ bindings });
  },

  getConflict(combo, excludeActionId) {
    return (
      get().bindings.find(
        (b) => b.actionId !== excludeActionId && comboEquals(b.combo, combo),
      ) ?? null
    );
  },

  findActionForEvent(e) {
    const match = get().bindings.find((b) => comboMatchesEvent(b.combo, e));
    return match?.actionId ?? null;
  },

  loadFromDb(overrides) {
    set({ bindings: buildBindings(overrides) });
  },
}));
