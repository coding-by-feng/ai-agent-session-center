// subagentTranscript.ts — one subagent's own conversation, for the AGENTS tab.
//
// Clicking a subagent card opens its task, its replies and tool calls, and its
// result. The server's run record (subagentTracker.ts) keeps a one-line
// description and a tool count; the conversation itself is on disk: Claude Code
// writes each subagent to
//   <session transcript without .jsonl>/subagents/agent-<agentId>.jsonl
// (SubagentStop's `agent_transcript_path` names exactly this file), with a
// `.meta.json` beside it. The first line is the prompt the leader gave it.
//
// Those files get big (18 MB was seen), so a page is read from the END of the
// file inside a byte budget and never whole: the newest entries first, then
// `before=<start>` for the page before that. `from=<start>` re-reads from a
// page start to the end, which is how a live view refreshes above history it
// has already loaded without leaving a gap.
//
// Mounted on the API router AFTER its `/sessions/:id` visibility gate: the
// transcript is that session's content, so a remote device reads it only for a
// session it may see.

import { open, readdir, realpath, stat, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Session } from '../src/types/index.js';
import {
  claudeProjectsRoot,
  projectDirCandidates,
  transcriptLineEntries,
  transcriptLineTimestamp,
  type ConversationEntry,
} from './extractPreviousAnswer.js';
import { markTranscriptSecrets } from './chat/transcriptMarks.js';
import log from './logger.js';

/** An agent id that is safe as a file-name part (Claude's are `a<hex>` or `a<name>-<hex>`). */
export const SUBAGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Same rule for a session directory name. */
const SESSION_DIR_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Entries in one backward page (a line's entries are never split, so a page can run a little over). */
export const PAGE_ENTRIES = 200;
/** Bytes one request may read for its page. */
export const SCAN_BYTES = 4 * 1024 * 1024;
/** How far into the file the first line (the task) is looked for. */
const TASK_SCAN_BYTES = 1024 * 1024;
const TASK_CHUNK_BYTES = 64 * 1024;
/** Resolved transcript paths kept between requests (a live view re-asks per tool call). */
const PATH_CACHE_MAX = 256;
/**
 * How long "no file for this run" is believed. A miss walks every conversation
 * folder of the project, and a live view asks again on every call the run makes.
 */
const MISS_TTL_MS = 10_000;
/** The task is sent with every page; a longer one is cut (with …). */
export const TASK_MAX_CHARS = 64 * 1024;
const NEWLINE = 0x0a;

export interface TranscriptOwner {
  sessionId: string;
  projectPath?: string | null;
  transcriptPath?: string | null;
}

export interface SubagentTranscriptPage {
  /** The prompt the leader gave the subagent (its transcript's first line), when that line is one. */
  task: string | null;
  /** Oldest first; never includes the task line. */
  entries: ConversationEntry[];
  /** Byte offset of the oldest line read: `before` for the page before this one, `from` to refresh it. */
  start: number;
  /** Lines older than `start` exist (after the task). */
  hasEarlier: boolean;
  /** A `from` refresh was too big for the budget: this is the newest page instead; drop older pages. */
  reset?: true;
}

export interface PageOptions {
  before?: number;
  from?: number;
  limit?: number;
  scanBytes?: number;
}

// ---------------------------------------------------------------------------
// Finding the file
// ---------------------------------------------------------------------------

const fileName = (agentId: string) => `agent-${agentId}.jsonl`;

/** Where the file is when the run belongs to the session's current conversation. */
function directCandidates(owner: TranscriptOwner, agentId: string): string[] {
  const out: string[] = [];
  const recorded = owner.transcriptPath;
  if (recorded && recorded.endsWith('.jsonl')) {
    out.push(join(dirname(recorded), basename(recorded, '.jsonl'), 'subagents', fileName(agentId)));
  }
  const id = owner.sessionId;
  if (owner.projectPath && SESSION_DIR_RE.test(id) && !id.startsWith('term-')) {
    for (const dir of projectDirCandidates(owner.projectPath)) out.push(join(dir, id, 'subagents', fileName(agentId)));
  }
  return out;
}

/**
 * Every conversation directory of the project: a run started before a /clear
 * or a resume sits under the conversation it ran in, not the current one.
 * Agent ids are random, so a file with this exact id is that run.
 */
async function projectWideCandidates(owner: TranscriptOwner, agentId: string, rootReal: string): Promise<string[]> {
  const dirs = new Set<string>();
  if (owner.transcriptPath) dirs.add(dirname(owner.transcriptPath));
  if (owner.projectPath) for (const dir of projectDirCandidates(owner.projectPath)) dirs.add(dir);
  const out: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      // Only folders inside the projects root are listed (the recorded path comes from a hook).
      if (!(await realpath(dir)).startsWith(rootReal + sep)) continue;
      names = await readdir(dir);
    } catch {
      continue;
    }
    // A `.jsonl` file fails the pattern (the dot), so only conversation dirs pass.
    for (const name of names) if (SESSION_DIR_RE.test(name)) out.push(join(dir, name, 'subagents', fileName(agentId)));
  }
  return out;
}

