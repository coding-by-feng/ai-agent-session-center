// ---------------------------------------------------------------------------
// Chat transcript entries (AASC-41): one model for Claude's JSONL and Codex's
// rollout, read in pages by server/chat/ and drawn by the phone's chat view.
// ---------------------------------------------------------------------------

/** The CLI a transcript was written by. */
export type ChatCli = 'claude' | 'codex';

/**
 * What a `system` row marks:
 * - compacted     the context was compacted (`label`: manual / auto when known)
 * - cancelled     the user interrupted the turn
 * - model         the model or effort in use (`label`, e.g. `gpt-5.5 · high`); Codex writes one per
 *                 turn, so a row equal to the one before it is noise the client may drop
 * - resumed       the session continued in a new process
 * - notification  a background task reported back (`label`: its status)
 * - context       text the harness put into a user turn that nobody typed (`label` says what:
 *                 a skill, a system reminder, AGENTS.md, the environment, a compact summary)
 * - info          a notice from the CLI (an API error, a warning)
 */
export type ChatSystemKind = 'compacted' | 'cancelled' | 'model' | 'resumed' | 'notification' | 'context' | 'info';

interface ChatEntryBase {
  /**
   * Unique within one transcript file and stable across pages: `<byte offset of the line>:<index in
   * that line>`. A list keyed by it keeps its rows when older pages are prepended.
   */
  key: string;
  /** Epoch ms. A record without a time takes the previous record's (0 when there is none yet). */
  timestamp: number;
}

export interface ChatUserEntry extends ChatEntryBase {
  kind: 'user';
  text: string;
  /** Images attached to this prompt (never sent: only counted). */
  images?: number;
  /** `text` was cut at the 16 KB cap. */
  truncated?: boolean;
}

export interface ChatAssistantEntry extends ChatEntryBase {
  kind: 'assistant';
  text: string;
  truncated?: boolean;
}

/** The model thought here. Only how much and for how long: the thinking itself is never sent. */
export interface ChatThinkingEntry extends ChatEntryBase {
  kind: 'thinking';
  /** Characters of thinking (or of Codex's reasoning summary); 0 when the CLI keeps it encrypted. */
  length: number;
  durationMs?: number;
}

export interface ChatToolUseEntry extends ChatEntryBase {
  kind: 'tool_use';
  /** The call id; the matching `tool_result` carries it as `toolUseId`. */
  id: string;
  name: string;
  /**
   * The tool's arguments as the CLI wrote them (an object, or a string for free-form tools such as
   * Codex's `apply_patch`). At most 2 KB, except edit tools (Edit, Write, MultiEdit, NotebookEdit,
   * apply_patch), whose input is kept whole up to 64 KB so diffs can be drawn from it.
   */
  input: unknown;
  /** `input` went over its cap: long strings were cut, or it became a cut JSON string. */
  inputTruncated?: boolean;
  /**
   * The call touched a secret file (`.env`, `~/.ssh`, keys…; server/mobile/secretPaths.ts), judged on
   * its whole input. Only marked here: a paired phone gets it redacted, everyone else as is.
   */
  secret?: boolean;
  /** …and its input carries that file's content (a read, an edit or a patch of it). */
  secretInput?: boolean;
  /** With `secretInput`: every file the call reads or edits (all of a patch's files). */
  editPaths?: string[];
}

export interface ChatToolResultEntry extends ChatEntryBase {
  kind: 'tool_result';
  toolUseId: string;
  isError: boolean;
  /** At most 4 KB of text; images appear as `[image]`. */
  output: string;
  truncated: boolean;
  /** Its call touched a secret file (see ChatToolUseEntry.secret). */
  secret?: boolean;
  /** Its call wasn't found (not on this page, nor within the reader's lookback): what it touched is unknown. */
  callUnknown?: boolean;
}

export interface ChatTodoItem {
  text: string;
  /** `pending` / `in_progress` / `completed` as the CLI wrote it. */
  status: string;
}

/** A to-do list update (Claude TodoWrite, Codex update_plan). Replaces that tool_use. */
export interface ChatTodoEntry extends ChatEntryBase {
  kind: 'todo';
  /** The call id (its tool_result, if any, carries it as `toolUseId`). */
  id: string;
  items: ChatTodoItem[];
}

