/**
 * Project Sync — the pure half: three manifests in, a reviewed plan out.
 *
 * L = this machine now, R = the server now, B = what both held after the last
 * run. Without B nobody can tell "deleted here" from "added there", which is
 * why a link with no base runs in first-run mode (docs/plans/project-sync-design.md §4).
 * A push link mirrors L onto R; a two-way link carries whichever side moved since B,
 * and a path both sides moved is a conflict (§16). Nothing here touches the file system.
 */
import { randomUUID } from 'crypto';
import { posix } from 'path';
import { isCredentialPath } from '../fsSafe.js';
import {
  defaultActionFor,
  defaultSyncAction,
  defaultTwoWayAction,
  LOCAL_ACTIONS,
  SERVER_ACTIONS,
  type FileMeta,
  type SyncAction,
  type SyncChange,
  type SyncDirection,
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
  /** Default `push`. */
  direction?: SyncDirection;
  /**
   * Two-way only: how this machine's file system folds names, when it does (macOS: letter
   * case and Unicode normalization). Two server paths that fold alike cannot both land here.
   */
  foldLocal?: (path: string) => string;
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
/** Characters HFS+ ignores in a name (git's own list): `.g\u200cit` is `.git` there. */
const IGNORABLE_RE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
/** How a Mac reads a name: letter case, Unicode forms, and the characters HFS+ ignores. */
const gitFold = (s: string) =>
  s.normalize('NFKC').replace(IGNORABLE_RE, '').toUpperCase().toLowerCase();
/** A segment a Mac reads as `.git` not spelled so. */
const otherGitName = (path: string) =>
  path.split('/').some((s) => s !== '.git' && gitFold(s) === '.git');
/** Config files inside a `.git` folder: the repository's, a submodule's and a worktree's. */
const GIT_CONFIG_RE = /^(?:(?:modules\/.+|worktrees\/[^/]+)\/)?config(?:\.worktree)?$/;
/** The path inside its innermost `.git` folder, or null outside one. */
function inGitDir(path: string): string | null {
  const parts = path.split('/');
  const i = parts.lastIndexOf('.git');
  return i === -1 || i === parts.length - 1 ? null : parts.slice(i + 1).join('/');
}
/** A path inside `.git` a Mac reads as one of git's config files (they can run programs). */
const isGitConfig = (rel: string) => GIT_CONFIG_RE.test(gitFold(rel));
/** `.git/Config`, `.git/Modules/x/config`: git's config file on a Mac, a stray file on Linux. */
const otherConfigName = (path: string) => {
  const rel = inGitDir(path);
  return rel !== null && isGitConfig(rel) && !GIT_CONFIG_RE.test(rel);
};

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

/** A link whose target lies outside the project (absolute, or climbing above its root). */
function pointsOutside(path: string, meta: FileMeta | undefined): boolean {
  if (meta?.kind !== 'symlink' || meta.linkTarget === undefined) return false;
  const t = meta.linkTarget;
  const resolved = posix.normalize(posix.join(posix.dirname(path), t));
  return posix.isAbsolute(t) || resolved === '..' || resolved.startsWith('../');
}

/** Changes where the server's side moved: in a two-way link its version may come here. */
const SERVER_MOVED: ReadonlySet<SyncChange> = new Set(['drift', 'extra', 'conflict', 'different']);
const EXECUTABLE = 0o111;

function flagsFor(
  path: string,
  sides: { change: SyncChange; local?: ManifestEntry; device?: ManifestEntry },
  localManifest: Manifest,
  options: ClassifyOptions,
): SyncFlag[] {
  const flags: SyncFlag[] = [];
  const { local: meta, device } = sides;
  // What the server holds matters only where it may come here: two-way, and the server moved.
  const fromServer = options.direction === 'two-way' && SERVER_MOVED.has(sides.change);
  if (isCredentialPath(path)) flags.push('credential');
  if (pointsOutside(path, meta) || (fromServer && pointsOutside(path, device)))
    flags.push('link-outside');
  if (
    fromServer &&
    device?.kind === 'file' &&
    device.mode & EXECUTABLE &&
    !(meta?.kind === 'file' && meta.mode & EXECUTABLE)
  )
    flags.push('executable');
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

/**
 * The action a repository decision gives one of its entries. In a two-way link the repo's
 * state says which side moved: `.git/index` (a stat cache either side rewrites on `git status`)
 * follows that side and never counts as a move on its own.
 */
export function repoEntryAction(
  entry: SyncEntry,
  decision: SyncGroupDecision,
  direction: SyncDirection = 'push',
  state?: SyncGroup['state'],
): SyncAction {
  if (entry.change === 'same' || entry.change === 'blocked') return 'skip';
  if (decision === 'review') return 'review';
  if (direction === 'two-way') {
    if (decision === 'skip') return 'skip';
    if (decision === 'overwrite') return entry.local ? 'push' : 'delete-device';
    if (decision === 'take-device') return entry.device ? 'pull' : 'delete-local';
    if (isDerivedGitFile(entry.path)) {
      if (state === 'local-ahead') return entry.local ? 'push' : 'skip';
      if (state === 'device-ahead') return entry.device ? 'pull' : 'skip';
      return 'skip';
    }
    return defaultTwoWayAction(entry);
  }
  if (decision === 'skip') return entry.local ? 'skip' : 'keep';
  if (decision === 'take-device') return 'review';
  if (decision === 'sync')
    return isDerivedGitFile(entry.path) && NEEDS_DEVICE_DECISION.has(entry.change)
      ? entry.local
        ? 'push'
        : 'keep'
      : defaultSyncAction(entry.change);
  // overwrite: make the device copy equal this one
  return entry.local ? 'push' : 'delete-device';
}

const LOCAL_MOVES: ReadonlySet<SyncChange> = new Set(['add', 'change', 'delete']);
const DEVICE_MOVES: ReadonlySet<SyncChange> = new Set(['drift', 'extra']);

/** Two-way: which side moved a repository since the base, and the decision that follows. */
function twoWayRepoState(
  members: SyncEntry[],
  hasBase: boolean,
): { state: NonNullable<SyncGroup['state']>; decision: SyncGroupDecision } {
  const moved = members.filter(
    (e) => !isDerivedGitFile(e.path) && e.change !== 'same' && e.change !== 'blocked',
  );
  if (!moved.length) return { state: 'in-step', decision: 'sync' };
  if (!hasBase) {
    // First run: a repository only one side has is copied over; two different ones need a pick.
    if (moved.every((e) => e.change === 'add')) return { state: 'local-ahead', decision: 'sync' };
    if (moved.every((e) => e.change === 'extra'))
      return { state: 'device-ahead', decision: 'sync' };
    return { state: 'different-repo', decision: 'review' };
  }
  const local = moved.some((e) => LOCAL_MOVES.has(e.change));
  const device = moved.some((e) => DEVICE_MOVES.has(e.change));
  const both = moved.some((e) => e.change === 'conflict' || e.change === 'different');
  if (both || (local && device)) return { state: 'both-changed', decision: 'review' };
  return local
    ? { state: 'local-ahead', decision: 'sync' }
    : { state: 'device-ahead', decision: 'sync' };
}

/**
 * Two-way: a path one side holds under a spelling that differs only in letter case or accents
 * from another path in the plan (`README.md` vs `Readme.md` on macOS) is skipped, and so is
 * everything under such a folder. A server path would land on the other spelling here, and a
 * delete here (the server renamed it) would remove the only copy. Two moves still carry: a
 * path new on this computer, and a delete of what this computer deleted (a rename made here;
 * applyOrder runs the old spelling's delete first).
 */
function blockCollisions(entries: SyncEntry[], fold: (p: string) => string) {
  const spellings = new Map<string, Set<string>>();
  for (const e of entries) {
    const key = fold(e.path);
    const set = spellings.get(key) ?? new Set<string>();
    set.add(e.path);
    spellings.set(key, set);
  }
  const blockedDirs: string[] = [];
  for (const e of entries) {
    if (!!e.local === !!e.device) continue;
    const underBlocked = blockedDirs.some((d) => e.path.startsWith(d));
    const carried = e.local ? e.change === 'add' : e.change === 'delete';
    if (carried && !underBlocked) continue;
    const others = [...(spellings.get(fold(e.path)) ?? [])].filter((p) => p !== e.path);
    if (!others.length && !underBlocked) continue;
    e.change = 'blocked';
    e.action = 'skip';
    if (!e.flags.includes('case-collision')) e.flags.push('case-collision');
    e.reason = !others.length
      ? 'Its folder differs only in letter case or accents from one on the other side. Rename one side to match.'
      : e.device
        ? `This computer cannot hold both "${e.path}" and "${others[0]}": the names differ only in letter case or accents. Rename one on the server.`
        : `The server has it as "${others[0]}" (the names differ only in letter case or accents). Rename one side to match.`;
    if ((e.local ?? e.device)!.kind === 'dir') blockedDirs.push(e.path + '/');
  }
}

/**
 * Two-way: a folder one side replaced with a file or link while the other side changed
 * something inside it is a conflict to decide, not a replace (which would fail on the
 * folder's files). Under a replaced folder the only plain change is the replace itself:
 * gone on the side that replaced it, untouched on the other.
 */
function guardReplacedFolders(entries: SyncEntry[]) {
  for (const e of entries) {
    const L = e.local?.kind,
      R = e.device?.kind;
    if (!L || !R || (L === 'dir') === (R === 'dir')) continue;
    if (e.change !== 'drift' && e.change !== 'change') continue;
    const serverMoved = e.change === 'drift';
    // The side that moved holds the folder: a file became a folder, and all inside it is new.
    if ((R === 'dir') === serverMoved) continue;
    const plain: SyncChange = serverMoved ? 'drift' : 'delete';
    const inside = e.path + '/';
    if (!entries.some((c) => c.path.startsWith(inside) && c.change !== plain)) continue;
    e.change = 'conflict';
    e.action = 'review';
    e.reason = serverMoved
      ? 'The server replaced this folder, and files in it changed here. Choose which side wins.'
      : 'This computer replaced this folder, and files in it changed on the server. Choose which side wins.';
  }
}

/**
 * Two-way: a link from the server that leads outside the project is copied here only by choice.
 * Inside a repository's .git it never comes: a repository is decided whole, so no choice could
 * leave the link behind, and git writes through it (COMMIT_EDITMSG on every commit).
 */
function holdOutsideLinks(entries: SyncEntry[], repos: ReadonlySet<string>) {
  for (const e of entries) {
    if (!pointsOutside(e.path, e.device)) continue;
    if (repos.has(e.groupId) && SERVER_MOVED.has(e.change)) {
      e.change = 'blocked';
      e.action = 'skip';
      e.reason = 'This link inside .git leads outside the project, so it is never copied here.';
    } else if (e.action === 'pull') {
      e.action = 'review';
      e.reason =
        'This link from the server leads outside the project. Check where it goes before you copy it here.';
    }
  }
}

/**
 * Two-way: what tells git where its folder is never comes from the server. A `.git` file or link
 * (a worktree's or submodule's `gitdir:`) can point git at any folder here, and a link inside
 * `.git` can stand in for one of its folders: git runs the hooks it finds there. A `.git` folder
 * here where the server has a file or link stays as it is: none of its files move either way.
 */
function holdGitRedirects(entries: SyncEntry[]) {
  const kept: string[] = [];
  for (const e of entries) {
    if (!e.device || (e.change !== 'blocked' && !SERVER_MOVED.has(e.change))) continue;
    const redirect = posix.basename(e.path) === '.git' && e.device.kind !== 'dir';
    // Blocked now or by an earlier pass (an outside link): this computer's folder stays whole.
    if (redirect && e.local?.kind === 'dir') kept.push(e.path + '/');
    if (e.change === 'blocked') continue;
    if (!redirect && !(e.device.kind === 'symlink' && inGitDir(e.path) !== null)) continue;
    e.change = 'blocked';
    e.action = 'skip';
    e.reason = redirect
      ? 'A .git file or link from the server could point git at hooks elsewhere, so it is never copied here. Set up the worktree or submodule on this computer.'
      : 'This link inside .git could point git at hooks elsewhere, so it is never copied here.';
  }
  if (!kept.length) return;
  for (const e of entries)
    if (e.change !== 'same' && e.change !== 'blocked' && kept.some((k) => e.path.startsWith(k))) {
      e.change = 'blocked';
      e.action = 'skip';
      e.reason =
        'Held: the server has a .git file or link where this folder is, and that never comes here, so the folder stays as it is.';
    }
}

export function classify(
  local: Manifest,
  device: Manifest,
  base: Base,
  options: ClassifyOptions,
): Plan {
  const direction = options.direction ?? 'push';
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
    // Push: `git status` on the device rewrote only its stat cache: nothing to sync.
    if (direction === 'push' && change === 'drift' && isDerivedGitFile(path)) change = 'same';
    const sides = { change, ...(L ? { local: L } : {}), ...(R ? { device: R } : {}) };
    entries.push({
      id: randomUUID(),
      path,
      groupId: groupOf(path, repos, (L ?? R)?.kind === 'dir'),
      change,
      action: defaultActionFor(sides, direction),
      ...(L ? { local: strip(L) } : {}),
      ...(R ? { device: strip(R) } : {}),
      ...(B ? { base: B } : {}),
      flags: flagsFor(path, sides, local, options),
      state: 'pending',
      ...(change === 'blocked' ? { reason: 'Not a regular file, folder or link — skipped.' } : {}),
    });
  }
  if (direction === 'two-way') {
    if (options.foldLocal) blockCollisions(entries, options.foldLocal);
    guardReplacedFolders(entries);
    holdOutsideLinks(entries, repos);
    holdGitRedirects(entries);
  }
  // `.GIT`, or `.git` with a character HFS+ ignores: a plain folder on Linux, git's own folder
  // (hooks and all) on a Mac. `.git/Config` likewise is git's config there. Neither helper
  // writes one; the plan says why.
  for (const e of entries)
    if (otherGitName(e.path)) {
      e.change = 'blocked';
      e.action = 'skip';
      e.reason =
        'A Mac reads this name as .git, the folder git runs hooks from, so it is never synced. Rename it on the side that has it.';
    } else if (otherConfigName(e.path)) {
      e.change = 'blocked';
      e.action = 'skip';
      e.reason =
        'A Mac reads this name as git’s config file, which can run programs, so it is never synced. Rename it on the side that has it.';
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
    } else if (direction === 'two-way') {
      Object.assign(g, twoWayRepoState(members, hasBase));
      // Git here reads the server's config files (the repository's, a submodule's, a worktree's)
      // on every command, and they can run programs; one the server deleted would go here too.
      // Folded: a Mac reads `Config` as `config`.
      const configs = members.filter(
        (e) => SERVER_MOVED.has(e.change) && isGitConfig(e.path.slice(repo.length + 1)),
      );
      for (const c of configs) if (!c.flags.includes('git-config')) c.flags.push('git-config');
      if (configs.length && g.decision === 'sync') g.decision = 'review';
    } else if (deviceChanged) {
      g.state = hasBase ? 'device-changed' : 'different-repo';
      g.decision = 'review';
    } else {
      g.state = moving ? 'local-ahead' : 'in-step';
      g.decision = 'sync';
    }
    for (const e of members) {
      e.action = repoEntryAction(e, g.decision!, direction, g.state);
      if (busy) {
        if (!e.flags.includes('git-busy')) e.flags.push('git-busy');
        if (e.change !== 'same')
          e.reason = 'Git is busy (a .lock file exists) — compare again when it finishes.';
      }
    }
  }
  for (const e of entries) {
    if (e.action === 'push' && e.local?.kind === 'file')
      groups.get(e.groupId)!.bytes += e.local.size;
    if (e.action === 'pull' && e.device?.kind === 'file')
      groups.get(e.groupId)!.bytes += e.device.size;
  }
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
  /** The id the helper journals and acknowledges: the entry's id, or its keep-both `copyId`. */
  entryId: string;
  /** The entry this operation belongs to. */
  owner: string;
  path: string;
  /** put: read this path on the sending side when it differs from `path` (keep-both's copy). */
  source?: string;
  /** put: the meta to write (the sending side's). */
  meta?: FileMeta;
  /** What the receiving side must hold right now (null = absent). */
  expect: FileMeta | null;
}

