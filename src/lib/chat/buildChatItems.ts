/**
 * buildChatItems.ts — the phone chat's rows (AASC-41), from a session's transcript
 * entries (src/types/chat.ts) and its queue. Pure, so it is tested on Claude and
 * Codex streams alike.
 *
 *   user           your prompt (a bubble; images counted)
 *   assistant      the agent's text, whole: never shortened or summarised
 *   thinking       "Thought for 12 s" (back-to-back blocks merged; the text is never sent)
 *   tool           one call paired with its result: "Ran npm test ✓ 0:42"
 *   tool-group     two or more consecutive finished calls: "Read 3 files, ran 2 commands"
 *   todo           a plan update; the newest one is the card
 *   subagent       a subagent card with its report once it came back
 *   command        a slash command you ran, with what it printed
 *   divider        a session event: compacted, stopped, model, resumed, background task, context
 *   notice         a notice from the CLI (an API error, a warning)
 *   queued         a prompt waiting in this session's queue, dimmed, at the end
 *
 * Folding (§6.2 of the redesign): only tool calls fold, never prose. A call that
 * failed, is still open, has no result, edits a file, proposes a plan or asks you
 * something stands on its own row, so failures and edits are always visible;
 * thinking between folded calls folds with them.
 *
 * Every item has a `key` (stable across pages and refreshes: its first entry's key; a
 * group's is `group:<first call's key>`, distinct from the call's own),
 * a `sig` (changes only when the row would draw differently, for memoised rows) and
 * `searchText` (what search matches: one predicate for the count, the highlight and the
 * step order, textHighlight.ts).
 */
import type {
  ChatEntry,
  ChatSystemKind,
  ChatTodoItem,
  ChatToolResultEntry,
  ChatToolUseEntry,
} from '@/types/chat';
import { matchesQuery, normalizeQuery } from '@/lib/textHighlight';
import { describeTool, groupSummary, toolCategory, type ToolCategory } from './toolSummary';
import { isEditTool } from './editDiff';

export type ToolStatus = 'running' | 'waiting' | 'done' | 'failed' | 'no-result';

/** What a phone shows for output that came from a secret file (server/mobile/phoneChatFilter.ts). */
export const HIDDEN_ON_PHONES = '[Hidden on phones: this touched a secret file]';

export interface ToolResult {
  isError: boolean;
  output: string;
  truncated: boolean;
  at: number;
  /** The server marked it: its call touched a secret file. */
  secret?: boolean;
}

/**
 * The server's marks on a call or result that touched a secret file (src/types/chat.ts,
 * `secret`): only marks, for the Mac and the phone alike. Read loosely so an entry
 * from a server without them simply has none.
 */
type SecretMark = { secret?: unknown };
const markedSecret = (entry: object): boolean => (entry as SecretMark).secret === true;

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
  inputTruncated: boolean;
  startedAt: number;
  result: ToolResult | null;
  status: ToolStatus;
  category: ToolCategory;
  verb: string;
  target: string;
  /** The target is a command, path or pattern (drawn in monospace). */
  mono: boolean;
  meta: string;
  command: string | null;
  path: string | null;
  durationMs?: number;
  /** A phone sees a secret file's call without its content. */
  redacted: boolean;
  /** It touched a secret file (marked by the server, or redacted for this phone): drawn with a lock. */
  secret: boolean;
}

interface ItemBase {
  key: string;
  timestamp: number;
  sig: string;
  searchText: string;
}

export interface UserItem extends ItemBase { kind: 'user'; text: string; images: number; truncated: boolean }
export interface AssistantItem extends ItemBase {
  kind: 'assistant'; text: string; truncated: boolean; isAnswer: boolean;
  /** The newest answer in the chat: the one whose actions show without a tap (Oct 20 2026). */
  latestAnswer: boolean;
}
export interface ThinkingItem extends ItemBase { kind: 'thinking'; length: number; durationMs?: number }
export interface ToolItem extends ItemBase { kind: 'tool'; call: ToolCall }
export interface ToolGroupItem extends ItemBase {
  kind: 'tool-group';
  /** The folded calls, in order, with any thinking between them. */
  members: Array<ToolItem | ThinkingItem>;
  calls: ToolItem[];
  summary: string;
}
export interface TodoItem extends ItemBase { kind: 'todo'; items: ChatTodoItem[]; done: number; total: number; latest: boolean }
export type SubagentStatus = 'running' | 'done' | 'failed' | 'no-report';
export interface SubagentItem extends ItemBase {
  kind: 'subagent';
  id: string;
  description: string;
  agentType?: string;
  prompt: string;
  background: boolean;
  truncated: boolean;
  report: ToolResult | null;
  status: SubagentStatus;
}
export interface CommandItem extends ItemBase { kind: 'command'; name: string; args?: string; output?: string }
export interface DividerItem extends ItemBase { kind: 'divider'; system: ChatSystemKind; label: string; text?: string }
export interface NoticeItem extends ItemBase { kind: 'notice'; label: string; text: string }
export interface QueuedItem extends ItemBase { kind: 'queued'; itemId: number; text: string; images: number; order: number }

