/**
 * The target side of a project transfer (docs/plans/project-transfer.md): accept a plan from a paired
 * computer, stage the files it sends beside the destination, check each one's SHA-256, and on commit
 * rename the project into place and re-key its Claude Code and Codex memory to the new folder.
 *
 * Staging: `<destination's parent>/.aasc-transfer-<id>/` holding `project/`, `claude/`, `codex/`,
 * `aasc/` and `tmp/`, plus `state.json` (the plan and what arrived), so an interrupted transfer can
 * resume even after this server restarts. Nothing outside the stage is written before commit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, rmdir, stat, statfs, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, sep } from 'node:path';
import { z } from 'zod';
import type {
  AascBundleCounts, CommitResult, IncomingState, IncomingStatus, IncomingTransferRequest, PackResult, TransferItem,
} from '../../src/types/projectTransfer.js';
import { confinedProjectPath } from '../cloud/projectPaths.js';
import { TransferError } from './errors.js';
import { linkInside, MAX_ITEMS } from './manifest.js';
import { ExactReader, parseRanges } from './pack.js';
import {
  claudeProjectDirName, claudeProjectsRoot, codexSessionsRoot, CODEX_REL_RE, displayPath, isGitHookPath,
  resolveDestination, safeRel, TransferPathError,
} from './paths.js';
import { rewriteJsonlCwd } from './rekey.js';

export { TransferError };

const HEX64 = /^[0-9a-f]{64}$/;
const AASC_MEDIA_RE = /^media\/[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9._-]{1,200}$/;
const MAX_FILE_BYTES = 1024 ** 4; // 1 TB
/** Kept free beyond what the transfer needs. */
const SPACE_MARGIN = 256 * 1024 * 1024;
const PENDING_TTL_MS = 15 * 60_000;
/** Transfers waiting for Allow at once, from every computer together. */
const MAX_PENDING = 10;
/** The AASC history file is read whole to import it. */
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
/** Transfers one computer may have receiving at once (each holds its plan in memory). */
const MAX_RECEIVING_PER_COMPUTER = 3;
/** A receiving transfer untouched this long leaves memory; its stage + state.json stay for a resume. */
const RECEIVING_IDLE_MS = 6 * 60 * 60_000;
/** Finished transfers (declined, lapsed, committed) kept as small records for a last status read. */
const MAX_SETTLED = 50;

