/**
 * @module secretCalls
 * Which tool calls touched a secret file (AASC-41), by the one list in server/mobile/secretPaths.ts.
 *
 * Judged on a call's RAW input, as the transcript holds it (the chat shows at most 2 KB of it):
 * Claude's `file_path` / `path` / `notebook_path` and Bash `command`, Codex's `cmd`, local shell
 * `action.command`, `exec` / `js` code, and patches in any form (an apply_patch input, a FileChange
 * map, a patch written inside a script). Any string argument naming a secret file or folder counts.
 *
 * A path inside the session's project is judged from the project root down (a worktree under
 * `<repo>/.claude/worktrees/` isn't secret for the `.claude` above it); inside, any secret folder or
 * secret-looking name still counts, and a path outside the project is judged in full. A relative
 * path is taken from the project root, as the agent's working directory.
 */
import { homedir } from 'node:os';
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { pathLooksSecret, segmentLooksSecret } from '../mobile/secretPaths.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How a call touched a secret file. */
export interface SecretTouch {
  /** The input itself carries that file's content (a read, an edit or a patch of it), not just its name. */
  content: boolean;
  /** When `content`: every file the call names (all of a patch's files, one of them secret). */
  paths: string[];
}

/** Argument names that hold the one file a tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

/**
 * `*** Add|Update|Delete File: x` lines anywhere in a string: an apply_patch input, or a patch
 * written inside an `exec` script (its newlines then `\n` escapes, which end the path too).
 */
const PATCH_FILE_RE = /\*\*\* (?:Add|Update|Delete) File: ([^\n\r"'`\\]+)/g;

const expandHome = (path: string): string =>
  (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/**
 * Does `path`, as an agent wrote it, name a secret file or folder, for a session whose project is
 * `projectRoot`? Without a root (or with one that is itself a secrets folder, like `~/.ssh`), the
 * whole path is judged.
 */
export function pathLooksSecretIn(path: string, projectRoot?: string | null): boolean {
  if (!projectRoot || !isAbsolute(projectRoot)) return pathLooksSecret(path);
  const root = normalize(projectRoot);
  const rootIsSecret = segmentLooksSecret(basename(root));
  const expanded = expandHome(path);
  // Fast paths (every word of every command comes here). Judging from the root only ever drops
  // segments, so an absolute path with no secret segment is fine; a relative one that can't climb out
  // of the project is judged as written.
  if (isAbsolute(expanded) && !pathLooksSecret(expanded)) return false;
  if (!isAbsolute(expanded) && !expanded.split(/[\\/]+/).includes('..')) return rootIsSecret || pathLooksSecret(expanded);
  const abs = isAbsolute(expanded) ? normalize(expanded) : resolve(root, expanded);
  const rel = relative(root, abs);
  const inside = rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
  if (inside && !rootIsSecret) return rel !== '' && pathLooksSecret(rel);
  return pathLooksSecret(abs);
}

/** Files a patch touches: Codex's FileChange map, or the patch text's file lines. */
function patchPaths(input: unknown): string[] | null {
  if (isRec(input) && isRec(input.changes)) return Object.keys(input.changes);
  if (typeof input === 'string' && input.includes('*** Begin Patch')) {
    return [...input.matchAll(PATCH_FILE_RE)].map((m) => m[1].trim());
  }
  return null;
}

/** Characters split off between the words of a command, a script or an argument. */
const WORD_BREAK_RE = /[\s'"`|;&<>()=,{}[\]]+/;
/** How deep into nested arguments the check looks. */
const MAX_DEPTH = 8;

/** Does any string in `value` (a command as text or argv, code, any argument) name a secret file or folder? */
function mentionsSecret(value: unknown, root: string | null | undefined, depth = 0): boolean {
  if (typeof value === 'string') return value.split(WORD_BREAK_RE).some((w) => w !== '' && pathLooksSecretIn(w, root));
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => mentionsSecret(child, root, depth + 1));
}

/** How a call with this raw input touched a secret file, or null when it didn't. */
export function secretTouch(input: unknown, projectRoot?: string | null): SecretTouch | null {
  const secret = (path: string) => pathLooksSecretIn(path, projectRoot);
  const patch = patchPaths(input);
  if (patch && patch.some(secret)) return { content: true, paths: patch };
  if (isRec(input)) {
    const field = PATH_FIELDS.find((f) => typeof input[f] === 'string');
    const path = field ? (input[field] as string) : '';
    if (path && secret(path)) return { content: true, paths: [path] };
  }
  return mentionsSecret(input, projectRoot) ? { content: false, paths: [] } : null;
}
