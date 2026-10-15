/**
 * @module callRedaction
 * Hiding what a tool call touched from a reader who may not see it (a paired phone and secret files,
 * AASC-41), page by page but never fooled by where a page starts.
 *
 * The decision is made on each call's RAW input, as the transcript holds it (the chat shows at most
 * 2 KB of it). A call's result often arrives in a later page than the call: a live `after=` read
 * returns the call when it starts and the result when it ends, and an older page can end between
 * them. So a result whose call isn't in the page is looked up backwards in the transcript (the call
 * always comes first), within a byte budget; a result whose call isn't found is hidden (fail closed).
 */
import type { FileHandle } from 'node:fs/promises';
import type { ChatEntry } from '../../src/types/chat.js';
import { parseRecord, readRange, splitLines } from './jsonlFile.js';

/** A tool call as the transcript holds it: its id, its tool, its full input. */
export interface RawCall {
  id: string;
  name: string;
  input: unknown;
}

/** What one kind of reader may not see. */
export interface CallRedactor {
  /** Null: all of the call. Otherwise its result is hidden, and its input replaced when `input` is set. */
  call(input: unknown): { input?: unknown } | null;
  /** What a hidden result's output becomes. */
  hiddenOutput: string;
}

/** Reads a record's raw calls (the CLI's own parser). */
export type CallsOf = (record: unknown) => RawCall[];

/** Bytes a page may read backwards looking for the calls of its results. */
export const LOOKUP_BYTES = 8 * 1024 * 1024;
const LOOKUP_WINDOW = 4 * 1024 * 1024;

/**
 * The calls among `ids` found in whole lines before byte `end`, newest first, until all are found or
 * `budget` bytes were read. A line is parsed only if it contains one of the ids.
 */
async function findCallsBefore(
  fh: FileHandle,
  callsOf: CallsOf,
  ids: ReadonlySet<string>,
  end: number,
  budget: number,
): Promise<Map<string, RawCall>> {
  const found = new Map<string, RawCall>();
  let to = end;
  let read = 0;
  while (to > 0 && read < budget && found.size < ids.size) {
    const from = Math.max(0, to - Math.min(LOOKUP_WINDOW, budget - read));
    const lines = splitLines(await readRange(fh, from, to), from, from === 0);
    read += to - from;
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].text;
      if (![...ids].some((id) => !found.has(id) && text.includes(id))) continue;
      for (const call of callsOf(parseRecord(text))) {
        if (ids.has(call.id) && !found.has(call.id)) found.set(call.id, call);
      }
    }
    // The next window ends where this one's first whole line began: its cut head is read again.
    to = from === 0 ? 0 : lines.length > 0 ? lines[0].offset : from;
  }
  return found;
}

/**
 * `entries` as `redactor`'s reader may see them. `records` are the page's parsed records with the
 * byte where each line starts; results whose call is older than the page are looked up before it.
 */
export async function redactEntries(
  entries: ChatEntry[],
  records: ReadonlyArray<{ offset: number; record: unknown }>,
  fh: FileHandle,
  callsOf: CallsOf,
  redactor: CallRedactor,
  budget = LOOKUP_BYTES,
): Promise<ChatEntry[]> {
  const decisions = new Map<string, { input?: unknown } | null>();
  for (const { record } of records) {
    for (const call of callsOf(record)) decisions.set(call.id, redactor.call(call.input));
  }
  const orphans = new Set(
    entries.filter((e) => e.kind === 'tool_result' && !decisions.has(e.toolUseId)).map((e) => (e as { toolUseId: string }).toolUseId),
  );
  if (orphans.size > 0) {
    const pageStart = records.length > 0 ? records[0].offset : 0;
    const found = await findCallsBefore(fh, callsOf, orphans, pageStart, budget);
    // Not found within the budget: hidden, since what it touched can't be told.
    for (const id of orphans) decisions.set(id, found.has(id) ? redactor.call(found.get(id)?.input) : {});
  }
  return entries.map((entry): ChatEntry => {
    if (entry.kind === 'tool_use') {
      const decision = decisions.get(entry.id);
      if (!decision || decision.input === undefined) return entry;
      const { inputTruncated: _cut, ...rest } = entry;
      return { ...rest, input: decision.input };
    }
    if (entry.kind === 'tool_result' && decisions.get(entry.toolUseId)) {
      return { ...entry, output: redactor.hiddenOutput, truncated: false };
    }
    return entry;
  });
}
