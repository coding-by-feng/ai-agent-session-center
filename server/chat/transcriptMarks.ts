/**
 * @module transcriptMarks
 * Secret marks for the classic layout's `GET /sessions/:id/transcript` (AASC-41), the same marks the
 * chat carries (secretMarks.ts) so the phone profile can hide by them; nothing is hidden here.
 *
 * That route's entries carry a 2 KB cut of each call's input, but the decision needs the whole input,
 * so the session's transcript is scanned for its calls (only lines holding a `"tool_use"` are parsed)
 * and each call and result is marked by call id. What each call touched (not its input) is kept per
 * file and project, and the scan continues from where it stopped when the file grows. A call or result that can't be judged (no id, no transcript, a call
 * not in it) is marked `callUnknown`.
 */
import { open, type FileHandle } from 'node:fs/promises';
import type { ConversationEntry } from '../extractPreviousAnswer.js';
import { claudeRecordCalls } from './claudeTranscript.js';
import { NEWLINE, parseRecord, readRange } from './jsonlFile.js';
import { secretTouch, type SecretTouch } from './secretCalls.js';
import type { TranscriptLocation } from './transcriptLocator.js';

/** The marks a phone is filtered by (see ChatToolUseEntry / ChatToolResultEntry in src/types/chat.ts). */
export interface TranscriptSecretMarks {
  secret?: boolean;
  secretInput?: boolean;
  editPaths?: string[];
  callUnknown?: boolean;
}

export type MarkedConversationEntry = ConversationEntry & TranscriptSecretMarks;

const CHUNK = 1024 * 1024;
const TAIL_BYTES = 64;
const CACHE_MAX = 8;

interface CallIndex {
  tag: string;
  /** Bytes scanned (whole lines only). */
  offset: number;
  /** The bytes just before `offset`, to notice a file rewritten in place. */
  tail: Buffer;
  /** How each call touched a secret file (null: it didn't), by call id. */
  touches: Map<string, SecretTouch | null>;
}

const indexes = new Map<string, CallIndex>();

async function tailBefore(fh: FileHandle, offset: number): Promise<Buffer> {
  return readRange(fh, Math.max(0, offset - TAIL_BYTES), offset);
}

/** Add the calls of every whole line from `index.offset` to the end. */
async function scan(fh: FileHandle, size: number, index: CallIndex, projectRoot: string | null): Promise<void> {
  let carry: Buffer = Buffer.alloc(0);
  let at = index.offset;
  while (at < size) {
    const chunk = await readRange(fh, at, Math.min(size, at + CHUNK));
    if (chunk.length === 0) break;
    at += chunk.length;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE); nl >= 0; nl = buf.indexOf(NEWLINE, start)) {
      const line = buf.toString('utf8', start, nl);
      start = nl + 1;
      if (!line.includes('"tool_use"')) continue;
      for (const call of claudeRecordCalls(parseRecord(line))) index.touches.set(call.id, secretTouch(call.input, projectRoot));
    }
    carry = buf.subarray(start);
    index.offset = at - carry.length;
  }
}

/** What each call in the transcript at `path` touched, by id (kept between requests). */
async function callTouches(path: string, projectRoot: string | null): Promise<Map<string, SecretTouch | null>> {
  const key = `${path}\0${projectRoot ?? ''}`;
  const fh = await open(path, 'r');
  try {
    const st = await fh.stat();
    const tag = `${st.dev}-${st.ino}`;
    const kept = indexes.get(key);
    const valid = kept && kept.tag === tag && kept.offset <= st.size && (await tailBefore(fh, kept.offset)).equals(kept.tail);
    const index: CallIndex = valid && kept ? kept : { tag, offset: 0, tail: Buffer.alloc(0), touches: new Map() };
    await scan(fh, st.size, index, projectRoot);
    index.tail = await tailBefore(fh, index.offset);
    indexes.delete(key);
    indexes.set(key, index);
    if (indexes.size > CACHE_MAX) indexes.delete(indexes.keys().next().value as string);
    return index.touches;
  } finally {
    await fh.close();
  }
}

function useMarks(touch: SecretTouch | null): TranscriptSecretMarks {
  if (!touch) return {};
  return touch.content ? { secret: true, secretInput: true, editPaths: touch.paths } : { secret: true };
}

/**
 * The transcript route's entries with secret marks, judged against the session's own transcript
 * (`location`, null when there is none) and project root.
 */
export async function markTranscriptSecrets(
  entries: ConversationEntry[],
  location: TranscriptLocation | null,
  projectRoot: string | null | undefined,
): Promise<MarkedConversationEntry[]> {
  if (!entries.some((e) => e.role === 'tool_use' || e.role === 'tool_result')) return entries;
  let touches = new Map<string, SecretTouch | null>();
  if (location?.cli === 'claude') {
    try {
      touches = await callTouches(location.path, projectRoot || null);
    } catch {
      // Unreadable now: every call and result is unjudged, so hidden on a phone.
    }
  }
  const touchOf = (id: string | undefined): SecretTouch | null | undefined => (id ? touches.get(id) : undefined);
  return entries.map((entry): MarkedConversationEntry => {
    if (entry.role !== 'tool_use' && entry.role !== 'tool_result') return entry;
    const touch = touchOf(entry.role === 'tool_use' ? entry.id : entry.toolUseId);
    if (touch === undefined) return { ...entry, callUnknown: true };
    if (entry.role === 'tool_use') return { ...entry, ...useMarks(touch) };
    return touch ? { ...entry, secret: true } : entry;
  });
}
