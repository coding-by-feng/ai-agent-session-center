/**
 * Project Sync — the pure half: three manifests in, a reviewed plan out.
 *
 * L = this machine now, R = the device now, B = what both held after the last
 * run. Without B nobody can tell "deleted here" from "added there", which is
 * why a link with no base runs in first-run mode (docs/plans/project-sync-design.md §4).
 * Nothing here touches the file system.
 */
import { randomUUID } from 'crypto';
import { posix } from 'path';
import { isCredentialPath } from '../fsSafe.js';
import {
  defaultSyncAction,
  type FileMeta,
  type SyncAction,
  type SyncChange,
  type SyncEntry,
  type SyncFlag,
  type SyncGroup,
  type SyncGroupDecision,
  type SyncRepoSide,
} from '../../src/types/projectSync.js';

/** A manifest row. `text` is only filled for tiny git files (HEAD, refs/heads/*) so a repo row can name its branch. */
export interface ManifestEntry extends FileMeta {
  text?: string;
}
export type Manifest = Map<string, ManifestEntry>;
export type Base = Map<string, FileMeta>;

export interface ClassifyOptions {
  localPlatform: string;
  devicePlatform: string;
}
export interface Plan {
  entries: SyncEntry[];
  groups: SyncGroup[];
}

/** Content identity: kind, bytes (by hash), permission bits, link target. mtime is not identity. */
export function sameContent(a: FileMeta | undefined, b: FileMeta | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.kind === 'other') return false;
  if ((a.mode & 0o777) !== (b.mode & 0o777) && a.kind !== 'symlink') return false;
  if (a.kind === 'file') return !!a.sha256 && a.sha256 === b.sha256;
  if (a.kind === 'symlink') return a.linkTarget === b.linkTarget;
  return true;
}

const REPO_LOCK_RE = /\.lock$/;

/** The repository a path belongs to: the deepest `.git` folder that is (or contains) it. O(depth). */
function repoOf(path: string, repos: ReadonlySet<string>): string | null {
  if (!repos.size) return null;
  const parts = path.split('/');
  let best: string | null = null;
  let prefix = '';
  for (let i = 0; i < parts.length; i++) {
    prefix = i ? `${prefix}/${parts[i]}` : parts[i];
    if (parts[i] === '.git' && repos.has(prefix)) best = prefix;
  }
  return best;
}

/** Repository, else top-level folder; plain files in the root share the '' group. */
function groupOf(path: string, repos: ReadonlySet<string>, isDir: boolean): string {
  const repo = repoOf(path, repos);
  if (repo) return repo;
  const slash = path.indexOf('/');
  if (slash !== -1) return path.slice(0, slash);
  return isDir ? path : '';
}

function flagsFor(
  path: string,
  local: ManifestEntry | undefined,
  localManifest: Manifest,
  options: ClassifyOptions,
): SyncFlag[] {
  const flags: SyncFlag[] = [];
  const meta = local;
  if (isCredentialPath(path)) flags.push('credential');
  if (meta?.kind === 'symlink' && meta.linkTarget !== undefined) {
    const t = meta.linkTarget;
    const resolved = posix.normalize(posix.join(posix.dirname(path), t));
    if (posix.isAbsolute(t) || resolved === '..' || resolved.startsWith('../'))
      flags.push('link-outside');
  }
  if (/\.(?:db|sqlite3?)$/i.test(path) && localManifest.has(path + '-wal')) flags.push('live-db');
  if (
    options.localPlatform !== options.devicePlatform &&
    /(?:^|\/)(?:node_modules|\.venv|venv)\//.test(path) &&
    /\.(?:node|so|dylib)$/.test(path)
  )
    flags.push('native-artifact');
  if (posix.basename(path) === '.git' && meta?.kind === 'file') flags.push('worktree-gitdir');
  return flags;
}

