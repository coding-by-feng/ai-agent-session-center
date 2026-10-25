/**
 * @module contextBreakdown
 * What a Claude session's context window holds (Oct 22 2026), for the phone's Usage sheet.
 *
 * Claude's status line reports how full the window is, not what fills it. The transcript does
 * better: every API reply carries the request's `usage`, and input + cache read + cache creation is
 * the whole window at that request. So the first request after a compaction (or the session's start)
 * measures the fixed part plus what came before it, and each later request's growth is exactly what
 * that turn added: the previous reply, the tool results, the next prompt, the reminders. That growth
 * is split across the turn's content by size. Totals are measured; only the split within a turn is
 * an estimate.
 *
 * When the CLI logged its request shape (`api-request-shape`: the system prompt and the tool
 * definitions, written by some Claude Code builds), the fixed part splits into the tool definitions
 * (their size) and the rest (system prompt and memory); without it the fixed part is one row.
 *
 * A window can shrink (Claude clears old tool results, drops old thinking): the content read so far
 * is then scaled down so the kinds still add up to the window Claude reported.
 */
import { open, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { ContextBreakdown, ContextItem, ContextKind } from '../../src/types/chat.js';
import { parseRecord, readRange, splitLines } from './jsonlFile.js';
import { secretTouch } from './secretCalls.js';

/** Characters per token for sizing text Claude never measured for us (the tool definitions). */
export const CHARS_PER_TOKEN = 3.6;
/** An image block's size in characters: about 1.6k tokens, whatever its base64 length. */
const IMAGE_CHARS = 6_000;
const MAX_ITEMS = 5;
const MAX_LABEL_CHARS = 80;
/** Read back from the end in chunks this big, looking for the last compaction. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
/** The most of a transcript read for one breakdown. */
const MAX_WINDOW_BYTES = 96 * 1024 * 1024;
const BOUNDARY_MARK = Buffer.from('"compact_boundary"');
const CACHE_MAX = 32;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const FIXED_KINDS: ReadonlySet<ContextKind> = new Set(['system', 'tools', 'fixed']);

/** What a tool's result counts as. */
export function toolKindOf(name: string): ContextKind {
  if (name.startsWith('mcp__')) return 'mcp';
  switch (name) {
    case 'Read': case 'NotebookRead':
      return 'read';
    case 'Bash': case 'BashOutput': case 'KillShell': case 'Monitor':
      return 'bash';
    case 'Grep': case 'Glob': case 'LS': case 'ToolSearch':
      return 'search';
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit':
      return 'edits';
    case 'Agent': case 'Task':
      return 'subagents';
    case 'WebFetch': case 'WebSearch':
      return 'web';
    default:
      return 'otherTools';
  }
}

const clip = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > MAX_LABEL_CHARS ? `${one.slice(0, MAX_LABEL_CHARS - 1)}…` : one;
};

function shortPath(path: string, projectRoot: string | null | undefined): string {
  if (projectRoot && isAbsolute(projectRoot) && isAbsolute(path)) {
    const rel = relative(projectRoot, path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return path;
}

/** "Read · server/index.ts": what a tool call was about, never naming a secret file. */
function callLabel(name: string, input: unknown, projectRoot: string | null | undefined): string {
  const short = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name;
  if (secretTouch(input, projectRoot)) return `${short} · a secret file`;
  const i = isRec(input) ? input : {};
  const str = (key: string) => (typeof i[key] === 'string' && i[key] !== '' ? (i[key] as string) : null);
  const path = str('file_path') ?? str('notebook_path') ?? str('path');
  const target = path ? shortPath(path, projectRoot)
    : str('description') ?? str('command') ?? str('pattern') ?? str('query') ?? str('url') ?? str('prompt');
  return clip(target ? `${short} · ${target}` : short);
}

interface Block {
  kind: ContextKind;
  chars: number;
  /** Set for a block that is an item of its own (a tool result, a prompt, the summary). */
  item?: string;
}

/** The size of a tool result's or a message's content, in characters. */
function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const part of content) {
    if (!isRec(part)) continue;
    if (part.type === 'image') n += IMAGE_CHARS;
    else if (typeof part.text === 'string') n += part.text.length;
    else n += JSON.stringify(part).length;
  }
  return n;
}

/**
 * What Claude Code's attachments put in the window, by type, and the field holding it. The
 * others (`prompt_snapshot`, `hook_success`, `deferred_tools_record`, `thinking_drop`…) are its
 * own records, not model input: their size would steal a turn's growth from what was sent.
 */
