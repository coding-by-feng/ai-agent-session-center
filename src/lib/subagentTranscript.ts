/**
 * subagentTranscript — one subagent's own conversation, for the AGENTS tab's
 * detail view (click a subagent card).
 *
 * The server reads it from the subagent's JSONL transcript in pages from the
 * end (server/subagentTranscript.ts): the newest page first, `before` for the
 * one above it, `from` to refresh the newest page without leaving a gap under
 * pages already loaded above it. This module fetches those pages, keeps them
 * together, and turns their entries into the rows the view draws: replies,
 * messages, and each tool call paired with its result.
 *
 * Pure apart from `fetchSubagentTranscript`; no store, no React.
 */
import type { ConversationEntry } from './transcript';
import { readJson } from './requestJson';

export interface SubagentTranscriptPage {
  /** The prompt the leader gave the subagent, when its transcript starts with one. */
  task: string | null;
  /** Oldest first. */
  entries: ConversationEntry[];
  /** Byte offset of the page's oldest line. */
  start: number;
  hasEarlier: boolean;
  /** The server answered a refresh with the newest page instead: drop older pages. */
  reset?: true;
}

export type SubagentTranscriptResult =
  | { ok: true; page: SubagentTranscriptPage | null } // null: this run has no transcript on disk
  | { ok: false; error: string };

export interface PageQuery {
  before?: number;
  from?: number;
}