function changeOf(
  L: FileMeta | undefined,
  R: FileMeta | undefined,
  B: FileMeta | undefined,
  hasBase: boolean,
): SyncChange {
  if (L?.kind === 'other' || R?.kind === 'other') return 'blocked';
  if (L && R && sameContent(L, R)) return 'same';
  if (!hasBase) {
    if (L && !R) return 'add';
    if (!L && R) return 'extra';
    return 'different';
  }
  const lChanged = !sameContent(L, B),
    rChanged = !sameContent(R, B);
  if (lChanged && !rChanged) return L ? (R ? 'change' : 'add') : 'delete';
  if (!lChanged && rChanged) return !L && !B ? 'extra' : 'drift';
  return 'conflict';
}

function repoSide(manifest: Manifest, repo: string): SyncRepoSide | undefined {
  const head = manifest.get(repo + '/HEAD')?.text?.trim();
  if (!head) return undefined;
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (!ref) return { head: '(detached)', commit: head.slice(0, 40) };
  const commit = manifest.get(`${repo}/refs/heads/${ref[1]}`)?.text?.trim();
  return { head: ref[1], ...(commit ? { commit: commit.slice(0, 40) } : {}) };
}

const NEEDS_DEVICE_DECISION: ReadonlySet<SyncChange> = new Set([
  'drift',
  'conflict',
  'extra',
  'different',
]);

/**
 * `.git/index` is a stat cache: a plain `git status` on the device rewrites it (verified),
 * so a device-side change to it alone is not "the device repo changed". The source's
 * index replaces it (the replaced copy is kept in the device journal).
 */
export const isDerivedGitFile = (path: string) => /(?:^|\/)\.git\/index$/.test(path);

/** The action a repository decision gives one of its entries. */
export function repoEntryAction(entry: SyncEntry, decision: SyncGroupDecision): SyncAction {
  if (entry.change === 'same' || entry.change === 'blocked') return 'skip';
  if (decision === 'skip') return entry.local ? 'skip' : 'keep';
  if (decision === 'review') return 'review';
  if (decision === 'sync')
    return isDerivedGitFile(entry.path) && NEEDS_DEVICE_DECISION.has(entry.change)
      ? entry.local
        ? 'push'
        : 'keep'
      : defaultSyncAction(entry.change);
  // overwrite: make the device copy equal this one
  return entry.local ? 'push' : 'delete-device';
}

export function classify(
  local: Manifest,
  device: Manifest,
  base: Base,
  options: ClassifyOptions,
): Plan {
  const hasBase = base.size > 0;
  const paths = [...new Set([...local.keys(), ...device.keys()])].sort();
  const repos = new Set(
    paths.filter(
      (p) =>
        posix.basename(p) === '.git' &&
        (local.get(p)?.kind === 'dir' || device.get(p)?.kind === 'dir'),
    ),
  );
  const entries: SyncEntry[] = [];
  for (const path of paths) {
    const L = local.get(path),
      R = device.get(path),
      B = hasBase ? base.get(path) : undefined;
    let change = changeOf(L, R, B, hasBase);
    // `git status` on the device rewrote only its stat cache: nothing to sync.
    if (change === 'drift' && isDerivedGitFile(path)) change = 'same';
    entries.push({
      id: randomUUID(),
      path,
      groupId: groupOf(path, repos, (L ?? R)?.kind === 'dir'),
      change,
      action: defaultSyncAction(change),
      ...(L ? { local: strip(L) } : {}),
      ...(R ? { device: strip(R) } : {}),
      ...(B ? { base: B } : {}),
      flags: flagsFor(path, L, local, options),
      state: 'pending',
      ...(change === 'blocked' ? { reason: 'Not a regular file, folder or link — skipped.' } : {}),
    });
  }
  const groups = new Map<string, SyncGroup>();
  for (const e of entries) {
    const g = groups.get(e.groupId) ?? {
      id: e.groupId,
      isRepo: repos.has(e.groupId),
      counts: {},
      bytes: 0,
    };
    g.counts[e.change] = (g.counts[e.change] ?? 0) + 1;
    groups.set(e.groupId, g);
  }
  const membersOf = new Map<string, SyncEntry[]>();
  for (const e of entries) {
    if (!repos.has(e.groupId)) continue;
    const list = membersOf.get(e.groupId); // local accumulator: a spread per entry is quadratic
    if (list) list.push(e);
    else membersOf.set(e.groupId, [e]);
  }
  for (const repo of repos) {
    const g = groups.get(repo)!;
    const members = membersOf.get(repo) ?? [];
    const busy = members.some((e) => REPO_LOCK_RE.test(e.path));
    const deviceChanged = members.some(
      (e) => NEEDS_DEVICE_DECISION.has(e.change) && !isDerivedGitFile(e.path),
    );
    const moving = members.some((e) => e.change !== 'same' && e.change !== 'blocked');
    g.local = repoSide(local, repo);
    g.device = repoSide(device, repo);
    if (busy) {
      g.state = 'busy';
      g.decision = 'skip';
    } else if (deviceChanged) {
      g.state = hasBase ? 'device-changed' : 'different-repo';
      g.decision = 'review';
    } else {
      g.state = moving ? 'local-ahead' : 'in-step';
      g.decision = 'sync';
    }
    for (const e of members) {
      e.action = repoEntryAction(e, g.decision);
      if (busy) {
        if (!e.flags.includes('git-busy')) e.flags.push('git-busy');
        if (e.change !== 'same')
          e.reason = 'Git is busy (a .lock file exists) — compare again when it finishes.';
      }
    }
  }
  for (const e of entries)
    if (e.action === 'push' && e.local?.kind === 'file')
      groups.get(e.groupId)!.bytes += e.local.size;
  return { entries, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)) };
}