/** A subagent started (Claude Agent / Task, Codex spawn_agent). Replaces that tool_use. */
export interface ChatSubagentEntry extends ChatEntryBase {
  kind: 'subagent';
  /** The call id; the subagent's report arrives as the tool_result with this `toolUseId`. */
  id: string;
  description: string;
  agentType?: string;
  /** What the subagent was asked, cut at 16 KB. */
  prompt: string;
  background?: boolean;
  truncated?: boolean;
}

/** A slash command the user ran (`/model opus`), with what it printed. */
export interface ChatCommandEntry extends ChatEntryBase {
  kind: 'command';
  name: string;
  args?: string;
  output?: string;
}

export interface ChatSystemEntry extends ChatEntryBase {
  kind: 'system';
  system: ChatSystemKind;
  label?: string;
  text?: string;
  truncated?: boolean;
}

export type ChatEntry =
  | ChatUserEntry
  | ChatAssistantEntry
  | ChatThinkingEntry
  | ChatToolUseEntry
  | ChatToolResultEntry
  | ChatTodoEntry
  | ChatSubagentEntry
  | ChatCommandEntry
  | ChatSystemEntry;

/**
 * `GET /api/sessions/:id/chat` → `{ success: true, data: ChatPage }`.
 *
 * Cursors are opaque strings tied to one transcript file. `before` asks for the page above the oldest
 * entry the client holds; `after` asks for what was written since. No cursor gives the newest page.
 */
export interface ChatPage {
  /** Oldest first. */
  entries: ChatEntry[];
  /** Pass as `?before=` for older entries; null when the session has no transcript. */
  before: string | null;
  /** Pass as `?after=` for newer entries; null when the session has no transcript. */
  after: string | null;
  /** The CLI that wrote the transcript, or null when AASC can't read this session's conversation. */
  cli: ChatCli | null;
  /**
   * More in the direction asked: older entries before `before` (newest page or `before=`), or more
   * already written after `after` (`after=`, the budget ran out: ask again at once).
   */
  hasMore: boolean;
  /**
   * The cursor named another file (a `/clear` started a new transcript) or a point past its end:
   * this is the newest page of the current file, and the client should drop what it holds.
   */
  reset?: boolean;
}

// ---------------------------------------------------------------------------
// What a session edited (AASC-44), built from the edit calls in its own transcript.
// ---------------------------------------------------------------------------

/** One edited file in `GET /api/sessions/:id/changes`. */
export interface ChangedFile {
  /** Relative to the session's project when inside it, else absolute. */
  path: string;
  added: number;
  removed: number;
  /** Epoch ms of the last edit to it. */
  lastAt: number;
}

/** `GET /api/sessions/:id/changes` → `{ success: true, data: SessionChanges }`. */
export interface SessionChanges {
  /** Newest edit first; at most 200. `GET …/changes/<index>` opens one by its index here. */
  files: ChangedFile[];
  total: { added: number; removed: number };
  cli: ChatCli | null;
  /** More than 200 files were edited: the ones edited longest ago are left out. */
  truncated?: boolean;
}

/** A hunk of a unified diff. */
export interface DiffHunk {
  /**
   * 1-based line numbers in the file when the transcript says where (the CLI's own diff, a Codex
   * unified diff); 0 when it doesn't (a diff of just the edited text, a patch hunk with no numbers).
   */
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Each prefixed with ' ' (context), '-' (removed) or '+' (added). */
  lines: string[];
}

/** `GET /api/sessions/:id/changes/:fileIndex` → `{ success: true, data: FileChanges }`. */
export interface FileChanges extends ChangedFile {
  /** Every edit's hunks, oldest edit first. */
  hunks: DiffHunk[];
  /** The first edit created the file (all of it is added). */
  created?: boolean;
  /** The file was deleted. */
  deleted?: boolean;
  /** Overwritten with content whose earlier version isn't in the transcript: all lines show as added. */
  replaced?: boolean;
  /** The hunks passed 512 KB and the rest were left out (the counts still include them). */
  truncated?: boolean;
}
