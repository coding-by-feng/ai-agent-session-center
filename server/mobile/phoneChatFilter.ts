// phoneChatFilter.ts — what a paired phone sees of the files an agent touched (AASC-41 / AASC-44).
//
// The chat and changes routes return what the agent read and wrote, straight from its
// transcript. A phone may read a shared session's project, but never a secret file in it
// (AASC-28, secretPaths.ts): the project browser refuses `.env` or `~/.ssh/config`, so the
// chat must not hand over the same content as a Read result or an Edit's new text. The phone
// still sees that the agent touched the file, and which one, just not what was in it.
//
// Applied to paired phones only (the phone profile marks them); the Mac and a password sign-in see
// all. The chat's page reader applies `phoneCallRedaction` to each call's RAW input, before the chat's
// 2 KB cap, and to a result whose call came in an earlier page by looking that call up in the
// transcript; a result whose call it can't find is hidden too (server/chat/transcriptPager.ts).

import { pathLooksSecret } from './secretPaths.js';

/** What a phone sees instead of output that came from a secret file. */
export const HIDDEN_ON_PHONES = '[Hidden on phones: this touched a secret file]';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Argument names that hold the one file a tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

/**
 * Files a patch touches: Codex's FileChange map, or `*** Add|Update|Delete File: x` lines anywhere in
 * a string (an apply_patch input, or a patch written inside an `exec` script, `\n` escapes and all).
 */
const PATCH_FILE_RE = /\*\*\* (?:Add|Update|Delete) File: ([^\n\r"'`\\]+)/g;

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

/**
 * Does any string in a call's input (a shell command as text or argv, Codex's `cmd` or
 * `action.command`, a script's code, any other argument) name a secret file or folder?
 */
function mentionsSecret(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.split(WORD_BREAK_RE).some((w) => w !== '' && pathLooksSecret(w));
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => mentionsSecret(child, depth + 1));
}

/**
 * What a phone may see of one tool call, judged on its raw input. Null: all of it. Otherwise its
 * result is hidden, and `input`, when set, replaces what the call showed (the content of an edit or a
 * patch to a secret file). A command that merely names one stays visible: it is what ran.
 */
export function phoneCallRedaction(input: unknown): { input?: unknown } | null {
  const patch = patchPaths(input);
  if (patch && patch.some(pathLooksSecret)) return { input: { redacted: true, paths: patch } };
  if (isRec(input)) {
    const field = PATH_FIELDS.find((f) => typeof input[f] === 'string');
    if (field && pathLooksSecret(input[field] as string)) return { input: { [field]: input[field], redacted: true } };
  }
  return mentionsSecret(input) ? {} : null;
}

/**
 * `GET /sessions/:id/changes[/:n]` for a phone. A secret file stays in the list (the phone opens a
 * file by its index, so dropping one would shift the rest) with its counts, marked `redacted`; its
 * own diff comes back without hunks.
 */
export function filterPhoneChangesAnswer(body: unknown): unknown {
  if (!isRec(body) || !isRec(body.data)) return body;
  const data = body.data;
  if (Array.isArray(data.files)) {
    const files = data.files.map((f: unknown) =>
      (isRec(f) && typeof f.path === 'string' && pathLooksSecret(f.path) ? { ...f, redacted: true } : f));
    return { ...body, data: { ...data, files } };
  }
  if (typeof data.path === 'string' && pathLooksSecret(data.path)) {
    return { ...body, data: { ...data, hunks: [], redacted: true } };
  }
  return body;
}