function strip(m: ManifestEntry): FileMeta {
  const { text: _text, ...meta } = m;
  return meta;
}

// ---------------------------------------------------------------------------
// Apply order
// ---------------------------------------------------------------------------

export interface ApplyOp {
  op: 'put' | 'delete';
  entryId: string;
  path: string;
  /** put: the local meta to write. */
  meta?: FileMeta;
  /** What the device must hold right now (null = absent). */
  expect: FileMeta | null;
}

const depth = (p: string) => p.split('/').length;

/**
 * Rank inside one run so a reader on the device never sees a ref pointing at a
 * missing object: folders, objects (.pack before .idx), everything else,
 * packed-refs, refs, HEAD/index, then deletes deepest-first.
 */
function rank(op: ApplyOp): number {
  if (op.op === 'delete') return 9;
  if (op.meta?.kind === 'dir') return 0;
  const i = op.path.lastIndexOf('.git/');
  if (i === -1 || (i > 0 && op.path[i - 1] !== '/')) return 3;
  const inner = op.path.slice(i + 5);
  if (inner.startsWith('objects/')) return inner.endsWith('.idx') ? 2 : 1;
  if (inner === 'packed-refs') return 4;
  if (inner.startsWith('refs/')) return 5;
  if (inner === 'HEAD') return 6;
  if (inner === 'index') return 7;
  return 3;
}

export function applyOrder(entries: SyncEntry[], device: Map<string, FileMeta>): ApplyOp[] {
  const ops: ApplyOp[] = [];
  for (const e of entries) {
    if (e.state === 'done' || e.state === 'skipped') continue;
    const expect = device.get(e.path) ?? null;
    if (e.action === 'push' && e.local)
      ops.push({
        op: 'put',
        entryId: e.id,
        path: e.path,
        meta: e.local,
        expect: expect ? strip(expect) : null,
      });
    else if (e.action === 'delete-device' && expect)
      ops.push({ op: 'delete', entryId: e.id, path: e.path, expect: strip(expect) });
  }
  // A folder replaced by a non-folder goes to the trash whole: its children's deletes are covered.
  const replacedDirs = ops
    .filter((o) => o.op === 'put' && o.meta?.kind !== 'dir' && o.expect?.kind === 'dir')
    .map((o) => o.path + '/');
  const kept = ops.filter(
    (o) => !(o.op === 'delete' && replacedDirs.some((d) => o.path.startsWith(d))),
  );
  return kept.sort((a, b) => {
    const ra = rank(a),
      rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1);
    if (ra === 9) return depth(b.path) - depth(a.path) || (a.path < b.path ? -1 : 1);
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}
