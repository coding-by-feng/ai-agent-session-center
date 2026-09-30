/**
 * @module transcriptInterrupt
 * Did the user stop the turn that just ended (Esc, or a declined tool)? Read
 * from Claude Code's own transcript, not from the terminal.
 *
 * Claude Code fires an ordinary Stop for a cancel, so the hook stream cannot
 * tell it from a finished turn. What it does leave is a user entry in the
 * transcript: "[Request interrupted by user]" (or "… for tool use]" after a
 * declined tool), carrying `interruptedMessageId` and the turn's `promptId`
 * (the same id the Stop hook sends as `prompt_id`). In the 2.1.285 binary the
 * entry is yielded before the turn ends, i.e. before Stop fires.
 *
 * The terminal's "⎿ Interrupted · What should Claude do instead?" line was
 * the first signal tried and is not usable: a tool or Claude's reply can print
 * the same text, a repaint reprints old ones, and whether a stripped row still
 * starts with ⎿ depends on how the TUI positions its output. None of that can
 * write a transcript entry.
 */
import { open } from 'node:fs/promises';

/** Enough for the end of a turn; a transcript can run to many MB. */
export const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The marker texts, matched exactly when an entry has no interruptedMessageId. */
const MARKER_TEXTS: ReadonlySet<string> = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

interface TranscriptEntry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  promptId?: unknown;
  interruptedMessageId?: unknown;
  interruptedByShutdown?: unknown;
  message?: { content?: unknown } | null;
}

function onlyText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length !== 1) return null;
  const block = content[0] as { type?: unknown; text?: unknown } | null;
  return block && block.type === 'text' && typeof block.text === 'string' ? block.text : null;
}

function isInterruptEntry(e: TranscriptEntry): boolean {
  if (e.interruptedByShutdown === true) return false;
  if (typeof e.interruptedMessageId === 'string' && e.interruptedMessageId) return true;
  const text = onlyText(e.message?.content);
  return text !== null && MARKER_TEXTS.has(text.trim());
}

function parse(raw: string): TranscriptEntry | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === 'object' ? (e as TranscriptEntry) : null;
  } catch {
    return null; // junk, or the line Claude Code is still writing
  }
}

/**
 * Pure. `lines` run oldest → newest. With the Stop's `promptId`, only this
 * turn's entries are considered: an interruption marker among them means
 * interrupted, and reaching an entry from another turn ends the search.
 * Without one, the most recent user entry decides.
 */
export function turnWasInterrupted(lines: readonly string[], promptId: string | null | undefined): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || e.type !== 'user' || e.isMeta === true || e.isSidechain === true) continue;
    if (!promptId) return isInterruptEntry(e);
    if (typeof e.promptId === 'string' && e.promptId !== promptId) return false;
    if (e.promptId === promptId && isInterruptEntry(e)) return true;
  }
  return false;
}

/**
 * The last `maxBytes` of a transcript as lines, the cut first line dropped.
 * Null for anything but a readable `.jsonl` file. Async: this runs on the
 * server's one event loop.
 */
export async function readTranscriptTail(
  path: string,
  maxBytes: number = TRANSCRIPT_TAIL_BYTES,
): Promise<string[] | null> {
  if (!path.endsWith('.jsonl')) return null;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** True / false from the transcript; null when it cannot be read. */
export async function checkTurnInterrupted(path: string, promptId: string | null | undefined): Promise<boolean | null> {
  const lines = await readTranscriptTail(path);
  return lines === null ? null : turnWasInterrupted(lines, promptId);
}