export type ChatItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | ToolGroupItem
  | TodoItem
  | SubagentItem
  | CommandItem
  | DividerItem
  | NoticeItem
  | QueuedItem;

/** What the builder reads of a queue item (src/stores/queueStore.ts QueueItem). */
export interface QueueLike {
  id: number;
  text: string;
  position: number;
  images?: readonly unknown[];
  type?: string;
  disabled?: boolean;
}

export interface BuildOptions {
  /** The session is working (or waiting on you): a trailing call without a result is still open, not cut off. */
  live?: boolean;
  /** The session waits for your approval or answer: its open call is waiting, not running. */
  awaiting?: boolean;
  queue?: readonly QueueLike[];
}

// ── Pairing ──────────────────────────────────────────────────────────────────

function resultOf(entry: ChatToolResultEntry | undefined): ToolResult | null {
  if (!entry) return null;
  return { isError: entry.isError, output: entry.output, truncated: entry.truncated, at: entry.timestamp, ...(markedSecret(entry) ? { secret: true } : {}) };
}

function isRedacted(input: unknown): boolean {
  return !!input && typeof input === 'object' && (input as { redacted?: unknown }).redacted === true;
}

function toolItem(entry: ChatToolUseEntry, raw: ToolResult | null, open: ToolStatus | null): ToolItem {
  const redacted = isRedacted(entry.input);
  const secret = redacted || markedSecret(entry) || !!raw?.secret;
  // A backstop for the server's filter: a call redacted for this phone never shows its
  // output here, even when its result arrived on another page than the call. Keyed on
  // the redacted input, not the `secret` mark: the Mac gets the mark with the content.
  const result = raw && redacted ? { ...raw, output: HIDDEN_ON_PHONES, truncated: false } : raw;
  const described = describeTool(entry.name, entry.input, result?.output);
  const status: ToolStatus = result ? (result.isError ? 'failed' : 'done') : open ?? 'no-result';
  const durationMs = result && result.at > entry.timestamp ? result.at - entry.timestamp : undefined;
  const call: ToolCall = {
    id: entry.id,
    name: entry.name,
    input: entry.input,
    inputTruncated: !!entry.inputTruncated,
    startedAt: entry.timestamp,
    result,
    status,
    category: toolCategory(entry.name),
    ...described,
    ...(durationMs !== undefined ? { durationMs } : {}),
    redacted,
    secret,
  };
  return {
    kind: 'tool',
    key: entry.key,
    timestamp: entry.timestamp,
    call,
    sig: `${status}|${result?.output.length ?? 0}|${described.meta}`,
    searchText: [described.verb, described.target, described.meta, described.command, described.path, result?.output]
      .filter(Boolean)
      .join('\n'),
  };
}

// ── Dividers ─────────────────────────────────────────────────────────────────

function dividerLabel(system: ChatSystemKind, label?: string): string {
  switch (system) {
    case 'compacted': return label ? `Context compacted · ${label}` : 'Context compacted';
    case 'cancelled': return 'You stopped this turn';
    case 'model': return label ? `Model · ${label}` : 'Model changed';
    case 'resumed': return 'Session resumed';
    case 'notification': return label ? `Background task · ${label}` : 'Background task reported';
    case 'context': return label ? `Added context · ${label}` : 'Added context';
    default: return label ?? 'Notice';
  }
}

// ── The first pass: one row per entry (tools paired, thinking merged) ────────

type Flat = Exclude<ChatItem, ToolGroupItem | QueuedItem>;

