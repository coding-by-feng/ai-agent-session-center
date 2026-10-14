/**
 * Project Sync — shared contract between server/projectSync and the PROJECTS sub-tab.
 * Import-free on purpose: the server imports it as `../../src/types/projectSync.js`.
 * Design: docs/plans/project-sync-design.md.
 */

export type SyncDirection = 'push';
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

/** What the run does with an entry. `review` means a decision is still owed. */
export type SyncAction = 'push' | 'delete-device' | 'keep' | 'skip' | 'review';

export type SyncFlag =
  | 'credential'
  | 'link-outside'
  | 'live-db'
  | 'native-artifact'
  | 'git-busy'
  | 'worktree-gitdir';

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
}

export type SyncGroupDecision = 'sync' | 'overwrite' | 'skip' | 'review';

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
  state?: 'in-step' | 'local-ahead' | 'device-changed' | 'different-repo' | 'busy';
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
  bytes: { toSend: number; sent: number };
  groups: SyncGroup[];
  warnings: string[];
  error?: string;
  /** The entries still owing a decision (entry-level, outside repositories). */
  pendingDecisions: number;
  /** Set when the plan no longer matches the link (e.g. its exclusions changed): it can never run. */
  stale?: string;
}

export type SyncLinkState = 'never' | 'in-sync' | 'pending' | 'attention' | 'running';

export interface SyncLinkInput {
  name: string;
  projectId: string;
  deviceId: string;
  remoteRoot: string;
  excludes: string[];
  credentialsAck: boolean;
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

export interface SyncOverview {
  links: SyncLink[];
  runs: SyncRun[];
}

export interface SyncEntryPage {
  entries: SyncEntry[];
  total: number;
  offset: number;
}

export type SyncEntryFilter = 'all' | 'changes' | 'decisions' | 'credentials' | 'links' | 'failed';

export type SyncDecisions = Record<string, SyncAction | SyncGroupDecision>;

/** Default action for a change; `review` = the user must choose. Shared so the tab and the server agree. */
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

/** Which actions a change may take. */
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
