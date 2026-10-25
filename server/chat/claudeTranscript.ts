/**
 * @module claudeTranscript
 * Claude Code's session JSONL as chat entries (AASC-41).
 *
 * Each line is one record. The ones a chat shows:
 *   { type: 'user', message: { content: string | blocks } }       prompts, tool results, harness text
 *   { type: 'assistant', message: { content: blocks } }           text, thinking, tool calls
 *   { type: 'system', subtype: 'compact_boundary' | 'local_command' | 'informational' }
 * Everything else (attachments, file-history snapshots, turn durations, hook summaries, sidechain
 * records of in-file subagents) is bookkeeping and holds no entry.
 *
 * Harness text arrives as user turns nobody typed: slash commands (`<command-name>`), their output
 * (`<local-command-stdout>`), the caveat before them, `<task-notification>`s, system reminders and
 * skill bodies. They become `command` and `system` entries so real prompts stand alone.
 */
import type { ChatSystemKind } from '../../src/types/chat.js';
import {
  assistantTextCap,
  capName,
  cappedText,
  todoItems,
  toolResultDraft,
  toolUseDraft,
  TEXT_CAP,
  type ChatEntryDraft,
} from './chatEntries.js';
import { readChatPage, type LineReader, type PageOptions, type TranscriptPage } from './transcriptPager.js';
import type { RawCall } from './secretMarks.js';

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const RE_COMMAND_NAME = /<command-name>([\s\S]*?)<\/command-name>/;
const RE_COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const RE_STDOUT = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/;
const RE_STDERR = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/;
const RE_CAVEAT = /^\s*<local-command-caveat>/;
const RE_INTERRUPTED = /^\s*\[Request interrupted by user/;
const RE_TASK_NOTIFICATION = /^\s*<task-notification>/;
const RE_TASK_STATUS = /<status>([^<]*)<\/status>/;
const RE_SYSTEM_REMINDER = /^\s*<system-reminder>/;
const RE_SKILL_BODY = /^\s*Base directory for this skill:\s*(\S+)/;

function system(kind: ChatSystemKind, label?: string, text?: string): ChatEntryDraft {
  return {
    kind: 'system',
    system: kind,
    ...(label ? { label: capName(label) } : {}),
    ...(text !== undefined ? cappedText(text) : {}),
  };
}

const lastSegment = (path: string): string => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path;

/** A command's printed output: stdout, else stderr; null when it printed nothing. */
function commandOutput(text: string): string | null {
  const out = (RE_STDOUT.exec(text)?.[1] ?? RE_STDERR.exec(text)?.[1] ?? '').trim();
  return out ? cappedText(out).text : null;
}

/** A user turn's text: a prompt, or the harness text it really is. */
function userText(text: string, isMeta: boolean): ChatEntryDraft | null {
  if (!text.trim()) return null;
  if (RE_CAVEAT.test(text)) return null;
  if (RE_INTERRUPTED.test(text)) return system('cancelled');
  const name = RE_COMMAND_NAME.exec(text)?.[1].trim();
  if (name) {
    const args = RE_COMMAND_ARGS.exec(text)?.[1].trim();
    const output = commandOutput(text);
    return {
      kind: 'command',
      name: capName(name),
      ...(args ? { args: cappedText(args).text } : {}),
      ...(output !== null ? { output } : {}),
    };
  }
  if (RE_STDOUT.test(text) || RE_STDERR.test(text)) {
    // Output on its own: folded into the command before it by the pager.
    const output = commandOutput(text);
    return output === null ? null : { kind: 'command', name: '', output };
  }
  if (RE_TASK_NOTIFICATION.test(text)) {
    return system('notification', RE_TASK_STATUS.exec(text)?.[1].trim() || 'background task', text);
  }
  if (RE_SYSTEM_REMINDER.test(text)) return system('context', 'system reminder', text);
  const skill = RE_SKILL_BODY.exec(text);
  if (skill) return system('context', lastSegment(skill[1]), text);
  if (isMeta) return system('context', 'harness', text);
  return { kind: 'user', ...cappedText(text) };
}

/**
 * A tool result's text. Text blocks are joined; any other block (an image, a document) shows as
 * `[<type>]`, so its data (base64) is never sent.
 */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (isRec(b) && b.type === 'text' && typeof b.text === 'string') return b.text;
        return `[${capName(isRec(b) ? str(b.type) : '') || 'block'}]`;
      })
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function toolUse(block: Rec): ChatEntryDraft {
  const id = str(block.id);
  const name = str(block.name) || 'tool';
  const input = block.input;
  if (name === 'TodoWrite' && isRec(input)) return { kind: 'todo', id: capName(id), items: todoItems(input.todos, 'content') };
  if ((name === 'Agent' || name === 'Task') && isRec(input)) {
    const prompt = cappedText(str(input.prompt), TEXT_CAP);
    return {
      kind: 'subagent',
      id: capName(id),
      description: capName(str(input.description)),
      ...(str(input.subagent_type) ? { agentType: capName(str(input.subagent_type)) } : {}),
      prompt: prompt.text,
      ...(input.run_in_background === true ? { background: true } : {}),
      ...(prompt.truncated ? { truncated: true } : {}),
    };
  }
  return toolUseDraft(id, name, input);
}

