/**
 * The source side of a project transfer (docs/plans/project-transfer.md): plans (a scan of one
 * project, kept here so a pack names files by index and no local path ever leaves this computer),
 * the packs Electron main pipes to the target, and the checks and marker of a Move.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  AascBundleCounts, TransferItem, TransferOptions, TransferPlanInfo,
} from '../../src/types/projectTransfer.js';
import { confinedProjectPath } from '../cloud/projectPaths.js';
import { publicItem, scanProject, summarize, type PlanEntry } from './manifest.js';
import { claudeProjectDirName, claudeProjectsRoot, homeRelative } from './paths.js';
import { TransferError } from './errors.js';

/** What the P2 module answers for a project's AASC data. */
export interface ExportedAascData {
  bundle: unknown;
  media: { rel: string; abs: string; size: number }[];
  counts: AascBundleCounts;
}

export interface SenderDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Folders with an agent mid-turn right now (`workingProjectPaths`). */
  workingPaths(): string[];
  exportAasc?(root: string): ExportedAascData;
  /** Where plans keep their bundle files; the system temp folder by default. */
  tmpRoot?: string;
}

interface Plan {
  id: string;
  root: string;
  options: TransferOptions;
  entries: PlanEntry[];
  createdAt: number;
  tmpDir: string | null;
}

const MAX_PLANS = 4;
const PLAN_TTL_MS = 6 * 60 * 60_000;
/** One pack: at most this many bytes or files, so a failure costs little to resend. */
export const PACK_MAX_BYTES = 64 * 1024 * 1024;
export const PACK_MAX_FILES = 2_000;

/** Is `path` the folder or inside it? */
const within = (path: string, root: string): boolean => path === root || path.startsWith(root + '/');

export function workingAgentsIn(root: string, working: string[]): number {
  return working.filter((p) => within(p, root)).length;
}

