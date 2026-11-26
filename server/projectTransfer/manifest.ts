/**
 * The source side's scan: one project folder, its Claude Code project folder, its Codex rollouts and
 * (P2) its AASC data, as a list of items with their SHA-256 (docs/plans/project-transfer.md).
 *
 * Links are never followed. A link inside the project is carried only when it is relative and stays
 * inside the project; memory folders carry plain files only.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GroupTotals,
  TransferGroup,
  TransferItem,
  TransferOptions,
  TransferPlanSummary,
} from '../../src/types/projectTransfer.js';
import { pathLooksSecret } from '../mobile/secretPaths.js';
import {
  claudeProjectDirName,
  claudeProjectsRoot,
  codexSessionsRoot,
  isGitHookPath,
  isStagingName,
} from './paths.js';
import { codexRolloutCwd } from './rekey.js';

/** An item and where its bytes are on this computer. */
export interface PlanEntry extends TransferItem {
  abs: string;
}

export const MAX_ITEMS = 500_000;
const SKIP_LIST_MAX = 50;
const HASH_CONCURRENCY = 8;
const FIRST_LINE_MAX = 64 * 1024;

/** Folders AASC itself keeps beside or inside a project: never part of it. */
const AASC_OWN = (name: string): boolean =>
  isStagingName(name) || name === '.aasc-project-sync' || /^\.aasc-(?:git-[0-9a-f]+\.lock|clone-.*)$/.test(name);

export class ScanError extends Error {
  constructor(message: string, readonly code = 'scan_failed') {
    super(message);
  }
}

/** Permission bits as both sides write them: never group/other-writable, credentials owner-only. */
export function normalMode(rel: string, mode: number, kind: TransferItem['kind']): number {
  if (kind === 'symlink') return 0o777;
  if (kind === 'file' && pathLooksSecret(rel)) return mode & 0o700;
  return mode & 0o755;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * A relative link that provably stays inside the project, as `/`-separated text; else null.
 *
 * Only `..` parts at the start, no more of them than the link's own folder is deep, then plain
 * names. A lexical check like `normalize(join(dir, target))` is not enough: it folds `s/..` away,
 * but the system follows `s` first (a link to `.` makes `s/..` the folder above), so a chain of
 * such links reached the user's home (security review, Nov 27 2026). With climbs only at the
 * start, from a real folder (no item may sit under a link: `validateItems`), every link resolves
 * inside the project, and so does any link it points through.
 */
export function linkInside(rel: string, target: string): string | null {
  if (!target || target.includes('\0') || target.startsWith('/') || target.includes('\\')) return null;
  const parts = target.split('/');
  let climbs = 0;
  while (climbs < parts.length && parts[climbs] === '..') climbs++;
  const names = parts.slice(climbs);
  if (names.length === 0) return null; // only climbs: a link to a folder above itself
  if (names.some((p) => p === '' || p === '.' || p === '..')) return null;
  const depth = rel.split('/').length - 1;
  return climbs <= depth ? target : null;
}

interface Collector {
  entries: PlanEntry[];
  skipped: { rel: string; reason: string }[];
  skippedCount: number;
}

function skip(c: Collector, rel: string, reason: string): void {
  c.skippedCount++;
  if (c.skipped.length < SKIP_LIST_MAX) c.skipped.push({ rel, reason });
}

function push(c: Collector, entry: Omit<PlanEntry, 'i'>): void {
  if (c.entries.length >= MAX_ITEMS) {
    throw new ScanError('More than 500,000 files. Leave out node_modules or split the project.', 'too_many');
  }
  c.entries.push({ ...entry, i: c.entries.length });
}

async function walkProject(root: string, options: TransferOptions, c: Collector): Promise<void> {
  const stack: string[] = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(root, ...relDir.split('/')) : root;
    let names: string[];
    try {
      names = (await readdir(absDir)).sort();
    } catch {
      skip(c, relDir || '.', 'Could not read this folder.');
      continue;
    }
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      if (AASC_OWN(name)) continue;
      if (isGitHookPath(rel)) continue;
      const abs = join(absDir, name);
      let st;
      try {
        st = await lstat(abs);
      } catch {
        continue; // gone since the listing
      }
      if (st.isDirectory()) {
        if (name === 'node_modules' && !options.includeNodeModules) {
          skip(c, rel, 'node_modules is left out (built for this computer).');
          continue;
        }
        push(c, { group: 'project', rel, kind: 'dir', size: 0, mode: normalMode(rel, st.mode, 'dir'), sha256: null, abs });
        stack.push(rel);
      } else if (st.isFile()) {
        push(c, { group: 'project', rel, kind: 'file', size: st.size, mode: normalMode(rel, st.mode, 'file'), sha256: null, abs });
      } else if (st.isSymbolicLink()) {
        const target = await readlink(abs).catch(() => '');
        const inside = linkInside(rel, target);
        if (!inside) {
          skip(c, rel, 'The link points outside the project, or takes a roundabout way (such as ./x or a/../b).');
          continue;
        }
        push(c, { group: 'project', rel, kind: 'symlink', size: 0, mode: 0o777, sha256: null, abs, linkTarget: inside });
      } else {
        skip(c, rel, 'Not a file, folder or link.');
      }
    }
  }
}

