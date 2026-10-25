/**
 * skillNoteOps — carrying out a skill-note change a central asked for (POST /api/skill-notes/ops), and its keep-awake
 * switch (POST /api/keep-awake/ops): the two changes only this window can make.
 *
 * Skill notes live in this browser (`skillNotesStore`), so the server cannot write them: it forwards the change to
 * the workspace writer's window as `skill_note_op`, and that window applies it here and answers
 * POST /api/skill-notes/ops/<opId>/result. Only the writer applies one (the same rule as `room_op`), so exactly one
 * window changes the notes however many are open.
 *
 * `set` says what the note should BE, not what to flip: a fav the note already has is left alone (the store only
 * toggles), and `tags` is the whole list wanted. Everything that can refuse is checked before anything changes, so
 * a refused op leaves the note as it was: the tags first (each must be what normalizeTag keeps, so none is quietly
 * cut or folded), then the catalog (the note's key must be one of its real names, except for an op that only clears
 * or removes what an existing note holds: the note of an uninstalled skill can still be emptied), then the
 * abbreviation's three rules; then the abbreviation is applied, then the rest.
 *
 * A refusal is a fixed code, never the store's words (they repeat the abbreviation and name other skills): the
 * central's tool (server/mcp/tools/skillNoteWrite.ts) turns each code into its own words.
 *
 * Keep-awake is this window's setting (`keepAwakeWhileWorking`), which useSettingsInit pushes to the server on load
 * and on change. A central's switch sets it here, so the person sees it in Settings and a later push carries the new
 * value instead of undoing it. Only the desktop app has the setting; a browser window answers `not-desktop`. The
 * window first waits (up to 3 s, inside the route's 5 s) for its settings to load from IndexedDB, since that load
 * would put the old value back; still loading, it answers `not-ready`.
 *
 * The messages come off the wire from a central's request, so they are read strictly, field by field.
 */
import { MAX_TAGS, normalizeTag, resourceNoteKey, isNotable, validateAbbr, type SkillNotes, type AbbrCheck } from '@/lib/skillNotes';
import { isRoomWriter } from '@/lib/roomSync';
import type { SkillNoteChange, SkillNoteOpMessage, SkillNoteOpResult } from '@/types/skillNoteOps';

/** How long a keep-awake op waits for this window's settings to load: inside the route's 5 s wait. */
export const SETTINGS_LOAD_WAIT_MS = 3_000;

/** The slice of the skill-note store an op uses; a zustand store satisfies it. */
export interface SkillNotesStoreApi {
  getState(): {
    ready: boolean;
    notes: SkillNotes;
    toggleFav(key: string): void;
    addTag(key: string, tag: string): void;
    removeTag(key: string, tag: string): void;
    setAbbr(key: string, abbr: string, realNames: ReadonlySet<string>): AbbrCheck | { ok: true; value: '' };
  };
}

export interface SkillNoteOpDeps {
  store: SkillNotesStoreApi;
  /** The `agent:name` keys of the real catalog's skills and commands (an abbreviation may not shadow one). */
  realNames(): Promise<ReadonlySet<string>>;
  post(path: string, body: SkillNoteOpResult): Promise<void>;
}

const refused = (error: string): SkillNoteOpResult => ({ ok: false, error });

/** The tags wanted, without repeats; null when one would not be kept as given (cut, folded, emptied) or there are too many. */
function wantedTags(tags: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const raw of tags) {
    if (normalizeTag(raw) !== raw) return null;
    if (!out.includes(raw)) out.push(raw);
  }
  return out.length > MAX_TAGS ? null : out;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Which of validateAbbr's three rules `abbr` breaks, as a fixed code; null when it may be set. */
function abbrRefusal(abbr: string, key: string, notes: SkillNotes, realNames: ReadonlySet<string>): string | null {
  if (!validateAbbr(abbr, key, {}, NO_NAMES).ok) return 'abbr-format';
  if (!validateAbbr(abbr, key, notes, NO_NAMES).ok) return 'abbr-taken';
  if (!validateAbbr(abbr, key, notes, realNames).ok) return 'abbr-shadows';
  return null;
}

