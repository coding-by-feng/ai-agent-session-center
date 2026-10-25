/**
 * @module historyResume
 * How to reopen a session that is only in the history (SQLite), not in the live store.
 *
 * A history row keeps no launch command, so the saved conversation decides: a Claude transcript
 * (`~/.claude/projects/<encoded dir>/<id>.jsonl`) means `claude --resume`, a Codex rollout
 * (`~/.codex/sessions/…/rollout-…-<id>.jsonl`) means `codex resume`. The same file says where and how
 * the session ran:
 *  - where: the first `cwd` it records is the folder it was LAUNCHED in. The row's `project_path` is the
 *    agent's last working folder (it follows a `cd`), and `claude --resume` finds a conversation only
 *    from its launch folder, which is also the folder Claude files the transcript under;
 *  - how: Claude records the permission mode of a prompt, a Codex `turn_context` its approval and sandbox
 *    policy, and both their model and effort (`readingFromTranscript`).
 * Those lines can be anywhere in a file of many megabytes (a 16 MB rollout held 9 turn contexts; one
 * transcript recorded its mode once, 1.4 MB into 2 MB), so the whole file is streamed once.
 *
 * Only this id's own file ever counts, never "the newest conversation in the folder" (AASC-49),
 * which would reopen somebody else's session.
 */
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeProjectsRoot, projectDirCandidates } from './extractPreviousAnswer.js';
import { codexHome, findCodexRollout } from './codexRollout.js';
import { readingFromTranscript } from './sessionRuntime.js';

export type HistoryResumeCli = 'claude' | 'codex';

export interface HistoryResumePlan {
  cli: HistoryResumeCli;
  /** The launch command the resume line is built on: `claude`, `codex`, or `codex` + its bypass flag. */
  command: string;
  /** The folder to resume in: where the conversation was launched, else the row's last folder. */
  workingDir?: string;
  /** Claude only: the permission mode of the last prompt (`reconstructPermissionFlags` turns it into a flag). */
  permissionMode?: string;
  /** A `--model` value the user chose (`/model`, or Codex's per-turn model); a reply never pins one. */
  model?: string;
  effortLevel?: string;
}

export interface HistoryResumeRoots {
  claudeProjects?: string;
  codex?: string;
}

/** A CLI conversation id. It becomes a file name and a shell argument, so nothing else is accepted. */
const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_MODE_RE = /^[a-zA-Z-]{1,40}$/;
const CODEX_BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox';

interface ConversationLine {
  type?: unknown;
  subtype?: unknown;
  isSidechain?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  permissionMode?: unknown;
  content?: unknown;
  commandRun?: unknown;
  message?: { model?: unknown } | null;
  payload?: {
    cwd?: unknown;
    model?: unknown;
    effort?: unknown;
    approval_policy?: unknown;
    sandbox_policy?: { type?: unknown } | null;
  } | null;
}

interface ConversationScan {
  launchDir?: string;
  permissionMode?: string;
  codexBypass: boolean;
  /** The lines `readingFromTranscript` reads, cut down to the fields it uses (replies can be large). */
  runtimeLines: string[];
}

function parse(line: string): ConversationLine | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' ? (value as ConversationLine) : null;
  } catch {
    return null;
  }
}

