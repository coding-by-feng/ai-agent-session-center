/**
 * @module sessionChanges
 * What a session edited, built from the edit calls in its own transcript (AASC-44). Reads no file
 * but the transcript: nothing a phone couldn't already read there.
 *
 * Claude: Edit, MultiEdit, Write and NotebookEdit calls whose result came back without an error
 * (a failed, declined or still-waiting edit changed nothing). The result's `toolUseResult` carries
 * Claude Code's own diff with real line numbers; without it, the edit's old → new text is diffed,
 * a first Write counts as all added, a later one is diffed against the content the transcript last
 * showed, and an overwrite of content it never showed is "replaced".
 *
 * Codex: the FileChange items it records (a unified diff per file); a rollout without them (older
 * Codex) is read from its `apply_patch` calls that succeeded. Never both, so no edit counts twice.
 *
 * Transcripts get big, so the file is scanned forward once and the tally kept: the next request
 * reads only what was appended (a replaced or shortened file starts over). Only lines that can hold
 * an edit, or the result of one being waited for, are parsed.
 */
import { open, type FileHandle } from 'node:fs/promises';
import type { TranscriptLocation } from './transcriptLocator.js';
import { ChangeSet, type ChangesSnapshot, type FileEdit } from './changeSet.js';
import {
  allAdded,
  allRemoved,
  contentHunks,
  hunksFrom,
  parseApplyPatch,
  rewriteHunks,
  snippetHunks,
  unifiedHunks,
  type PatchOp,
} from './diffHunks.js';
import { parseArgs, shellPatch, toolOutput } from './codexTranscript.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Reads a transcript's records one at a time and keeps the tally. */
interface Scanner {
  /** Could this raw line matter? (Cheap: most lines are never parsed.) */
  wants(line: string): boolean;
  consume(record: unknown, at: number): void;
  snapshot(): ChangesSnapshot;
}

const TOOL_USE_ID_RE = /"tool_use_id"\s*:\s*"([^"]+)"/g;
const CALL_ID_RE = /"call_id"\s*:\s*"([^"]+)"/g;

function mentionsPending(line: string, re: RegExp, pending: ReadonlyMap<string, unknown>): boolean {
  if (pending.size === 0) return false;
  for (const m of line.matchAll(re)) if (pending.has(m[1])) return true;
  return false;
}

// ── Claude ───────────────────────────────────────────────────────────────────

const CLAUDE_EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const CLAUDE_EDIT_CALL_RE = /"name"\s*:\s*"(?:Edit|MultiEdit|Write|NotebookEdit)"/;

/** `text` with `from` replaced by `to` (all of them, or the first), or null when `from` isn't there. */
function replaced(text: string | null, from: string, to: string, all: boolean): string | null {
  if (text === null || from === '' || !text.includes(from)) return null;
  return all ? text.split(from).join(to) : text.replace(from, () => to);
}

class ClaudeScanner implements Scanner {
  private readonly pending = new Map<string, { name: string; input: Rec }>();
  constructor(private readonly changes: ChangeSet) {}

  wants(line: string): boolean {
    return CLAUDE_EDIT_CALL_RE.test(line) || mentionsPending(line, TOOL_USE_ID_RE, this.pending);
  }

  consume(record: unknown, at: number): void {
    if (!isRec(record) || record.isSidechain === true || !isRec(record.message)) return;
    const content = record.message.content;
    if (!Array.isArray(content)) return;
    if (record.type === 'assistant') {
      for (const b of content) {
        if (isRec(b) && b.type === 'tool_use' && CLAUDE_EDIT_TOOLS.has(str(b.name)) && isRec(b.input)) {
          this.pending.set(str(b.id), { name: str(b.name), input: b.input });
        }
      }
      return;
    }
    if (record.type !== 'user') return;
    const results = content.filter((b): b is Rec => isRec(b) && b.type === 'tool_result');
    // The record-level result belongs to its tool result only when there is just one.
    const cli = results.length === 1 && isRec(record.toolUseResult) ? record.toolUseResult : null;
    for (const result of results) {
      const call = this.pending.get(str(result.tool_use_id));
      if (!call) continue;
      this.pending.delete(str(result.tool_use_id));
      if (result.is_error !== true) this.applyEdit(call.name, call.input, cli, at);
    }
  }

