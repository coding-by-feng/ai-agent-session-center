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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
}

// ---------------------------------------------------------------------------
// Full-conversation reader (backs the CONVERSATION tab — see src/lib/transcript.ts
// for the matching client-side union).
// ---------------------------------------------------------------------------

/** One interleaved conversation entry parsed from the Claude JSONL transcript. */
export type ConversationEntry =
  | { role: 'user'; text: string; timestamp: number }
  | { role: 'assistant'; text: string; timestamp: number }
  | { role: 'tool_use'; tool: string; input: string; timestamp: number }
  | { role: 'tool_result'; tool?: string; output: string; timestamp: number; isError?: boolean }
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

function projectDirCandidates(projectPath: string): string[] {
  const projectsRoot = join(homedir(), '.claude', 'projects');
  const variants = new Set<string>();
  // Standard: leading dash + slashes-to-dashes
  variants.add('-' + projectPath.replace(/^\//, '').replace(/\//g, '-'));
  // Without leading dash
  variants.add(projectPath.replace(/^\//, '').replace(/\//g, '-'));
  // Replace dots too (Claude sometimes encodes dots)
  variants.add('-' + projectPath.replace(/^\//, '').replace(/[/.]/g, '-'));
  return Array.from(variants).map((v) => join(projectsRoot, v));
}

/**
 * Find the JSONL file for a given (sessionId, projectPath). If sessionId is missing
 * or doesn't correspond to a file, fall back to the newest .jsonl in the project dir.
 */
function findTranscriptFile(sessionId: string | null, projectPath: string): string | null {
  for (const dir of projectDirCandidates(projectPath)) {
    if (!existsSync(dir)) continue;
    if (sessionId) {
      const direct = join(dir, `${sessionId}.jsonl`);
      if (existsSync(direct)) return direct;
    }
    // Fallback: newest .jsonl in dir
    try {
      const files = readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (files.length > 0) return join(dir, files[0].f);
    } catch (err) {
      log.warn('floating-spawn', `Failed to enumerate ${dir}: ${err instanceof Error ? err.message : String(err)}`);
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
 *   3. Newest .jsonl in the encoded project directory (fallback)
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

/**
 * Parse a whole Claude Code JSONL transcript into an ordered list of interleaved
 * conversation entries (user text, assistant text, tool calls, tool results).
 *
 * Lookup order mirrors readClaudeLastAssistant:
 *   1. `transcriptPath` if provided and exists (constrained to ~/.claude/projects
 *      only when falling back to the encoded project directory)
 *   2. `<sessionId>.jsonl` in the encoded project directory
 *   3. Newest .jsonl in the encoded project directory (fallback)
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
      // Skip non-conversation records.
      if (obj.type === 'system' || obj.type === 'summary') continue;

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : NaN;
      const timestamp = Number.isFinite(ts) ? ts : lastTs;
      lastTs = timestamp;

      const role = obj.message?.role ?? obj.role ?? obj.type;
      const content2 = obj.message?.content ?? obj.content;

      if (role === 'assistant') {
        if (typeof content2 === 'string') {
          if (content2.trim()) entries.push({ role: 'assistant', text: content2, timestamp });
          continue;
        }
        if (Array.isArray(content2)) {
          for (const block of content2 as ContentBlock[]) {
            if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              entries.push({ role: 'assistant', text: block.text, timestamp });
            } else if (block?.type === 'tool_use') {
              entries.push({
                role: 'tool_use',
                tool: typeof block.name === 'string' ? block.name : 'tool',
                input: cap(stringifyToolPayload(block.input), TOOL_INPUT_CAP),
                timestamp,
              });
            }
          }
        }
        continue;
      }

      if (role === 'user') {
        if (typeof content2 === 'string') {
          if (content2.trim()) entries.push({ role: 'user', text: content2, timestamp });
          continue;
        }
        if (Array.isArray(content2)) {
          for (const block of content2 as ContentBlock[]) {
            if (block?.type === 'tool_result') {
              const output = cap(stringifyToolPayload(block.content), TOOL_RESULT_CAP);
              if (output.trim()) {
                entries.push({ role: 'tool_result', output, timestamp, isError: block.is_error === true });
              }
            } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
              entries.push({ role: 'user', text: block.text, timestamp });
            }
          }
        }
      }
    }
  } catch (err) {
    log.warn('floating-spawn', `Failed to read transcript ${file}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  // Bound the payload to the most recent MAX_ENTRIES, preserving file order.
  return entries.length > MAX_ENTRIES ? entries.slice(entries.length - MAX_ENTRIES) : entries;
}