function flatten(entries: readonly ChatEntry[], live: boolean, awaiting: boolean): Flat[] {
  const results = new Map<string, ChatToolResultEntry>();
  let lastTurnStart = 0;
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    if (e.kind === 'tool_result') results.set(e.toolUseId, e);
    else if (e.kind === 'user' || e.kind === 'assistant') lastTurnStart = i;
  }

  const out: Flat[] = [];
  let lastModel: string | null = null;
  entries.forEach((e, index) => {
    const prev = out[out.length - 1];
    switch (e.kind) {
      case 'user':
        out.push({ kind: 'user', key: e.key, timestamp: e.timestamp, text: e.text, images: e.images ?? 0, truncated: !!e.truncated, sig: '', searchText: e.text });
        break;
      case 'assistant':
        out.push({ kind: 'assistant', key: e.key, timestamp: e.timestamp, text: e.text, truncated: !!e.truncated, isAnswer: false, latestAnswer: false, sig: '', searchText: e.text });
        break;
      case 'thinking': {
        if (prev?.kind === 'thinking') {
          const durationMs = (prev.durationMs ?? 0) + (e.durationMs ?? 0);
          out[out.length - 1] = { ...prev, length: prev.length + e.length, ...(durationMs > 0 ? { durationMs } : {}) };
        } else {
          out.push({ kind: 'thinking', key: e.key, timestamp: e.timestamp, length: e.length, ...(e.durationMs ? { durationMs: e.durationMs } : {}), sig: '', searchText: '' });
        }
        break;
      }
      case 'tool_use': {
        const result = resultOf(results.get(e.id));
        // Open only at the live end of the transcript: an older call without a result was cut off.
        const open = live && !result && index >= lastTurnStart ? (awaiting ? 'waiting' : 'running') : null;
        out.push(toolItem(e, result, open));
        break;
      }
      case 'todo': {
        const done = e.items.filter((t) => t.status === 'completed').length;
        out.push({ kind: 'todo', key: e.key, timestamp: e.timestamp, items: e.items, done, total: e.items.length, latest: false, sig: '', searchText: e.items.map((t) => t.text).join('\n') });
        break;
      }
      case 'subagent': {
        const report = resultOf(results.get(e.id));
        const status: SubagentStatus = report ? (report.isError ? 'failed' : 'done') : live ? 'running' : 'no-report';
        out.push({
          kind: 'subagent',
          key: e.key,
          timestamp: e.timestamp,
          id: e.id,
          description: e.description,
          ...(e.agentType ? { agentType: e.agentType } : {}),
          prompt: e.prompt,
          background: !!e.background,
          truncated: !!e.truncated,
          report,
          status,
          sig: `${status}|${report?.output.length ?? 0}`,
          searchText: [e.description, e.agentType, e.prompt, report?.output].filter(Boolean).join('\n'),
        });
        break;
      }
      case 'command':
        out.push({ kind: 'command', key: e.key, timestamp: e.timestamp, name: e.name, ...(e.args ? { args: e.args } : {}), ...(e.output !== undefined ? { output: e.output } : {}), sig: '', searchText: [e.name, e.args, e.output].filter(Boolean).join('\n') });
        break;
      case 'system': {
        if (e.system === 'info') {
          out.push({ kind: 'notice', key: e.key, timestamp: e.timestamp, label: e.label ?? 'Notice', text: e.text ?? '', sig: '', searchText: [e.label, e.text].filter(Boolean).join('\n') });
          break;
        }
        if (e.system === 'model') {
          // Codex writes one per turn: a row equal to the one before it is noise.
          if (e.label && e.label === lastModel) break;
          lastModel = e.label ?? null;
        }
        if (e.system === 'context' && prev?.kind === 'divider' && prev.system === 'context') {
          const label = [prev.label.replace(/^Added context · /, ''), e.label].filter(Boolean).join(', ');
          const text = [prev.text, e.text].filter(Boolean).join('\n\n');
          out[out.length - 1] = { ...prev, label: `Added context · ${label}`, ...(text ? { text } : {}), searchText: label };
          break;
        }
        const label = dividerLabel(e.system, e.label);
        out.push({ kind: 'divider', key: e.key, timestamp: e.timestamp, system: e.system, label, ...(e.text ? { text: e.text } : {}), sig: '', searchText: label });
        break;
      }
      default:
        break; // tool_result (paired above) and kinds this client doesn't know
    }
  });
  return out;
}

