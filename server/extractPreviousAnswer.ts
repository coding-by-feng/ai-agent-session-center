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
  message?: { role?: string; content?: unknown };
}

interface ContentBlock {
  type?: string;
  text?: string;
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