export async function fetchSubagentTranscript(
  sessionId: string,
  agentId: string,
  query: PageQuery = {},
  signal?: AbortSignal,
): Promise<SubagentTranscriptResult> {
  const params = new URLSearchParams();
  if (query.before !== undefined) params.set('before', String(query.before));
  if (query.from !== undefined) params.set('from', String(query.from));
  const qs = params.toString();
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/subagents/${encodeURIComponent(agentId)}/transcript${qs ? `?${qs}` : ''}`;
  try {
    const res = await fetch(url, { signal });
    const body = await readJson<{ success?: boolean; data?: SubagentTranscriptPage | null }>(res, 'Could not load this agent’s messages');
    return { ok: true, page: body.data ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Pages kept together
// ---------------------------------------------------------------------------

/** What the detail view has loaded: the newest page, and any pages above it. */
export interface TranscriptView {
  /** Entries of the pages loaded above the newest one, oldest first. */
  older: ConversationEntry[];
  /** Start of the oldest loaded page above the newest one; null when none is loaded. */
  olderStart: number | null;
  olderHasEarlier: boolean;
  latest: SubagentTranscriptPage;
}

export function viewOf(page: SubagentTranscriptPage): TranscriptView {
  return { older: [], olderStart: null, olderHasEarlier: false, latest: page };
}

/** A fresh newest page in place of the old one; a reset also drops the pages above it. */
export function mergeLatest(view: TranscriptView, page: SubagentTranscriptPage): TranscriptView {
  return page.reset ? viewOf(page) : { ...view, latest: page };
}

/** The page above everything loaded, put on top. */
export function prependOlder(view: TranscriptView, page: SubagentTranscriptPage): TranscriptView {
  return { ...view, older: [...page.entries, ...view.older], olderStart: page.start, olderHasEarlier: page.hasEarlier };
}

export function hasEarlier(view: TranscriptView): boolean {
  return view.olderStart !== null ? view.olderHasEarlier : view.latest.hasEarlier;
}

/** The offset to read the next page above from. */
export function earlierCursor(view: TranscriptView): number {
  return view.olderStart ?? view.latest.start;
}

/**
 * How to refresh: the newest page, or, once pages above it are loaded,
 * everything from where the newest page starts (so nothing falls in between).
 */
export function refreshQuery(view: TranscriptView | null): PageQuery {
  return view && view.olderStart !== null ? { from: view.latest.start } : {};
}

export function viewEntries(view: TranscriptView): ConversationEntry[] {
  return view.older.length > 0 ? [...view.older, ...view.latest.entries] : view.latest.entries;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MessageRow =
  | { kind: 'reply'; key: string; at: number; text: string }
  /** User-role text: a follow-up message to the agent, or text the harness injected (`<…>`). */
  | { kind: 'message'; key: string; at: number; text: string; injected: boolean }
  | { kind: 'tool'; key: string; at: number; tool: string; summary: string; input: string; output: string | null; failed: boolean }
  /** A result whose call is on a page not loaded. */
  | { kind: 'result'; key: string; at: number; output: string; failed: boolean };

/** Fields that say what a call was about, most telling first. */
const SUMMARY_KEYS = [
  'command', 'file_path', 'notebook_path', 'path', 'pattern', 'url', 'query',
  'skill', 'subject', 'description', 'prompt',
] as const;
const SUMMARY_MAX = 300;

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX);

function fieldsOf(input: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A string field out of JSON the server cut short (no longer parseable as a whole). */
function fieldFromCut(input: string): string | null {
  for (const key of SUMMARY_KEYS) {
    const match = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(input);
    if (!match) continue;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return match[1];
    }
  }
  return null;
}

/** One line saying what a tool call did: its command, file, pattern, URL… */
export function summarizeToolCall(_tool: string, input: string): string {
  const fields = fieldsOf(input);
  if (!fields) return oneLine(fieldFromCut(input) ?? input);
  const str = (k: string) => (typeof fields[k] === 'string' && (fields[k] as string).trim() ? (fields[k] as string) : null);
  const pattern = str('pattern');
  const where = str('path');
  if (pattern && where) return oneLine(`${pattern} in ${where}`);
  for (const key of SUMMARY_KEYS) {
    const value = str(key);
    if (value) return oneLine(value);
  }
  const first = Object.values(fields).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  return oneLine(first ?? input);
}

/** A call's input to read: one `field: value` line per field, strings as they are (not JSON-escaped). */
export function formatToolInput(input: string): string {
  const fields = fieldsOf(input);
  if (!fields) return input;
  return Object.entries(fields)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

/**
 * Rows in order. A result joins its call (by call id; without ids, the oldest
 * unanswered call), so a call reads as one row that opens to input + output.
 * Keys belong to the entry, not its position: pages loaded above must not move
 * an opened row.
 */
export function buildMessageRows(entries: readonly ConversationEntry[]): MessageRow[] {
  const rows: MessageRow[] = [];
  const byCallId = new Map<string, number>();
  const unansweredWithoutId: number[] = [];
  const seen = new Map<string, number>();
  const keyFor = (base: string) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  const answer = (index: number, entry: Extract<ConversationEntry, { role: 'tool_result' }>) => {
    const row = rows[index];
    if (row.kind === 'tool') rows[index] = { ...row, output: entry.output, failed: entry.isError === true };
  };

  for (const entry of entries) {
    switch (entry.role) {
      case 'assistant':
        rows.push({ kind: 'reply', key: keyFor(`reply:${entry.timestamp}`), at: entry.timestamp, text: entry.text });
        break;
      case 'user':
        rows.push({
          kind: 'message', key: keyFor(`message:${entry.timestamp}`), at: entry.timestamp, text: entry.text,
          injected: entry.text.trimStart().startsWith('<'),
        });
        break;
      case 'tool_use': {
        const index = rows.length;
        rows.push({
          kind: 'tool', key: entry.id ? `tool:${entry.id}` : keyFor(`tool:${entry.timestamp}:${entry.tool}`), at: entry.timestamp,
          tool: entry.tool, summary: summarizeToolCall(entry.tool, entry.input), input: entry.input, output: null, failed: false,
        });
        if (entry.id) byCallId.set(entry.id, index);
        else unansweredWithoutId.push(index);
        break;
      }
      case 'tool_result': {
        const index = entry.toolUseId !== undefined ? byCallId.get(entry.toolUseId) : unansweredWithoutId.shift();
        if (index !== undefined) {
          answer(index, entry);
          if (entry.toolUseId !== undefined) byCallId.delete(entry.toolUseId);
        } else {
          rows.push({ kind: 'result', key: keyFor(`result:${entry.timestamp}`), at: entry.timestamp, output: entry.output, failed: entry.isError === true });
        }
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

/** The last thing the agent said: its answer, once it has finished. */
export function finalReply(entries: readonly ConversationEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.role === 'assistant') return entry.text;
  }
  return null;
}
