/**
 * Project Sync — shared contract between server/projectSync and the Projects cards.
 * Import-free on purpose: the server imports it as `../../src/types/projectSync.js`.
 * Design: docs/plans/project-sync-design.md (§16: two-way, Oct 31 2026).
 */

/** `push` mirrors this machine onto the server (P1); `two-way` carries changes both ways (P2). */
export type SyncDirection = 'push' | 'two-way';
export type SyncKind = 'file' | 'dir' | 'symlink' | 'other';

/** One path as a manifest saw it. `sha256` is absent for dirs, symlinks, specials — and in the browser for credentials. */
export interface FileMeta {
  kind: SyncKind;
  size: number;
  mtimeMs: number;
  mode: number;
  sha256?: string;
  linkTarget?: string;
}

/**
 * How a path moved since the last sync (the base). `drift`: only the server changed it
 * (or deleted it); `extra`: only the server has it; `different`: no base yet and both
 * sides hold different content.
 */
export type SyncChange =
  | 'same'
  | 'add'
  | 'change'
  | 'delete'
  | 'drift'
  | 'conflict'
  | 'extra'
  | 'different'
  | 'blocked';

/**
 * What the run does with an entry. `push` and `delete-device` write on the server; `pull`
 * and `delete-local` write here; `keep-both` keeps this machine's file at its path and the
 * server's beside it (`copyPath`), on both sides. `review` means a decision is still owed.
 */
export type SyncAction =
  | 'push'
  | 'pull'
  | 'delete-device'
  | 'delete-local'
  | 'keep-both'
  | 'keep'
  | 'skip'
  | 'review';

export type SyncFlag =
  | 'credential'
  | 'link-outside'
  | 'live-db'
  | 'native-artifact'
  | 'git-busy'
  | 'worktree-gitdir'
  | 'case-collision'
  /** `.git/config` changed on the server: git here would read it (it can run programs). */
  | 'git-config'
  /** An executable file the server added or made executable. */
  | 'executable';

export type SyncEntryState = 'pending' | 'applying' | 'done' | 'failed' | 'skipped';

export interface SyncEntry {
  id: string;
  path: string;
  /** A repository (`<dir>/.git` or `.git`) or the top-level folder ('' = files in the root). */
  groupId: string;
  change: SyncChange;
  action: SyncAction;
  local?: FileMeta;
  device?: FileMeta;
  base?: FileMeta;
  flags: SyncFlag[];
  state: SyncEntryState;
  reason?: string;
  error?: string;
  /** keep-both: where the server's copy goes, and the operation id that writes it. */
  copyPath?: string;
  copyId?: string;
}

/** A repository is decided as one unit: `overwrite` takes this machine's, `take-device` the server's. */
export type SyncGroupDecision = 'sync' | 'overwrite' | 'take-device' | 'skip' | 'review';

export interface SyncRepoSide {
  head?: string;
  commit?: string;
}

export interface SyncGroup {
  id: string;
  isRepo: boolean;
  counts: Partial<Record<SyncChange, number>>;
  bytes: number;
  /** Repositories only: decided as one unit. */
  decision?: SyncGroupDecision;
  state?:
    | 'in-step'
    | 'local-ahead'
    | 'device-ahead'
    | 'both-changed'
    | 'device-changed'
    | 'different-repo'
    | 'busy';
  local?: SyncRepoSide;
  device?: SyncRepoSide;
}

export type SyncRunState =
  | 'comparing'
  | 'review'
  | 'running'
  | 'complete'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'undone';

export interface SyncRun {
  id: string;
  linkId: string;
  createdAt: number;
  updatedAt: number;
  state: SyncRunState;
  counts: Partial<Record<SyncChange, number>>;
  done: number;
  failed: number;
  total: number;
  /** `toSend`/`sent`: this machine → server; `toGet`/`got`: server → this machine. */
  bytes: { toSend: number; sent: number; toGet?: number; got?: number };
  groups: SyncGroup[];
  warnings: string[];
  error?: string;
  /** The entries still owing a decision (entry-level, outside repositories). */
  pendingDecisions: number;
  /** Set when the plan no longer matches the link (e.g. its exclusions changed): it can never run. */
  stale?: string;
  /** The compare produced a plan: only such a run can start. */
  planned?: boolean;
  /** When the run first started writing; undo needs it. */
  startedAt?: number;
}

export type SyncLinkState = 'never' | 'in-sync' | 'pending' | 'attention' | 'running';

export interface SyncLinkInput {
  name: string;
  projectId: string;
  deviceId: string;
  remoteRoot: string;
  excludes: string[];
  credentialsAck: boolean;
  /** Default `two-way`. */
  direction?: SyncDirection;
}

export interface SyncLink {
  id: string;
  name: string;
  projectId: string;
  /** Display path (`~/…`). */
  localPath: string;
  deviceId: string;
  remoteRoot: string;
  direction: SyncDirection;
  excludes: string[];
  credentialsAckAt?: number;
  hasBase: boolean;
  lastRunId?: string;
  state: SyncLinkState;
  createdAt: number;
  updatedAt: number;
}

/** A server, as the user typed it. */
export interface SyncDeviceInput {
  name: string;
  host: string;
  username: string;
  port: number;
}

/** A saved server: its trusted host-key digest is pinned when it is added. */
export interface SyncDevice extends SyncDeviceInput {
  id: string;
  fingerprint: string;
  home: string;
  platform: string;
  checkedAt: number;
}

