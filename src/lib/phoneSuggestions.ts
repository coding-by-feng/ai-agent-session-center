/**
 * phoneSuggestions — what the phone's suggestion bar offers above the keyboard
 * (AASC-20, feature 70), and the skill notes it ranks them by.
 *
 * A phone has no skill notes of its own (they live in the desktop's browser and
 * the cloud), so it reads the user's favourites through the Mac: `GET
 * /api/skill-notes/favorites` answers `{ key, fav, tags, abbr }` per note, from
 * the Mac's cloud connection. With no connection the list is empty and the bar
 * ranks commands plainly (prefix, then A–Z). Those notes are read-only here and
 * never enter `skillNotesStore`, which would sync them back to the cloud.
 *
 * Pure apart from `fetchPhoneSkillNotes`, which caches for a minute.
 */
import { entryDisplayName, entryToken, type CommandEntry, type CommandKind } from './commandIndex';
import { lookupNote, withAbbr, withFav, withTag, ABBR_RE, type SkillNote, type SkillNotes } from './skillNotes';

export interface Suggestion {
  /** What goes into the prompt, sigil included (`/name`, or `$name` for a Codex skill). */
  token: string;
  kind: CommandKind;
  fav: boolean;
  abbr?: string;
}

/** How many chips the bar offers at once (it scrolls sideways). */
export const SUGGESTION_LIMIT = 12;

const KEY_RE = /^(claude|codex|shared):\S+$/;

/** The Mac's answer as read-only notes. Anything malformed is dropped, field by field. */
export function notesFromFavorites(body: unknown): SkillNotes {
  const entries = (body as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return {};
  let notes: SkillNotes = {};
  for (const raw of entries) {
    if (!raw || typeof raw !== 'object') continue;
    const { key, fav, tags, abbr } = raw as Record<string, unknown>;
    if (typeof key !== 'string' || !KEY_RE.test(key) || typeof fav !== 'boolean') continue;
    notes = withFav(notes, key, fav);
    if (Array.isArray(tags)) for (const t of tags) if (typeof t === 'string') notes = withTag(notes, key, t);
    if (typeof abbr === 'string' && ABBR_RE.test(abbr)) notes = withAbbr(notes, key, abbr);
  }
  return notes;
}

/** The phone's own notes (if any) win over the Mac's for the same key. */
export function mergeNotes(remote: SkillNotes, local: SkillNotes): SkillNotes {
  return { ...remote, ...local };
}

function toSuggestion(entry: CommandEntry, note: SkillNote | null): Suggestion {
  return {
    token: entryToken(entry),
    kind: entry.kind,
    fav: !!note?.fav,
    ...(note?.abbr ? { abbr: note.abbr } : {}),
  };
}

/**
 * Commands and skills matching `query`, best first: the exact abbreviation,
 * then favourites, then names (or abbreviations) that start with the query,
 * then the most used (`uses`, the Mac's count of your recent prompts; Oct 21
 * 2026, it was A–Z), then A–Z. With no notes this is the plain command ranking.
 * One flat list, not grouped by source: a favourite global skill outranks a
 * built-in command.
 */
export function rankSuggestions(
  entries: readonly CommandEntry[],
  query: string,
  kinds: readonly CommandKind[],
  notes: SkillNotes,
  limit = SUGGESTION_LIMIT,
): Suggestion[] {
  const q = query.toLowerCase();
  const scored = entries
    .filter((e) => kinds.includes(e.kind))
    .map((e) => ({ e, name: entryDisplayName(e).toLowerCase(), note: lookupNote(notes, e.cli, entryDisplayName(e)) }))
    .filter(({ name, note }) => !q || name.includes(q) || !!note?.abbr?.startsWith(q));
  scored.sort((a, b) => {
    const exact = (x: typeof a) => (q && x.note?.abbr === q ? 0 : 1);
    const fav = (x: typeof a) => (x.note?.fav ? 0 : 1);
    const prefix = (x: typeof a) => (q && (x.name.startsWith(q) || x.note?.abbr?.startsWith(q)) ? 0 : 1);
    const used = (x: typeof a) => x.e.uses ?? 0;
    return exact(a) - exact(b) || fav(a) - fav(b) || prefix(a) - prefix(b) || used(b) - used(a) || a.name.localeCompare(b.name);
  });
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const { e, note } of scored) {
    const s = toSuggestion(e, note);
    if (seen.has(s.token)) continue;
    seen.add(s.token);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * What a sigil lists in the Chat composer (Oct 21 2026), or null for nothing: `/` lists
 * commands and skills on both CLIs, each by its own token (a Codex skill goes in as
 * `$name`, as the terminal's `/` list does); `$` lists skills on Codex only (on Claude it
 * is ordinary text: $HOME, a price); `@` is the file sheet's.
 */
export function chatSuggestionKinds(type: 'command' | 'skill' | 'file', cli: 'claude' | 'codex'): CommandKind[] | null {
  if (type === 'command') return ['command', 'skill'];
  if (type === 'skill' && cli === 'codex') return ['skill'];
  return null;
}

/** With nothing typed yet: the favourites, then anything with an abbreviation. Empty without notes. */
export function favoriteSuggestions(
  entries: readonly CommandEntry[],
  kinds: readonly CommandKind[],
  notes: SkillNotes,
  limit = SUGGESTION_LIMIT,
): Suggestion[] {
  return rankSuggestions(entries, '', kinds, notes, Number.MAX_SAFE_INTEGER)
    .filter((s) => s.fav || s.abbr)
    .slice(0, limit);
}

/**
 * Put `token` into `text` at the caret. Inside a `/foo` or `$foo` fragment it
 * replaces the fragment (from `triggerStart`); elsewhere it is inserted as its
 * own word. Always followed by one space, so the next word can start at once.
 */
export function insertSuggestion(
  text: string,
  caret: number,
  token: string,
  triggerStart: number | null,
): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const start = triggerStart ?? at;
  const before = text.slice(0, start);
  const after = text.slice(at).replace(/^ +/, '');
  const lead = triggerStart === null && before && !/\s$/.test(before) ? ' ' : '';
  const head = `${before}${lead}${token} `;
  return { text: head + after, caret: head.length };
}

/**
 * Start a command at the caret: the bare sigil, as the start of its own word,
 * touching nothing after the caret (so the list for it opens next).
 */
export function insertSigil(text: string, caret: number, sigil: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const head = `${before}${lead}${sigil}`;
  return { text: head + text.slice(at), caret: head.length };
}

// ── The Mac's favourites ─────────────────────────────────────────────────────

const TTL_MS = 60_000;
let cache: { at: number; notes: SkillNotes } | null = null;
let inflight: Promise<SkillNotes> | null = null;

/** The user's skill notes as the Mac reads them; `{}` without a cloud connection or on any failure. */
export function fetchPhoneSkillNotes(now = Date.now()): Promise<SkillNotes> {
  if (cache && now - cache.at < TTL_MS) return Promise.resolve(cache.notes);
  if (inflight) return inflight;
  const request: Promise<SkillNotes> = fetch('/api/skill-notes/favorites')
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return notesFromFavorites(await res.json());
    })
    .then(
      (notes) => {
        cache = { at: Date.now(), notes };
        return notes;
      },
      // A failed read is not cached: the next keystroke asks again.
      () => ({}),
    )
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  inflight = request;
  return request;
}

/** Tests only: forget the cached answer. */
export function resetPhoneSkillNotesCache(): void {
  cache = null;
  inflight = null;
}