/** `path`, or the nearest folder above it that exists. */
async function nearestExisting(path: string): Promise<string> {
  let cur = path;
  for (;;) {
    if (await exists(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return cur;
    cur = up;
  }
}

export const TransferIdSchema = z.string().uuid();

const ItemSchema = z
  .object({
    i: z.number().int().min(0),
    group: z.enum(['project', 'claude', 'codex', 'aasc']),
    rel: z.string().min(1).max(4095),
    kind: z.enum(['file', 'dir', 'symlink']),
    size: z.number().int().min(0).max(MAX_FILE_BYTES),
    mode: z.number().int().min(0).max(0o777),
    sha256: z.string().regex(HEX64).nullable(),
    linkTarget: z.string().min(1).max(4095).optional(),
  })
  .strict();

export const IncomingRequestSchema = z
  .object({
    id: TransferIdSchema,
    projectName: z.string().min(1).max(256),
    destination: z.string().min(3).max(4096),
    sourceRoot: z.string().min(1).max(4096).refine((p) => p.startsWith('/') && !p.includes('\0')),
    items: z.array(ItemSchema).max(MAX_ITEMS),
  })
  .strict();

/** Every rule an item must meet beyond its shape; a reason when it doesn't. */
export function itemProblem(item: TransferItem, index: number): string | null {
  if (item.i !== index) return 'Items are out of order.';
  if (!safeRel(item.rel)) return `Path not allowed: ${item.rel.slice(0, 200)}`;
  const isFile = item.kind === 'file';
  if (isFile !== (item.sha256 !== null)) return `A file needs its checksum: ${item.rel}`;
  if (!isFile && item.size !== 0) return `Only files have a size: ${item.rel}`;
  if ((item.kind === 'symlink') !== (item.linkTarget !== undefined)) return `Bad link: ${item.rel}`;
  if (item.kind === 'symlink' && linkInside(item.rel, item.linkTarget!) === null) return `The link points outside the project: ${item.rel}`;
  if (item.group === 'project') return isGitHookPath(item.rel) ? `Git hooks are never carried: ${item.rel}` : null;
  if (!isFile) return `Only files go into memory folders: ${item.rel}`;
  if (item.group === 'codex' && !CODEX_REL_RE.test(item.rel)) return `Not a Codex rollout: ${item.rel}`;
  if (item.group === 'aasc' && item.rel !== 'bundle.json' && !AASC_MEDIA_RE.test(item.rel)) return `Not AASC data: ${item.rel}`;
  if (item.group === 'aasc' && item.rel === 'bundle.json' && item.size > MAX_BUNDLE_BYTES) return 'The AASC history is too large to bring across.';
  return null;
}

/**
 * The backstop under `linkInside` and `validateItems`: the folder `path` will be written in really
 * is `base` or inside it, links followed. Run after its `mkdir`, before the write.
 */
async function confirmInside(base: string, path: string): Promise<void> {
  const [b, d] = await Promise.all([realpath(base), realpath(dirname(path))]);
  if (d !== b && !d.startsWith(b + sep)) {
    throw new TransferError('A path in the plan leads outside its folder.', 'path_escape', 400);
  }
}

/** A line longer than this is copied as it is (not parsed), so memory stays bounded. */
const MAX_REKEY_LINE = 64 * 1024 * 1024;

/** Copy a `.jsonl` file line by line, `cwd` re-keyed, without holding the whole file. */
async function writeRekeyed(from: string, out: import('node:fs/promises').FileHandle, src: string, dest: string): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of createReadStream(from, { highWaterMark: 1 << 20 })) {
    rest += decoder.write(chunk as Buffer);
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    if (lines.length > 0) await out.write(`${rewriteJsonlCwd(lines.join('\n'), src, dest).text}\n`);
    if (rest.length > MAX_REKEY_LINE) {
      await out.write(rest);
      rest = '';
    }
  }
  rest += decoder.end();
  if (rest) await out.write(rewriteJsonlCwd(rest, src, dest).text);
}

const foldKey = (item: Pick<TransferItem, 'group' | 'rel'>): string => `${item.group}:${item.rel.normalize('NFC').toLowerCase()}`;

export function validateItems(items: TransferItem[]): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    const problem = itemProblem(item, index);
    if (problem) throw new TransferError(problem, 'invalid_plan', 400);
    const key = foldKey(item);
    if (seen.has(key)) throw new TransferError(`The plan names one path twice: ${item.rel}`, 'invalid_plan', 400);
    seen.add(key);
  });
  // Nothing may sit under a link (folded the way a Mac compares names): a write through it would
  // land wherever the link points, and `linkInside` relies on every link's folder being real.
  const links = new Set(items.filter((it) => it.kind === 'symlink').map(foldKey));
  if (links.size === 0) return;
  for (const item of items) {
    const parts = item.rel.split('/');
    for (let n = 1; n < parts.length; n++) {
      if (links.has(foldKey({ group: item.group, rel: parts.slice(0, n).join('/') }))) {
        throw new TransferError(`A path sits under a link: ${item.rel.slice(0, 200)}`, 'invalid_plan', 400);
      }
    }
  }
}

interface Incoming {
  id: string;
  computerId: string;
  computerLabel: string;
  projectName: string;
  /** Absolute, on this computer. */
  destination: string;
  sourceRoot: string;
  items: TransferItem[];
  have: Set<number>;
  state: IncomingState;
  requestedAt: number;
  stage: string;
  busy: boolean;
  /** The owner pressed Decline: that id never asks again (one that only lapsed may). */
  ownerDeclined?: boolean;
  /** Last begin, pack or commit: an idle receiving transfer leaves memory. */
  touchedAt: number;
}