/** The file's real path when it is a regular file inside the projects root, else null. */
async function containedFile(candidate: string, rootReal: string): Promise<string | null> {
  try {
    const real = await realpath(candidate);
    if (!real.startsWith(rootReal + sep)) return null;
    return (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

const pathCache = new Map<string, string>();
const missCache = new Map<string, number>();

function remember(key: string, file: string): void {
  missCache.delete(key);
  pathCache.delete(key);
  pathCache.set(key, file);
  if (pathCache.size > PATH_CACHE_MAX) pathCache.delete(pathCache.keys().next().value as string);
}

function rememberMiss(key: string, at: number): void {
  missCache.delete(key);
  missCache.set(key, at);
  if (missCache.size > PATH_CACHE_MAX) missCache.delete(missCache.keys().next().value as string);
}

/**
 * The real path of the subagent's transcript, or null when there is none.
 * Only files inside ~/.claude/projects count: the recorded transcript path
 * comes from a hook payload, and a symlink must not lead the read elsewhere.
 */
export async function findSubagentTranscript(
  owner: TranscriptOwner,
  agentId: string,
  now: () => number = Date.now,
): Promise<string | null> {
  if (!SUBAGENT_ID_RE.test(agentId)) return null;
  let rootReal: string;
  try {
    rootReal = await realpath(claudeProjectsRoot());
  } catch {
    return null;
  }
  const key = `${rootReal}\0${owner.sessionId}\0${agentId}`;
  const cached = pathCache.get(key);
  if (cached && (await containedFile(cached, rootReal))) return cached;

  // The likely places are always looked at (they are a few stats); the
  // project-wide walk only once per MISS_TTL_MS for a run with no file.
  for (const candidate of directCandidates(owner, agentId)) {
    const file = await containedFile(candidate, rootReal);
    if (file) { remember(key, file); return file; }
  }
  const missedAt = missCache.get(key);
  if (missedAt !== undefined && now() - missedAt < MISS_TTL_MS) return null;
  for (const candidate of await projectWideCandidates(owner, agentId, rootReal)) {
    const file = await containedFile(candidate, rootReal);
    if (file) { remember(key, file); return file; }
  }
  rememberMiss(key, now());
  return null;
}

// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

async function readRange(fh: FileHandle, from: number, to: number): Promise<Buffer> {
  const length = Math.max(0, to - from);
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, from + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
  return buf.subarray(0, done);
}

interface Line {
  offset: number;
  text: string;
}

/**
 * The lines of `buf`, which starts at byte `base` of the file. Unless the
 * buffer starts at a line start, its first segment is the tail of a line that
 * began earlier and is dropped. A last segment with no newline is kept: it is
 * either the whole last line or a half-written one that will not parse.
 */
function splitLines(buf: Buffer, base: number, startsAtLine: boolean): Line[] {
  let at = 0;
  if (!startsAtLine) {
    const nl = buf.indexOf(NEWLINE);
    if (nl < 0) return [];
    at = nl + 1;
  }
  const lines: Line[] = [];
  while (at < buf.length) {
    const nl = buf.indexOf(NEWLINE, at);
    const stop = nl < 0 ? buf.length : nl;
    if (stop > at) lines.push({ offset: base + at, text: buf.toString('utf8', at, stop) });
    at = stop + 1;
  }
  return lines;
}

function parseLine(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The prompt text of a first line, or null when that line is not a user prompt. */
function taskText(line: unknown): string | null {
  const entries = transcriptLineEntries(line, 0);
  if (entries.length === 0 || entries.some((e) => e.role !== 'user')) return null;
  const text = entries.map((e) => (e.role === 'user' ? e.text : '')).join('\n');
  return text.length > TASK_MAX_CHARS ? `${text.slice(0, TASK_MAX_CHARS)}…` : text;
}

/** The task and the byte where the messages start (after the task line, or 0 when there is no task). */
async function readTask(fh: FileHandle, size: number): Promise<{ task: string | null; floor: number }> {
  const chunks: Buffer[] = [];
  let read = 0;
  while (read < Math.min(size, TASK_SCAN_BYTES)) {
    const chunk = await readRange(fh, read, Math.min(size, read + TASK_CHUNK_BYTES));
    if (chunk.length === 0) break;
    const nl = chunk.indexOf(NEWLINE);
    if (nl >= 0) {
      chunks.push(chunk.subarray(0, nl));
      const task = taskText(parseLine(Buffer.concat(chunks).toString('utf8')));
      return { task, floor: task === null ? 0 : read + nl + 1 };
    }
    chunks.push(chunk);
    read += chunk.length;
  }
  // No newline: a one-line file (the agent has only its task yet), or a first
  // line too long to look through (then it counts as an ordinary line).
  if (read === size && size > 0) {
    const task = taskText(parseLine(Buffer.concat(chunks).toString('utf8')));
    return { task, floor: task === null ? 0 : size };
  }
  return { task: null, floor: 0 };
}

/** Entries of parsed records in file order; a record without a time takes its neighbour's. */
function entriesOf(records: readonly unknown[]): ConversationEntry[] {
  const out: ConversationEntry[] = [];
  let lastTs = 0;
  for (const obj of records) {
    const own = transcriptLineTimestamp(obj);
    const ts = Number.isFinite(own) ? own : lastTs;
    lastTs = ts;
    out.push(...transcriptLineEntries(obj, ts));
  }
  return out;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * One page of a subagent transcript. With no `before`/`from`: the newest
 * `limit` entries, read backwards from the end inside `scanBytes`.
 */
export async function readSubagentTranscriptPage(file: string, opts: PageOptions = {}): Promise<SubagentTranscriptPage> {
  const limit = opts.limit ?? PAGE_ENTRIES;
  const scanBytes = opts.scanBytes ?? SCAN_BYTES;
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const { task, floor } = await readTask(fh, size);

    let reset = false;
    if (opts.from !== undefined) {
      const from = clamp(opts.from, floor, size);
      if (size - from <= scanBytes) {
        const lines = splitLines(await readRange(fh, from, size), from, true);
        return { task, entries: entriesOf(lines.map((l) => parseLine(l.text))), start: from, hasEarlier: from > floor };
      }
      reset = true;
    }

    const end = clamp(opts.before ?? size, floor, size);
    const base = Math.max(floor, end - scanBytes);
    const lines = splitLines(await readRange(fh, base, end), base, base === floor);
    // Newest first, whole lines, until the page is full.
    const records: unknown[] = [];
    let first = lines.length;
    let count = 0;
    while (first > 0 && count < limit) {
      first -= 1;
      const obj = parseLine(lines[first].text);
      records.unshift(obj);
      count += transcriptLineEntries(obj, 0).length;
    }
    // A window holding no line start (one line longer than the budget) still
    // moves the next page back, past the part it skipped.
    const start = first < lines.length ? lines[first].offset : base;
    return {
      task,
      entries: entriesOf(records),
      start,
      hasEarlier: start > floor,
      ...(reset ? { reset: true as const } : {}),
    };
  } finally {
    await fh.close();
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

const offset = z.string().regex(/^\d{1,15}$/).transform(Number);
const querySchema = z
  .object({ before: offset.optional(), from: offset.optional() })
  .refine((q) => q.before === undefined || q.from === undefined);

export interface SubagentTranscriptRouterDeps {
  getSession: (sessionId: string) => Session | undefined | null;
}

export function createSubagentTranscriptRouter(deps: SubagentTranscriptRouterDeps): Router {
  const router = Router();

  router.get('/sessions/:id/subagents/:agentId/transcript', async (req: Request, res: Response) => {
    try {
      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ success: false, error: 'before and from are byte offsets, and only one is allowed' });
        return;
      }
      const session = deps.getSession(String(req.params.id));
      if (!session) {
        res.status(404).json({ success: false, error: 'Session not found' });
        return;
      }
      // Only the session's own runs: a known run is what makes the file its content.
      const agentId = String(req.params.agentId);
      if (!SUBAGENT_ID_RE.test(agentId) || !(session.subagents ?? []).some((r) => r.agentId === agentId)) {
        res.status(404).json({ success: false, error: 'Subagent not found' });
        return;
      }
      const file = await findSubagentTranscript(
        { sessionId: session.sessionId, projectPath: session.projectPath, transcriptPath: session.transcriptPath },
        agentId,
      );
      if (!file) {
        res.json({ success: true, data: null });
        return;
      }
      const page = await readSubagentTranscriptPage(file, query.data);
      // Marked like the session transcript, so the phone profile can hide what a subagent
      // read from a secret file from a paired phone (AASC-41).
      const entries = await markTranscriptSecrets(page.entries, { cli: 'claude', path: file }, session.projectPath);
      res.json({ success: true, data: { ...page, entries } });
    } catch (err) {
      log.warn('api', `subagent transcript read failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ success: false, error: 'Could not read the subagent transcript' });
    }
  });

  return router;
}