/** Which side an operation list writes to. */
export type ApplySide = 'device' | 'local';

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

/**
 * The operations one side receives, in a safe order. `target` is what that side held at compare
 * time. The server receives push / delete-device and keep-both's two writes (this machine's file
 * at the path, the server's copy beside it); this machine receives pull / delete-local and
 * keep-both's copy, which runs first so the server's version exists here before it is replaced.
 */
export function applyOrder(
  entries: SyncEntry[],
  target: Map<string, FileMeta>,
  side: ApplySide = 'device',
): ApplyOp[] {
  const ops: ApplyOp[] = [];
  const writes = side === 'device' ? SERVER_ACTIONS : LOCAL_ACTIONS;
  for (const e of entries) {
    if (e.state === 'done' || e.state === 'skipped' || !writes.has(e.action)) continue;
    const held = target.get(e.path) ?? null;
    const expect = held ? strip(held) : null;
    const base = { owner: e.id, path: e.path };
    if (e.action === 'keep-both') {
      if (!e.copyPath || !e.copyId || !e.device || !e.local) continue;
      if (side === 'local') {
        ops.push({
          op: 'put',
          entryId: e.copyId,
          owner: e.id,
          path: e.copyPath,
          source: e.path,
          meta: e.device,
          expect: null,
        });
      } else {
        ops.push({ op: 'put', entryId: e.id, ...base, meta: e.local, expect });
        ops.push({
          op: 'put',
          entryId: e.copyId,
          owner: e.id,
          path: e.copyPath,
          meta: e.device,
          expect: null,
        });
      }
      continue;
    }
    const sending = side === 'device' ? e.local : e.device;
    if ((e.action === 'push' || e.action === 'pull') && sending)
      ops.push({ op: 'put', entryId: e.id, ...base, meta: sending, expect });
    else if ((e.action === 'delete-device' || e.action === 'delete-local') && expect)
      ops.push({ op: 'delete', entryId: e.id, ...base, expect });
  }
  // Deletes that must run before anything is written, deepest first:
  //  - inside a folder a file or link replaces: the helper replaces only an empty folder, so a
  //    file the plan does not delete makes the replace fail instead of vanishing with it;
  //  - of a spelling that differs only in letter case or accents from a path being written:
  //    on a side that folds names the write would land on the old file, and the delete
  //    after it would remove the only copy.
  const replacedDirs = ops
    .filter((o) => o.op === 'put' && o.meta?.kind !== 'dir' && o.expect?.kind === 'dir')
    .map((o) => o.path + '/');
  const written = new Set(ops.filter((o) => o.op === 'put').map((o) => o.path));
  const writtenFolded = new Set([...written].map(foldName));
  const early = (o: ApplyOp) =>
    o.op === 'delete' &&
    (replacedDirs.some((d) => o.path.startsWith(d)) ||
      (writtenFolded.has(foldName(o.path)) && !written.has(o.path)));
  const deepestFirst = (a: ApplyOp, b: ApplyOp) =>
    depth(b.path) - depth(a.path) || (a.path < b.path ? -1 : 1);
  const rest = ops
    .filter((o) => !early(o))
    .sort((a, b) => {
      const ra = rank(a),
        rb = rank(b);
      if (ra !== rb) return ra - rb;
      if (ra === 0) return depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1);
      if (ra === 9) return deepestFirst(a, b);
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
  return [...ops.filter(early).sort(deepestFirst), ...rest];
}

/** How a file system that folds names would see a path: the widest fold (case and accents). */
const foldName = (p: string) => p.normalize('NFC').toLowerCase();
