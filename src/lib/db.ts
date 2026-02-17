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
  label: string | null;
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
    label: session.label ?? null,
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
}