/** Does `set` only clear or remove what `note` holds (fav off, abbr cleared, tags only dropped)? */
function onlyClears(set: SkillNoteChange, note: SkillNotes[string] | undefined): boolean {
  if (note === undefined) return false;
  if (set.fav === true || (set.abbr !== undefined && set.abbr !== null && set.abbr.trim() !== '')) return false;
  return set.tags === undefined || set.tags.every((tag) => note.tags.includes(tag));
}

async function applyChange(msg: SkillNoteOpMessage, deps: SkillNoteOpDeps): Promise<SkillNoteOpResult> {
  const { key, set } = msg;
  const store = () => deps.store.getState();
  if (!store().ready) return refused('not-ready');

  const tags = set.tags === undefined ? undefined : wantedTags(set.tags);
  if (tags === null) return refused('bad-tags');

  const clearing = onlyClears(set, store().notes[key]);
  let realNames: ReadonlySet<string>;
  try {
    realNames = await deps.realNames();
  } catch {
    if (!clearing) return refused('catalog-unavailable');
    realNames = NO_NAMES;
  }
  if (!realNames.has(key) && !clearing) return refused('unknown-skill');

  if (set.abbr !== undefined) {
    const abbr = set.abbr ?? '';
    if (abbr.trim() !== '') {
      const rule = abbrRefusal(abbr, key, store().notes, realNames);
      if (rule !== null) return refused(rule);
    }
    if (!store().setAbbr(key, abbr, realNames).ok) return refused('failed');
  }

  if (set.fav !== undefined && Boolean(store().notes[key]?.fav) !== set.fav) store().toggleFav(key);

  if (tags !== undefined) {
    const held = store().notes[key]?.tags ?? [];
    for (const tag of held) if (!tags.includes(tag)) store().removeTag(key, tag);
    for (const tag of tags) if (!held.includes(tag)) store().addTag(key, tag);
  }
  return { ok: true };
}

/**
 * Apply `msg` to the store, then post the result to the op's result route. Never throws: a result that cannot be
 * posted is dropped, and the server answers its caller "pending" when no result comes in time.
 */
export async function applySkillNoteOp(msg: SkillNoteOpMessage, deps: SkillNoteOpDeps): Promise<SkillNoteOpResult> {
  let result: SkillNoteOpResult;
  try {
    result = await applyChange(msg, deps);
  } catch {
    result = refused('failed');
  }
  try {
    await deps.post(`/api/skill-notes/ops/${encodeURIComponent(msg.opId)}/result`, result);
  } catch {
    // Nothing more to do: the route has its own deadline.
  }
  return result;
}

// ---------------------------------------------------------------------------
// The socket message
// ---------------------------------------------------------------------------

/** A change read off the wire, or null when it is not one. Unknown fields are dropped. */
function readChange(raw: unknown): SkillNoteChange | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const change: { fav?: boolean; tags?: string[]; abbr?: string | null } = {};
  if (r.fav !== undefined) {
    if (typeof r.fav !== 'boolean') return null;
    change.fav = r.fav;
  }
  if (r.tags !== undefined) {
    if (!Array.isArray(r.tags) || !r.tags.every((t): t is string => typeof t === 'string')) return null;
    change.tags = [...r.tags];
  }
  if (r.abbr !== undefined) {
    if (r.abbr !== null && typeof r.abbr !== 'string') return null;
    change.abbr = r.abbr;
  }
  return change;
}

/** `agent:name` with a non-empty name. */
const isNoteKey = (key: unknown): key is string => typeof key === 'string' && /^[^:\s]+:.+$/.test(key);

async function defaultRealNames(): Promise<ReadonlySet<string>> {
  const { fetchCatalog } = await import('@/lib/resourcesApi');
  const catalog = await fetchCatalog();
  return new Set(catalog.resources.filter(isNotable).map((r) => resourceNoteKey(r)));
}

