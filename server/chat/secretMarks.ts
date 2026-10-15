/**
 * @module secretMarks
 * Marks the chat entries of tool calls that touched a secret file, and their results (AASC-41).
 * Nothing is hidden here: every reader gets the same content, and the phone profile hides what a
 * paired phone may not see by these marks (server/mobile/phoneChatFilter.ts).
 *
 *   tool_use     secret: true            the call touched a secret file (secretCalls.ts)
 *                secretInput: true       …and its input carries that file's content; editPaths names
 *                                        every file it reads or edits
 *   tool_result  secret: true            its call touched a secret file
 *                callUnknown: true       its call wasn't found, so what it touched can't be told
 *
 * A result often lands in a later page than its call: a live `after=` read returns the call when it
 * starts and the result when it ends, and a page can begin between them. Such a result's call is
 * looked for backwards (calls come first): in the lines the page read but didn't show, then up to
 * one more scan budget of the file. Not found there means `callUnknown`.
 */
import type { FileHandle } from 'node:fs/promises';
import type { ChatEntry } from '../../src/types/chat.js';
import { parseRecord, readRange, splitLines, type Line } from './jsonlFile.js';
import { secretTouch, type SecretTouch } from './secretCalls.js';

/** A tool call as the transcript holds it: its id, its tool, its full input. */
export interface RawCall {
  id: string;
  name: string;
  input: unknown;
}

/** Reads a record's raw calls (the CLI's own parser). */
export type CallsOf = (record: unknown) => RawCall[];

/** Where a page's results may find their calls. */
export interface Lookback {
  /** Lines the page read before its first entry, in file order (searched first, no further reads). */
  prior: readonly Line[];
  /** The byte before which the file is read further back for calls still missing. */
  end: number;
  /** Bytes that further read may take. */
  budget: number;
}

const touches = (ids: ReadonlySet<string>, found: ReadonlyMap<string, unknown>, text: string): boolean =>
  [...ids].some((id) => !found.has(id) && text.includes(id));

/** Calls among `ids` in `lines` (newest first), added to `found`. A line is parsed only if it names one. */
function searchLines(lines: readonly Line[], callsOf: CallsOf, ids: ReadonlySet<string>, found: Map<string, RawCall>): void {
  for (let i = lines.length - 1; i >= 0 && found.size < ids.size; i--) {
    if (!touches(ids, found, lines[i].text)) continue;
    for (const call of callsOf(parseRecord(lines[i].text))) {
      if (ids.has(call.id) && !found.has(call.id)) found.set(call.id, call);
    }
  }
}

/** The calls among `ids` within `lookback`: the page's unshown lines, then at most `budget` bytes before `end`. */
async function findCalls(fh: FileHandle, callsOf: CallsOf, ids: ReadonlySet<string>, lookback: Lookback): Promise<Map<string, RawCall>> {
  const found = new Map<string, RawCall>();
  searchLines(lookback.prior, callsOf, ids, found);
  if (found.size < ids.size && lookback.end > 0 && lookback.budget > 0) {
    // One read: a line cut at the start of the window is beyond the budget.
    const from = Math.max(0, lookback.end - lookback.budget);
    searchLines(splitLines(await readRange(fh, from, lookback.end), from, from === 0), callsOf, ids, found);
  }
  return found;
}

function markUse(entry: Extract<ChatEntry, { kind: 'tool_use' }>, touch: SecretTouch | null | undefined): ChatEntry {
  if (!touch) return entry;
  return touch.content ? { ...entry, secret: true, secretInput: true, editPaths: touch.paths } : { ...entry, secret: true };
}

/** `entries` with secret marks. `records` are the page's parsed records, in file order. */
export async function markSecretEntries(
  entries: ChatEntry[],
  records: ReadonlyArray<{ record: unknown }>,
  fh: FileHandle,
  callsOf: CallsOf,
  lookback: Lookback,
): Promise<ChatEntry[]> {
  const decided = new Map<string, SecretTouch | null>();
  for (const { record } of records) {
    for (const call of callsOf(record)) decided.set(call.id, secretTouch(call.input));
  }
  const missing = new Set(
    entries.flatMap((e) => (e.kind === 'tool_result' && !decided.has(e.toolUseId) ? [e.toolUseId] : [])),
  );
  if (missing.size > 0) {
    for (const [id, call] of await findCalls(fh, callsOf, missing, lookback)) decided.set(id, secretTouch(call.input));
  }
  return entries.map((entry): ChatEntry => {
    if (entry.kind === 'tool_use') return markUse(entry, decided.get(entry.id));
    if (entry.kind !== 'tool_result') return entry;
    if (!decided.has(entry.toolUseId)) return { ...entry, callUnknown: true };
    return decided.get(entry.toolUseId) ? { ...entry, secret: true } : entry;
  });
}