/** Plain files under `base`, as `group` items (links and special files are left out). */
async function walkFiles(base: string, group: TransferGroup, c: Collector, accept: (rel: string) => boolean = () => true): Promise<void> {
  try {
    if (!(await lstat(base)).isDirectory()) return;
  } catch {
    return;
  }
  const stack: string[] = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = relDir ? join(base, ...relDir.split('/')) : base;
    const names = (await readdir(absDir).catch(() => [] as string[])).sort();
    for (const name of names) {
      const rel = relDir ? `${relDir}/${name}` : name;
      const abs = join(absDir, name);
      const st = await lstat(abs).catch(() => null);
      if (!st) continue;
      if (st.isDirectory()) stack.push(rel);
      else if (st.isFile() && accept(rel)) {
        push(c, { group, rel, kind: 'file', size: st.size, mode: st.mode & 0o600, sha256: null, abs });
      }
    }
  }
}

async function firstLine(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(FIRST_LINE_MAX);
    const { bytesRead } = await handle.read(buf, 0, FIRST_LINE_MAX, 0);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const end = text.indexOf('\n');
    return end === -1 ? text : text.slice(0, end);
  } finally {
    await handle.close();
  }
}

const insideRoot = (cwd: string, root: string): boolean => cwd === root || cwd.startsWith(root + '/');

/** Codex rollouts whose session ran in the project (or a folder inside it). */
async function walkCodex(sessions: string, root: string, c: Collector): Promise<void> {
  const numbered = async (dir: string, re: RegExp): Promise<string[]> =>
    (await readdir(dir).catch(() => [] as string[])).filter((n) => re.test(n)).sort();
  for (const year of await numbered(sessions, /^\d{4}$/)) {
    for (const month of await numbered(join(sessions, year), /^\d{2}$/)) {
      for (const day of await numbered(join(sessions, year, month), /^\d{2}$/)) {
        const dir = join(sessions, year, month, day);
        for (const name of await numbered(dir, /^rollout-[\w.:-]{1,200}\.jsonl$/)) {
          const abs = join(dir, name);
          const st = await lstat(abs).catch(() => null);
          if (!st?.isFile()) continue;
          const cwd = codexRolloutCwd(await firstLine(abs).catch(() => ''));
          if (!cwd || !insideRoot(cwd, root)) continue;
          push(c, { group: 'codex', rel: `${year}/${month}/${day}/${name}`, kind: 'file', size: st.size, mode: 0o600, sha256: null, abs });
        }
      }
    }
  }
}

async function hashAll(entries: PlanEntry[]): Promise<void> {
  const files = entries.filter((e) => e.kind === 'file');
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length) {
      const entry = files[next++];
      try {
        entry.sha256 = await sha256File(entry.abs);
      } catch {
        throw new ScanError(`Could not read ${entry.rel}.`, 'read_failed');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, worker));
}

export interface ScanInput {
  root: string;
  options: TransferOptions;
  /** P2: the AASC bundle file and media to carry, already written by the caller. */
  aasc?: { bundlePath: string; bundleSize: number; media: { rel: string; abs: string; size: number }[] } | null;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface ScanResult {
  entries: PlanEntry[];
  skipped: { rel: string; reason: string }[];
  skippedCount: number;
}

export async function scanProject(input: ScanInput): Promise<ScanResult> {
  const c: Collector = { entries: [], skipped: [], skippedCount: 0 };
  await walkProject(input.root, input.options, c);
  if (input.options.memory) {
    const claudeDir = join(claudeProjectsRoot(input.env, input.home), claudeProjectDirName(input.root));
    await walkFiles(claudeDir, 'claude', c);
    await walkCodex(codexSessionsRoot(input.env, input.home), input.root, c);
  }
  if (input.aasc) {
    push(c, { group: 'aasc', rel: 'bundle.json', kind: 'file', size: input.aasc.bundleSize, mode: 0o600, sha256: null, abs: input.aasc.bundlePath });
    for (const m of input.aasc.media) {
      push(c, { group: 'aasc', rel: m.rel, kind: 'file', size: m.size, mode: 0o600, sha256: null, abs: m.abs });
    }
  }
  await hashAll(c.entries);
  return { entries: c.entries, skipped: c.skipped, skippedCount: c.skippedCount };
}

const zero = (): GroupTotals => ({ files: 0, bytes: 0 });

export function summarize(
  scan: ScanResult,
  extra: Pick<TransferPlanSummary, 'workingAgents' | 'aasc'>,
): TransferPlanSummary {
  const byGroup: Record<TransferGroup, GroupTotals> = { project: zero(), claude: zero(), codex: zero(), aasc: zero() };
  let files = 0;
  let bytes = 0;
  for (const e of scan.entries) {
    if (e.kind !== 'file') continue;
    files++;
    bytes += e.size;
    byGroup[e.group].files++;
    byGroup[e.group].bytes += e.size;
  }
  return { files, bytes, byGroup, skipped: scan.skipped, skippedCount: scan.skippedCount, ...extra };
}

/** The item as it goes on the wire: no local path. */
export function publicItem(e: PlanEntry): TransferItem {
  const { abs: _abs, ...item } = e;
  return item;
}