interface SavedState {
  id: string;
  computerId: string;
  projectName: string;
  destination: string;
  sourceRoot: string;
  items: TransferItem[];
  have: number[];
}

export interface ReceiverDeps {
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Has this computer's owner allowed transfers from `computerId`? */
  isAllowed(computerId: string): boolean;
  /** The owner pressed Allow: remember the computer. */
  allow(computerId: string, label: string): void;
  /** The pending Allow list changed. */
  onRequestsChanged(requests: IncomingTransferRequest[]): void;
  /** P2: put the AASC bundle's rows and media in this computer's database. */
  importAasc?(raw: unknown, opts: { toRoot: string; mediaDir: string }): AascBundleCounts;
  /** Free bytes on the volume holding `path` (statfs by default; tests pass their own). */
  freeBytes?(path: string): Promise<number>;
}

const fileBytes = (items: TransferItem[]): number => items.reduce((n, it) => n + (it.kind === 'file' ? it.size : 0), 0);
const fileCount = (items: TransferItem[]): number => items.filter((it) => it.kind === 'file').length;

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

/** Absent, or an empty folder. */
async function destinationFree(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    return st.isDirectory() && (await readdir(path)).length === 0;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function defaultFreeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}

const itemKey = (it: TransferItem): string => `${it.group}\0${it.rel}\0${it.size}\0${it.sha256 ?? ''}`;