  private applyEdit(name: string, input: Rec, cli: Rec | null, at: number): void {
    const cliHunks = hunksFrom(cli?.structuredPatch);
    if (name === 'Edit' || name === 'MultiEdit') {
      const path = str(input.file_path);
      if (!path) return;
      const edits = name === 'Edit' ? [input] : Array.isArray(input.edits) ? input.edits.filter(isRec) : [];
      let content = typeof cli?.originalFile === 'string' ? cli.originalFile : this.changes.contentOf(path);
      for (const e of edits) content = replaced(content, str(e.old_string), str(e.new_string), e.replace_all === true);
      if (cliHunks && cliHunks.length > 0) {
        this.changes.apply(path, { hunks: cliHunks, content }, at);
        return;
      }
      let rewritten = false;
      const hunks = edits.flatMap((e) => {
        const before = str(e.old_string);
        const after = str(e.new_string);
        const h = snippetHunks(before, after);
        if (h) return h;
        rewritten = true;
        return rewriteHunks(before, after, false);
      });
      this.changes.apply(path, { hunks, content, ...(rewritten ? { replaced: true } : {}) }, at);
      return;
    }
    if (name === 'Write') {
      const path = str(input.file_path);
      if (path) this.changes.apply(path, this.writeEdit(path, str(input.content), cli, cliHunks), at);
      return;
    }
    if (name === 'NotebookEdit') {
      const path = str(input.notebook_path);
      if (!path) return;
      const mode = str(input.edit_mode) || 'replace';
      const hunks = mode === 'delete' ? [] : allAdded(str(input.new_source)).map((h) => ({ ...h, newStart: 0 }));
      this.changes.apply(path, { hunks, replaced: mode === 'replace', content: null }, at);
    }
  }

  private writeEdit(path: string, content: string, cli: Rec | null, cliHunks: ReturnType<typeof hunksFrom>): FileEdit {
    if (cliHunks && cliHunks.length > 0) return { hunks: cliHunks, content };
    const before = this.changes.contentOf(path) ?? (typeof cli?.originalFile === 'string' ? cli.originalFile : null);
    if (before !== null) {
      const hunks = contentHunks(before, content);
      return hunks ? { hunks, content } : { hunks: rewriteHunks(before, content, true), replaced: true, content };
    }
    if (cli?.type === 'update') return { hunks: [], content };
    if (this.changes.has(path)) return { hunks: allAdded(content), replaced: true, content };
    return { hunks: allAdded(content), created: true, content };
  }

  snapshot(): ChangesSnapshot {
    return this.changes.snapshot();
  }
}

// ── Codex ────────────────────────────────────────────────────────────────────

const CODEX_EDIT_RE = /"FileChange"|apply_patch/;

class CodexScanner implements Scanner {
  private readonly pending = new Map<string, string>();
  private sawFileChange = false;
  constructor(
    private readonly fromItems: ChangeSet,
    private readonly fromPatches: ChangeSet,
  ) {}

  wants(line: string): boolean {
    return CODEX_EDIT_RE.test(line) || mentionsPending(line, CALL_ID_RE, this.pending);
  }

  consume(record: unknown, at: number): void {
    if (!isRec(record) || !isRec(record.payload)) return;
    const p = record.payload;
    if (record.type === 'event_msg' && p.type === 'item_completed' && isRec(p.item) && p.item.type === 'FileChange') {
      this.sawFileChange = true;
      if (p.item.status === 'completed' && isRec(p.item.changes)) this.applyFileChange(p.item.changes, at);
      return;
    }
    if (record.type !== 'response_item') return;
    if (p.type === 'custom_tool_call' && p.name === 'apply_patch') {
      this.pending.set(str(p.call_id), str(p.input));
    } else if (p.type === 'function_call') {
      const patch = shellPatch(parseArgs(p.arguments));
      if (patch !== null) this.pending.set(str(p.call_id), patch);
    } else if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      const patch = this.pending.get(str(p.call_id));
      if (patch === undefined) return;
      this.pending.delete(str(p.call_id));
      if (!toolOutput(p.output).isError) for (const op of parseApplyPatch(patch)) this.applyPatchOp(op, at);
    }
  }

  private applyFileChange(changes: Rec, at: number): void {
    for (const [path, change] of Object.entries(changes)) {
      if (!isRec(change)) continue;
      if (change.type === 'add') {
        this.fromItems.apply(path, { hunks: allAdded(str(change.content)), created: true, content: str(change.content) }, at);
      } else if (change.type === 'delete') {
        this.fromItems.apply(path, { hunks: allRemoved(str(change.content)), deleted: true, content: null }, at);
      } else if (change.type === 'update') {
        const target = str(change.move_path) || path;
        this.fromItems.apply(target, { hunks: unifiedHunks(str(change.unified_diff)), content: null }, at);
      }
    }
  }

  private applyPatchOp(op: PatchOp, at: number): void {
    const target = op.movePath || op.path;
    this.fromPatches.apply(target, {
      hunks: op.hunks,
      content: null,
      ...(op.kind === 'add' ? { created: true } : {}),
      ...(op.kind === 'delete' ? { deleted: true } : {}),
    }, at);
  }

  snapshot(): ChangesSnapshot {
    return (this.sawFileChange ? this.fromItems : this.fromPatches).snapshot();
  }
}

