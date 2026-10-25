// tools/entries.ts — chat and transcript entries as text a central can read, one entry per line (or block).
//
// A page of the conversation can be megabytes (a message is up to 16 KB, a tool result 4 KB, 200 to a page),
// and a central pays for every character in its context. So the rendering is bounded: each entry's text is
// cut to a per-entry cap, the cap shrinks until the whole page fits one budget, and only when even the
// smallest cap is not enough are the OLDEST entries left out (and counted). The newest entry is always shown.
//
// This module only renders: it fences nothing. The caller wraps the result in ONE `fence(...)`, because every
// character of it was written by a session.

import type { ChatEntry } from '../../../src/types/chat.js';
import type { ConversationEntry } from '../../extractPreviousAnswer.js';
import { inputText, oneLine } from './define.js';

/** The most characters one rendering holds (fence tags excluded). */
export const RENDER_BUDGET = 40_000;

/** Per-entry text caps, tried in turn until the page fits the budget. */
const TEXT_CAPS: readonly number[] = [3_000, 1_200, 500, 200];

/** Tool inputs and results are shown shorter than a message: they are the bulk of a page and the least read. */
const INPUT_CAP = 400;
const RESULT_CAP = 800;
const MISC_CAP = 400;

export interface Rendered {
  /** The entries, one per line, oldest first. */
  text: string;
  /** How many entries `text` holds. */
  count: number;
  /** How many of the oldest entries were left out to fit the budget. */
  omitted: number;
  /** The time of the first and the last entry shown (epoch ms), 0 when an entry has none. */
  firstAt: number;
  lastAt: number;
}

/** `text` cut to `cap` characters, with how many more there were. */
function clipMarked(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}… [${text.length - cap} more chars]` : text;
}

/** `11:05:22Z`, or dashes for an entry with no time. */
export function clock(timestamp: number): string {
  return timestamp > 0 ? `${new Date(timestamp).toISOString().slice(11, 19)}Z` : '--:--:--';
}

/**
 * Renders every entry at the largest per-entry cap that makes the whole fit the budget. Beyond the smallest
 * cap, the newest entries that fit are kept and the rest counted as omitted.
 */
function fitted<E>(entries: readonly E[], lineOf: (entry: E, cap: number) => string, timeOf: (entry: E) => number): Rendered {
  const smallest = TEXT_CAPS[TEXT_CAPS.length - 1];
  let lines: string[] = [];
  for (const cap of TEXT_CAPS) {
    lines = entries.map((entry) => lineOf(entry, cap));
    if (lines.join('\n').length <= RENDER_BUDGET) return summarize(entries, lines, 0, timeOf);
  }
  lines = entries.map((entry) => lineOf(entry, smallest));
  let used = 0;
  let from = lines.length;
  while (from > 0 && used + lines[from - 1].length + 1 <= RENDER_BUDGET) {
    from -= 1;
    used += lines[from].length + 1;
  }
  // The newest entry is shown even if it alone is over the budget (its text is capped, so it is not by much).
  if (from === lines.length && lines.length > 0) from = lines.length - 1;
  return summarize(entries.slice(from), lines.slice(from), from, timeOf);
}

function summarize<E>(shown: readonly E[], lines: readonly string[], omitted: number, timeOf: (e: E) => number): Rendered {
  return {
    text: lines.join('\n'),
    count: shown.length,
    omitted,
    firstAt: shown.length > 0 ? timeOf(shown[0]) : 0,
    lastAt: shown.length > 0 ? timeOf(shown[shown.length - 1]) : 0,
  };
}

// ---------------------------------------------------------------------------
// The chat reader's entries (src/types/chat.ts)
// ---------------------------------------------------------------------------

const TODO_MARK: Record<string, string> = { completed: 'x', in_progress: '~' };

function chatLine(e: ChatEntry, cap: number): string {
  const head = `[${e.key}] ${clock(e.timestamp)}`;
  switch (e.kind) {
    case 'user': {
      const images = e.images ? ` (+${e.images} image${e.images === 1 ? '' : 's'})` : '';
      return `${head} user${images}: ${clipMarked(e.text, cap)}`;
    }
    case 'assistant':
      return `${head} assistant: ${clipMarked(e.text, cap)}`;
    case 'thinking':
      return `${head} thinking (${e.length} chars)`;
    case 'tool_use':
      return `${head} tool_use ${e.name}: ${clipMarked(inputText(e.input), Math.min(cap, INPUT_CAP))}`;
    case 'tool_result':
      return `${head} tool_result ${e.isError ? 'ERROR' : 'ok'}: ${clipMarked(e.output, Math.min(cap, RESULT_CAP))}`;
    case 'todo': {
      const items = e.items.map((i) => `[${TODO_MARK[i.status] ?? ' '}] ${oneLine(i.text, 80)}`).join('; ');
      return `${head} todo: ${items}`;
    }
    case 'subagent': {
      const kind = e.agentType ? `${e.agentType} ` : '';
      return `${head} subagent ${kind}${JSON.stringify(oneLine(e.description, 100))}: ${clipMarked(e.prompt, Math.min(cap, 600))}`;
    }
    case 'command': {
      const args = e.args ? ` ${e.args}` : '';
      const output = e.output ? `: ${clipMarked(e.output, Math.min(cap, MISC_CAP))}` : '';
      return `${head} command /${e.name}${args}${output}`;
    }
    case 'system': {
      const label = e.label ? ` (${e.label})` : '';
      const text = e.text ? `: ${clipMarked(e.text, Math.min(cap, MISC_CAP))}` : '';
      return `${head} system ${e.system}${label}${text}`;
    }
  }
}

/** A page of the chat reader's entries (oldest first) as lines. */
export function renderChatEntries(entries: readonly ChatEntry[]): Rendered {
  return fitted(entries, chatLine, (e) => e.timestamp);
}

// ---------------------------------------------------------------------------
// The classic transcript's entries (a Claude JSONL, and a subagent's)
// ---------------------------------------------------------------------------

/** A transcript entry with its 1-based place in the list it came from, so a central can point at it. */
export interface NumberedEntry {
  n: number;
  entry: ConversationEntry;
}

function conversationLine({ n, entry }: NumberedEntry, cap: number): string {
  const head = `[#${n}] ${clock(entry.timestamp)}`;
  switch (entry.role) {
    case 'user':
      return `${head} user: ${clipMarked(entry.text, cap)}`;
    case 'assistant':
      return `${head} assistant: ${clipMarked(entry.text, cap)}`;
    case 'tool_use':
      return `${head} tool_use ${entry.tool}: ${clipMarked(entry.input, Math.min(cap, INPUT_CAP))}`;
    case 'tool_result':
      return `${head} tool_result ${entry.isError ? 'ERROR' : 'ok'}: ${clipMarked(entry.output, Math.min(cap, RESULT_CAP))}`;
    case 'event':
      return `${head} event ${entry.eventType}: ${clipMarked(entry.detail, Math.min(cap, MISC_CAP))}`;
  }
}

/** Transcript entries (oldest first), numbered from `firstNumber`, as lines. */
export function renderConversationEntries(entries: readonly ConversationEntry[], firstNumber = 1): Rendered {
  const numbered = entries.map((entry, i) => ({ n: firstNumber + i, entry }));
  return fitted(numbered, conversationLine, (e) => e.entry.timestamp);
}