export function createReceiver(deps: ReceiverDeps) {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const freeBytes = deps.freeBytes ?? defaultFreeBytes;
  const transfers = new Map<string, Incoming>();
  const settled = new Set<string>();

  const stagePath = (t: Pick<Incoming, 'stage'>, group: string, rel: string): string => join(t.stage, group, ...rel.split('/'));

  function requests(): IncomingTransferRequest[] {
    return [...transfers.values()]
      .filter((t) => t.state === 'awaiting-allow')
      .map((t) => ({
        id: t.id,
        computerId: t.computerId,
        computerLabel: t.computerLabel,
        projectName: t.projectName,
        destination: displayPath(t.destination, home),
        files: fileCount(t.items),
        bytes: fileBytes(t.items),
        requestedAt: t.requestedAt,
      }))
      .sort((a, b) => a.requestedAt - b.requestedAt);
  }

  const announce = (): void => deps.onRequestsChanged(requests());

  /** Pending Allows older than 15 minutes lapse (declined; the stage is removed). */
  /** Over: keep a small record (the sender reads its last status), never the plan. */
  function settle(t: Incoming, state: IncomingState): void {
    t.state = state;
    t.items = [];
    t.have = new Set();
    settled.delete(t.id);
    settled.add(t.id);
    for (const old of settled) {
      if (settled.size <= MAX_SETTLED) break;
      settled.delete(old);
      const x = transfers.get(old);
      if (x && (x.state === 'declined' || x.state === 'committed')) transfers.delete(old);
    }
  }

  async function expire(): Promise<void> {
    let changed = false;
    for (const t of [...transfers.values()]) {
      if (t.state === 'awaiting-allow' && now() - t.requestedAt > PENDING_TTL_MS) {
        settle(t, 'declined');
        changed = true;
        await rm(t.stage, { recursive: true, force: true });
      } else if (t.state === 'receiving' && !t.busy && now() - t.touchedAt > RECEIVING_IDLE_MS) {
        transfers.delete(t.id); // the stage and its state.json stay: the same id resumes from them
      }
    }
    if (changed) announce();
  }

  async function saveState(t: Incoming): Promise<void> {
    const saved: SavedState = {
      id: t.id, computerId: t.computerId, projectName: t.projectName, destination: t.destination,
      sourceRoot: t.sourceRoot, items: t.items, have: [...t.have].sort((a, b) => a - b),
    };
    const tmp = join(t.stage, `state.json.${randomUUID()}`);
    await writeFile(tmp, JSON.stringify(saved), { mode: 0o600 });
    await rename(tmp, join(t.stage, 'state.json'));
  }

  /** A stage left by an earlier run of this server, for the same computer and transfer. */
  async function loadSaved(stage: string, id: string, computerId: string): Promise<SavedState | null> {
    try {
      const saved = JSON.parse(await readFile(join(stage, 'state.json'), 'utf8')) as SavedState;
      return saved.id === id && saved.computerId === computerId && Array.isArray(saved.items) && Array.isArray(saved.have)
        ? saved
        : null;
    } catch {
      return null;
    }
  }

  /** Keep what already arrived and still matches the new plan; drop the rest. */
  async function carryOver(t: Incoming, oldItems: TransferItem[], oldHave: Iterable<number>): Promise<void> {
    const byKey = new Map(t.items.map((it) => [itemKey(it), it.i]));
    const have = new Set<number>();
    for (const i of oldHave) {
      const old = oldItems[i];
      if (!old) continue;
      const next = byKey.get(itemKey(old));
      if (next !== undefined && old.kind === 'file') have.add(next);
      else if (old.kind === 'file') await rm(stagePath(t, old.group, old.rel), { force: true });
    }
    t.have = have;
  }

  /** The destination's parent (made now, under a folder that passed the home rule) and the stage in it. */
  async function prepareStage(t: Incoming): Promise<void> {
    const parent = dirname(t.destination);
    await mkdir(parent, { recursive: true, mode: 0o755 });
    try {
      await confinedProjectPath(parent, home, { allowHome: true });
    } catch {
      throw new TransferError('Choose a folder inside the home folder, outside hidden configuration, Library and secrets folders.', 'path_not_allowed', 400);
    }
    for (const sub of ['project', 'claude', 'codex', 'aasc', 'tmp']) await mkdir(join(t.stage, sub), { recursive: true, mode: 0o700 });
    await chmod(t.stage, 0o700);
    await saveState(t);
  }

  /** POST /incoming: a new transfer, or the same id again to resume one. */
  async function begin(
    body: unknown,
    computer: { id: string; label: string },
  ): Promise<IncomingStatus> {
    await expire();
    const parsed = IncomingRequestSchema.safeParse(body);
    if (!parsed.success) throw new TransferError('That transfer request is not valid.', 'invalid_plan', 400);
    const req = parsed.data;
    const items = req.items as TransferItem[];
    validateItems(items);
    let destination: string;
    try {
      destination = resolveDestination(req.destination, home);
    } catch (err) {
      throw new TransferError((err as Error).message, err instanceof TransferPathError ? err.code : 'path_not_allowed', 400);
    }

    const known = transfers.get(req.id);
    if (known && known.computerId !== computer.id) throw new TransferError('That transfer belongs to another computer.', 'not_yours', 409);
    if (known && known.busy) throw new TransferError('That transfer is still receiving files.', 'busy', 409);
    if (known?.state === 'committed') throw new TransferError('That transfer is already finished.', 'finished', 409);
    if (known?.ownerDeclined) throw new TransferError('This computer’s owner declined that transfer.', 'declined', 403);

    if (!(await destinationFree(destination))) {
      throw new TransferError(
        `${displayPath(destination, home)} already exists on this computer. Use Project Sync to bring the two folders in step.`,
        'destination_exists',
      );
    }
    const parent = dirname(destination);
    // The nearest folder that exists must itself pass the home rule before anything is made under it:
    // mkdir -p would follow a link in the way and make folders wherever it points.
    const anchor = await nearestExisting(parent);
    try {
      await confinedProjectPath(anchor, home, { allowHome: true });
    } catch {
      throw new TransferError('Choose a folder inside the home folder, outside hidden configuration, Library and secrets folders.', 'path_not_allowed', 400);
    }
    const stage = join(parent, `.aasc-transfer-${req.id}`);

    const t: Incoming = known ?? {
      id: req.id, computerId: computer.id, computerLabel: computer.label, projectName: req.projectName,
      destination, sourceRoot: req.sourceRoot, items, have: new Set(), state: 'awaiting-allow',
      requestedAt: now(), stage, busy: false, touchedAt: now(),
    };
    if (known) {
      if (known.destination !== destination) {
        await rm(known.stage, { recursive: true, force: true });
        known.have = new Set();
      }
      const oldItems = known.items;
      Object.assign(known, { items, destination, stage, sourceRoot: req.sourceRoot, projectName: req.projectName, computerLabel: computer.label });
      if (known.state === 'declined' || known.state === 'cancelled') known.state = 'awaiting-allow';
      await carryOver(known, oldItems, known.have);
    } else {
      const saved = await loadSaved(stage, req.id, computer.id);
      if (saved) await carryOver(t, saved.items, saved.have);
    }

    const needed = fileBytes(items.filter((it) => !t.have.has(it.i)));
    if ((await freeBytes(anchor)) < needed + SPACE_MARGIN) {
      throw new TransferError('There is not enough free space on this computer for that project.', 'insufficient_space', 507);
    }

    if (t.state === 'awaiting-allow' && deps.isAllowed(computer.id)) t.state = 'receiving';
    t.touchedAt = now();
    if (t.state === 'receiving') {
      const others = [...transfers.values()].filter((x) => x.state === 'receiving' && x.computerId === computer.id && x.id !== t.id);
      if (others.length >= MAX_RECEIVING_PER_COMPUTER) {
        throw new TransferError('That computer already has transfers in progress here. Finish or discard one first.', 'too_many_transfers', 429);
      }
    }
    if (t.state === 'awaiting-allow') {
      // Nothing is written for a computer this computer's owner hasn't allowed yet: the stage is made on Allow.
      const waiting = [...transfers.values()].filter((x) => x.state === 'awaiting-allow' && x.id !== t.id);
      if (waiting.length >= MAX_PENDING) throw new TransferError('This computer already has transfers waiting for Allow.', 'too_many_pending', 429);
      t.requestedAt = now();
    } else {
      await prepareStage(t);
    }
    transfers.set(t.id, t);
    announce();
    return status(t);
  }

  function status(t: Incoming): IncomingStatus {
    const message =
      t.state === 'awaiting-allow' ? 'Waiting for Allow on this computer.'
        : t.state === 'declined' ? 'This computer declined the transfer.'
          : null;
    return { id: t.id, state: t.state, have: [...t.have].sort((a, b) => a - b), destination: displayPath(t.destination, home), message };
  }

  function owned(id: string, computerId: string): Incoming {
    const t = transfers.get(id);
    if (!t || t.computerId !== computerId) throw new TransferError('This computer has no such transfer. Start it again.', 'unknown_transfer', 404);
    return t;
  }

  async function getStatus(id: string, computerId: string): Promise<IncomingStatus> {
    await expire();
    return status(owned(id, computerId));
  }

  /** The owner's answer to a pending Allow. */
  async function answer(id: string, allowIt: boolean): Promise<IncomingStatus> {
    const t = transfers.get(id);
    if (!t || t.state !== 'awaiting-allow') throw new TransferError('That request is no longer waiting.', 'not_waiting', 404);
    if (allowIt) {
      await prepareStage(t);
      deps.allow(t.computerId, t.computerLabel);
      t.state = 'receiving';
    } else {
      t.ownerDeclined = true;
      settle(t, 'declined');
      await rm(t.stage, { recursive: true, force: true });
    }
    announce();
    return status(t);
  }

  /** Write one item's bytes to `tmp/`, hashing as they come; then into its staged place when they match. */
  async function receiveOne(t: Incoming, item: TransferItem, reader: ExactReader): Promise<'ok' | string | null> {
    const tmp = join(t.stage, 'tmp', `${item.i}-${randomUUID()}`);
    const hash = createHash('sha256');
    const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
    const done = new Promise<void>((resolve, reject) => {
      out.on('finish', resolve);
      out.on('error', reject);
    });
    const complete = await reader.read(item.size, async (piece) => {
      hash.update(piece);
      if (!out.write(piece)) await new Promise<void>((resolve) => out.once('drain', resolve));
    });
    out.end();
    await done;
    if (!complete) {
      await rm(tmp, { force: true });
      return null; // the pack ended early: this and every later item still missing
    }
    if (hash.digest('hex') !== item.sha256) {
      await rm(tmp, { force: true });
      return 'The file changed while it was being sent.';
    }
    const target = stagePath(t, item.group, item.rel);
    try {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await confirmInside(join(t.stage, item.group), target);
      await rename(tmp, target);
      await chmod(target, item.group === 'project' ? item.mode | 0o600 : 0o600);
    } catch {
      await rm(tmp, { force: true });
      return 'Could not place the file (a file and a folder share its path).';
    }
    return 'ok';
  }

  /** PUT /incoming/:id/pack: the bytes of the files `ranges` names (`0-5,7`), back to back. */
  async function receivePack(
    id: string,
    computerId: string,
    ranges: string,
    body: AsyncIterable<Buffer | Uint8Array | string>,
  ): Promise<PackResult> {
    const t = owned(id, computerId);
    const indexes = parseRanges(ranges, t.items.length);
    if (!indexes) throw new TransferError('That pack names no files.', 'invalid_pack', 400);
    if (t.state !== 'receiving') throw new TransferError(t.state === 'awaiting-allow' ? 'Waiting for Allow on this computer.' : 'That transfer is not receiving files.', 'not_receiving', 409);
    if (t.busy) throw new TransferError('That transfer is already receiving a pack.', 'busy', 409);
    if (indexes.some((i) => t.items[i]?.kind !== 'file')) throw new TransferError('A pack may name files only.', 'invalid_pack', 400);
    t.busy = true;
    t.touchedAt = now();
    const result: PackResult = { received: [], failed: [] };
    try {
      const reader = new ExactReader(body);
      for (const i of indexes) {
        const item = t.items[i];
        const outcome = await receiveOne(t, item, reader);
        if (outcome === null) break;
        if (outcome === 'ok') {
          t.have.add(i);
          result.received.push(i);
        } else {
          t.have.delete(i);
          result.failed.push({ i, reason: outcome });
        }
      }
    } finally {
      t.busy = false;
      await saveState(t).catch(() => undefined);
    }
    return result;
  }

  async function placeMemory(t: Incoming, group: 'claude' | 'codex', base: string): Promise<{ written: number; existing: number }> {
    let written = 0;
    let existing = 0;
    for (const item of t.items) {
      if (item.group !== group) continue;
      const from = stagePath(t, group, item.rel);
      const to = join(base, ...item.rel.split('/'));
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      await confirmInside(base, to);
      const out = await open(to, 'wx', 0o600).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
        return null;
      });
      if (!out) {
        existing++;
        continue;
      }
      try {
        if (item.rel.endsWith('.jsonl')) await writeRekeyed(from, out, t.sourceRoot, t.destination);
        else for await (const chunk of createReadStream(from, { highWaterMark: 1 << 20 })) await out.write(chunk as Buffer);
      } finally {
        await out.close();
      }
      written++;
    }
    return { written, existing };
  }

  async function removeLinks(projectStage: string, links: TransferItem[]): Promise<void> {
    for (const l of links) {
      const at = join(projectStage, ...l.rel.split('/'));
      const info = await lstat(at).catch(() => null);
      if (info?.isSymbolicLink()) await unlink(at).catch(() => undefined);
    }
  }

  /** POST /incoming/:id/commit: every file checked → the project in place, then its memory and history. */
  async function commit(id: string, computerId: string): Promise<CommitResult> {
    const t = owned(id, computerId);
    if (t.state !== 'receiving') throw new TransferError('That transfer is not ready to finish.', 'not_receiving', 409);
    if (t.busy) throw new TransferError('That transfer is still receiving files.', 'busy', 409);
    const missing = t.items.filter((it) => it.kind === 'file' && !t.have.has(it.i)).length;
    if (missing > 0) throw new TransferError(`${missing} files have not arrived yet.`, 'incomplete', 409);
    if (!(await destinationFree(t.destination))) {
      throw new TransferError(
        `${displayPath(t.destination, home)} appeared on this computer meanwhile. Use Project Sync to bring the two folders in step.`,
        'destination_exists',
      );
    }
    t.busy = true;
    t.touchedAt = now();
    const warnings: string[] = [];
    try {
      const projectStage = join(t.stage, 'project');
      const dirs = t.items.filter((it) => it.group === 'project' && it.kind === 'dir');
      const links = t.items.filter((it) => it.group === 'project' && it.kind === 'symlink');
      try {
        for (const d of dirs) {
          const at = stagePath(t, 'project', d.rel);
          await mkdir(at, { recursive: true, mode: 0o700 });
          await confirmInside(projectStage, at);
        }
        for (const l of links) {
          const at = stagePath(t, 'project', l.rel);
          await mkdir(dirname(at), { recursive: true, mode: 0o700 });
          await confirmInside(projectStage, at);
          await symlink(l.linkTarget!, at).catch((err: Error) => {
            warnings.push(`The link ${l.rel} could not be made: ${err.message}`);
          });
        }
        // Deepest first, so a folder's own mode never blocks writing inside it.
        for (const d of [...dirs].reverse()) await chmod(stagePath(t, 'project', d.rel), d.mode | 0o700);
        await chmod(projectStage, 0o755);
        if (await exists(t.destination)) await rmdir(t.destination);
        await rename(projectStage, t.destination);
      } catch (err) {
        // Not in place: take the links back out, so nothing a retry writes can follow one.
        await removeLinks(projectStage, links);
        throw err;
      }
      t.state = 'committed';

      let claude = { written: 0, existing: 0 };
      let codex = { written: 0, existing: 0 };
      try {
        const claudeDir = join(claudeProjectsRoot(deps.env, home), claudeProjectDirName(t.destination));
        // Claude names this folder after the path with punctuation as `-`: `~/work-app` and `~/work/app`
        // share one. A folder that already has content belongs to another project here: never add to it.
        const taken = t.items.some((it) => it.group === 'claude') && (await readdir(claudeDir).catch(() => [])).length > 0;
        if (taken) {
          warnings.push('The Claude memory did not come across: this computer already keeps memory under that name for another folder (Claude treats punctuation in folder names as the same).');
        } else {
          claude = await placeMemory(t, 'claude', claudeDir);
        }
        codex = await placeMemory(t, 'codex', codexSessionsRoot(deps.env, home));
      } catch (err) {
        warnings.push(`Some agent memory did not come across: ${(err as Error).message}`);
      }
      let aasc: AascBundleCounts | null = null;
      if (t.items.some((it) => it.group === 'aasc' && it.rel === 'bundle.json')) {
        try {
          if (!deps.importAasc) throw new Error('this computer cannot import AASC history');
          const raw = JSON.parse(await readFile(stagePath(t, 'aasc', 'bundle.json'), 'utf8')) as unknown;
          aasc = deps.importAasc(raw, { toRoot: t.destination, mediaDir: join(t.stage, 'aasc') });
        } catch (err) {
          warnings.push(`The AASC history did not come across: ${(err as Error).message}`);
        }
      }
      await rm(t.stage, { recursive: true, force: true });
      const projectFiles = t.items.filter((it) => it.group === 'project' && it.kind === 'file');
      const result = {
        destination: displayPath(t.destination, home),
        files: projectFiles.length,
        bytes: fileBytes(projectFiles),
        claudeFiles: claude.written,
        codexFiles: codex.written,
        skippedExisting: claude.existing + codex.existing,
        aasc,
        warnings,
      };
      settle(t, 'committed');
      return result;
    } finally {
      t.busy = false;
    }
  }

  /** DELETE /incoming/:id: stop and remove what was staged. */
  async function cancel(id: string, computerId: string): Promise<void> {
    const t = owned(id, computerId);
    if (t.busy) throw new TransferError('That transfer is still receiving files.', 'busy', 409);
    if (t.state === 'committed') return;
    const waiting = t.state === 'awaiting-allow';
    t.state = 'cancelled';
    await rm(t.stage, { recursive: true, force: true });
    transfers.delete(id);
    if (waiting) announce();
  }

  return { begin, getStatus, answer, receivePack, commit, cancel, requests };
}

export type Receiver = ReturnType<typeof createReceiver>;