// ── The second pass: fold runs of finished calls ─────────────────────────────

/** Calls that carry words for you (a proposed plan, a question) are never folded away. */
const NEVER_FOLDED: ReadonlySet<string> = new Set(['ExitPlanMode', 'AskUserQuestion']);

const foldable = (item: Flat): boolean =>
  item.kind === 'thinking'
  || (item.kind === 'tool' && item.call.status === 'done' && !isEditTool(item.call.name) && !NEVER_FOLDED.has(item.call.name));

function fold(flat: Flat[]): ChatItem[] {
  const out: ChatItem[] = [];
  let run: Array<ToolItem | ThinkingItem> = [];
  const flush = () => {
    const calls = run.filter((m): m is ToolItem => m.kind === 'tool');
    if (calls.length >= 2) {
      // Thinking before the first call or after the last stays outside the fold.
      const first = run.indexOf(calls[0]);
      const last = run.indexOf(calls[calls.length - 1]);
      out.push(...run.slice(0, first));
      const members = run.slice(first, last + 1);
      out.push({
        kind: 'tool-group',
        // Its own key, never its first call's: the chat keeps each row's open state by key.
        key: `group:${calls[0].key}`,
        timestamp: calls[0].timestamp,
        members,
        calls,
        summary: groupSummary(calls.map((c) => c.call.category)),
        sig: members.map((m) => `${m.key}:${m.sig}`).join(','),
        searchText: calls.map((c) => c.searchText).join('\n'),
      });
      out.push(...run.slice(last + 1));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const item of flat) {
    if (foldable(item)) {
      run.push(item as ToolItem | ThinkingItem);
    } else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

// ── Finishing touches: answers, the latest plan, signatures, the queue ───────

function finish(items: ChatItem[], live: boolean): ChatItem[] {
  let latestTodo = -1;
  // A turn still under way has no answer yet: its last reply so far isn't one.
  let answerSeen = live;
  let latestMarked = false;
  const out = items.slice();
  for (let i = out.length - 1; i >= 0; i -= 1) {
    const item = out[i];
    if (item.kind === 'todo' && latestTodo < 0) latestTodo = i;
    if (item.kind === 'user') answerSeen = false;
    if (item.kind === 'assistant' && !answerSeen) {
      answerSeen = true;
      out[i] = { ...item, isAnswer: true, latestAnswer: !latestMarked };
      latestMarked = true;
    }
  }
  if (latestTodo >= 0) out[latestTodo] = { ...(out[latestTodo] as TodoItem), latest: true };
  return out.map((item) => {
    if (item.kind === 'tool' || item.kind === 'tool-group' || item.kind === 'subagent') return item;
    if (item.kind === 'todo') return { ...item, sig: `${item.latest}|${item.done}/${item.total}` };
    if (item.kind === 'assistant') return { ...item, sig: `${item.isAnswer}|${item.latestAnswer}|${item.text.length}` };
    if (item.kind === 'thinking') return { ...item, sig: `${item.length}|${item.durationMs ?? 0}` };
    if (item.kind === 'divider') return { ...item, sig: item.label };
    return { ...item, sig: item.key };
  });
}

function queued(queue: readonly QueueLike[]): QueuedItem[] {
  return queue
    .filter((q) => (q.type ?? 'once') === 'once' && !q.disabled)
    .sort((a, b) => a.position - b.position)
    .map((q, i) => ({
      kind: 'queued',
      key: `queued:${q.id}`,
      timestamp: 0,
      itemId: q.id,
      text: q.text,
      images: q.images?.length ?? 0,
      order: i + 1,
      sig: `${i + 1}|${q.images?.length ?? 0}|${q.text}`,
      searchText: q.text,
    }));
}

export function buildChatItems(entries: readonly ChatEntry[], options: BuildOptions = {}): ChatItem[] {
  const items = finish(fold(flatten(entries, !!options.live, !!options.awaiting)), !!options.live && !options.awaiting);
  return options.queue?.length ? [...items, ...queued(options.queue)] : items;
}

/** Keys of the items matching `query`, in order (case-insensitive; a blank query matches none). */
export function findMatches(items: readonly ChatItem[], query: string): string[] {
  const q = normalizeQuery(query);
  if (!q) return [];
  return items.filter((item) => matchesQuery(item.searchText, q)).map((item) => item.key);
}
