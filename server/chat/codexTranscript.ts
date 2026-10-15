/**
 * @module codexTranscript
 * A Codex rollout (`$CODEX_HOME/sessions/…/rollout-<started>-<id>.jsonl`) as chat entries (AASC-41).
 *
 * Each line is `{ timestamp, type, payload }`. What a chat shows:
 *   response_item  message (user / assistant; developer = system prompt, skipped), reasoning,
 *                  function_call + function_call_output, custom_tool_call + custom_tool_call_output
 *                  (`apply_patch` carries a patch; `exec` runs a script)
 *   turn_context   the model and effort of a turn
 *   compacted      the context was compacted
 *   session_meta   the rollout's header; one further down means the session was resumed
 *   event_msg      mostly echoes of the response items (user and agent messages, command items,
 *                  token counts), skipped; except `turn_aborted` (a cancel) and an `item_completed`
 *                  FileChange, which is the only record of an edit made from inside an `exec` script
 *
 * Codex puts harness text into user turns too (AGENTS.md, `<environment_context>`, skill bodies);
 * those become `system` context entries.
 */
import type { ChatSystemKind } from '../../src/types/chat.js';
import { capName, cappedText, todoItems, toolResultDraft, toolUseDraft, type ChatEntryDraft } from './chatEntries.js';
import { readChatPage, type LineReader, type PageOptions, type TranscriptPage } from './transcriptPager.js';
import type { RawCall } from './secretMarks.js';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A user-turn block that is harness text: an XML-ish tag or the AGENTS.md heading at its start. */
const RE_CONTEXT_TAG = /^\s*<([A-Za-z][\w-]*)[\s>]/;
const RE_AGENTS_MD = /^\s*#\s*AGENTS\.md\b/;
/** The `<image …>` / `</image>` wrappers around an attached image. */
const RE_IMAGE_WRAPPER = /^\s*<\/?image\b[^>]*>\s*$/;
/** The status line an `exec` script's output starts with. */
const RE_SCRIPT_FAILED = /^\s*Script failed\b/;

function system(kind: ChatSystemKind, label?: string, text?: string): ChatEntryDraft {
  return { kind: 'system', system: kind, ...(label ? { label: capName(label) } : {}), ...(text !== undefined ? cappedText(text) : {}) };
}

function contextLabel(text: string): string | null {
  if (RE_AGENTS_MD.test(text)) return 'AGENTS.md';
  return RE_CONTEXT_TAG.exec(text)?.[1] ?? null;
}

function userMessage(content: unknown): ChatEntryDraft[] {
  if (!Array.isArray(content)) return [];
  const out: ChatEntryDraft[] = [];
  const typed: string[] = [];
  let images = 0;
  for (const block of content) {
    if (!isRec(block)) continue;
    if (block.type === 'input_image') {
      images += 1;
      continue;
    }
    const text = str(block.text);
    if (!text.trim() || RE_IMAGE_WRAPPER.test(text)) continue;
    const label = contextLabel(text);
    if (label) out.push(system('context', label, text));
    else typed.push(text);
  }
  if (typed.length > 0 || images > 0) {
    out.push({ kind: 'user', ...cappedText(typed.join('\n')), ...(images > 0 ? { images } : {}) });
  }
  return out;
}

function assistantMessage(content: unknown): ChatEntryDraft[] {
  if (!Array.isArray(content)) return [];
  const text = content.filter(isRec).map((b) => str(b.text)).filter((t) => t.trim()).join('\n');
  return text ? [{ kind: 'assistant', ...cappedText(text) }] : [];
}

/** A function call's arguments: parsed JSON, or the raw value when it isn't JSON. */
export function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** The patch of a shell call that runs `apply_patch` (older Codex), or null. */
export function shellPatch(args: unknown): string | null {
  const command = isRec(args) ? args.command : undefined;
  if (!Array.isArray(command) || command.length < 2) return null;
  return command[0] === 'apply_patch' && typeof command[1] === 'string' ? command[1] : null;
}

function functionCall(p: Rec): ChatEntryDraft {
  const id = str(p.call_id);
  const name = str(p.name) || 'tool';
  const args = parseArgs(p.arguments);
  if (name === 'update_plan' && isRec(args)) return { kind: 'todo', id: capName(id), items: todoItems(args.plan, 'step') };
  if (name === 'spawn_agent' && isRec(args)) {
    const prompt = cappedText(str(args.message));
    return {
      kind: 'subagent',
      id: capName(id),
      description: capName(str(args.task_name)),
      prompt: prompt.text,
      ...(prompt.truncated ? { truncated: true } : {}),
    };
  }
  const patch = shellPatch(args);
  return patch !== null ? toolUseDraft(id, 'apply_patch', patch) : toolUseDraft(id, name, args);
}

/** Text of a list of content blocks; an image is `[image]` (its data URL is never sent). */
function blocksText(blocks: unknown[]): string {
  return blocks
    .filter(isRec)
    .map((b) => (b.type === 'input_image' || b.type === 'image' ? '[image]' : str(b.text)))
    .join('\n');
}

