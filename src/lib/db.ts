import Dexie, { type EntityTable } from 'dexie';
import type { Session } from '@/types';

// ---------------------------------------------------------------------------
// Record types (stored in IndexedDB)
// ---------------------------------------------------------------------------

export interface DbSession {
  id: string;
  projectPath: string;
  projectName: string;
  title: string;
  status: string;
  model: string;
  source: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  totalToolCalls: number;
  totalPrompts: number;
  archived: number;
  summary: string | null;
  characterModel: string | null;
  accentColor: string | null;
  teamId: string | null;
  teamRole: string | null;
  terminalId: string | null;
  queueCount: number;
}

export interface DbPrompt {
  id?: number;
  sessionId: string;
  text: string;
  timestamp: number;
}

export interface DbResponse {
  id?: number;
  sessionId: string;
  textExcerpt: string;
  timestamp: number;
}

export interface DbToolCall {
  id?: number;
  sessionId: string;
  toolName: string;
  toolInputSummary: string;
  timestamp: number;
}

export interface DbEvent {
  id?: number;
  sessionId: string;
  eventType: string;
  detail: string;
  timestamp: number;
}

export interface DbNote {
  id?: number;
  sessionId: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

export interface DbQueueItem {
  id?: number;
  sessionId: string;
  text: string;
  position: number;
  createdAt: number;
  /** JSON-serialized array of { name, dataUrl } image attachments */
  images?: string;
  /** Automation type — defaults to 'once' for legacy rows */
  type?: 'once' | 'loop' | 'schedule';
  /** Loop interval in milliseconds (only when type='loop') */
  intervalMs?: number;
  /** Schedule one-shot fire time as unix ms (only when type='schedule') */
  runAt?: number;
  /** Next fire time as unix ms; 0 for 'once' items so they win priority sort */
  nextFireAt?: number;
  /** Last successful send timestamp (unix ms) */
  lastFiredAt?: number;
  /** Total successful fires — drives "fired N×" display */
  totalFires?: number;
  /** JSON-serialized ChainStep[] that runs before the main prompt */
  beforeChain?: string;
  /** JSON-serialized ChainStep[] that runs after the main prompt */
  afterChain?: string;
  /** Current chain execution phase — persisted so reloads can resume mid-chain */
  execState?: string;
  /** Cursor within before-/after-chain for the active execution */
  execStepIdx?: number;
  /** JSON-serialized ExcludeWindow[] — time-of-day pause windows for loops */
  excludeWindows?: string;
  /** When this item was saved to the global history, the matching
   *  queueHistory.id. Lets the UI render a filled ★ and supports "unfavorite"
   *  toggling. Cleared automatically when the history entry is removed. */
  historyId?: number;
  /** When 1, the scheduler skips this item entirely (per-item pause).
   *  Stored as int because Dexie indexes booleans poorly. Undefined / 0 = enabled. */
  disabled?: number;
  /** Loop-only daily clamp — 'HH:MM' 24-hour local time. Loop won't fire
   *  before this clock time on any given day. Non-indexed; no schema bump. */
  firstFireOfDay?: string;
}

export interface DbAlert {
  id?: number;
  sessionId: string;
  type: string;
  message: string;
  createdAt: number;
}

export interface DbSshProfile {
  id?: number;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  privateKeyPath: string;
  workingDir: string;
  command: string;
}

export interface DbSetting {
  key: string;
  value: unknown;
  updatedAt: number;
}

export interface DbSummaryPrompt {
  id?: number;
  name: string;
  prompt: string;
  isDefault: number;
  createdAt: number;
  updatedAt: number;
}

export interface DbTeam {
  id: string;
  parentSessionId: string;
  childSessionIds: string[];
  teamName: string | null;
  createdAt: number;
}

/**
 * Per-session queue automation row. Stores user preferences that survive a
 * restart: pause/idleGuard toggles plus session-level loop quiet hours.
 *
 * `loopExcludeWindows` is JSON-serialized for portability — it's a
 * fixed-length array of {startHHMM, endHHMM} (see ExcludeWindow in
 * queueStore).
 */
export interface DbQueueAutomation {
  sessionId: string;
  paused: number;            // 0 / 1 — Dexie indexes booleans poorly so use int
  /** 0 / 1 — per-session auto-send toggle. Optional for back-compat: rows saved
   *  before auto-send became per-session read as `undefined`, which the loader
   *  maps to true (the prior global default). Non-indexed, so no schema bump. */
  autoSend?: number;
  /** 0 / 1 — per-session auto-enter toggle. Same back-compat handling. */
  autoEnter?: number;
  idleGuard: number;         // 0 / 1
  /** 0 / 1 — when 1, scheduler also skips while status==='prompting'. Default 1
   *  for back-compat: rows from before this field existed are read as `undefined`,
   *  which the loader maps to true (safe default). */
  skipWhenPrompting?: number;
  loopExcludeWindows?: string; // JSON ExcludeWindow[]
  updatedAt: number;
}

/**
 * A globally favorited queue item. Saved when the user clicks the ★ on any
 * queue row; lets them re-apply the same pattern to a different session later.
 *
 * `item` holds the serialized QueueItem (text, chain, intervals, etc.) at the
 * moment of save — it's a snapshot, not a reference. If the original queue
 * row or session is deleted, this entry survives.
 */
export interface DbQueueHistory {
  id?: number;
  /** Optional user-chosen alias / display name for this saved entry. Lets a
   *  user label a favorite (e.g. "nightly lint loop") instead of identifying it
   *  by its prompt text. Non-indexed, so adding it needs no Dexie schema bump. */
  alias?: string;
  /** JSON-serialized snapshot of the saved QueueItem. Excludes session-local
   *  fields like position, sessionId, lastFiredAt, execState — those are
   *  re-derived when applying to a target session. */
  item: string;
  /** Display name of the session this item came from (for the breadcrumb in
   *  the history sheet). Snapshot — survives if the source session is gone. */
  sourceSessionTitle?: string;
  /** Source session ID — kept as breadcrumb only, NOT a foreign key. */
  sourceSessionId?: string;
  /** Increments each time this entry is applied to a session. */
  usedCount: number;
  /** Unix ms of last [+ Apply]. Null until first use. */
  lastUsedAt?: number;
  createdAt: number;
}

/** A saved explanation or translation, captured when the user clicks one of
 *  the four select-to-translate buttons. The `response` is filled in later
 *  when the corresponding floating session is closed. */
export interface DbTranslationLog {
  id?: number;
  /** Stable id used to find the row from across spawn-time and close-time. */
  uuid: string;
  mode:
    | 'explain-learning'
    | 'explain-native'
    | 'vocab-native'
    | 'translate-selection-learning'
    | 'translate-selection-native'
    | 'translate-answer'
    | 'translate-file'
    | 'custom';
  nativeLanguage: string;
  learningLanguage: string;
  /** Selected text (modes 1, 2, 3). For translate-file this is empty. */
  selection: string;
  /** Surrounding sentence/line for selection-anchored modes. */
  contextLine: string;
  /** Source file path for translate-file. */
  filePath: string;
  /** File content for translate-file (≤ 256 KB enforced server-side). */
  fileContent: string;
  /** The synthesized prompt sent to the CLI. */
  prompt: string;
  /** Captured CLI output, ANSI-stripped. Empty until the float is closed. */
  response: string;
  originSessionId: string;
  originProjectName: string;
  originSessionTitle: string;
  /** Terminal id of the floating session that produced this entry. */
  floatTerminalId: string;
  /** Optional user-authored note. */
  notes: string;
  /** 1 = archived (hidden by default), 0 = active. */
  archived: 0 | 1;
  /** 1 = user-favorited (★), 0 = not. Favorited selections are highlighted
   *  back in their source markdown file. */
  favorite: 0 | 1;
  /** Optional user-chosen short label for the record (shown in the REVIEW
   *  header and the md-highlight tooltip). */
  alias: string;
  /** Path of the markdown file the selection came from (file viewer). Recorded
   *  for every selection regardless of whether it was attached to the prompt,
   *  so favorited selections can be highlighted in that file. Distinct from
   *  `filePath`, which is the prompt-attached path. */
  sourceFilePath: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

class DashboardDb extends Dexie {
  sessions!: EntityTable<DbSession, 'id'>;
  prompts!: EntityTable<DbPrompt, 'id'>;
  responses!: EntityTable<DbResponse, 'id'>;
  toolCalls!: EntityTable<DbToolCall, 'id'>;
  events!: EntityTable<DbEvent, 'id'>;
  notes!: EntityTable<DbNote, 'id'>;
  promptQueue!: EntityTable<DbQueueItem, 'id'>;
  alerts!: EntityTable<DbAlert, 'id'>;
  sshProfiles!: EntityTable<DbSshProfile, 'id'>;
  settings!: EntityTable<DbSetting, 'key'>;
  summaryPrompts!: EntityTable<DbSummaryPrompt, 'id'>;
  teams!: EntityTable<DbTeam, 'id'>;
  queueAutomation!: EntityTable<DbQueueAutomation, 'sessionId'>;
  queueHistory!: EntityTable<DbQueueHistory, 'id'>;
  translationLogs!: EntityTable<DbTranslationLog, 'id'>;

