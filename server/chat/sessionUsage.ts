/**
 * @module sessionUsage
 * A Claude session's token totals for the header's Context details card (Nov 25 2026):
 * how many API replies it made and what they read and wrote, summed over its transcript.
 * The status line reports only the last reply, so the totals come from here.
 *
 * Claude Code writes one transcript line per content block of a reply, each repeating
 * that reply's `usage`, so replies are counted once by `message.id` (last line wins: its
 * `output_tokens` is final). Summing lines would count a reply two to four times.
 *
 * Transcripts grow to hundreds of MB, so each file is read once and then only from where
 * the last read stopped (a half-written line waits for the next read).
 *
 * The reference cost is Claude Code's own `cost.total_cost_usd`, copied by the status-line
 * tap into `<queue>/runtime/<sid>.json` as `cost.usd`.
 */
import { lstat, open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionUsageTotals } from '../../src/types/session.js';
import { checkUsageDirectory } from '../planUsageSources.js';
import { RUNTIME_DIR } from '../sessionRuntimeWatch.js';

interface ReplyUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

const CHUNK_BYTES = 4 * 1024 * 1024;
const CACHE_MAX = 32;
/** A real snapshot is ~400 bytes. */
const MAX_SNAPSHOT_BYTES = 16 * 1024;
const SNAPSHOT_KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;

/** Fold transcript lines into `byId` (one entry per API reply). Returns the same map. */
export function foldClaudeUsage(lines: Iterable<string>, byId: Map<string, ReplyUsage> = new Map()): Map<string, ReplyUsage> {
  for (const line of lines) {
    // Cheap filter first: most lines are tool results and user turns.
    if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
    let rec: { type?: unknown; requestId?: unknown; uuid?: unknown; message?: { id?: unknown; model?: unknown; usage?: unknown } | null };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec?.type !== 'assistant' || !rec.message || typeof rec.message !== 'object') continue;
    const { id, model, usage } = rec.message;
    if (model === '<synthetic>' || !usage || typeof usage !== 'object') continue;
    const key = typeof id === 'string' && id ? id
      : typeof rec.requestId === 'string' && rec.requestId ? `req:${rec.requestId}`
        : typeof rec.uuid === 'string' ? `uuid:${rec.uuid}` : null;
    if (!key) continue;
    const u = usage as Record<string, unknown>;
    byId.set(key, {
      input: count(u.input_tokens),
      cacheWrite: count(u.cache_creation_input_tokens),
      cacheRead: count(u.cache_read_input_tokens),
      output: count(u.output_tokens),
    });
  }
  return byId;
}

/** The sums, or null when no reply has been made. */
export function totalsOf(byId: ReadonlyMap<string, ReplyUsage>): SessionUsageTotals | null {
  if (byId.size === 0) return null;
  const totals: SessionUsageTotals = { steps: byId.size, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  for (const u of byId.values()) {
    totals.input += u.input;
    totals.cacheWrite += u.cacheWrite;
    totals.cacheRead += u.cacheRead;
    totals.output += u.output;
  }
  return totals;
}

interface Cached {
  /** Bytes consumed: always just past a newline. */
  offset: number;
  byId: Map<string, ReplyUsage>;
}

const cache = new Map<string, Cached>();

/** Forget what was read (tests). */
export function resetSessionUsageCache(): void {
  cache.clear();
}

/** The totals of the Claude transcript at `path`; null when it is missing or has no reply yet. */
export async function readSessionUsage(path: string): Promise<SessionUsageTotals | null> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return null;
  }
  let entry = cache.get(path);
  // Shorter than what was read: the file was rewritten, so start over.
  if (!entry || info.size < entry.offset) entry = { offset: 0, byId: new Map() };
  if (info.size > entry.offset) {
    const fh = await open(path, 'r');
    try {
      let pos = entry.offset;
      let carry = '';
      while (pos < info.size) {
        const len = Math.min(CHUNK_BYTES, info.size - pos);
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        const text = carry + buf.subarray(0, bytesRead).toString('utf8');
        const nl = text.lastIndexOf('\n');
        if (nl < 0) {
          carry = text;
          continue;
        }
        foldClaudeUsage(text.slice(0, nl).split('\n'), entry.byId);
        carry = text.slice(nl + 1);
      }
      // A trailing line with no newline is still being written: read it next time.
      entry.offset = pos - Buffer.byteLength(carry, 'utf8');
    } finally {
      await fh.close();
    }
  }
  cache.delete(path);
  cache.set(path, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return totalsOf(entry.byId);
}

/**
 * Claude Code's own reference cost for session `key` (its id, the transcript's basename), in USD,
 * from the status-line tap. Undefined when the tap has not reported one. The directory gets the
 * same checks as every other read of this shared /tmp ground.
 */
export async function readStatusLineCost(key: string, dir: string = RUNTIME_DIR): Promise<number | undefined> {
  if (!SNAPSHOT_KEY_RE.test(key)) return undefined;
  if (!(await checkUsageDirectory(dir)).ok) return undefined;
  const path = join(dir, `${key}.json`);
  const st = await lstat(path).catch(() => null);
  if (!st || !st.isFile() || st.size > MAX_SNAPSHOT_BYTES) return undefined;
  try {
    const snap = JSON.parse(await readFile(path, 'utf8')) as { cost?: { usd?: unknown } | null };
    const usd = snap?.cost?.usd;
    return typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? usd : undefined;
  } catch {
    return undefined;
  }
}