const ATTACHMENTS: Readonly<Record<string, { kind: ContextKind; field: string; item?: string }>> = {
  instructions: { kind: 'memory', field: 'files', item: 'Memory · CLAUDE.md and rules' },
  skill_listing: { kind: 'skills', field: 'content', item: 'Skills list' },
  invoked_skills: { kind: 'skills', field: 'skills', item: 'Skills in use' },
  deferred_tools_delta: { kind: 'tools', field: 'addedLines' },
  agent_listing_delta: { kind: 'tools', field: 'addedLines' },
  mcp_instructions_delta: { kind: 'tools', field: 'addedBlocks' },
  file: { kind: 'read', field: 'content' },
  hook_additional_context: { kind: 'reminders', field: 'content' },
  hook_system_message: { kind: 'reminders', field: 'content' },
  session_context: { kind: 'reminders', field: 'context' },
  total_tokens_reminder: { kind: 'reminders', field: 'text' },
  silent_turn_reminder: { kind: 'reminders', field: 'text' },
  model: { kind: 'reminders', field: 'text' },
  environment: { kind: 'reminders', field: 'snapshot' },
  date: { kind: 'reminders', field: 'date' },
};

function attachmentBlock(attachment: unknown, projectRoot: string | null | undefined): Block | null {
  if (!isRec(attachment) || typeof attachment.type !== 'string') return null;
  const known = ATTACHMENTS[attachment.type];
  if (!known) return null;
  const value = attachment[known.field];
  const chars = typeof value === 'string' ? value.length : value === undefined ? 0 : JSON.stringify(value).length;
  if (chars === 0) return null;
  if (attachment.type === 'file') {
    const path = typeof attachment.filename === 'string' ? attachment.filename : '';
    return { kind: 'read', chars, item: path ? callLabel('File', { file_path: path }, projectRoot) : 'File' };
  }
  return { kind: known.kind, chars, ...(known.item ? { item: known.item } : {}) };
}

export interface MeasureOptions {
  /** The session's project: item paths are shown relative to it, and secret files are judged in it. */
  projectRoot?: string | null;
}

/**
 * What the window holds, from a Claude transcript's records (oldest first). The window starts after
 * the last `compact_boundary`. Null when no request was made in it.
 */
