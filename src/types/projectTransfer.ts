/**
 * Copy / Move a project to another computer (Nov 27 2026, docs/plans/project-transfer.md).
 *
 * The source computer's server scans a project into a plan (files, the folder's Claude Code and
 * Codex memory, and its AASC data as a bundle). Electron main signs in to the target computer and
 * pipes packs of file bytes from the local server to the target's server, which stages them,
 * checks each one's SHA-256, and on commit puts the project in place and re-keys the memory.
 */

/** Where an item lives, on both sides. */
export type TransferGroup = 'project' | 'claude' | 'codex' | 'aasc';

export type TransferItemKind = 'file' | 'dir' | 'symlink';

/** One entry of a plan. `rel` is `/`-separated and relative to its group's root. */
export interface TransferItem {
  /** Index in the plan; packs name items by it. */
  i: number;
  group: TransferGroup;
  rel: string;
  kind: TransferItemKind;
  /** Bytes (files only; 0 otherwise). */
  size: number;
  /** Permission bits, already masked (no group/other write; credentials owner-only). */
  mode: number;
  /** Lowercase hex SHA-256 of a file's bytes; null for a dir or a symlink. */
  sha256: string | null;
  /** A symlink's target, relative and inside the project (others are left out of the plan). */
  linkTarget?: string;
}

/** What to bring along. Files always come. */
export interface TransferOptions {
  /** The folder's Claude Code project folder (memory + transcripts) and its Codex rollouts. */
  memory: boolean;
  /** This project's AASC data: ended sessions, prompts, notes + media, queued prompts. */
  aasc: boolean;
  /** node_modules holds native builds for this computer's CPU, so it is left out unless asked. */
  includeNodeModules: boolean;
}

export interface GroupTotals {
  files: number;
  bytes: number;
}

/** Counts in the AASC bundle (P2). */
export interface AascBundleCounts {
  sessions: number;
  prompts: number;
  notes: number;
  media: number;
  queues: number;
}

export interface TransferPlanSummary {
  /** Files to send (dirs and links are not counted) and their bytes. */
  files: number;
  bytes: number;
  byGroup: Record<TransferGroup, GroupTotals>;
  /** What the scan left out and why (capped list). */
  skipped: { rel: string; reason: string }[];
  skippedCount: number;
  /** Agent sessions mid-turn in the folder right now: Copy warns, Move refuses. */
  workingAgents: number;
  aasc: AascBundleCounts | null;
}

/** POST /api/project-transfer/plan answer (source, loopback only). */
export interface TransferPlanInfo {
  planId: string;
  /** The project folder, as this computer knows it. */
  root: string;
  /** Its folder name. */
  name: string;
  /** The folder relative to home (`Documents/exmouth`): the default destination on the target. */
  homeRelative: string;
  summary: TransferPlanSummary;
}

/** The target's state for one incoming transfer. */
export type IncomingState = 'awaiting-allow' | 'receiving' | 'declined' | 'committed' | 'cancelled';

/** POST /api/project-transfer/incoming (target) body. */
export interface IncomingRequest {
  /** Chosen by the source; the same id resumes a transfer the target still has staged. */
  id: string;
  projectName: string;
  /** Destination inside the target's home: `~/Documents/exmouth`. */
  destination: string;
  /** The project's path on the source, for re-keying memory (`cwd` fields). */
  sourceRoot: string;
  items: TransferItem[];
}

export interface IncomingStatus {
  id: string;
  state: IncomingState;
  /** Item indexes the target already holds, checked. */
  have: number[];
  /** `~/…` as the target will write it. */
  destination: string;
  message: string | null;
}

export interface PackResult {
  received: number[];
  failed: { i: number; reason: string }[];
}

export interface CommitResult {
  /** `~/…` on the target. */
  destination: string;
  files: number;
  bytes: number;
  claudeFiles: number;
  codexFiles: number;
  /** Memory files the target already had (never overwritten). */
  skippedExisting: number;
  aasc: AascBundleCounts | null;
  /** What did not come across after the project was in place (memory or history), in plain sentences. */
  warnings: string[];
}

/** A pending Allow on the target (GET /api/project-transfer/requests, loopback only). */
export interface IncomingTransferRequest {
  id: string;
  computerId: string;
  computerLabel: string;
  projectName: string;
  destination: string;
  files: number;
  bytes: number;
  requestedAt: number;
}

/** The marker a Move leaves on the source (GET /api/project-transfer/moved). */
export interface MovedProject {
  root: string;
  computer: string;
  destination: string;
  at: number;
}

// ---- The renderer ↔ Electron main contract (window.electronAPI.remotes) ----

export type TransferMode = 'copy' | 'move';

export interface TransferStartArgs {
  /** The paired computer (RemoteComputer.id). */
  remoteId: string;
  /** From POST /plan; main reads the items from the local server. */
  planId: string;
  /** `~/…` on the target. */
  destination: string;
  mode: TransferMode;
  /** Resume: the id of an earlier attempt the target may still hold. */
  transferId?: string;
}

export type TransferStage =
  | 'connecting'
  | 'waiting-allow'
  | 'sending'
  | 'committing'
  | 'moving'
  | 'done'
  | 'failed';

export interface TransferProgress {
  transferId: string;
  stage: TransferStage;
  sentFiles: number;
  totalFiles: number;
  sentBytes: number;
  totalBytes: number;
  message: string | null;
}

export interface TransferOutcome {
  transferId: string;
  commit: CommitResult;
  /** Move only: whether the source went to the Trash, and why not when it didn't. */
  moved: boolean | null;
  moveMessage: string | null;
}

/** A failure that can be resumed keeps its id so the dialog can offer Resume. */
export interface TransferFailure {
  transferId: string;
  error: string;
  /** `destination_exists`: send the user to Project Sync instead. */
  code?: string;
  resumable: boolean;
}

/** What `projectTransferStart` answers: a failure that can be resumed carries `failure`. */
export type TransferStartResult =
  | { ok: true; data: TransferOutcome }
  | { ok: false; error: string; failure?: TransferFailure };
