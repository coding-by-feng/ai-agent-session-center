// browserDb.js — IndexedDB wrapper for client-side persistence
// Replaces server-side SQLite. All session data, notes, settings, profiles stored here.
import { debugLog } from './utils.js';

const DB_NAME = 'claude-dashboard';
const DB_VERSION = 2;

let dbInstance = null;

const STORES = {
  sessions:       { keyPath: 'id' },
  prompts:        { keyPath: 'id', autoIncrement: true },
  responses:      { keyPath: 'id', autoIncrement: true },
  toolCalls:      { keyPath: 'id', autoIncrement: true },
  events:         { keyPath: 'id', autoIncrement: true },
  notes:          { keyPath: 'id', autoIncrement: true },
  promptQueue:    { keyPath: 'id', autoIncrement: true },
  alerts:         { keyPath: 'id', autoIncrement: true },
  sshProfiles:    { keyPath: 'id', autoIncrement: true },
  settings:       { keyPath: 'key' },
  summaryPrompts: { keyPath: 'id', autoIncrement: true },
  teams:          { keyPath: 'id' },
};

const INDEXES = {
  sessions:       [['status', 'status'], ['projectPath', 'projectPath'], ['startedAt', 'startedAt'], ['lastActivityAt', 'lastActivityAt'], ['archived', 'archived']],
  prompts:        [['sessionId', 'sessionId'], ['timestamp', 'timestamp'], ['sessionId_timestamp', ['sessionId', 'timestamp']]],
  responses:      [['sessionId', 'sessionId'], ['timestamp', 'timestamp'], ['sessionId_timestamp', ['sessionId', 'timestamp']]],
  toolCalls:      [['sessionId', 'sessionId'], ['timestamp', 'timestamp'], ['toolName', 'toolName'], ['sessionId_timestamp', ['sessionId', 'timestamp']]],
  events:         [['sessionId', 'sessionId'], ['timestamp', 'timestamp'], ['sessionId_timestamp', ['sessionId', 'timestamp']]],
  notes:          [['sessionId', 'sessionId']],
  promptQueue:    [['sessionId', 'sessionId'], ['sessionId_position', ['sessionId', 'position']]],
  alerts:         [['sessionId', 'sessionId']],
  sshProfiles:    [['name', 'name']],
  summaryPrompts: [['isDefault', 'isDefault']],
};

// ---- Open / Initialize ----

export async function openDB() {
  if (dbInstance) return dbInstance;

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      // Create any missing stores (handles both fresh installs and upgrades)
      for (const [name, opts] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          const store = db.createObjectStore(name, opts);
          const indexes = INDEXES[name] || [];
          for (const [indexName, keyPath] of indexes) {
            store.createIndex(indexName, keyPath, { unique: false });
          }
        }
      }
    };

    request.onsuccess = async (event) => {
      dbInstance = event.target.result;
      await seedDefaults();
      resolve(dbInstance);
    };

    request.onerror = (event) => {
      console.error('[browserDb] Failed to open IndexedDB:', event.target.error);
      reject(event.target.error);
    };
  });
}

function getDB() {
  if (!dbInstance) throw new Error('IndexedDB not initialized. Call openDB() first.');
  return dbInstance;
}

// ---- Generic CRUD ----