export function measureContext(records: readonly unknown[], opts: MeasureOptions = {}): ContextBreakdown | null {
  let start = 0;
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (isRec(r) && r.type === 'system' && r.subtype === 'compact_boundary') { start = i + 1; break; }
  }
  const sinceCompaction = start > 0;

  const totals = new Map<ContextKind, number>();
  const items = new Map<string, ContextItem>();
  const calls = new Map<string, { name: string; input: unknown }>();
  let pending: Block[] = [];
  let shape: { toolsChars: number } | null = null;
  let window: number | null = null;
  let requests = 0;
  let measuredAt = 0;
  let replyId: string | null = null;
  let itemSeq = 0;

  const add = (kind: ContextKind, tokens: number, item?: string) => {
    if (tokens <= 0) return;
    totals.set(kind, (totals.get(kind) ?? 0) + tokens);
    if (item) {
      const key = `${itemSeq++}`;
      items.set(key, { kind, label: item, tokens });
    }
  };
  const fixedTotal = () => [...totals].reduce((n, [k, v]) => (FIXED_KINDS.has(k) ? n + v : n), 0);
  const allTotal = () => [...totals.values()].reduce((n, v) => n + v, 0);
  /** Scale what was read (the content, or everything when the window is smaller than the fixed part) to `target`. */
  const scaleTo = (target: number) => {
    const fixed = fixedTotal();
    const all = allTotal();
    if (all === target || all === 0) return;
    const onlyContent = target >= fixed && all > fixed;
    const factor = onlyContent ? (target - fixed) / (all - fixed) : target / all;
    for (const [k, v] of totals) if (!onlyContent || !FIXED_KINDS.has(k)) totals.set(k, v * factor);
    for (const item of items.values()) item.tokens *= factor;
  };

  /** A request was made with this window: account for everything added since the last one. */
  const request = (size: number) => {
    const chars = pending.reduce((n, b) => n + b.chars, 0);
    if (window === null) {
      // The first request: the content before it is sized by its length, and the rest of the
      // window is what every request carries (system prompt, tools, memory).
      const content = Math.min(size, chars / CHARS_PER_TOKEN);
      for (const b of pending) add(b.kind, chars > 0 ? (content * b.chars) / chars : 0, b.item);
      const fixed = size - content;
      if (shape) {
        const tools = Math.min(fixed, shape.toolsChars / CHARS_PER_TOKEN);
        add('tools', tools);
        add('system', fixed - tools);
      } else {
        add('fixed', fixed);
      }
    } else {
      const grew = size - window;
      if (grew > 0 && chars > 0) {
        for (const b of pending) add(b.kind, (grew * b.chars) / chars, b.item);
      } else if (grew > 0) {
        add('reminders', grew); // added, but nothing in the transcript shows what
      } else {
        for (const b of pending) add(b.kind, b.chars / CHARS_PER_TOKEN, b.item);
      }
      scaleTo(size);
    }
    window = size;
    pending = [];
  };

  for (let i = start; i < records.length; i++) {
    const r = records[i];
    if (!isRec(r) || r.isSidechain === true) continue;
    if (r.type === 'api-request-shape' && isRec(r.shape)) {
      const tools = r.shape.tools;
      shape = { toolsChars: Array.isArray(tools) ? JSON.stringify(tools).length : 0 };
      continue;
    }
    if (r.type === 'attachment') {
      const block = attachmentBlock(r.attachment, opts.projectRoot);
      if (block) pending.push(block);
      continue;
    }
    const message = isRec(r.message) ? r.message : null;
    if (!message) continue;

    if (r.type === 'assistant') {
      const id = typeof message.id === 'string' ? message.id : null;
      const u = isRec(message.usage) ? message.usage : null;
      if (id && id !== replyId && u) {
        replyId = id;
        const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
        const size = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
        if (size > 0) {
          request(size);
          requests += 1;
          const t = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
          if (Number.isFinite(t)) measuredAt = t;
        }
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isRec(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string') pending.push({ kind: 'replies', chars: block.text.length });
        else if (block.type === 'thinking' && typeof block.thinking === 'string') pending.push({ kind: 'replies', chars: block.thinking.length });
        else if (block.type === 'tool_use') {
          const name = typeof block.name === 'string' ? block.name : 'Tool';
          if (typeof block.id === 'string') calls.set(block.id, { name, input: block.input });
          pending.push({ kind: 'toolCalls', chars: JSON.stringify(block.input ?? {}).length + name.length });
        }
      }
      continue;
    }

    if (r.type === 'user') {
      const content = message.content;
      if (typeof content === 'string') {
        if (r.isCompactSummary === true) pending.push({ kind: 'summary', chars: content.length, item: 'Compaction summary' });
        else if (r.isMeta === true) pending.push({ kind: 'reminders', chars: content.length });
        else pending.push({ kind: 'prompts', chars: content.length, item: clip(`Prompt · ${content}`) });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!isRec(part)) continue;
        if (part.type === 'tool_result') {
          const call = typeof part.tool_use_id === 'string' ? calls.get(part.tool_use_id) : undefined;
          const name = call?.name ?? 'Tool';
          pending.push({
            kind: toolKindOf(name),
            chars: contentChars(part.content),
            item: callLabel(name, call?.input, opts.projectRoot),
          });
        } else if (part.type === 'image') {
          pending.push({ kind: 'prompts', chars: IMAGE_CHARS });
        } else if (typeof part.text === 'string') {
          pending.push({ kind: r.isMeta === true ? 'reminders' : 'prompts', chars: part.text.length });
        }
      }
    }
  }

  if (window === null) return null;
  const tokens: number = window;
  const kinds = [...totals]
    .map(([kind, v]) => ({ kind, tokens: Math.round(v) }))
    .filter((k) => k.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  // Rounding must not break the sum: the difference goes to the largest kind.
  const drift = tokens - kinds.reduce((n, k) => n + k.tokens, 0);
  if (kinds.length > 0) kinds[0] = { ...kinds[0], tokens: kinds[0].tokens + drift };
  const top = [...items.values()]
    .map((item) => ({ ...item, tokens: Math.round(item.tokens) }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_ITEMS);
  return { tokens, kinds, items: top, requests, sinceCompaction, measuredAt };
}

/** Where the last compaction's line starts, or 0. Reads back from the end in chunks. */
async function windowStart(fh: Awaited<ReturnType<typeof open>>, size: number): Promise<number> {
  const floor = Math.max(0, size - MAX_WINDOW_BYTES);
  let end = size;
  while (end > floor) {
    const from = Math.max(floor, end - SCAN_CHUNK_BYTES);
    // Overlap by the mark's length, so a mark split across two chunks is still seen.
    const buf = await readRange(fh, from, Math.min(size, end + BOUNDARY_MARK.length));
    const hit = buf.lastIndexOf(BOUNDARY_MARK);
    if (hit >= 0) {
      const lineStart = buf.lastIndexOf(0x0a, hit);
      if (lineStart >= 0) return from + lineStart + 1;
      if (from === 0) return 0;
      // The line began in the chunk before: find its start there.
      const before = await readRange(fh, Math.max(0, from - SCAN_CHUNK_BYTES), from);
      const nl = before.lastIndexOf(0x0a);
      return nl >= 0 ? from - before.length + nl + 1 : Math.max(0, from - before.length);
    }
    end = from;
  }
  return floor;
}

const cache = new Map<string, { size: number; mtimeMs: number; result: ContextBreakdown | null }>();

/** Forget remembered breakdowns (tests). */
export function resetContextBreakdownCache(): void {
  cache.clear();
}

/** The breakdown of the Claude transcript at `path`, or null (no file, no request yet). */
export async function readContextBreakdown(path: string, opts: MeasureOptions = {}): Promise<ContextBreakdown | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  const key = `${path}\0${opts.projectRoot ?? ''}`;
  const hit = cache.get(key);
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.result;

  const fh = await open(path, 'r');
  let result: ContextBreakdown | null;
  try {
    const from = await windowStart(fh, info.size);
    const buf = await readRange(fh, from, info.size);
    const records = splitLines(buf, from, true).filter((l) => l.complete).map((l) => parseRecord(l.text));
    result = measureContext(records, opts);
  } finally {
    await fh.close();
  }
  cache.delete(key);
  cache.set(key, { size: info.size, mtimeMs: info.mtimeMs, result });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return result;
}
