/**
 * Read the most recent assistant message from a Claude Code session transcript.
 *
 * Claude Code stores per-session JSONL transcripts under
 *   ~/.claude/projects/<encoded-project-path>/<sessionId>.jsonl
 * where <encoded-project-path> is the absolute project path with `/` → `-`,
 * conventionally prefixed with a leading `-`.
 *
 * Each line is one JSON record. Assistant messages appear with shape
 *   { type: "assistant", message: { role: "assistant", content: <string|blocks[]> } }
 * but legacy variants exist; we accept several common shapes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import log from './logger.js';

interface JsonlLine {
  type?: string;
  role?: string;
  content?: unknown;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  /** A tool_use block's call id. */
  id?: string;
  /** A tool_result block's call id: the tool_use it answers. */
  tool_use_id?: string;
}

// ---------------------------------------------------------------------------
// Full-conversation reader (backs the CONVERSATION tab — see src/lib/transcript.ts
// for the matching client-side union).
// ---------------------------------------------------------------------------

/** One interleaved conversation entry parsed from the Claude JSONL transcript. */
export type ConversationEntry =
  | { role: 'user'; text: string; timestamp: number }
  | { role: 'assistant'; text: string; timestamp: number }
  | { role: 'tool_use'; tool: string; input: string; timestamp: number; id?: string }
  | { role: 'tool_result'; tool?: string; output: string; timestamp: number; isError?: boolean; toolUseId?: string }
  | { role: 'event'; eventType: string; detail: string; timestamp: number };

/** Per-entry payload caps so a single record can't bloat the response. */
const TOOL_INPUT_CAP = 2 * 1024;
const TOOL_RESULT_CAP = 4 * 1024;
/** Keep only the most recent N entries to bound the payload. */
const MAX_ENTRIES = 2000;

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stringifyToolPayload(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * A tool result's text. MCP tools answer with content blocks: their text (an
 * image as `[image]`), not the blocks as escaped JSON. Anything with a block
 * of another kind stays JSON, so nothing is dropped.
 */
function toolResultText(content: unknown): string {
  if (Array.isArray(content) && content.length > 0) {
    const parts = (content as ContentBlock[]).map((b) => {
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      if (b?.type === 'image') return '[image]';
      return null;
    });
    if (parts.every((p) => p !== null)) return parts.join('\n');
  }
  return stringifyToolPayload(content);
}

function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => (b.type === 'text' || typeof b.text === 'string') && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n');
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content || null;
  if (Array.isArray(content)) {
    const text = blocksToText(content as ContentBlock[]);
    return text || null;
  }
  return null;
}

function isAssistant(line: JsonlLine): boolean {
  if (line.type === 'assistant') return true;
  if (line.role === 'assistant') return true;
  if (line.message?.role === 'assistant') return true;
  return false;
}

/** Where Claude Code keeps its per-project transcript directories. */
export function claudeProjectsRoot(): string {
  return join(homedir(), '.claude', 'projects');
}