export function put(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function get(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export function getAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function del(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function getByIndex(storeName, indexName, value) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const req = index.getAll(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function clear(storeName) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function count(storeName) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Batch operations ----

export function putMany(storeName, items) {
  return new Promise((resolve, reject) => {
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const item of items) {
      store.put(item);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- Batched Write Queue ----
// Collects individual put() calls and flushes them in a single transaction per store.
// Flush triggers: every 200ms or when queue reaches 20 items (whichever comes first).

const WRITE_QUEUE_FLUSH_MS = 200;
const WRITE_QUEUE_MAX_ITEMS = 20;

// Map of storeName -> { items: Array<{data, resolve, reject}>, timerId }
const writeQueues = new Map();

export function putBatched(storeName, data) {
  return new Promise((resolve, reject) => {
    let queue = writeQueues.get(storeName);
    if (!queue) {
      queue = { items: [], timerId: null };
      writeQueues.set(storeName, queue);
    }
    queue.items.push({ data, resolve, reject });

    // Flush immediately if queue is full
    if (queue.items.length >= WRITE_QUEUE_MAX_ITEMS) {
      flushWriteQueue(storeName);
      return;
    }

    // Schedule flush if not already scheduled
    if (!queue.timerId) {
      queue.timerId = setTimeout(() => flushWriteQueue(storeName), WRITE_QUEUE_FLUSH_MS);
    }
  });
}

function flushWriteQueue(storeName) {
  const queue = writeQueues.get(storeName);
  if (!queue || queue.items.length === 0) return;

  const batch = queue.items;
  queue.items = [];
  if (queue.timerId) { clearTimeout(queue.timerId); queue.timerId = null; }

  try {
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const entry of batch) {
      const req = store.put(entry.data);
      req.onsuccess = () => entry.resolve(req.result);
      req.onerror = () => entry.reject(req.error);
    }
    tx.onerror = () => {
      for (const entry of batch) entry.reject(tx.error);
    };
  } catch (err) {
    for (const entry of batch) entry.reject(err);
  }
}

// Flush all pending write queues (call on page unload or when needed)
export function flushAllWriteQueues() {
  for (const storeName of writeQueues.keys()) {
    flushWriteQueue(storeName);
  }
}

// ---- Session-specific helpers ----

// Persist a session snapshot from WebSocket (upsert into sessions store + child records)
export async function persistSessionUpdate(session) {
  if (!session || !session.sessionId) return;

  // Upsert session record
  const record = {
    id: session.sessionId,
    projectPath: session.projectPath || '',
    projectName: session.projectName || 'Unknown',
    title: session.title || '',
    status: session.status || 'idle',
    model: session.model || '',
    source: session.source || 'hook',
    startedAt: session.startedAt || Date.now(),
    lastActivityAt: session.lastActivityAt || Date.now(),
    endedAt: session.endedAt || null,
    totalToolCalls: session.totalToolCalls || 0,
    totalPrompts: session.totalPrompts || 0,
    archived: session.archived || 0,
    summary: session.summary || null,
    characterModel: session.characterModel || null,
    accentColor: session.accentColor || null,
    teamId: session.teamId || null,
    teamRole: session.teamRole || null,
    terminalId: session.terminalId || null,
    queueCount: session.queueCount || 0,
    label: session.label || null,
  };
  await putBatched('sessions', record);

  // Persist prompt history entries (deduplicate by timestamp)
  if (session.promptHistory?.length) {
    const existing = await getByIndex('prompts', 'sessionId', session.sessionId);
    const existingTs = new Set(existing.map(e => e.timestamp));
    const newPrompts = session.promptHistory.filter(p => !existingTs.has(p.timestamp));
    if (newPrompts.length > 0) {
      await putMany('prompts', newPrompts.map(p => ({
        sessionId: session.sessionId,
        text: p.text,
        timestamp: p.timestamp,
      })));
    }
  }

  // Persist tool log entries
  if (session.toolLog?.length) {
    const existing = await getByIndex('toolCalls', 'sessionId', session.sessionId);
    const existingTs = new Set(existing.map(e => e.timestamp));
    const newTools = session.toolLog.filter(t => !existingTs.has(t.timestamp));
    if (newTools.length > 0) {
      await putMany('toolCalls', newTools.map(t => ({
        sessionId: session.sessionId,
        toolName: t.tool,
        toolInputSummary: t.input,
        timestamp: t.timestamp,
      })));
    }
  }

  // Persist response log entries
  if (session.responseLog?.length) {
    const existing = await getByIndex('responses', 'sessionId', session.sessionId);
    const existingTs = new Set(existing.map(e => e.timestamp));
    const newResponses = session.responseLog.filter(r => !existingTs.has(r.timestamp));
    if (newResponses.length > 0) {
      await putMany('responses', newResponses.map(r => ({
        sessionId: session.sessionId,
        textExcerpt: r.text,
        timestamp: r.timestamp,
      })));
    }
  }

  // Persist events
  if (session.events?.length) {
    const existing = await getByIndex('events', 'sessionId', session.sessionId);
    const existingTs = new Set(existing.map(e => e.timestamp));
    const newEvents = session.events.filter(e => !existingTs.has(e.timestamp));
    if (newEvents.length > 0) {
      await putMany('events', newEvents.map(e => ({
        sessionId: session.sessionId,
        eventType: e.type,
        detail: e.detail || '',
        timestamp: e.timestamp,
      })));
    }
  }
}

// ---- History / Query ----

export async function searchSessions({ query, project, status, dateFrom, dateTo, archived, sortBy = 'startedAt', sortDir = 'desc', page = 1, pageSize = 50 } = {}) {
  let sessions = await getAll('sessions');

  // Filter
  if (project) sessions = sessions.filter(s => s.projectPath === project);
  if (status) sessions = sessions.filter(s => s.status === status);
  if (dateFrom) sessions = sessions.filter(s => s.startedAt >= dateFrom);
  if (dateTo) sessions = sessions.filter(s => s.startedAt <= dateTo);
  if (archived === true || archived === 'true') {
    sessions = sessions.filter(s => s.archived === 1);
  } else if (archived !== 'all') {
    sessions = sessions.filter(s => !s.archived || s.archived === 0);
  }

  // Text search (simple substring match on prompts)
  if (query) {
    const allPrompts = await getAll('prompts');
    const matchingSessionIds = new Set();
    const lowerQuery = query.toLowerCase();
    for (const p of allPrompts) {
      if (p.text && p.text.toLowerCase().includes(lowerQuery)) {
        matchingSessionIds.add(p.sessionId);
      }
    }
    sessions = sessions.filter(s => matchingSessionIds.has(s.id));
  }

  // Sort
  const dir = sortDir === 'asc' ? 1 : -1;
  sessions.sort((a, b) => ((a[sortBy] || 0) - (b[sortBy] || 0)) * dir);

  const total = sessions.length;
  const offset = (page - 1) * pageSize;
  const paged = sessions.slice(offset, offset + pageSize);

  return { sessions: paged, total, page, pageSize };
}

export async function getSessionDetail(sessionId) {
  const session = await get('sessions', sessionId);
  if (!session) return null;

  const prompts = (await getByIndex('prompts', 'sessionId', sessionId)).sort((a, b) => a.timestamp - b.timestamp);
  const responses = (await getByIndex('responses', 'sessionId', sessionId)).sort((a, b) => a.timestamp - b.timestamp);
  const toolCalls = (await getByIndex('toolCalls', 'sessionId', sessionId)).sort((a, b) => a.timestamp - b.timestamp);
  const events = (await getByIndex('events', 'sessionId', sessionId)).sort((a, b) => a.timestamp - b.timestamp);
  const notes = (await getByIndex('notes', 'sessionId', sessionId)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return { session, prompts, responses, tool_calls: toolCalls, events, notes };
}

export async function deleteSession(sessionId) {
  // Remove session record
  await del('sessions', sessionId);
  // Remove all related records from child stores
  const childStores = ['prompts', 'responses', 'toolCalls', 'events', 'notes', 'promptQueue', 'alerts'];
  for (const storeName of childStores) {
    const records = await getByIndex(storeName, 'sessionId', sessionId);
    for (const r of records) {
      await del(storeName, r.id);
    }
  }
}

export async function getDistinctProjects() {
  const sessions = await getAll('sessions');
  const seen = new Map();
  for (const s of sessions) {
    if (s.projectPath && !seen.has(s.projectPath)) {
      seen.set(s.projectPath, s.projectName || s.projectPath);
    }
  }
  return [...seen.entries()].map(([path, name]) => ({ project_path: path, project_name: name })).sort((a, b) => a.project_name.localeCompare(b.project_name));
}

// ---- Full-text search ----

export async function fullTextSearch({ query, type = 'all', page = 1, pageSize = 50 } = {}) {
  if (!query) return { results: [], total: 0, page, pageSize };

  const lowerQuery = query.toLowerCase();
  const results = [];
  const sessions = await getAll('sessions');
  const sessionMap = new Map(sessions.map(s => [s.id, s]));

  if (type === 'all' || type === 'prompts') {
    const prompts = await getAll('prompts');
    for (const p of prompts) {
      if (p.text && p.text.toLowerCase().includes(lowerQuery)) {
        const s = sessionMap.get(p.sessionId);
        results.push({
          session_id: p.sessionId,
          project_name: s?.projectName || 'Unknown',
          type: 'prompt',
          text_snippet: highlightMatch(p.text, query),
          timestamp: p.timestamp,
        });
      }
    }
  }

  if (type === 'all' || type === 'responses') {
    const responses = await getAll('responses');
    for (const r of responses) {
      const text = r.textExcerpt || r.fullText || '';
      if (text.toLowerCase().includes(lowerQuery)) {
        const s = sessionMap.get(r.sessionId);
        results.push({
          session_id: r.sessionId,
          project_name: s?.projectName || 'Unknown',
          type: 'response',
          text_snippet: highlightMatch(text, query),
          timestamp: r.timestamp,
        });
      }
    }
  }

  results.sort((a, b) => b.timestamp - a.timestamp);
  const total = results.length;
  const offset = (page - 1) * pageSize;
  return { results: results.slice(offset, offset + pageSize), total, page, pageSize };
}

function highlightMatch(text, query) {
  if (!text || !query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.substring(0, 200);
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 60);
  let snippet = text.substring(start, end);
  // Wrap match in <mark> tags
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  snippet = snippet.replace(re, '<mark>$1</mark>');
  return (start > 0 ? '...' : '') + snippet + (end < text.length ? '...' : '');
}

// ---- Analytics ----

export async function getSummaryStats() {
  const sessions = await getAll('sessions');
  const toolCalls = await getAll('toolCalls');
  const prompts = await getAll('prompts');

  const totalSessions = sessions.length;
  const totalPrompts = prompts.length;
  const totalToolCalls = toolCalls.length;
  const activeSessions = sessions.filter(s => s.status !== 'ended').length;

  // Average duration (only for sessions with endedAt)
  const withDuration = sessions.filter(s => s.endedAt && s.startedAt);
  const avgDuration = withDuration.length > 0
    ? Math.round(withDuration.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0) / withDuration.length)
    : 0;

  // Most used tool
  const toolCounts = {};
  for (const t of toolCalls) {
    toolCounts[t.toolName] = (toolCounts[t.toolName] || 0) + 1;
  }
  const mostUsedTool = Object.entries(toolCounts).sort((a, b) => b[1] - a[1])[0];

  // Busiest project (track name alongside path)
  const projectCounts = {};
  const projectNames = {};
  for (const s of sessions) {
    if (s.projectPath) {
      projectCounts[s.projectPath] = (projectCounts[s.projectPath] || 0) + 1;
      if (s.projectName) projectNames[s.projectPath] = s.projectName;
    }
  }
  const busiestProject = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    total_sessions: totalSessions,
    total_prompts: totalPrompts,
    total_tool_calls: totalToolCalls,
    active_sessions: activeSessions,
    avg_duration: avgDuration,
    most_used_tool: mostUsedTool ? { tool_name: mostUsedTool[0], count: mostUsedTool[1] } : null,
    busiest_project: busiestProject
      ? { project_path: busiestProject[0], name: projectNames[busiestProject[0]] || busiestProject[0], count: busiestProject[1] }
      : null,
  };
}

export async function getToolBreakdown() {
  const toolCalls = await getAll('toolCalls');
  const counts = {};
  for (const t of toolCalls) {
    counts[t.toolName] = (counts[t.toolName] || 0) + 1;
  }
  const total = toolCalls.length;
  return Object.entries(counts)
    .map(([tool_name, count]) => ({ tool_name, count, percentage: total > 0 ? Math.round(count / total * 1000) / 10 : 0 }))
    .sort((a, b) => b.count - a.count);
}

export async function getDurationTrends({ period = 'day' } = {}) {
  const sessions = await getAll('sessions');
  const withDuration = sessions.filter(s => s.endedAt && s.startedAt);

  const buckets = {};
  for (const s of withDuration) {
    const key = formatPeriod(s.startedAt, period);
    if (!buckets[key]) buckets[key] = { durations: [], count: 0 };
    buckets[key].durations.push(s.endedAt - s.startedAt);
    buckets[key].count++;
  }

  return Object.entries(buckets)
    .map(([period_label, data]) => ({
      period: period_label,
      avg_duration: Math.round(data.durations.reduce((a, b) => a + b, 0) / data.durations.length),
      session_count: data.count,
    }))
    .sort((a, b) => a.period.localeCompare(b.period));
}

export async function getActiveProjects() {
  const sessions = await getAll('sessions');
  const prompts = await getAll('prompts');
  const toolCalls = await getAll('toolCalls');

  // Count prompts/tools per session
  const sessionPromptCounts = {};
  for (const p of prompts) sessionPromptCounts[p.sessionId] = (sessionPromptCounts[p.sessionId] || 0) + 1;
  const sessionToolCounts = {};
  for (const t of toolCalls) sessionToolCounts[t.sessionId] = (sessionToolCounts[t.sessionId] || 0) + 1;

  const projects = {};
  for (const s of sessions) {
    const key = s.projectPath || 'Unknown';
    if (!projects[key]) {
      projects[key] = { project_path: key, project_name: s.projectName || key, session_count: 0, total_prompts: 0, total_tools: 0, last_activity: 0 };
    }
    projects[key].session_count++;
    projects[key].total_prompts += sessionPromptCounts[s.id] || 0;
    projects[key].total_tools += sessionToolCounts[s.id] || 0;
    projects[key].last_activity = Math.max(projects[key].last_activity, s.lastActivityAt || 0);
  }

  return Object.values(projects).sort((a, b) => b.last_activity - a.last_activity);
}

export async function getHeatmap() {
  const events = await getAll('events');
  const grid = {}; // "day-hour" -> count (day: 0=Mon, 6=Sun)
  for (const e of events) {
    const d = new Date(e.timestamp);
    // Convert JS getDay (0=Sun) to Mon-first (0=Mon, 6=Sun)
    const jsDay = d.getDay();
    const day = jsDay === 0 ? 6 : jsDay - 1;
    const hour = d.getHours();
    const key = `${day}-${hour}`;
    grid[key] = (grid[key] || 0) + 1;
  }

  const result = [];
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}-${hour}`;
      if (grid[key]) {
        result.push({ day_of_week: day, hour, count: grid[key] });
      }
    }
  }
  return result;
}

export async function getTimeline({ dateFrom, dateTo, granularity = 'day', project } = {}) {
  let sessions = await getAll('sessions');

  if (project) sessions = sessions.filter(s => s.projectPath === project);
  if (dateFrom) sessions = sessions.filter(s => s.startedAt >= dateFrom);
  if (dateTo) sessions = sessions.filter(s => s.startedAt <= dateTo);

  // Build a set of matching session IDs for filtering prompts/tools
  const sessionIds = new Set(sessions.map(s => s.id));

  // Count actual prompts and tool calls by their own timestamps for accurate per-period data
  const [allPrompts, allToolCalls] = await Promise.all([
    getAll('prompts'),
    getAll('toolCalls'),
  ]);

  const buckets = {};

  // Count sessions by startedAt
  for (const s of sessions) {
    const key = formatPeriod(s.startedAt, granularity);
    if (!buckets[key]) buckets[key] = { session_count: 0, prompt_count: 0, tool_call_count: 0 };
    buckets[key].session_count++;
  }

  // Count prompts by their own timestamp
  for (const p of allPrompts) {
    if (!sessionIds.has(p.sessionId)) continue;
    if (dateFrom && p.timestamp < dateFrom) continue;
    if (dateTo && p.timestamp > dateTo) continue;
    const key = formatPeriod(p.timestamp, granularity);
    if (!buckets[key]) buckets[key] = { session_count: 0, prompt_count: 0, tool_call_count: 0 };
    buckets[key].prompt_count++;
  }

  // Count tool calls by their own timestamp
  for (const t of allToolCalls) {
    if (!sessionIds.has(t.sessionId)) continue;
    if (dateFrom && t.timestamp < dateFrom) continue;
    if (dateTo && t.timestamp > dateTo) continue;
    const key = formatPeriod(t.timestamp, granularity);
    if (!buckets[key]) buckets[key] = { session_count: 0, prompt_count: 0, tool_call_count: 0 };
    buckets[key].tool_call_count++;
  }

  return {
    buckets: Object.entries(buckets)
      .map(([period, data]) => ({ period, ...data }))
      .sort((a, b) => a.period.localeCompare(b.period)),
  };
}

function formatPeriod(ts, granularity) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');

  switch (granularity) {
    case 'hour': return `${yyyy}-${mm}-${dd} ${hh}:00`;
    case 'week': {
      // ISO week
      const jan1 = new Date(yyyy, 0, 1);
      const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
      return `${yyyy}-W${String(week).padStart(2, '0')}`;
    }
    case 'month': return `${yyyy}-${mm}`;
    default: return `${yyyy}-${mm}-${dd}`;
  }
}

// ---- Prompt Queue helpers ----

export async function getQueue(sessionId) {
  const items = await getByIndex('promptQueue', 'sessionId', sessionId);
  return items.sort((a, b) => a.position - b.position);
}

export async function addToQueue(sessionId, text) {
  const items = await getQueue(sessionId);
  const maxPos = items.length > 0 ? Math.max(...items.map(i => i.position)) : -1;
  const now = Date.now();
  const id = await put('promptQueue', { sessionId, text: text.trim(), position: maxPos + 1, createdAt: now });
  return { id, sessionId, text: text.trim(), position: maxPos + 1, createdAt: now };
}

export async function popQueue(sessionId) {
  const items = await getQueue(sessionId);
  if (items.length === 0) return null;
  const top = items[0];
  await del('promptQueue', top.id);
  return top;
}

export async function reorderQueue(sessionId, orderedIds) {
  const tx = getDB().transaction('promptQueue', 'readwrite');
  const store = tx.objectStore('promptQueue');
  for (let i = 0; i < orderedIds.length; i++) {
    const req = store.get(orderedIds[i]);
    req.onsuccess = () => {
      const item = req.result;
      if (item && item.sessionId === sessionId) {
        item.position = i;
        store.put(item);
      }
    };
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveQueueItems(itemIds, targetSessionId) {
  const targetItems = await getQueue(targetSessionId);
  let maxPos = targetItems.length > 0 ? Math.max(...targetItems.map(i => i.position)) : -1;
  const tx = getDB().transaction('promptQueue', 'readwrite');
  const store = tx.objectStore('promptQueue');
  for (const id of itemIds) {
    const req = store.get(id);
    req.onsuccess = () => {
      const item = req.result;
      if (item) {
        item.sessionId = targetSessionId;
        item.position = ++maxPos;
        store.put(item);
      }
    };
  }
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function moveAllQueue(sourceSessionId, targetSessionId) {
  const sourceItems = await getQueue(sourceSessionId);
  if (sourceItems.length === 0) return;
  const ids = sourceItems.map(i => i.id);
  return moveQueueItems(ids, targetSessionId);
}

// ---- Session ID migration (re-key support) ----

/**
 * Migrate all child records from one session ID to another.
 * Called when a session is re-keyed (e.g., after `claude --resume` creates a new session ID).
 * Updates sessionId in all child stores so records follow the session card.
 */
export async function migrateSessionId(oldSessionId, newSessionId) {
  const childStores = ['prompts', 'responses', 'toolCalls', 'events', 'notes', 'promptQueue', 'alerts'];
  for (const storeName of childStores) {
    const records = await getByIndex(storeName, 'sessionId', oldSessionId);
    if (records.length === 0) continue;
    const tx = getDB().transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const r of records) {
      r.sessionId = newSessionId;
      store.put(r);
    }
    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ---- Notes helpers ----

export async function getNotes(sessionId) {
  const notes = await getByIndex('notes', 'sessionId', sessionId);
  return notes.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function addNote(sessionId, text) {
  const now = Date.now();
  const id = await put('notes', { sessionId, text, createdAt: now, updatedAt: now });
  return { id, sessionId, text, createdAt: now, updatedAt: now };
}

// ---- Settings helpers ----

export async function getSetting(key) {
  const row = await get('settings', key);
  return row ? row.value : null;
}

export async function setSetting(key, value) {
  await put('settings', { key, value, updatedAt: Date.now() });
}

export async function getAllSettings() {
  const all = await getAll('settings');
  const result = {};
  for (const row of all) result[row.key] = row.value;
  return result;
}

export async function setManySettings(obj) {
  const now = Date.now();
  await putMany('settings', Object.entries(obj).map(([key, value]) => ({ key, value, updatedAt: now })));
}

// ---- Seed defaults (first run only) ----

async function seedDefaults() {
  // Seed default settings
  const settingsCount = await count('settings');
  if (settingsCount === 0) {
    const now = Date.now();
    const defaults = {
      theme: 'command-center',
      fontSize: '13',
      modelUrl: 'https://threejs.org/examples/models/gltf/Xbot.glb',
      modelName: 'Xbot',
      soundEnabled: 'true',
      soundVolume: '0.5',
      soundPack: 'default',
    };
    await putMany('settings', Object.entries(defaults).map(([key, value]) => ({ key, value, updatedAt: now })));
    debugLog('[browserDb] Seeded default settings');
  }

  // Seed default summary prompts
  const promptCount = await count('summaryPrompts');
  if (promptCount === 0) {
    const now = Date.now();
    const templates = [
      {
        name: 'Detailed Technical Summary',
        prompt: `You are summarizing a Claude Code coding session. Produce a detailed summary with these sections:

## Overview
One paragraph describing the overall goal and outcome of the session.

## What Was Accomplished
- List every concrete change, feature, or fix completed (be specific — mention file names, function names, components)
- Group related changes together

## Key Decisions & Approach
- Architectural choices made (e.g. data structures, algorithms, patterns chosen)
- Trade-offs considered
- Why certain approaches were chosen over alternatives

## Files Modified
List each file touched and a brief note on what changed in it.

## Issues & Blockers
- Any errors encountered and how they were resolved
- Workarounds applied
- Things left unfinished or requiring follow-up

## Technical Details
- Notable implementation details worth remembering
- Dependencies added or updated
- Configuration changes

Be thorough and specific. Include file paths, function names, and concrete details. This summary should allow someone to fully understand what happened in this session without reading the transcript.`,
        isDefault: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Quick Bullet Points',
        prompt: 'Summarize this Claude Code session in 5-8 bullet points. Focus on what was accomplished, key files changed, and any issues encountered.',
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Changelog Entry',
        prompt: `Generate a changelog entry for this Claude Code session. Format it as:

### [Feature/Fix/Refactor]: <title>

**Changes:**
- List each change with the affected file path
- Be specific about what was added, modified, or removed

**Breaking Changes:** (if any)
**Migration Notes:** (if any)`,
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'Handoff Notes',
        prompt: `Write detailed handoff notes for another developer picking up this work. Include:

## Context
What was the developer trying to accomplish? What's the current state of things?

## What's Done
List completed changes with file paths and implementation details.

## What's Left / Next Steps
Any unfinished work, TODOs, or follow-up tasks.

## Gotchas & Important Notes
Anything the next developer needs to be aware of — edge cases, workarounds, architectural decisions that might not be obvious.

## How to Test
Steps to verify the changes work correctly.`,
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        name: 'PR Description',
        prompt: `Generate a pull request description for the changes made in this session. Format:

## Summary
1-3 sentences describing what this PR does.

## Changes
- Bullet list of every change, organized by file or feature area
- Include file paths

## Testing
- How to test these changes
- Any edge cases to watch for

## Screenshots / Notes
Any additional context for reviewers.`,
        isDefault: 0,
        createdAt: now,
        updatedAt: now,
      },
    ];
    await putMany('summaryPrompts', templates);
    debugLog('[browserDb] Seeded 5 default summary prompt templates');
  }
}


