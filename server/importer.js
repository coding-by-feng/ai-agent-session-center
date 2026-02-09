// importer.js — Scans ~/.claude/projects/ and imports historical sessions from JSONL files
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { readdir, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import db from './db.js';

let importStatus = { status: 'idle', processed: 0, total: 0, last_import_at: null };
const importProjectCounters = new Map();

function summarizeToolInput(toolInput, toolName) {
  if (!toolInput) return '';
  switch (toolName) {
    case 'Read': return toolInput.file_path || '';
    case 'Write': return toolInput.file_path || '';
    case 'Edit': return toolInput.file_path || '';
    case 'Bash': return (toolInput.command || '').substring(0, 120);
    case 'Grep': return `${toolInput.pattern || ''} in ${toolInput.path || 'cwd'}`;
    case 'Glob': return toolInput.pattern || '';
    case 'WebFetch': return toolInput.url || '';
    case 'Task': return toolInput.description || '';
    default: return JSON.stringify(toolInput).substring(0, 100);
  }
}

function makeShortTitle(prompt) {
  if (!prompt) return '';
  let text = prompt.trim().replace(/^(please|can you|could you|help me|i want to|i need to)\s+/i, '');
  if (!text) return '';
  const match = text.match(/^[^\n.!?]{1,60}/);
  if (match) text = match[0].trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toEpochMs(ts) {
  if (ts == null) return null;
  if (typeof ts === 'number') return ts;
  const ms = new Date(ts).getTime();
  return isNaN(ms) ? null : ms;
}

async function collectJsonlFiles(baseDir) {
  const files = [];
  let dirs;
  try {
    dirs = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue;
    const dirPath = join(baseDir, entry.name);
    let children;
    try {
      children = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const child of children) {
      if (child.endsWith('.jsonl')) {
        files.push({ dirName: entry.name, filePath: join(dirPath, child), sessionId: child.replace(/\.jsonl$/, '') });
      }
    }
  }
  return files;
}

function parseJsonlLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function readJsonlFile(filePath) {
  return new Promise((resolve, reject) => {
    const messages = [];
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const parsed = parseJsonlLine(trimmed);
      if (parsed) messages.push(parsed);
    });
    rl.on('close', () => resolve(messages));
    rl.on('error', reject);
  });
}

// Prepared statements (lazily created)
let stmts = null;
function getStmts() {
  if (stmts) return stmts;
  stmts = {
    checkSession: db.prepare('SELECT id FROM sessions WHERE id = ?'),
    insertSession: db.prepare(`INSERT INTO sessions (id, project_path, project_name, model, status, git_branch, claude_version, started_at, ended_at, last_activity_at, total_tool_calls, total_prompts, source, imported_at, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', ?, ?)`),
    insertPrompt: db.prepare('INSERT INTO prompts (session_id, text, timestamp, uuid) VALUES (?, ?, ?, ?)'),
    insertResponse: db.prepare('INSERT INTO responses (session_id, text_excerpt, full_text, timestamp, uuid, model) VALUES (?, ?, ?, ?, ?, ?)'),
    insertToolCall: db.prepare('INSERT INTO tool_calls (session_id, tool_name, tool_input_summary, timestamp, uuid) VALUES (?, ?, ?, ?, ?)'),
    insertEvent: db.prepare('INSERT INTO events (session_id, event_type, detail, timestamp) VALUES (?, ?, ?, ?)'),
    getMeta: db.prepare('SELECT value FROM import_meta WHERE key = ?'),
    upsertMeta: db.prepare('INSERT OR REPLACE INTO import_meta (key, value) VALUES (?, ?)')
  };
  return stmts;
}