/** A tool output's text and whether it failed, from the shapes Codex has written. */
export function toolOutput(output: unknown): { text: string; isError: boolean } {
  if (Array.isArray(output)) {
    const text = blocksText(output);
    return { text, isError: RE_SCRIPT_FAILED.test(text) };
  }
  if (isRec(output)) {
    const content = output.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? blocksText(content) : JSON.stringify(output);
    return { text, isError: output.success === false };
  }
  const raw = str(output);
  const parsed = raw.startsWith('{') ? parseArgs(raw) : null;
  if (isRec(parsed) && typeof parsed.output === 'string' && isRec(parsed.metadata)) {
    const code = parsed.metadata.exit_code;
    return { text: parsed.output, isError: typeof code === 'number' && code !== 0 };
  }
  return { text: raw, isError: RE_SCRIPT_FAILED.test(raw) };
}

function responseItem(p: Rec): ChatEntryDraft[] {
  switch (p.type) {
    case 'message':
      if (p.role === 'user') return userMessage(p.content);
      if (p.role === 'assistant') return assistantMessage(p.content);
      return [];
    case 'reasoning': {
      // How much, never what: only the summary's length, and nothing of the encrypted content.
      const summary = Array.isArray(p.summary) ? p.summary.filter(isRec).map((s) => str(s.text)).join('') : '';
      return [{ kind: 'thinking', length: summary.length }];
    }
    case 'function_call':
      return [functionCall(p)];
    case 'custom_tool_call':
      return [toolUseDraft(str(p.call_id), str(p.name) || 'tool', str(p.input))];
    case 'local_shell_call':
      return [toolUseDraft(str(p.call_id) || str(p.id), 'shell', p.action)];
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const out = toolOutput(p.output);
      return [toolResultDraft(str(p.call_id), out.text, out.isError)];
    }
    default:
      return [];
  }
}

function eventMsg(p: Rec): ChatEntryDraft[] {
  if (p.type === 'turn_aborted') return [system('cancelled')];
  if (p.type !== 'item_completed' || !isRec(p.item) || p.item.type !== 'FileChange') return [];
  const item = p.item;
  const id = str(item.id);
  const failed = item.status !== 'completed';
  const output = (failed && str(item.stderr)) || str(item.stdout) || str(item.stderr) || str(item.status);
  return [
    toolUseDraft(id, 'apply_patch', { changes: isRec(item.changes) ? item.changes : {} }),
    toolResultDraft(id, output, failed),
  ];
}

/** The chat entries one parsed rollout record holds. `offset`: where its line starts. */
export function codexRecordEntries(record: unknown, offset: number): ChatEntryDraft[] {
  if (!isRec(record) || !isRec(record.payload)) return [];
  const p = record.payload;
  switch (record.type) {
    case 'response_item':
      return responseItem(p);
    case 'event_msg':
      return eventMsg(p);
    case 'turn_context': {
      const label = [str(p.model), str(p.effort)].filter(Boolean).join(' · ');
      return label ? [system('model', label)] : [];
    }
    case 'compacted':
      return [system('compacted')];
    case 'session_meta':
      return offset > 0 ? [system('resumed')] : [];
    default:
      return [];
  }
}

/** The tool calls one rollout record makes, with their full input, under the ids its entries carry. */
export function codexRecordCalls(record: unknown): RawCall[] {
  if (!isRec(record) || !isRec(record.payload)) return [];
  const p = record.payload;
  if (record.type === 'event_msg') {
    const item = p.type === 'item_completed' && isRec(p.item) && p.item.type === 'FileChange' ? p.item : null;
    return item ? [{ id: capName(str(item.id)), name: 'apply_patch', input: { changes: isRec(item.changes) ? item.changes : {} } }] : [];
  }
  if (record.type !== 'response_item') return [];
  const id = capName(str(p.call_id));
  switch (p.type) {
    case 'function_call': {
      const args = parseArgs(p.arguments);
      const patch = shellPatch(args);
      return [patch !== null ? { id, name: 'apply_patch', input: patch } : { id, name: str(p.name) || 'tool', input: args }];
    }
    case 'custom_tool_call':
      return [{ id, name: str(p.name) || 'tool', input: str(p.input) }];
    case 'local_shell_call':
      return [{ id: capName(str(p.call_id) || str(p.id)), name: 'shell', input: p.action }];
    default:
      return [];
  }
}

export const codexLineReader: LineReader = {
  entries: (record, { offset }) => codexRecordEntries(record, offset),
  calls: codexRecordCalls,
  timestamp: (record) => (isRec(record) && typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN),
};

/** A page of a Codex rollout's chat entries (see transcriptPager for the cursors). */
export function readCodexChatPage(file: string, opts: PageOptions = {}): Promise<TranscriptPage> {
  return readChatPage(file, codexLineReader, opts);
}