async function defaultPost(path: string, body: SkillNoteOpResult): Promise<void> {
  await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function defaultDeps(): Promise<SkillNoteOpDeps> {
  const { useSkillNotesStore } = await import('@/stores/skillNotesStore');
  return { store: useSkillNotesStore, realNames: defaultRealNames, post: defaultPost };
}

/**
 * A `skill_note_op` from the server: applied only by the writer's main window (as `handleRoomOpMessage` does for
 * rooms). A malformed message that names its op is answered `bad-op`, so the caller need not wait out its deadline.
 */
export async function handleSkillNoteOpMessage(msg: unknown, deps?: SkillNoteOpDeps): Promise<void> {
  if (!isRoomWriter() || !msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  if (typeof m.opId !== 'string' || m.opId === '') return;
  const resolved = deps ?? (await defaultDeps());
  const set = readChange(m.set);
  if (!isNoteKey(m.key) || set === null) {
    try {
      await resolved.post(`/api/skill-notes/ops/${encodeURIComponent(m.opId)}/result`, refused('bad-op'));
    } catch {
      // The route has its own deadline.
    }
    return;
  }
  await applySkillNoteOp({ type: 'skill_note_op', opId: m.opId, key: m.key, set }, resolved);
}

// ---------------------------------------------------------------------------
// Keep-awake
// ---------------------------------------------------------------------------

/** What a keep-awake op uses; the settings store satisfies `settings`. */
export interface KeepAwakeOpDeps {
  settings: { getState(): { setKeepAwakeWhileWorking(enabled: boolean): void } };
  /** Is this window the desktop app, where the setting lives? */
  isDesktop(): boolean;
  /** Resolves true once the settings have loaded from IndexedDB (or there is nothing to load); false at the bound. */
  settingsLoaded(): Promise<boolean>;
  post(path: string, body: SkillNoteOpResult): Promise<void>;
}

export interface SettingsLoadSignal {
  /** Has loadFromDb run? (`hasLoadedSettingsFromDb`) */
  loaded(): boolean;
  /** Called on every settings store change; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Rows in the settings table. useSettingsInit loads nothing when there are none; a throw means it cannot load. */
  countRows(): Promise<number>;
  timeoutMs?: number;
}

/**
 * True once loading can no longer overwrite a change: loadFromDb has run, the table is empty (the load returns early),
 * or IndexedDB cannot be read (the load fails). False when it is still loading after `timeoutMs`.
 */
export async function waitForSettingsLoad(signal: SettingsLoadSignal): Promise<boolean> {
  if (signal.loaded()) return true;
  try {
    if ((await signal.countRows()) === 0) return true;
  } catch {
    return true;
  }
  if (signal.loaded()) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, signal.timeoutMs ?? SETTINGS_LOAD_WAIT_MS);
    const unsubscribe = signal.subscribe(() => {
      if (!signal.loaded()) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

async function defaultKeepAwakeDeps(): Promise<KeepAwakeOpDeps> {
  const [{ useSettingsStore, hasLoadedSettingsFromDb }, { isDesktopApp }, { db }] = await Promise.all([
    import('@/stores/settingsStore'),
    import('@/lib/platform'),
    import('@/lib/db'),
  ]);
  return {
    settings: useSettingsStore,
    isDesktop: isDesktopApp,
    settingsLoaded: () =>
      waitForSettingsLoad({ loaded: hasLoadedSettingsFromDb, subscribe: useSettingsStore.subscribe, countRows: () => db.settings.count() }),
    post: defaultPost,
  };
}

/** What the window does with a keep-awake op: its own code, or ok once the setting holds the value asked for. */
async function applyKeepAwake(on: unknown, deps: KeepAwakeOpDeps): Promise<SkillNoteOpResult> {
  if (typeof on !== 'boolean') return refused('bad-op');
  if (!deps.isDesktop()) return refused('not-desktop');
  if (!(await deps.settingsLoaded())) return refused('not-ready');
  deps.settings.getState().setKeepAwakeWhileWorking(on);
  return { ok: true };
}

/**
 * A `keep_awake_op` from the server: applied only by the writer's main window, to its own setting, whose effect in
 * useSettingsInit then tells the server as the person's own switch does. Never throws.
 */
export async function handleKeepAwakeOpMessage(msg: unknown, deps?: KeepAwakeOpDeps): Promise<void> {
  if (!isRoomWriter() || !msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  if (typeof m.opId !== 'string' || m.opId === '') return;
  let resolved: KeepAwakeOpDeps;
  let result: SkillNoteOpResult;
  try {
    resolved = deps ?? (await defaultKeepAwakeDeps());
  } catch {
    return; // Nothing to post with: the route has its own deadline.
  }
  try {
    result = await applyKeepAwake(m.on, resolved);
  } catch {
    result = refused('failed');
  }
  try {
    await resolved.post(`/api/keep-awake/ops/${encodeURIComponent(m.opId)}/result`, result);
  } catch {
    // The route has its own deadline.
  }
}
