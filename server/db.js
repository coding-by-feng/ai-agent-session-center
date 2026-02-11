// db.js — SQLite database initialization and schema
import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(join(__dirname, '..', 'data', 'sessions.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_path TEXT,
    project_name TEXT,
    model TEXT,
    status TEXT,
    git_branch TEXT,
    claude_version TEXT,
    started_at INTEGER,
    ended_at INTEGER,
    last_activity_at INTEGER,
    total_tool_calls INTEGER DEFAULT 0,
    total_prompts INTEGER DEFAULT 0,
    source TEXT DEFAULT 'hook',
    imported_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    text TEXT,
    timestamp INTEGER,
    uuid TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    text_excerpt TEXT,
    full_text TEXT,
    timestamp INTEGER,
    uuid TEXT,
    model TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    tool_name TEXT,
    tool_input_summary TEXT,
    timestamp INTEGER,
    uuid TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    event_type TEXT,
    detail TEXT,
    timestamp INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );

  CREATE TABLE IF NOT EXISTS import_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  -- FTS5 virtual tables for full-text search
  CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(
    text,
    content=prompts,
    content_rowid=id
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS responses_fts USING fts5(
    text_excerpt,
    full_text,
    content=responses,
    content_rowid=id
  );

  -- Indexes
  CREATE INDEX IF NOT EXISTS idx_prompts_session_id ON prompts(session_id);
  CREATE INDEX IF NOT EXISTS idx_prompts_timestamp ON prompts(timestamp);
  CREATE INDEX IF NOT EXISTS idx_responses_session_id ON responses(session_id);
  CREATE INDEX IF NOT EXISTS idx_responses_timestamp ON responses(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_session_id ON tool_calls(session_id);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_timestamp ON tool_calls(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tool_calls_tool_name ON tool_calls(tool_name);
  CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type);
  CREATE INDEX IF NOT EXISTS idx_sessions_project_path ON sessions(project_path);
  CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_activity_at ON sessions(last_activity_at);
`);

// Schema migrations for session controls
try { db.exec('ALTER TABLE sessions ADD COLUMN archived INTEGER DEFAULT 0'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN title TEXT'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN summary TEXT'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN character_model TEXT'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN accent_color TEXT'); } catch(e) { /* column may already exist */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS session_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    text TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE TABLE IF NOT EXISTS duration_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    threshold_ms INTEGER,
    enabled INTEGER DEFAULT 1,
    triggered_at INTEGER,
    created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_notes_session_id ON session_notes(session_id);
  CREATE INDEX IF NOT EXISTS idx_duration_alerts_session_id ON duration_alerts(session_id);
  CREATE INDEX IF NOT EXISTS idx_duration_alerts_enabled ON duration_alerts(enabled);
`);

// Backfill titles for sessions that have no title yet
// Uses "ProjectName — first prompt summary" format
try {
  const backfillTitle = db.prepare(`
    UPDATE sessions
    SET title = COALESCE(project_name, 'Unknown') || ' — ' || SUBSTR(REPLACE(
      (SELECT p.text FROM prompts p WHERE p.session_id = sessions.id ORDER BY p.timestamp ASC LIMIT 1),
      CHAR(10), ' '
    ), 1, 80)
    WHERE (title IS NULL OR title = '')
      AND EXISTS (SELECT 1 FROM prompts p WHERE p.session_id = sessions.id)
  `);
  const result = backfillTitle.run();
  if (result.changes > 0) {
    console.log(`[db] Backfilled ${result.changes} session titles`);
  }
} catch(e) {
  console.error('[db] Title backfill error:', e.message);
}

// Team mode schema migrations
try { db.exec('ALTER TABLE sessions ADD COLUMN team_id TEXT'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN team_role TEXT'); } catch(e) { /* column may already exist */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT'); } catch(e) { /* column may already exist */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    parent_session_id TEXT NOT NULL,
    team_name TEXT,
    created_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_team_id ON sessions(team_id);
`);

// Summary prompt templates
db.exec(`
  CREATE TABLE IF NOT EXISTS summary_prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    is_default INTEGER DEFAULT 0,
    created_at INTEGER,
    updated_at INTEGER
  );
`);

// Seed default summary prompts if table is empty
{
  const count = db.prepare('SELECT COUNT(*) AS c FROM summary_prompts').get().c;
  if (count === 0) {
    const seedPrompt = db.prepare('INSERT INTO summary_prompts (name, prompt, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    const now = Date.now();
    seedPrompt.run('Detailed Technical Summary', `You are summarizing a Claude Code coding session. Produce a detailed summary with these sections:

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

Be thorough and specific. Include file paths, function names, and concrete details. This summary should allow someone to fully understand what happened in this session without reading the transcript.`, 1, now, now);

    seedPrompt.run('Quick Bullet Points', `Summarize this Claude Code session in 5-8 bullet points. Focus on what was accomplished, key files changed, and any issues encountered.`, 0, now, now);

    seedPrompt.run('Changelog Entry', `Generate a changelog entry for this Claude Code session. Format it as:

### [Feature/Fix/Refactor]: <title>

**Changes:**
- List each change with the affected file path
- Be specific about what was added, modified, or removed

**Breaking Changes:** (if any)
**Migration Notes:** (if any)`, 0, now, now);

    seedPrompt.run('Handoff Notes', `Write detailed handoff notes for another developer picking up this work. Include:

## Context
What was the developer trying to accomplish? What's the current state of things?

## What's Done
List completed changes with file paths and implementation details.

## What's Left / Next Steps
Any unfinished work, TODOs, or follow-up tasks.

## Gotchas & Important Notes
Anything the next developer needs to be aware of — edge cases, workarounds, architectural decisions that might not be obvious.

## How to Test
Steps to verify the changes work correctly.`, 0, now, now);

    seedPrompt.run('PR Description', `Generate a pull request description for the changes made in this session. Format:

## Summary
1-3 sentences describing what this PR does.

## Changes
- Bullet list of every change, organized by file or feature area
- Include file paths

## Testing
- How to test these changes
- Any edge cases to watch for

## Screenshots / Notes
Any additional context for reviewers.`, 0, now, now);

    console.log('[db] Seeded 5 default summary prompt templates');
  }
}

// Prompt queue table — per-session ordered prompt queue
db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    text TEXT,
    position INTEGER,
    created_at INTEGER,
    FOREIGN KEY (session_id) REFERENCES sessions(id)
  );
  CREATE INDEX IF NOT EXISTS idx_prompt_queue_session ON prompt_queue(session_id, position);
`);

// SSH profiles table
db.exec(`
  CREATE TABLE IF NOT EXISTS ssh_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL DEFAULT 'localhost',
    port INTEGER NOT NULL DEFAULT 22,
    username TEXT NOT NULL,
    auth_method TEXT NOT NULL DEFAULT 'key',
    private_key_path TEXT,
    working_dir TEXT DEFAULT '~',
    default_command TEXT DEFAULT 'claude',
    created_at INTEGER,
    updated_at INTEGER
  );
`);

// User settings table
db.exec(`
  CREATE TABLE IF NOT EXISTS user_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at INTEGER
  );
`);

// Seed defaults
const seedSetting = db.prepare('INSERT OR IGNORE INTO user_settings (key, value, updated_at) VALUES (?, ?, ?)');
const now = Date.now();
const defaultSettings = {
  theme: 'command-center',
  fontSize: '13',
  modelUrl: 'https://threejs.org/examples/models/gltf/Xbot.glb',
  modelName: 'Xbot',
  soundEnabled: 'true',
  soundVolume: '0.5',
  soundPack: 'default'
};
for (const [key, value] of Object.entries(defaultSettings)) {
  seedSetting.run(key, value, now);
}

// FTS sync triggers — keep FTS tables in sync with content tables
// Use try/catch because CREATE TRIGGER IF NOT EXISTS is not supported in all SQLite versions
const triggerStatements = [
  `CREATE TRIGGER IF NOT EXISTS prompts_fts_insert AFTER INSERT ON prompts BEGIN
    INSERT INTO prompts_fts(rowid, text) VALUES (new.id, new.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS prompts_fts_delete AFTER DELETE ON prompts BEGIN
    INSERT INTO prompts_fts(prompts_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS responses_fts_insert AFTER INSERT ON responses BEGIN
    INSERT INTO responses_fts(rowid, text_excerpt, full_text) VALUES (new.id, new.text_excerpt, new.full_text);
  END`,
  `CREATE TRIGGER IF NOT EXISTS responses_fts_delete AFTER DELETE ON responses BEGIN
    INSERT INTO responses_fts(responses_fts, rowid, text_excerpt, full_text) VALUES ('delete', old.id, old.text_excerpt, old.full_text);
  END`
];

for (const sql of triggerStatements) {
  try {
    db.exec(sql);
  } catch (e) {
    // Trigger already exists, safe to ignore
    if (!e.message.includes('already exists')) throw e;
  }
}

export default db;
