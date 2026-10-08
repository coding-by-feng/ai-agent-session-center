/**
 * Skill notes: a favourite flag, any number of tags and one abbreviation the
 * user puts on a skill or command.
 *
 * Notes are the user's own, so they live apart from the catalog and are keyed
 * by `agent:name`, never by file path (paths differ per machine and change on
 * a move). `type` is left out on purpose: in Claude Code and Codex a skill and
 * a command of one name are invoked the same way (`/name`), so one note covers
 * both. `shared` notes (skills under `~/.agents`) apply to every agent.
 *
 * Pure and import-free: used by the Library, the prompt autocomplete and the
 * Transfers selection, and unit-tested without a store or a DOM. Every update
 * returns a new object; stored text is untrusted and cleaned on the way in.
 */

export interface SkillNote {
  fav: boolean;
  tags: string[];
  abbr?: string;
  /**
   * The abbreviation also exists as a real command file in Claude Code / Codex
   * (server/resourceAliases.ts). Only ever true together with `abbr`.
   */
  cli?: boolean;
}

export type SkillNotes = Readonly<Record<string, SkillNote>>;

export type NoteAgent = 'claude' | 'codex' | 'shared';

export const MAX_TAGS = 12;
export const MAX_TAG_CHARS = 24;
/** 2–12 chars, lowercase letters, digits, `_` and `-`, starting with a letter or digit. */
export const ABBR_RE = /^[a-z0-9][a-z0-9_-]{1,11}$/;
export const STORAGE_KEY = 'aasc.skillNotes.v1';

export function noteKey(agent: NoteAgent, name: string): string {
  return `${agent}:${name}`;
}

/** Lowercase, words joined by `-`, letters/digits (any script), `_` and `-` only. Null when nothing is left. */
export function normalizeTag(raw: string): string | null {
  const tag = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_TAG_CHARS)
    .replace(/-+$/g, '');
  return tag || null;
}

function isEmpty(note: SkillNote): boolean {
  return !note.fav && note.tags.length === 0 && !note.abbr;
}

function put(notes: SkillNotes, key: string, note: SkillNote): SkillNotes {
  const next: Record<string, SkillNote> = { ...notes };
  if (isEmpty(note)) delete next[key];
  else next[key] = note;
  return next;
}

const blank: SkillNote = { fav: false, tags: [] };

export function withFav(notes: SkillNotes, key: string, fav: boolean): SkillNotes {
  return put(notes, key, { ...(notes[key] ?? blank), fav });
}

export function withTag(notes: SkillNotes, key: string, raw: string): SkillNotes {
  const tag = normalizeTag(raw);
  const cur = notes[key] ?? blank;
  if (!tag || cur.tags.includes(tag) || cur.tags.length >= MAX_TAGS) return notes;
  return put(notes, key, { ...cur, tags: [...cur.tags, tag] });
}

export function withoutTag(notes: SkillNotes, key: string, tag: string): SkillNotes {
  const cur = notes[key];
  if (!cur || !cur.tags.includes(tag)) return notes;
  return put(notes, key, { ...cur, tags: cur.tags.filter((t) => t !== tag) });
}

export function withAbbr(notes: SkillNotes, key: string, abbr: string | null): SkillNotes {
  const cur = notes[key] ?? blank;
  // Clearing the abbreviation also clears `cli`: there is nothing left to mirror.
  const next: SkillNote = { fav: cur.fav, tags: cur.tags };
  if (abbr) {
    next.abbr = abbr;
    if (cur.cli) next.cli = true;
  }
  return put(notes, key, next);
}

/** Record whether the abbreviation exists as a real CLI command. Needs an abbreviation. */
export function withCli(notes: SkillNotes, key: string, cli: boolean): SkillNotes {
  const cur = notes[key];
  if (!cur?.abbr) return notes;
  return put(notes, key, { fav: cur.fav, tags: cur.tags, abbr: cur.abbr, ...(cli ? { cli: true } : {}) });
}

export type AbbrCheck = { ok: true; value: string } | { ok: false; error: string };

/** The agent half of a key (`claude` in `claude:retouch`). */
function agentOf(key: string): string {
  return key.slice(0, key.indexOf(':'));
}
function nameOf(key: string): string {
  return key.slice(key.indexOf(':') + 1);
}

/**
 * Can `key` take this abbreviation? It must be well formed, must not equal a
 * real skill or command name (it would shadow it), and must be free among
 * every note that applies to the same agent: that agent's own and `shared`
 * ones. `realNames` holds `agent:name` keys of the real catalog.
 */
