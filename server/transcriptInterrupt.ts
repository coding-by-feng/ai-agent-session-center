/**
 * @module transcriptInterrupt
 * Did the user stop the turn (Esc, or a declined tool)? Read from the CLI's own
 * transcript, not from the terminal.
 *
 * The hook stream cannot say. Claude Code fires no Stop when Esc stops a turn
 * (none within 3 s of 21 of 21 interrupts in AASC's database, 2.1.241–2.1.312;
 * Oct 2026), and when a Stop does come, it cannot be told from a finished turn.
 * What it does leave is a user entry in the transcript:
 * "[Request interrupted by user]" (or "… for tool use]" after a declined tool),
 * carrying `interruptedMessageId` and the turn's `promptId` (the same id its
 * hooks send as `prompt_id`). Codex fires nothing either; its rollout gets
 * `turn_aborted` with reason `interrupted` and the hook's `turn_id`.
 * `stoppedTurn` reads either as the file is written; `turnWasInterrupted`
 * answers for a Stop.
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
  timestamp?: unknown;
  interruptedMessageId?: unknown;
  interruptedByShutdown?: unknown;
  message?: { id?: unknown; content?: unknown } | null;
  /** Codex rollout lines: `{ type: 'event_msg', payload: { type: 'turn_aborted', … } }`. */
  payload?: { type?: unknown; reason?: unknown; turn_id?: unknown } | null;
}

/** A turn the user stopped, named the way its hooks name it. */
export interface StoppedTurn {
  /** Claude's `promptId` (the hooks' `prompt_id`) or Codex's `turn_id`; null when the line has none. */
  turnId: string | null;
  /** When Claude wrote the marker (ms); null without a timestamp, and for Codex, whose abort names its turn exactly. */
  at: number | null;
}

/**
 * A prompt typed into a busy turn makes Claude write a marker within a few ms of the
 * prompt's own entry (3 and 13 ms in real transcripts); the quickest real stop seen came
 * 514 ms after its prompt.
 */
export const TYPED_PROMPT_MARKER_MS = 300;

const idOf = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function timeOf(e: TranscriptEntry): number | null {
  if (typeof e.timestamp !== 'string') return null;
  const at = Date.parse(e.timestamp);
  return Number.isFinite(at) ? at : null;
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

const isMainUserEntry = (e: TranscriptEntry): boolean =>
  e.type === 'user' && e.isMeta !== true && e.isSidechain !== true;

/** Something the person sent (a prompt, a command), not a tool's result. */
function isTypedEntry(e: TranscriptEntry): boolean {
  const content = e.message?.content;
  if (typeof content === 'string') return true;
  return Array.isArray(content)
    && !content.some((block) => (block as { type?: unknown } | null)?.type === 'tool_result');
}

/**
 * Pure. Did the newest turn in `lines` (oldest → newest) end with the user
 * stopping it? Claude: the newest main-thread user entry is the marker, and it is
 * not one written for a typed prompt (`isTypedPromptMarker`). Codex: the newest
 * turn boundary is `turn_aborted` with reason `interrupted` (`replaced` means
 * another turn took over).
 */
export function stoppedTurn(lines: readonly string[]): StoppedTurn | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e) continue;
    if (e.type === 'event_msg') {
      const kind = e.payload?.type;
      if (kind === 'turn_aborted') return e.payload?.reason === 'interrupted' ? { turnId: idOf(e.payload?.turn_id), at: null } : null;
      if (kind === 'task_started' || kind === 'task_complete') return null;
      continue;
    }
    if (!isMainUserEntry(e)) continue;
    if (!isInterruptEntry(e)) return null;
    const turnId = idOf(e.promptId);
    return turnId && isTypedPromptMarker(lines, i, turnId, e) ? null : { turnId, at: timeOf(e) };
  }
  return null;
}

/**
 * Claude also writes the marker when a prompt is typed into a busy turn, under that
 * prompt's `promptId`, a few ms before or after the prompt's own entry (the order
 * changes between versions); that prompt then runs. Any one of these gives it away.
 */
function isTypedPromptMarker(lines: readonly string[], index: number, turnId: string, marker: TranscriptEntry): boolean {
  return startsAnotherTurn(lines, index, turnId)
    || followsOwnPrompt(lines, index, turnId, timeOf(marker))
    || interruptsAnotherTurn(lines, index, turnId, idOf(marker.interruptedMessageId));
}

/** The turn of the nearest main-thread user entry before `index`, markers skipped. */
function turnBefore(lines: readonly string[], index: number): string | null {
  for (let i = index - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || !isMainUserEntry(e) || isInterruptEntry(e)) continue;
    return idOf(e.promptId);
  }
  return null;
}

/** Written ahead of its prompt (2.1.312): the user entry before it is another turn's. */
function startsAnotherTurn(lines: readonly string[], index: number, turnId: string): boolean {
  const before = turnBefore(lines, index);
  return before !== null && before !== turnId;
}

/** Written just after its prompt (2.1.286, 2.1.296): this turn's prompt came at most TYPED_PROMPT_MARKER_MS before. */
function followsOwnPrompt(lines: readonly string[], index: number, turnId: string, markerAt: number | null): boolean {
  if (markerAt === null) return false;
  for (let i = index - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || !isMainUserEntry(e) || isInterruptEntry(e)) continue;
    if (e.promptId !== turnId) return false;
    if (!isTypedEntry(e)) continue;
    const promptAt = timeOf(e);
    return promptAt !== null && markerAt - promptAt <= TYPED_PROMPT_MARKER_MS;
  }
  return false;
}

/**
 * The message it interrupted belongs to another turn: the one the typed prompt cut off
 * (2.1.312 then stamps that turn's cut-off tool result with the new id too). A message
 * the tail does not hold decides nothing.
 */
function interruptsAnotherTurn(lines: readonly string[], index: number, turnId: string, messageId: string | null): boolean {
  if (!messageId) return false;
  for (let i = index - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || e.type !== 'assistant' || e.isSidechain === true || e.message?.id !== messageId) continue;
    const owner = turnBefore(lines, i);
    return owner !== null && owner !== turnId;
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
