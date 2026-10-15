/**
 * @module chatEntries
 * What the Claude and Codex readers share when they turn a transcript record into chat entries
 * (`src/types/chat.ts`): the caps, cutting text and tool inputs to them, and the edit tools whose
 * input is kept whole so the chat and the Changes view can draw diffs from it.
 */
import type { ChatEntry, ChatTodoItem } from '../../src/types/chat.js';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry before the pager gives it its key (`<line offset>:<index>`) and its record's time. */
export type ChatEntryDraft = DistributiveOmit<ChatEntry, 'key' | 'timestamp'>;

/** Characters of user, assistant, command or system text per entry. */
export const TEXT_CAP = 16 * 1024;
/** Characters of a tool's input (as JSON). */
export const TOOL_INPUT_CAP = 2 * 1024;
/** Characters of an edit tool's input: whole, so diffs can be drawn from it. */
export const EDIT_INPUT_CAP = 64 * 1024;
/** Characters of a tool's output. */
export const TOOL_OUTPUT_CAP = 4 * 1024;

/** Tools whose input is an edit (Claude's, and Codex's patch tool). */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);

/** The cap for a tool's input. */
export const toolInputCap = (name: string): number => (EDIT_TOOLS.has(name) ? EDIT_INPUT_CAP : TOOL_INPUT_CAP);

/** `text` cut to `max` characters, never between the halves of a surrogate pair. */
export function cut(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** `{ text }` plus `truncated: true` when it had to be cut. */
export function cappedText(text: string, max = TEXT_CAP): { text: string; truncated?: true } {
  const c = cut(text, max);
  return c.truncated ? { text: c.text, truncated: true } : { text: c.text };
}

function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Infinity;
  }
}

/** `value` with every string longer than `limit` cut to it. */
function withStringsCut(value: unknown, limit: number, depth = 0): unknown {
  if (typeof value === 'string') return cut(value, limit).text;
  if (depth > 20 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => withStringsCut(v, limit, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withStringsCut(v, limit, depth + 1)]));
}

/**
 * A tool input within `max` characters of JSON. Under the cap it is returned as it was; over it, its
 * long strings are cut (shortest cut that fits, down to 64 characters each) so the client still gets
 * the input's shape; when even that doesn't fit, a cut JSON string.
 */
export function capInput(value: unknown, max: number): { input: unknown; truncated: boolean } {
  if (jsonLength(value) <= max) return { input: value, truncated: false };
  for (let limit = Math.floor(max / 2); limit >= 64; limit = Math.floor(limit / 2)) {
    const smaller = withStringsCut(value, limit);
    if (jsonLength(smaller) <= max) return { input: smaller, truncated: true };
  }
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  } catch {
    raw = String(value);
  }
  return { input: cut(raw, max).text, truncated: true };
}

/** A tool_use draft with its input capped for its tool. */
export function toolUseDraft(id: string, name: string, input: unknown): ChatEntryDraft {
  const capped = capInput(input, toolInputCap(name));
  return { kind: 'tool_use', id, name, input: capped.input, ...(capped.truncated ? { inputTruncated: true } : {}) };
}

/** A tool_result draft with its output capped. */
export function toolResultDraft(toolUseId: string, output: string, isError: boolean): ChatEntryDraft {
  const c = cut(output, TOOL_OUTPUT_CAP);
  return { kind: 'tool_result', toolUseId, isError, output: c.text, truncated: c.truncated };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** To-do items from a list of `{ <textKey>, status }` records; anything else is skipped. */
export function todoItems(list: unknown, textKey: string): ChatTodoItem[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => ({ text: cut(str(t[textKey]), TEXT_CAP).text, status: str(t.status) || 'pending' }));
}

/**
 * Slash-command output that arrived as its own record attaches to the command just before it, as
 * the CLI shows it; output with no command before it in the page becomes a `system` notice.
 */
export function foldCommandOutput(entries: ChatEntry[]): ChatEntry[] {
  const out: ChatEntry[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'command' || entry.name !== '') {
      out.push(entry);
      continue;
    }
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'command' && prev.name !== '' && prev.output === undefined) {
      out[out.length - 1] = { ...prev, ...(entry.output !== undefined ? { output: entry.output } : {}) };
      continue;
    }
    if (entry.output === undefined) continue;
    out.push({ kind: 'system', system: 'info', label: 'command output', text: entry.output, key: entry.key, timestamp: entry.timestamp });
  }
  return out;
}