export interface SyncOverview {
  links: SyncLink[];
  runs: SyncRun[];
  devices: SyncDevice[];
  /** False where AASC runs on Windows: the cards offer no sync there. */
  supported: boolean;
}

export interface SyncEntryPage {
  entries: SyncEntry[];
  total: number;
  offset: number;
}

export type SyncEntryFilter = 'all' | 'changes' | 'decisions' | 'credentials' | 'links' | 'failed';

export type SyncDecisions = Record<string, SyncAction | SyncGroupDecision>;

/**
 * What a new link leaves out: dependency and build folders, rebuilt on each side. Native
 * modules built on Linux do not run on macOS (and back), so copying them breaks both.
 */
export const DEFAULT_SYNC_EXCLUDES: readonly string[] = [
  'node_modules/',
  '.venv/',
  'venv/',
  '__pycache__/',
  'dist/',
  'build/',
  '.next/',
  'target/',
];

/** Actions that write on the server / on this machine. */
export const SERVER_ACTIONS: ReadonlySet<SyncAction> = new Set([
  'push',
  'delete-device',
  'keep-both',
]);
export const LOCAL_ACTIONS: ReadonlySet<SyncAction> = new Set([
  'pull',
  'delete-local',
  'keep-both',
]);
export const isActing = (a: SyncAction) => SERVER_ACTIONS.has(a) || LOCAL_ACTIONS.has(a);

/** Default action for a change in a push link; `review` = the user must choose. */
export function defaultSyncAction(change: SyncChange): SyncAction {
  switch (change) {
    case 'add':
    case 'change':
      return 'push';
    case 'delete':
      return 'delete-device';
    case 'extra':
      return 'keep';
    case 'same':
      return 'skip';
    case 'blocked':
      return 'skip';
    default:
      return 'review';
  }
}

/** Which actions a change may take in a push link. */
export function allowedSyncActions(change: SyncChange): SyncAction[] {
  switch (change) {
    case 'add':
    case 'change':
      return ['push', 'skip'];
    case 'delete':
      return ['delete-device', 'keep'];
    case 'extra':
      return ['keep', 'delete-device'];
    case 'drift':
    case 'different':
      return ['keep', 'push'];
    case 'conflict':
      return ['keep', 'push', 'delete-device'];
    default:
      return ['skip'];
  }
}

type Sides = Pick<SyncEntry, 'change' | 'local' | 'device'>;

/** Default action in a two-way link: whichever side moved since the base wins; both = review. */
export function defaultTwoWayAction(e: Sides): SyncAction {
  switch (e.change) {
    case 'add':
    case 'change':
      return 'push';
    case 'delete':
      return 'delete-device';
    case 'extra':
      return 'pull';
    case 'drift':
      return e.device ? 'pull' : 'delete-local';
    case 'different':
    case 'conflict':
      return 'review';
    default:
      return 'skip';
  }
}

/** Which actions an entry may take in a two-way link. `skip` leaves both sides as they are. */
export function allowedTwoWayActions(e: Sides): SyncAction[] {
  const L = !!e.local,
    R = !!e.device;
  switch (e.change) {
    case 'add':
    case 'change':
      return ['push', 'skip'];
    case 'delete':
      return ['delete-device', 'pull', 'skip'];
    case 'extra':
      return ['pull', 'delete-device', 'skip'];
    case 'drift':
      return R ? ['pull', 'push', 'skip'] : ['delete-local', 'push', 'skip'];
    case 'different':
    case 'conflict':
      if (L && R)
        return e.local!.kind === 'file' && e.device!.kind === 'file'
          ? ['push', 'pull', 'keep-both', 'skip']
          : ['push', 'pull', 'skip'];
      if (R) return ['pull', 'delete-device', 'skip'];
      if (L) return ['push', 'delete-local', 'skip'];
      return ['skip'];
    default:
      return ['skip'];
  }
}

/** The actions an entry may take in a link of this direction. */
export function actionsFor(e: Sides, direction: SyncDirection): SyncAction[] {
  return direction === 'two-way' ? allowedTwoWayActions(e) : allowedSyncActions(e.change);
}

/** The default action for an entry in a link of this direction. */
export function defaultActionFor(e: Sides, direction: SyncDirection): SyncAction {
  return direction === 'two-way' ? defaultTwoWayAction(e) : defaultSyncAction(e.change);
}

/** The actions an entry can take: allowed for its change, and possible with what each side holds. */
export function possibleActions(e: Sides, direction: SyncDirection): SyncAction[] {
  return actionsFor(e, direction).filter((a) => {
    switch (a) {
      case 'push':
        return !!e.local;
      case 'pull':
        return !!e.device;
      case 'delete-device':
        return !e.local && !!e.device;
      case 'delete-local':
        return !!e.local && !e.device;
      case 'keep-both':
        return e.local?.kind === 'file' && e.device?.kind === 'file';
      default:
        return true;
    }
  });
}

/**
 * Where keep-both puts the server's copy: `name.server-YYYYMMDD.ext` beside the file,
 * `-2`, `-3`… when that name is taken. `taken` sees every path both sides hold.
 */
export function keepBothPath(path: string, date: Date, taken: (p: string) => boolean): string {
  const slash = path.lastIndexOf('/');
  const dir = slash === -1 ? '' : path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${dir}${stem}.server-${day}${n === 1 ? '' : `-${n}`}${ext}`;
    if (!taken(candidate)) return candidate;
  }
  return `${dir}${stem}.server-${day}-${Date.now()}${ext}`;
}
