/**
 * @module secretCalls
 * Which tool calls touched a secret file (AASC-41), by the one list in server/mobile/secretPaths.ts.
 *
 * Judged on a call's RAW input, as the transcript holds it (the chat shows at most 2 KB of it):
 * Claude's `file_path` / `path` / `notebook_path` and Bash `command`, Codex's `cmd`, local shell
 * `action.command`, `exec` / `js` code, and patches in any form (an apply_patch input, a FileChange
 * map, a patch written inside a script). Any string argument naming a secret file or folder counts.
 */
import { pathLooksSecret } from '../mobile/secretPaths.js';

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
function mentionsSecret(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.split(WORD_BREAK_RE).some((w) => w !== '' && pathLooksSecret(w));
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => mentionsSecret(child, depth + 1));
}

/** How a call with this raw input touched a secret file, or null when it didn't. */
export function secretTouch(input: unknown): SecretTouch | null {
  const patch = patchPaths(input);
  if (patch && patch.some(pathLooksSecret)) return { content: true, paths: patch };
  if (isRec(input)) {
    const field = PATH_FIELDS.find((f) => typeof input[f] === 'string');
    const path = field ? (input[field] as string) : '';
    if (path && pathLooksSecret(path)) return { content: true, paths: [path] };
  }
  return mentionsSecret(input) ? { content: false, paths: [] } : null;
}
