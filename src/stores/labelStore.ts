import { create } from 'zustand';

/**
 * labelStore — client-only single-label-per-session tagging.
 *
 * Labels live entirely in the browser (localStorage); there is no server, DB,
 * or API involvement. Each session may carry at most one label, keyed by
 * sessionId. Built-in labels are always available; users may add their own
 * custom labels (name + color) that persist and are reusable across sessions.
 */

export interface CustomLabel {
  name: string;
  color: string;
}

/** Built-in labels (name → color), always available in the picker. */
export const BUILTIN_LABELS: ReadonlyArray<CustomLabel> = [
  { name: 'ONEOFF', color: '#ff9100' },
  { name: 'HEAVY', color: '#ff3355' },
  { name: 'IMPORTANT', color: '#aa66ff' },
];

/** Fallback color when a label name has no known built-in/custom color. */
export const DEFAULT_LABEL_COLOR = '#7aa2ff';

/** Maximum number of user-defined custom labels. */
export const MAX_CUSTOM_LABELS = 30;

const LABEL_MAP_KEY = 'session-label-map';
const CUSTOM_DEFS_KEY = 'custom-label-defs';

function loadLabelMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LABEL_MAP_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, string>;
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    // Ignore parse errors
  }
  return {};
}

function saveLabelMap(labels: Record<string, string>) {
  try {
    localStorage.setItem(LABEL_MAP_KEY, JSON.stringify(labels));
  } catch {
    // Ignore quota errors
  }
}

function loadCustom(): CustomLabel[] {
  try {
    const raw = localStorage.getItem(CUSTOM_DEFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CustomLabel[];
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (l): l is CustomLabel =>
            !!l && typeof l.name === 'string' && typeof l.color === 'string',
        );
      }
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

function saveCustom(custom: CustomLabel[]) {
  try {
    localStorage.setItem(CUSTOM_DEFS_KEY, JSON.stringify(custom));
  } catch {
    // Ignore quota errors
  }
}

interface LabelState {
  /** sessionId → label name (single label per session). */
  labels: Record<string, string>;
  /** User-defined custom labels, reusable across sessions. */
  custom: CustomLabel[];

  /** Set (or clear, when name is null) the label for a session. */
  setLabel: (sessionId: string, name: string | null) => void;
  /** Add a custom label (deduped by name, capped at MAX_CUSTOM_LABELS). */
  addCustom: (name: string, color: string) => void;
  /** Remove a custom label by name. */
  removeCustom: (name: string) => void;

  /** Resolve a label name to its color (built-in, custom, or default). */
  labelColor: (name: string) => string;
  /** Get the current label name for a session, if any. */
  getLabel: (sessionId: string) => string | undefined;
  /** Reload both maps from localStorage. */
  loadFromStorage: () => void;
}

export const useLabelStore = create<LabelState>((set, get) => ({
  labels: loadLabelMap(),
  custom: loadCustom(),

  setLabel: (sessionId, name) =>
    set((state) => {
      const labels = { ...state.labels };
      if (name == null || name === '') {
        delete labels[sessionId];
      } else {
        labels[sessionId] = name;
      }
      saveLabelMap(labels);
      return { labels };
    }),

  addCustom: (name, color) =>
    set((state) => {
      const trimmed = name.trim();
      if (!trimmed) return state;
      // Dedupe by name (case-insensitive); update color if it already exists.
      const lower = trimmed.toLowerCase();
      const existingIdx = state.custom.findIndex((l) => l.name.toLowerCase() === lower);
      // Don't shadow a built-in label name.
      if (BUILTIN_LABELS.some((l) => l.name.toLowerCase() === lower) && existingIdx === -1) {
        return state;
      }
      let custom: CustomLabel[];
      if (existingIdx >= 0) {
        custom = state.custom.map((l, i) => (i === existingIdx ? { name: trimmed, color } : l));
      } else {
        if (state.custom.length >= MAX_CUSTOM_LABELS) return state;
        custom = [...state.custom, { name: trimmed, color }];
      }
      saveCustom(custom);
      return { custom };
    }),

  removeCustom: (name) =>
    set((state) => {
      const lower = name.toLowerCase();
      const custom = state.custom.filter((l) => l.name.toLowerCase() !== lower);
      if (custom.length === state.custom.length) return state;
      saveCustom(custom);
      return { custom };
    }),

  labelColor: (name) => {
    const lower = name.toLowerCase();
    const builtin = BUILTIN_LABELS.find((l) => l.name.toLowerCase() === lower);
    if (builtin) return builtin.color;
    const custom = get().custom.find((l) => l.name.toLowerCase() === lower);
    if (custom) return custom.color;
    return DEFAULT_LABEL_COLOR;
  },

  getLabel: (sessionId) => get().labels[sessionId],

  loadFromStorage: () => {
    set({ labels: loadLabelMap(), custom: loadCustom() });
  },
}));