function assistantEntries(rec: Rec, content: unknown, cap: number): ChatEntryDraft[] {
  if (rec.isApiErrorMessage === true) {
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(isRec).map((b) => str(b.text)).join('\n') : '';
    return text.trim() ? [system('info', 'API error', text)] : [];
  }
  if (typeof content === 'string') return content.trim() ? [{ kind: 'assistant', ...cappedText(content, cap) }] : [];
  if (!Array.isArray(content)) return [];
  const out: ChatEntryDraft[] = [];
  let duration = typeof rec.thinkingDurationMs === 'number' ? rec.thinkingDurationMs : undefined;
  for (const block of content) {
    if (!isRec(block)) continue;
    if (block.type === 'text' && str(block.text).trim()) {
      out.push({ kind: 'assistant', ...cappedText(str(block.text), cap) });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // How much and how long, never what: the thinking itself stays on the Mac.
      out.push({ kind: 'thinking', length: str(block.thinking).length, ...(duration !== undefined ? { durationMs: duration } : {}) });
      duration = undefined;
    } else if (block.type === 'tool_use') {
      out.push(toolUse(block));
    }
  }
  return out;
}

function userEntries(rec: Rec, content: unknown): ChatEntryDraft[] {
  const isMeta = rec.isMeta === true;
  if (rec.isCompactSummary === true) {
    const text = typeof content === 'string' ? content : toolResultText(content);
    return [system('context', 'compact summary', text)];
  }
  if (typeof content === 'string') {
    const entry = userText(content, isMeta);
    return entry ? [entry] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: ChatEntryDraft[] = [];
  let images = 0;
  for (const block of content) {
    if (!isRec(block)) continue;
    if (block.type === 'tool_result') {
      out.push(toolResultDraft(str(block.tool_use_id), toolResultText(block.content), block.is_error === true));
    } else if (block.type === 'text') {
      const entry = userText(str(block.text), isMeta);
      if (entry) out.push(entry);
    } else if (block.type === 'image') {
      images += 1;
    }
  }
  if (images > 0) {
    const i = out.findIndex((e) => e.kind === 'user');
    if (i >= 0) out[i] = { ...out[i], images } as ChatEntryDraft;
    else out.push({ kind: 'user', text: '', images });
  }
  return out;
}

function systemEntries(rec: Rec): ChatEntryDraft[] {
  switch (rec.subtype) {
    case 'compact_boundary': {
      const trigger = isRec(rec.compactMetadata) ? str(rec.compactMetadata.trigger) : '';
      return [system('compacted', trigger || undefined)];
    }
    case 'local_command': {
      const entry = userText(str(rec.content), false);
      return entry && entry.kind !== 'user' ? [entry] : [];
    }
    case 'informational': {
      const text = str(rec.content);
      return text.trim() ? [system('info', str(rec.level) || undefined, text)] : [];
    }
    default:
      return [];
  }
}

/** The chat entries one parsed Claude record holds; `assistantCap`: characters of assistant text per entry. */
export function claudeRecordEntries(record: unknown, assistantCap: number = TEXT_CAP): ChatEntryDraft[] {
  if (!isRec(record) || record.isSidechain === true) return [];
  const message = isRec(record.message) ? record.message : undefined;
  const content = message?.content ?? record.content;
  switch (record.type) {
    case 'assistant':
      return assistantEntries(record, content, assistantCap);
    case 'user':
      return userEntries(record, content);
    case 'system':
      return systemEntries(record);
    default:
      return [];
  }
}

/** The tool calls one Claude record makes, with their full input. */
export function claudeRecordCalls(record: unknown): RawCall[] {
  if (!isRec(record) || record.isSidechain === true || record.type !== 'assistant' || !isRec(record.message)) return [];
  const content = record.message.content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((b): b is Rec => isRec(b) && b.type === 'tool_use')
    .map((b) => ({ id: capName(str(b.id)), name: str(b.name) || 'tool', input: b.input }));
}

export const claudeLineReader: LineReader = {
  entries: (record, { assistantCap }) => claudeRecordEntries(record, assistantTextCap(assistantCap)),
  calls: claudeRecordCalls,
  timestamp: (record) => (isRec(record) && typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN),
};

/** A page of a Claude transcript's chat entries (see transcriptPager for the cursors). */
export function readClaudeChatPage(file: string, opts: PageOptions = {}): Promise<TranscriptPage> {
  return readChatPage(file, claudeLineReader, opts);
}