function processSession(sessionId, messages) {
  const s = getStmts();

  // Check if session already exists
  if (s.checkSession.get(sessionId)) return false;

  let projectPath = null;
  let projectName = null;
  let model = null;
  let gitBranch = null;
  let claudeVersion = null;
  let title = null;
  let minTs = Infinity;
  let maxTs = -Infinity;
  let totalPrompts = 0;
  let totalToolCalls = 0;

  const prompts = [];
  const responses = [];
  const toolCalls = [];
  const events = [];

  for (const msg of messages) {
    const msgType = msg.type;

    // Skip non-message types
    if (['progress', 'file-history-snapshot', 'queue-operation'].includes(msgType)) continue;

    const ts = toEpochMs(msg.timestamp);
    if (ts != null) {
      if (ts < minTs) minTs = ts;
      if (ts > maxTs) maxTs = ts;
    }

    if (msgType === 'user') {
      if (!projectPath && msg.cwd) {
        projectPath = msg.cwd;
        projectName = msg.cwd.split('/').filter(Boolean).pop() || msg.cwd;
      }
      if (!gitBranch && msg.gitBranch) gitBranch = msg.gitBranch;
      if (!claudeVersion && msg.version) claudeVersion = msg.version;

      // Extract prompt text from message.content
      let promptText = '';
      if (msg.message && msg.message.content) {
        if (typeof msg.message.content === 'string') {
          promptText = msg.message.content;
        } else if (Array.isArray(msg.message.content)) {
          promptText = msg.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('\n');
        }
      }

      const uuid = msg.uuid || (msg.message && msg.message.id) || null;
      prompts.push({ text: promptText, timestamp: ts, uuid });
      totalPrompts++;
      events.push({ type: 'prompt', detail: promptText.substring(0, 200), timestamp: ts });

      // Auto-generate title from project name + counter + short prompt summary
      if (!title && projectName) {
        const cnt = (importProjectCounters.get(projectName) || 0) + 1;
        importProjectCounters.set(projectName, cnt);
        const shortPrompt = makeShortTitle(promptText);
        title = shortPrompt
          ? `${projectName} #${cnt} — ${shortPrompt}`
          : `${projectName} — Session #${cnt}`;
      }
    }

    if (msgType === 'assistant') {
      const msgModel = msg.message && msg.message.model;
      if (msgModel && !model) model = msgModel;

      let responseText = '';
      const uuid = msg.uuid || (msg.message && msg.message.id) || null;

      if (msg.message && msg.message.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (block.type === 'thinking') continue;

          if (block.type === 'text') {
            responseText += (responseText ? '\n' : '') + (block.text || '');
          }

          if (block.type === 'tool_use') {
            const toolName = block.name || 'Unknown';
            const toolInputSummary = summarizeToolInput(block.input, toolName);
            toolCalls.push({ toolName, toolInputSummary, timestamp: ts, uuid });
            totalToolCalls++;
            events.push({ type: 'tool_use', detail: toolName, timestamp: ts });
          }
        }
      }

      const textExcerpt = responseText.substring(0, 2000);
      responses.push({ textExcerpt, fullText: responseText, timestamp: ts, uuid, model: msgModel });
      events.push({ type: 'response', detail: textExcerpt.substring(0, 200), timestamp: ts });
    }
  }

  const startedAt = minTs === Infinity ? null : minTs;
  const endedAt = maxTs === -Infinity ? null : maxTs;
  const now = Date.now();

  // Wrap all inserts in a transaction
  const runTransaction = db.transaction(() => {
    s.insertSession.run(sessionId, projectPath, projectName, model, 'ended', gitBranch, claudeVersion, startedAt, endedAt, endedAt, totalToolCalls, totalPrompts, now, title || projectName || null);

    for (const p of prompts) {
      s.insertPrompt.run(sessionId, p.text, p.timestamp, p.uuid);
    }
    for (const r of responses) {
      s.insertResponse.run(sessionId, r.textExcerpt, r.fullText, r.timestamp, r.uuid, r.model);
    }
    for (const tc of toolCalls) {
      s.insertToolCall.run(sessionId, tc.toolName, tc.toolInputSummary, tc.timestamp, tc.uuid);
    }
    for (const ev of events) {
      s.insertEvent.run(sessionId, ev.type, ev.detail, ev.timestamp);
    }
  });

  runTransaction();
  return true;
}

function yieldEventLoop() {
  return new Promise(resolve => setImmediate(resolve));
}

export async function startImport() {
  if (importStatus.status === 'running') {
    console.log('[importer] Import already in progress');
    return;
  }

  importStatus = { status: 'running', processed: 0, total: 0, last_import_at: null };

  try {
    const s = getStmts();
    const metaRow = s.getMeta.get('last_import_timestamp');
    const lastImportAt = metaRow ? metaRow.value : null;

    const baseDir = join(homedir(), '.claude', 'projects');
    const jsonlFiles = await collectJsonlFiles(baseDir);
    importStatus.total = jsonlFiles.length;

    console.log(`[importer] Found ${jsonlFiles.length} JSONL files to process`);

    let imported = 0;
    let skipped = 0;

    for (const file of jsonlFiles) {
      try {
        const messages = await readJsonlFile(file.filePath);
        const wasImported = processSession(file.sessionId, messages);
        if (wasImported) {
          imported++;
        } else {
          skipped++;
        }
      } catch (err) {
        console.error(`[importer] Error processing ${file.filePath}:`, err.message);
      }

      importStatus.processed++;

      // Yield to event loop between sessions
      await yieldEventLoop();
    }

    const now = Date.now();
    s.upsertMeta.run('last_import_timestamp', String(now));

    importStatus.status = 'idle';
    importStatus.last_import_at = now;

    console.log(`[importer] Import complete: ${imported} imported, ${skipped} skipped (already in DB)`);
  } catch (err) {
    console.error('[importer] Import failed:', err.message);
    importStatus.status = 'idle';
  }
}

export function getImportStatus() {
  return { ...importStatus };
}
