// sessionMemory.ts — how much memory each session's terminal holds (Oct 28 2026, by request).
//
// macOS charges every process an app starts to that app, so the "out of application memory" dialog
// showed AASC at 10 GB while AASC itself held ~650 MB: the rest was the Claude/Codex CLIs (and their
// MCP servers) running in its PTYs. This answers "which session is using it":
//
//   GET /api/session-memory → { ok, at, totalBytes, appBytes, bySession: { [sessionId]: bytes }, asleep }
//
// One `ps` run (async execFile, never on the event loop) gives every process's parent and resident size;
// each terminal's shell pid is summed with all its descendants. `totalBytes` is the whole tree under this
// server process (in Electron that includes the renderer and GPU helpers), and `appBytes` is that total
// minus the sessions'. Resident size, not macOS's footprint (which also counts compressed memory), so
// the UI labels it "≈". A sample is reused for SAMPLE_TTL_MS: nothing samples while nobody asks.

import { execFile } from 'child_process';
import { Router } from 'express';
import type { Request, Response } from 'express';
import log from './logger.js';
import { isLocalRequest } from './requestLocality.js';

export const SAMPLE_TTL_MS = 10_000;
const PS_TIMEOUT_MS = 5_000;

export interface ProcRow {
  pid: number;
  ppid: number;
  rssKb: number;
}

export interface MemorySample {
  at: number;
  totalBytes: number;
  appBytes: number;
  bySession: Record<string, number>;
  asleep: number;
}

/** `ps -axo pid=,ppid=,rss=` output → rows; lines that are not three whole numbers are skipped. */
export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, ppid, rssKb] = parts.slice(0, 3).map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(rssKb)) continue;
    rows.push({ pid, ppid, rssKb });
  }
  return rows;
}

/** Bytes held by `rootPid` and every process below it. A pid that is not running is 0. */
export function treeBytes(rows: readonly ProcRow[], rootPid: number): number {
  const children = new Map<number, ProcRow[]>();
  const byPid = new Map<number, ProcRow>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const root = byPid.get(rootPid);
  if (!root) return 0;
  let kb = 0;
  const seen = new Set<number>();
  const stack: ProcRow[] = [root];
  while (stack.length > 0) {
    const row = stack.pop()!;
    if (seen.has(row.pid)) continue;
    seen.add(row.pid);
    kb += row.rssKb;
    for (const child of children.get(row.pid) ?? []) stack.push(child);
  }
  return kb * 1024;
}

export interface SessionLike {
  sessionId: string;
  terminalId?: string | null;
  opsTerminalId?: string | null;
  asleepAt?: number;
}

/** The sample from one `ps` reading: each session's terminals (agent + ops shell), the whole tree, AASC's share. */
export function buildSample(
  rows: readonly ProcRow[],
  serverPid: number,
  terminals: ReadonlyArray<{ terminalId: string; pid: number }>,
  sessions: readonly SessionLike[],
  at: number,
): MemorySample {
  const pidOf = new Map(terminals.map((t) => [t.terminalId, t.pid]));
  const bySession: Record<string, number> = {};
  let sessionsBytes = 0;
  let asleep = 0;
  for (const s of sessions) {
    if (s.asleepAt) asleep++;
    let bytes = 0;
    for (const id of [s.terminalId, s.opsTerminalId]) {
      const pid = id ? pidOf.get(id) : undefined;
      if (pid) bytes += treeBytes(rows, pid);
    }
    if (bytes > 0) {
      bySession[s.sessionId] = bytes;
      sessionsBytes += bytes;
    }
  }
  const totalBytes = Math.max(treeBytes(rows, serverPid), sessionsBytes);
  return { at, totalBytes, appBytes: Math.max(0, totalBytes - sessionsBytes), bySession, asleep };
}

function readPs(): Promise<ProcRow[]> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(parsePs(stdout));
    });
  });
}

export interface SessionMemoryDeps {
  terminals: () => Array<{ terminalId: string; pid: number }>;
  sessions: () => SessionLike[];
  serverPid?: number;
  readProcs?: () => Promise<ProcRow[]>;
  now?: () => number;
  isLocal?: (req: Request) => boolean;
}

export function createSessionMemory(deps: SessionMemoryDeps) {
  const readProcs = deps.readProcs ?? readPs;
  const now = deps.now ?? Date.now;
  const serverPid = deps.serverPid ?? process.pid;
  let cached: MemorySample | null = null;
  let inFlight: Promise<MemorySample> | null = null;

  async function sample(): Promise<MemorySample> {
    if (cached && now() - cached.at < SAMPLE_TTL_MS) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const rows = await readProcs();
        cached = buildSample(rows, serverPid, deps.terminals(), deps.sessions(), now());
        return cached;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const isLocal = deps.isLocal ?? ((req: Request) => isLocalRequest(req));
  const router = Router();
  router.get('/session-memory', async (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    try {
      res.json({ ok: true, ...(await sample()) });
    } catch (err) {
      log.warn('memory', `Sampling session memory failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(503).json({ ok: false, error: 'Memory reading unavailable' });
    }
  });

  return { sample, router };
}
