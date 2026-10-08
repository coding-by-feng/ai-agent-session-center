/**
 * Skill notes (favourite, tags, abbreviation) for this browser.
 *
 * Local-first: kept in `localStorage['aasc.skillNotes.v1']`, per viewer, like
 * the Library's added folders. All shaping lives in `lib/skillNotes.ts`; this
 * store only holds the current notes, writes them through and follows edits
 * made in another window of the same browser (pop-outs, a second tab).
 * Storage can be absent or throw (private window, quota): notes then work in
 * memory for the session instead of failing.
 */
import { create } from 'zustand';
import {
  STORAGE_KEY,
  parseStored,
  serialize,
  validateAbbr,
  withAbbr,
  withCli,
  withFav,
  withTag,
  withoutTag,
  type AbbrCheck,
  type SkillNotes,
} from '@/lib/skillNotes';

export function loadSkillNotes(): SkillNotes {
  try {
    return parseStored(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
}

function save(notes: SkillNotes): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(notes));
  } catch {
    /* in-memory only */
  }
}

interface SkillNotesState {
  notes: SkillNotes;
  toggleFav: (key: string) => void;
  addTag: (key: string, tag: string) => void;
  removeTag: (key: string, tag: string) => void;
  /** Record that the abbreviation does (or no longer does) exist as a real CLI command. */
  setCli: (key: string, cli: boolean) => void;
  /** Empty string clears it. `realNames` = `agent:name` keys of the real catalog. */
  setAbbr: (key: string, abbr: string, realNames: ReadonlySet<string>) => AbbrCheck | { ok: true; value: '' };
}

export const useSkillNotesStore = create<SkillNotesState>((set, get) => {
  const commit = (next: SkillNotes) => {
    if (next === get().notes) return;
    set({ notes: next });
    save(next);
  };
  return {
    notes: loadSkillNotes(),
    toggleFav: (key) => commit(withFav(get().notes, key, !get().notes[key]?.fav)),
    addTag: (key, tag) => commit(withTag(get().notes, key, tag)),
    removeTag: (key, tag) => commit(withoutTag(get().notes, key, tag)),
    setCli: (key, cli) => commit(withCli(get().notes, key, cli)),
    setAbbr: (key, abbr, realNames) => {
      if (!abbr.trim()) {
        commit(withAbbr(get().notes, key, null));
        return { ok: true, value: '' };
      }
      const check = validateAbbr(abbr, key, get().notes, realNames);
      if (check.ok) commit(withAbbr(get().notes, key, check.value));
      return check;
    },
  };
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) useSkillNotesStore.setState({ notes: loadSkillNotes() });
  });
}