/** One pass over the file; only lines that can matter are parsed. */
async function scanConversation(file: string): Promise<ConversationScan> {
  const scan: ConversationScan = { codexBypass: false, runtimeLines: [] };
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.charCodeAt(0) !== 123 /* { */) continue;
    const wantsCwd = scan.launchDir === undefined && line.includes('"cwd":"');
    const wantsMode = line.includes('"permissionMode":"');
    const runtime = line.includes('"turn_context"') || line.includes('"local_command"') || line.includes('"type":"assistant"');
    if (!wantsCwd && !wantsMode && !runtime) continue;
    const entry = parse(line);
    if (!entry) continue;

    if (wantsCwd) {
      // Claude: a top-level `cwd` on its records. Codex: the `session_meta` payload.
      const cwd = typeof entry.cwd === 'string' ? entry.cwd : entry.type === 'session_meta' ? entry.payload?.cwd : undefined;
      if (typeof cwd === 'string' && cwd.startsWith('/')) scan.launchDir = cwd;
    }
    if (wantsMode && typeof entry.permissionMode === 'string' && PERMISSION_MODE_RE.test(entry.permissionMode)) {
      scan.permissionMode = entry.permissionMode;
    }
    if (entry.type === 'turn_context') {
      scan.codexBypass = entry.payload?.approval_policy === 'never' && entry.payload?.sandbox_policy?.type === 'danger-full-access';
      scan.runtimeLines.push(JSON.stringify({
        type: 'turn_context', timestamp: entry.timestamp, payload: { model: entry.payload?.model, effort: entry.payload?.effort },
      }));
    } else if (entry.type === 'assistant') {
      scan.runtimeLines.push(JSON.stringify({
        type: 'assistant', timestamp: entry.timestamp, isSidechain: entry.isSidechain, message: { model: entry.message?.model },
      }));
    } else if (entry.type === 'system' && entry.subtype === 'local_command') {
      scan.runtimeLines.push(JSON.stringify({
        type: 'system', subtype: 'local_command', timestamp: entry.timestamp, isSidechain: entry.isSidechain,
        content: entry.content, commandRun: entry.commandRun,
      }));
    }
  }
  return scan;
}

/** `<id>.jsonl` in the row's folder, else in whichever project folder Claude filed it under. */
function claudeTranscript(sessionId: string, projectPath: string, root: string): string | null {
  const name = `${sessionId}.jsonl`;
  if (projectPath) {
    for (const dir of projectDirCandidates(projectPath, root)) {
      if (existsSync(join(dir, name))) return join(dir, name);
    }
  }
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(root, dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/**
 * The folder to resume a Claude conversation in: its launch folder, when that is the folder Claude
 * filed the transcript under (so `claude --resume` finds it there), else the row's last folder.
 */
function claudeWorkingDir(file: string, launchDir: string | undefined, projectPath: string, root: string): string | undefined {
  const filedUnder = dirname(file);
  const matches = (dir: string): boolean => projectDirCandidates(dir, root).includes(filedUnder);
  if (launchDir && matches(launchDir)) return launchDir;
  if (projectPath && matches(projectPath)) return projectPath;
  return launchDir ?? (projectPath || undefined);
}

/**
 * How to resume `sessionId` from its saved conversation, or null when neither CLI saved one
 * (a `term-*` placeholder, a session killed before its first flush, or a transcript since cleaned up).
 */
export async function planHistoryResume(
  sessionId: string,
  projectPath: string,
  roots: HistoryResumeRoots = {},
): Promise<HistoryResumePlan | null> {
  if (!CONVERSATION_ID_RE.test(sessionId)) return null;

  const claudeRoot = roots.claudeProjects ?? claudeProjectsRoot();
  const claudeFile = claudeTranscript(sessionId, projectPath, claudeRoot);
  const codexFile = claudeFile ? null : await findCodexRollout(sessionId, roots.codex ?? codexHome());
  const file = claudeFile ?? codexFile;
  if (!file) return null;

  let scan: ConversationScan;
  try {
    scan = await scanConversation(file);
  } catch {
    return null;
  }
  const reading = readingFromTranscript(scan.runtimeLines);
  if (claudeFile) {
    return {
      cli: 'claude',
      command: 'claude',
      workingDir: claudeWorkingDir(claudeFile, scan.launchDir, projectPath, claudeRoot),
      permissionMode: scan.permissionMode,
      model: reading.launchModel,
      // Claude writes an effort only for an explicit `/effort`; anything else is the launch default.
      effortLevel: reading.effortSet && reading.effort ? reading.effort : undefined,
    };
  }
  return {
    cli: 'codex',
    command: scan.codexBypass ? `codex ${CODEX_BYPASS_FLAG}` : 'codex',
    workingDir: scan.launchDir ?? (projectPath || undefined),
    model: reading.launchModel,
    effortLevel: reading.effort ?? undefined,
  };
}