export function projectDirCandidates(projectPath: string, projectsRoot = claudeProjectsRoot()): string[] {
  const variants = new Set<string>();
  // Standard: leading dash + slashes-to-dashes
  variants.add('-' + projectPath.replace(/^\//, '').replace(/\//g, '-'));
  // Without leading dash
  variants.add(projectPath.replace(/^\//, '').replace(/\//g, '-'));
  // Replace dots too (Claude sometimes encodes dots)
  variants.add('-' + projectPath.replace(/^\//, '').replace(/[/.]/g, '-'));
  return Array.from(variants).map((v) => join(projectsRoot, v));
}

/** A session id safe to interpolate into a single-quoted shell argument (or a file name). */
const RESUMABLE_SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;

/**
 * The session's own `<sessionId>.jsonl` in the encoded project directory, or null.
 *
 * There is deliberately NO "newest .jsonl in the dir" fallback (AASC-49): that
 * file belongs to whichever conversation in the project ran last, so a Codex
 * session (no transcriptPath, an id that never names a Claude file) or a Claude
 * session whose transcript is missing showed somebody else's conversation.
 */
export function findTranscriptFile(sessionId: string | null, projectPath: string): string | null {
  if (!sessionId || !projectPath || !RESUMABLE_SESSION_ID_RE.test(sessionId)) return null;
  for (const dir of projectDirCandidates(projectPath)) {
    const direct = join(dir, `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  return null;
}

/**
 * Resolve the session id that `claude --resume` will actually find on disk, or
 * null when no transcript backs this session.
 *
 * Callers use this to decide whether a `--resume <id>` / `--fork-session` launch
 * is viable at all. `promptHistory.length > 0` does NOT answer that question:
 * prompt history survives workspace restore, `/clear` and session re-keys, and a
 * session whose transcript was never persisted (an inherited
 * CLAUDE_CODE_CHILD_SESSION — see config.ts INHERITED_CLAUDE_SESSION_ENV_KEYS)
 * or was removed by Claude's retention cleanup still shows plenty of prompts.
 * Resuming it exits immediately with "No conversation found with session ID",
 * leaving the user a dead shell.
 *
 * Like `findTranscriptFile`, this deliberately has NO "newest .jsonl in the
 * dir" fallback: an unrelated conversation in the same project directory does
 * not make THIS session resumable. The recorded `transcriptPath` is accepted as
 * a second source because a re-keyed/aliased card can carry a stale id while the
 * hook-reported transcript names the id Claude will find.
 */
export function resolveResumableClaudeSessionId(
  sessionId: string | null,
  projectPath: string,
  transcriptPath?: string | null,
): string | null {
  if (!projectPath) return null;
  const id = sessionId || '';
  // term-* is a dashboard-internal placeholder — passing it to --resume opens
  // Claude's interactive session picker and blocks the shell.
  if (id && !id.startsWith('term-') && RESUMABLE_SESSION_ID_RE.test(id)) {
    for (const dir of projectDirCandidates(projectPath)) {
      if (existsSync(join(dir, `${id}.jsonl`))) return id;
    }
  }
  if (transcriptPath && existsSync(transcriptPath)) {
    const recordedId = basename(transcriptPath, '.jsonl');
    if (recordedId && !recordedId.startsWith('term-') && RESUMABLE_SESSION_ID_RE.test(recordedId)) {
      return recordedId;
    }
  }
  return null;
}

/**
 * Read the last assistant message text from the Claude transcript for the given
 * session.
 *
 * Lookup order:
 *   1. `transcriptPath` if provided and exists
 *   2. `<sessionId>.jsonl` in the encoded project directory
 * Nothing else: another conversation's file is never this session's (AASC-49).
 *
 * Returns null when no transcript exists or no assistant message can be parsed.
 */
export function readClaudeLastAssistant(
  sessionId: string | null,
  projectPath: string,
  transcriptPath: string | null = null,
): string | null {
  let file: string | null = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    file = transcriptPath;
  } else {
    file = findTranscriptFile(sessionId, projectPath);
  }
  if (!file) return null;
  try {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const raw = lines[i].trim();
      if (!raw) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isAssistant(obj)) continue;
      const text =
        extractText(obj.message?.content) ??
        extractText(obj.content) ??
        null;
      if (text && text.trim()) return text;
    }
  } catch (err) {
    log.warn('floating-spawn', `Failed to read transcript ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

/** A record's own time in ms, or NaN when it has none. */
export function transcriptLineTimestamp(line: unknown): number {
  const stamp = (line as JsonlLine | null)?.timestamp;
  return stamp ? new Date(stamp).getTime() : NaN;
}

/**
 * The conversation entries one parsed JSONL record holds (user text, assistant
 * text, tool calls, tool results), in block order. Non-conversation records
 * (system, summary, attachments, progress) hold none. Shared by the session
 * transcript (CONVERSATION tab) and the subagent transcript (AGENTS tab).
 */
export function transcriptLineEntries(line: unknown, timestamp: number): ConversationEntry[] {
  if (!line || typeof line !== 'object') return [];
  const obj = line as JsonlLine;
  if (obj.type === 'system' || obj.type === 'summary') return [];
  const role = obj.message?.role ?? obj.role ?? obj.type;
  const content = obj.message?.content ?? obj.content;
  const out: ConversationEntry[] = [];

  if (role === 'assistant') {
    if (typeof content === 'string') {
      if (content.trim()) out.push({ role: 'assistant', text: content, timestamp });
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content as ContentBlock[]) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ role: 'assistant', text: block.text, timestamp });
      } else if (block?.type === 'tool_use') {
        out.push({
          role: 'tool_use',
          tool: typeof block.name === 'string' ? block.name : 'tool',
          input: cap(stringifyToolPayload(block.input), TOOL_INPUT_CAP),
          timestamp,
          ...(typeof block.id === 'string' ? { id: block.id } : {}),
        });
      }
    }
    return out;
  }

  if (role === 'user') {
    if (typeof content === 'string') {
      if (content.trim()) out.push({ role: 'user', text: content, timestamp });
      return out;
    }
    if (!Array.isArray(content)) return out;
    for (const block of content as ContentBlock[]) {
      if (block?.type === 'tool_result') {
        const output = cap(toolResultText(block.content), TOOL_RESULT_CAP);
        if (output.trim()) {
          out.push({
            role: 'tool_result',
            output,
            timestamp,
            isError: block.is_error === true,
            ...(typeof block.tool_use_id === 'string' ? { toolUseId: block.tool_use_id } : {}),
          });
        }
      } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ role: 'user', text: block.text, timestamp });
      }
    }
  }
  return out;
}

/**
 * Parse a whole Claude Code JSONL transcript into an ordered list of interleaved
 * conversation entries (user text, assistant text, tool calls, tool results).
 *
 * Lookup order mirrors readClaudeLastAssistant:
 *   1. `transcriptPath` if provided and exists
 *   2. `<sessionId>.jsonl` in the encoded project directory
 * Nothing else (AASC-49).
 *
 * Returns [] when no transcript exists or nothing parseable is found — callers
 * fall back to the in-memory logs.
 */
export function readClaudeTranscript(
  sessionId: string | null,
  projectPath: string,
  transcriptPath: string | null = null,
): ConversationEntry[] {
  let file: string | null = null;
  if (transcriptPath && existsSync(transcriptPath)) {
    file = transcriptPath;
  } else {
    file = findTranscriptFile(sessionId, projectPath);
  }
  if (!file) return [];

  const entries: ConversationEntry[] = [];
  let lastTs = 0;
  try {
    const content = readFileSync(file, 'utf8');
    const lines = content.split('\n');
    for (const rawLine of lines) {
      const raw = rawLine.trim();
      if (!raw) continue;
      let obj: JsonlLine;
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      // Skip non-conversation records (their times don't carry to the next entry).
      if (obj.type === 'system' || obj.type === 'summary') continue;
      const own = transcriptLineTimestamp(obj);
      const timestamp = Number.isFinite(own) ? own : lastTs;
      lastTs = timestamp;
      entries.push(...transcriptLineEntries(obj, timestamp));
    }
  } catch (err) {
    log.warn('floating-spawn', `Failed to read transcript ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Bound the payload to the most recent MAX_ENTRIES, preserving file order.
  return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
}