export function validateAbbr(
  raw: string,
  key: string,
  notes: SkillNotes,
  realNames: ReadonlySet<string>,
): AbbrCheck {
  const value = raw.trim().toLowerCase();
  if (!ABBR_RE.test(value)) {
    return { ok: false, error: 'Use 2–12 lowercase letters, digits, "-" or "_", starting with a letter or digit.' };
  }
  const agent = agentOf(key);
  const scopes = agent === 'shared' ? new Set(['claude', 'codex', 'shared']) : new Set([agent, 'shared']);
  for (const [other, note] of Object.entries(notes)) {
    if (other !== key && note.abbr === value && scopes.has(agentOf(other))) {
      return { ok: false, error: `"${value}" is already the abbreviation of ${nameOf(other)}.` };
    }
  }
  for (const real of realNames) {
    if (nameOf(real) === value && scopes.has(agentOf(real))) {
      return { ok: false, error: `"${value}" is the name of an existing skill or command.` };
    }
  }
  return { ok: true, value };
}

/** What applies to a skill as one agent sees it: its own note merged with the `shared` one. */
export function lookupNote(notes: SkillNotes, agent: 'claude' | 'codex', name: string): SkillNote | null {
  const own = notes[noteKey(agent, name)];
  const shared = notes[noteKey('shared', name)];
  if (!own && !shared) return null;
  const tags = [...(own?.tags ?? [])];
  for (const t of shared?.tags ?? []) if (!tags.includes(t)) tags.push(t);
  const abbr = own?.abbr ?? shared?.abbr;
  return { fav: !!(own?.fav || shared?.fav), tags, ...(abbr ? { abbr } : {}) };
}

/** Case-insensitive substring match on the tags and the abbreviation, for search. */
export function matchesNote(note: SkillNote | null, query: string): boolean {
  if (!note) return false;
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return note.tags.some((t) => t.includes(q)) || !!note.abbr?.includes(q);
}

/** The slice of a catalog resource that decides its note. Structural, so this file stays import-free. */
export interface NotableResource {
  agent: NoteAgent;
  type: string;
  name: string;
  origin?: string;
  pluginName?: string;
}

/** Skills and commands carry notes; rules, memory and the rest do not. */
export function isNotable(r: Pick<NotableResource, 'type'>): boolean {
  return r.type === 'skill' || r.type === 'command';
}

/** The name the prompt autocomplete shows: a plugin's items are typed `plugin:name`. */
export function resourceNoteName(r: NotableResource): string {
  return r.origin === 'plugin' && r.pluginName ? `${r.pluginName}:${r.name}` : r.name;
}

export function resourceNoteKey(r: NotableResource): string {
  return noteKey(r.agent, resourceNoteName(r));
}

/** A shared skill has only its own note; an agent's skill also inherits the shared one. */
export function noteForResource(notes: SkillNotes, r: NotableResource): SkillNote | null {
  if (!isNotable(r)) return null;
  if (r.agent === 'shared') return notes[resourceNoteKey(r)] ?? null;
  return lookupNote(notes, r.agent, resourceNoteName(r));
}

export interface NoteFilter {
  favOnly?: boolean;
  /** Match ANY of these tags. */
  tags?: readonly string[];
}

export function hasNoteFilter(f: NoteFilter): boolean {
  return !!f.favOnly || (f.tags?.length ?? 0) > 0;
}

export function passesNoteFilter(note: SkillNote | null, f: NoteFilter): boolean {
  if (f.favOnly && !note?.fav) return false;
  if (f.tags && f.tags.length > 0 && !f.tags.some((t) => note?.tags.includes(t))) return false;
  return true;
}

/** `?fav=1&tags=a,b` → the Library's note filter. Anything else is ignored. */
export function readNoteParams(params: URLSearchParams): { favOnly: boolean; tags: string[] } {
  const tags: string[] = [];
  for (const raw of (params.get('tags') ?? '').split(',')) {
    const tag = normalizeTag(raw);
    if (tag && !tags.includes(tag) && tags.length < MAX_TAGS) tags.push(tag);
  }
  return { favOnly: params.get('fav') === '1', tags };
}

export function tagsInUse(notes: SkillNotes): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const note of Object.values(notes)) {
    for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Parse what was stored. Anything malformed becomes empty; every field is cleaned again. */
export function parseStored(raw: string | null): SkillNotes {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object' || (data as { v?: unknown }).v !== 1) return {};
  const stored = (data as { notes?: unknown }).notes;
  if (!stored || typeof stored !== 'object') return {};
  let out: SkillNotes = {};
  for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
    if (!/^(claude|codex|shared):.+/.test(key) || !value || typeof value !== 'object') continue;
    const v = value as { fav?: unknown; tags?: unknown; abbr?: unknown };
    if (typeof v.fav !== 'boolean') continue;
    out = withFav(out, key, v.fav);
    if (Array.isArray(v.tags)) {
      for (const t of v.tags) if (typeof t === 'string') out = withTag(out, key, t);
    }
    if (typeof v.abbr === 'string' && ABBR_RE.test(v.abbr)) {
      out = withAbbr(out, key, v.abbr);
      if ((value as { cli?: unknown }).cli === true) out = withCli(out, key, true);
    }
  }
  return out;
}

export function serialize(notes: SkillNotes): string {
  return JSON.stringify({ v: 1, notes });
}