export function createSender(deps: SenderDeps) {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const plans = new Map<string, Plan>();

  async function drop(plan: Plan): Promise<void> {
    plans.delete(plan.id);
    if (plan.tmpDir) await rm(plan.tmpDir, { recursive: true, force: true });
  }

  async function prune(): Promise<void> {
    for (const plan of [...plans.values()]) if (now() - plan.createdAt > PLAN_TTL_MS) await drop(plan);
    const byAge = [...plans.values()].sort((a, b) => a.createdAt - b.createdAt);
    while (byAge.length >= MAX_PLANS) await drop(byAge.shift()!);
  }

  async function confinedRoot(root: unknown): Promise<string> {
    if (typeof root !== 'string') throw new TransferError('Choose a project folder.', 'path_not_allowed', 400);
    try {
      return await confinedProjectPath(root, home);
    } catch (err) {
      throw new TransferError((err as Error).message, 'path_not_allowed', 400);
    }
  }

  async function plan(rootIn: unknown, options: TransferOptions): Promise<TransferPlanInfo> {
    const root = await confinedRoot(rootIn);
    if (!(await stat(root)).isDirectory()) throw new TransferError('That is not a folder.', 'path_not_allowed', 400);
    await prune();
    const id = randomUUID();
    let tmpDir: string | null = null;
    let aascInput: Parameters<typeof scanProject>[0]['aasc'] = null;
    let aascCounts: AascBundleCounts | null = null;
    try {
      if (options.aasc && deps.exportAasc) {
        const exported = deps.exportAasc(root);
        tmpDir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'aasc-transfer-'));
        const bundlePath = join(tmpDir, 'bundle.json');
        const text = JSON.stringify(exported.bundle);
        await writeFile(bundlePath, text, { mode: 0o600 });
        aascInput = { bundlePath, bundleSize: Buffer.byteLength(text), media: exported.media };
        aascCounts = exported.counts;
      }
      const scan = await scanProject({ root, options, aasc: aascInput, env: deps.env, home });
      const entry: Plan = { id, root, options, entries: scan.entries, createdAt: now(), tmpDir };
      plans.set(id, entry);
      return {
        planId: id,
        root,
        name: basename(root),
        homeRelative: homeRelative(root, home) ?? basename(root),
        summary: summarize(scan, { workingAgents: workingAgentsIn(root, deps.workingPaths()), aasc: aascCounts }),
      };
    } catch (err) {
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
      if (err instanceof TransferError) throw err;
      throw new TransferError((err as Error).message, (err as { code?: string }).code ?? 'scan_failed', 500);
    }
  }

  function get(planId: string): Plan {
    const p = plans.get(planId);
    if (!p) throw new TransferError('That plan has expired. Measure the project again.', 'unknown_plan', 404);
    return p;
  }

  function items(planId: string): { root: string; items: TransferItem[] } {
    const p = get(planId);
    return { root: p.root, items: p.entries.map(publicItem) };
  }

  /** The files a pack names, with their paths here; refuses an index that isn't a file. */
  function packFiles(planId: string, indexes: number[]): { abs: string; size: number }[] {
    const p = get(planId);
    return indexes.map((i) => {
      const e = p.entries[i];
      if (!e || e.kind !== 'file') throw new TransferError('A pack may name files only.', 'invalid_pack', 400);
      return { abs: e.abs, size: e.size };
    });
  }

  /**
   * Move, after the target committed: the folder and its Claude Code project folder go to the Trash
   * (Electron main does that with the system Trash), unless an agent is mid-turn in the folder.
   */
  async function moveCheck(planId: string): Promise<{ root: string; trash: string[]; note: string | null }> {
    const p = get(planId);
    const working = workingAgentsIn(p.root, deps.workingPaths());
    if (working > 0) {
      throw new TransferError(
        `${working === 1 ? 'An agent is' : `${working} agents are`} working in this folder, so it stays here. The copy on the other computer is complete.`,
        'agents_working',
      );
    }
    const claudeDir = join(claudeProjectsRoot(deps.env, home), claudeProjectDirName(p.root));
    if (await holdsAnotherFolder(claudeDir, p.root)) {
      return {
        root: p.root,
        trash: [p.root],
        note: 'This folder went to the Trash. Its agent memory stays here: Claude keeps it together with another folder whose name differs only in punctuation.',
      };
    }
    return { root: p.root, trash: [p.root, claudeDir], note: null };
  }

  /** A fresh scan of the same folder with the same options (files changed while being sent). */
  async function refresh(planId: string): Promise<TransferPlanInfo> {
    const old = get(planId);
    const next = await plan(old.root, old.options);
    await drop(old);
    return next;
  }

  async function discard(planId: string): Promise<void> {
    const p = plans.get(planId);
    if (p) await drop(p);
  }

  return { plan, refresh, items, packFiles, moveCheck, discard };
}

export type Sender = ReturnType<typeof createSender>;

/** How much of a transcript is read to find its `cwd`. */
const CWD_PROBE_BYTES = 64 * 1024;

/**
 * Does this Claude project folder also hold another folder's transcripts? Claude names it after the
 * path with every non-alphanumeric character as `-`, so `~/work-app` and `~/work/app` share one
 * (security review, Nov 27 2026): a Move must not send the other project's memory to the Trash.
 */
export async function holdsAnotherFolder(claudeDir: string, root: string): Promise<boolean> {
  const names = await readdir(claudeDir).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.jsonl')).slice(0, 2000)) {
    const handle = await open(join(claudeDir, name), 'r').catch(() => null);
    if (!handle) continue;
    try {
      const buf = Buffer.alloc(CWD_PROBE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, CWD_PROBE_BYTES, 0);
      for (const line of buf.subarray(0, bytesRead).toString('utf8').split('\n')) {
        if (!line.includes('"cwd"')) continue;
        let cwd: unknown;
        try {
          cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        } catch {
          continue;
        }
        if (typeof cwd !== 'string') continue;
        if (cwd !== root && !cwd.startsWith(`${root}/`)) return true;
        break;
      }
    } finally {
      await handle.close();
    }
  }
  return false;
}