  constructor() {
    super('claude-dashboard');

    this.version(2).stores({
      sessions:
        'id, status, projectPath, startedAt, lastActivityAt, archived',
      prompts:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      responses:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      toolCalls:
        '++id, sessionId, timestamp, toolName, [sessionId+timestamp]',
      events:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      notes:
        '++id, sessionId',
      promptQueue:
        '++id, sessionId, [sessionId+position]',
      alerts:
        '++id, sessionId',
      sshProfiles:
        '++id, name',
      settings:
        'key',
      summaryPrompts:
        '++id, isDefault',
      teams:
        'id',
    });

    // v3 — adds translationLogs for the REVIEW tab (saved explanations / translations).
    this.version(3).stores({
      sessions:
        'id, status, projectPath, startedAt, lastActivityAt, archived',
      prompts:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      responses:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      toolCalls:
        '++id, sessionId, timestamp, toolName, [sessionId+timestamp]',
      events:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      notes:
        '++id, sessionId',
      promptQueue:
        '++id, sessionId, [sessionId+position]',
      alerts:
        '++id, sessionId',
      sshProfiles:
        '++id, name',
      settings:
        'key',
      summaryPrompts:
        '++id, isDefault',
      teams:
        'id',
      translationLogs:
        '++id, uuid, mode, createdAt, originSessionId, archived, floatTerminalId',
    });

    // v4 — adds queueAutomation: persisted per-session pause/idle-guard/quiet hours.
    // Previously this state was in-memory only and silently reset on reload.
    this.version(4).stores({
      sessions:
        'id, status, projectPath, startedAt, lastActivityAt, archived',
      prompts:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      responses:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      toolCalls:
        '++id, sessionId, timestamp, toolName, [sessionId+timestamp]',
      events:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      notes:
        '++id, sessionId',
      promptQueue:
        '++id, sessionId, [sessionId+position]',
      alerts:
        '++id, sessionId',
      sshProfiles:
        '++id, name',
      settings:
        'key',
      summaryPrompts:
        '++id, isDefault',
      teams:
        'id',
      queueAutomation:
        'sessionId',
      translationLogs:
        '++id, uuid, mode, createdAt, originSessionId, archived, floatTerminalId',
    });

    // v5 — adds queueHistory: global favorited queue items, reusable across
    // sessions. Indexed on createdAt + lastUsedAt to support "Recent" sort and
    // pagination in the history sheet.
    this.version(5).stores({
      sessions:
        'id, status, projectPath, startedAt, lastActivityAt, archived',
      prompts:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      responses:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      toolCalls:
        '++id, sessionId, timestamp, toolName, [sessionId+timestamp]',
      events:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      notes:
        '++id, sessionId',
      promptQueue:
        '++id, sessionId, [sessionId+position]',
      alerts:
        '++id, sessionId',
      sshProfiles:
        '++id, name',
      settings:
        'key',
      summaryPrompts:
        '++id, isDefault',
      teams:
        'id',
      queueAutomation:
        'sessionId',
      queueHistory:
        '++id, createdAt, lastUsedAt',
      translationLogs:
        '++id, uuid, mode, createdAt, originSessionId, archived, floatTerminalId',
    });

    // v6 — REVIEW favorites + aliases + md highlighting. Adds favorite (★),
    // alias, and sourceFilePath to translationLogs (indexed on favorite +
    // sourceFilePath); existing rows back-filled with defaults.
    this.version(6).stores({
      sessions:
        'id, status, projectPath, startedAt, lastActivityAt, archived',
      prompts:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      responses:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      toolCalls:
        '++id, sessionId, timestamp, toolName, [sessionId+timestamp]',
      events:
        '++id, sessionId, timestamp, [sessionId+timestamp]',
      notes:
        '++id, sessionId',
      promptQueue:
        '++id, sessionId, [sessionId+position]',
      alerts:
        '++id, sessionId',
      sshProfiles:
        '++id, name',
      settings:
        'key',
      summaryPrompts:
        '++id, isDefault',
      teams:
        'id',
      queueAutomation:
        'sessionId',
      queueHistory:
        '++id, createdAt, lastUsedAt',
      translationLogs:
        '++id, uuid, mode, createdAt, originSessionId, archived, favorite, sourceFilePath, floatTerminalId',
    }).upgrade(async (tx) => {
      await tx.table('translationLogs').toCollection().modify((row) => {
        const r = row as Partial<DbTranslationLog>;
        r.favorite ??= 0;
        r.alias ??= '';
        r.sourceFilePath ??= '';
      });
    });
  }
}

export const db = new DashboardDb();

// ---------------------------------------------------------------------------
// Session persistence (matches legacy browserDb.persistSessionUpdate)
// ---------------------------------------------------------------------------

export async function persistSessionUpdate(session: Session): Promise<void> {
  if (!session?.sessionId) return;

  const record: DbSession = {
    id: session.sessionId,
    projectPath: session.projectPath || '',
    projectName: session.projectName || 'Unknown',
    title: session.title || '',
    status: session.status || 'idle',
    model: session.model || '',
    source: typeof session.source === 'string' ? session.source : 'hook',
    startedAt: session.startedAt || Date.now(),
    lastActivityAt: session.lastActivityAt || Date.now(),
    endedAt: session.endedAt ?? null,
    totalToolCalls: session.totalToolCalls || 0,
    totalPrompts: session.promptHistory?.length || 0,
    archived: session.archived || 0,
    summary: session.summary ?? null,
    characterModel: session.characterModel ?? null,
    accentColor: session.accentColor ?? null,
    teamId: session.teamId ?? null,
    teamRole: session.teamRole ?? null,
    terminalId: session.terminalId ?? null,
    queueCount: session.queueCount || 0,
  };
  await db.sessions.put(record);

  // Persist prompt history (deduplicate by timestamp)
  if (session.promptHistory?.length) {
    const existing = await db.prompts
      .where('sessionId')
      .equals(session.sessionId)
      .toArray();
    const existingTs = new Set(existing.map((e) => e.timestamp));
    const newPrompts = session.promptHistory
      .filter((p) => !existingTs.has(p.timestamp))
      .map((p) => ({
        sessionId: session.sessionId,
        text: p.text,
        timestamp: p.timestamp,
      }));
    if (newPrompts.length > 0) {
      await db.prompts.bulkAdd(newPrompts);
    }
  }

  // Persist tool log
  if (session.toolLog?.length) {
    const existing = await db.toolCalls
      .where('sessionId')
      .equals(session.sessionId)
      .toArray();
    const existingTs = new Set(existing.map((e) => e.timestamp));
    const newTools = session.toolLog
      .filter((t) => !existingTs.has(t.timestamp))
      .map((t) => ({
        sessionId: session.sessionId,
        toolName: t.tool,
        toolInputSummary: t.input,
        timestamp: t.timestamp,
      }));
    if (newTools.length > 0) {
      await db.toolCalls.bulkAdd(newTools);
    }
  }

  // Persist response log
  if (session.responseLog?.length) {
    const existing = await db.responses
      .where('sessionId')
      .equals(session.sessionId)
      .toArray();
    const existingTs = new Set(existing.map((e) => e.timestamp));
    const newResponses = session.responseLog
      .filter((r) => !existingTs.has(r.timestamp))
      .map((r) => ({
        sessionId: session.sessionId,
        textExcerpt: r.text,
        timestamp: r.timestamp,
      }));
    if (newResponses.length > 0) {
      await db.responses.bulkAdd(newResponses);
    }
  }

  // Persist events
  if (session.events?.length) {
    const existing = await db.events
      .where('sessionId')
      .equals(session.sessionId)
      .toArray();
    const existingTs = new Set(existing.map((e) => e.timestamp));
    const newEvents = session.events
      .filter((e) => !existingTs.has(e.timestamp))
      .map((e) => ({
        sessionId: session.sessionId,
        eventType: e.type,
        detail: e.detail || '',
        timestamp: e.timestamp,
      }));
    if (newEvents.length > 0) {
      await db.events.bulkAdd(newEvents);
    }
  }
}

// ---------------------------------------------------------------------------
// Session ID migration (Fix 6: re-key support)
// ---------------------------------------------------------------------------

const CHILD_TABLES = [
  'prompts',
  'responses',
  'toolCalls',
  'events',
  'notes',
  'promptQueue',
  'alerts',
] as const;

export async function migrateSessionId(
  oldSessionId: string,
  newSessionId: string,
): Promise<void> {
  for (const tableName of CHILD_TABLES) {
    const table = db.table(tableName);
    const records = await table.where('sessionId').equals(oldSessionId).toArray();
    if (records.length === 0) continue;
    await db.transaction('rw', table, async () => {
      for (const record of records) {
        await table.update(record.id, { sessionId: newSessionId });
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Delete session and all child records
// ---------------------------------------------------------------------------

export async function deleteSession(sessionId: string): Promise<void> {
  await db.sessions.delete(sessionId);
  for (const tableName of CHILD_TABLES) {
    const table = db.table(tableName);
    const records = await table.where('sessionId').equals(sessionId).toArray();
    const ids = records.map((r) => r.id).filter((id): id is number => id != null);
    if (ids.length > 0) {
      await table.bulkDelete(ids);
    }
  }
  // queueAutomation is keyed by sessionId (not ++id) — delete by key.
  await db.queueAutomation.delete(sessionId).catch(() => {});
}

/**
 * Cascade-delete child rows (every CHILD_TABLES row + the per-session
 * queueAutomation row) for a BATCH of session ids whose parent was already
 * removed from db.sessions. Used by the snapshot reconciliation so orphaned
 * promptQueue / queueAutomation / event rows don't accumulate one generation
 * per restart and re-hydrate as zombie "Unknown" queue groups. The caller is
 * responsible for deleting the db.sessions rows themselves.
 */
export async function deleteSessionChildrenBatch(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  for (const tableName of CHILD_TABLES) {
    const table = db.table(tableName);
    const keys = await table.where('sessionId').anyOf(sessionIds).primaryKeys();
    if (keys.length > 0) {
      await table.bulkDelete(keys as number[]).catch(() => {});
    }
  }
  // queueAutomation primary key is sessionId itself.
  await db.queueAutomation.bulkDelete(sessionIds).catch(() => {});
}