// ── Scanning, with the tally kept between requests ───────────────────────────

const CHUNK = 1024 * 1024;
const NEWLINE = 0x0a;

interface Tally {
  tag: string;
  /** Bytes consumed: everything before it was read (whole lines only). */
  offset: number;
  /** The bytes just before `offset`, to notice a file rewritten in place (same inode, other content). */
  tail: Buffer;
  lastAt: number;
  scanner: Scanner;
}

const TAIL_BYTES = 64;

const CACHE_MAX = 8;
const tallies = new Map<string, Tally>();
const queues = new Map<string, Promise<unknown>>();

function newScanner(cli: TranscriptLocation['cli'], projectPath: string): Scanner {
  return cli === 'codex'
    ? new CodexScanner(new ChangeSet(projectPath), new ChangeSet(projectPath))
    : new ClaudeScanner(new ChangeSet(projectPath));
}

function recordTime(record: unknown): number {
  return isRec(record) && typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
}

/** Feed the scanner every whole line from `tally.offset` to the last newline. */
async function scanFrom(fh: FileHandle, size: number, tally: Tally): Promise<void> {
  let carry: Buffer = Buffer.alloc(0);
  let at = tally.offset;
  while (at < size) {
    const len = Math.min(CHUNK, size - at);
    const chunk = Buffer.alloc(len);
    const { bytesRead } = await fh.read(chunk, 0, len, at);
    if (bytesRead === 0) break;
    at += bytesRead;
    const buf = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    let start = 0;
    for (let nl = buf.indexOf(NEWLINE); nl >= 0; nl = buf.indexOf(NEWLINE, start)) {
      const line = buf.toString('utf8', start, nl);
      start = nl + 1;
      if (!line.trim() || !tally.scanner.wants(line)) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const own = recordTime(record);
      if (Number.isFinite(own)) tally.lastAt = own;
      tally.scanner.consume(record, tally.lastAt);
    }
    carry = buf.subarray(start);
    tally.offset = at - carry.length;
  }
}

async function readTail(fh: FileHandle, offset: number): Promise<Buffer> {
  const from = Math.max(0, offset - TAIL_BYTES);
  const buf = Buffer.alloc(offset - from);
  const { bytesRead } = await fh.read(buf, 0, buf.length, from);
  return buf.subarray(0, bytesRead);
}

/** Can the kept tally continue on this file, or must the scan start over? */
async function stillValid(fh: FileHandle, tally: Tally | undefined, tag: string, size: number): Promise<boolean> {
  if (!tally || tally.tag !== tag || tally.offset > size) return false;
  return (await readTail(fh, tally.offset)).equals(tally.tail);
}

async function build(location: TranscriptLocation, projectPath: string): Promise<ChangesSnapshot> {
  const key = `${location.cli}\0${location.path}\0${projectPath}`;
  const fh = await open(location.path, 'r');
  try {
    const st = await fh.stat();
    const tag = `${st.dev}-${st.ino}`;
    const kept = tallies.get(key);
    const tally: Tally = kept && (await stillValid(fh, kept, tag, st.size))
      ? kept
      : { tag, offset: 0, tail: Buffer.alloc(0), lastAt: 0, scanner: newScanner(location.cli, projectPath) };
    await scanFrom(fh, st.size, tally);
    tally.tail = await readTail(fh, tally.offset);
    tallies.delete(key);
    tallies.set(key, tally);
    if (tallies.size > CACHE_MAX) tallies.delete(tallies.keys().next().value as string);
    return tally.scanner.snapshot();
  } finally {
    await fh.close();
  }
}

/**
 * What the session whose transcript is at `location` edited. Builds for the same transcript run one
 * after another (they share the kept tally).
 */
export function buildSessionChanges(location: TranscriptLocation, projectPath: string): Promise<ChangesSnapshot> {
  const key = `${location.cli}\0${location.path}\0${projectPath}`;
  const run = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(() => build(location, projectPath));
  queues.set(key, run);
  void run.finally(() => {
    if (queues.get(key) === run) queues.delete(key);
  }).catch(() => undefined);
  return run;
}
