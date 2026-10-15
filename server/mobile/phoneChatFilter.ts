// phoneChatFilter.ts — what a paired phone sees of the files an agent touched (AASC-41 / AASC-44).
//
// The chat and changes routes return what the agent read and wrote, straight from its
// transcript. A phone may read a shared session's project, but never a secret file in it
// (AASC-28, secretPaths.ts): the project browser refuses `.env` or `~/.ssh/config`, so the
// chat must not hand over the same content as a Read result or an Edit's new text. The phone
// still sees that the agent touched the file, and which one, just not what was in it.
//
// Applied by the phone profile to paired phones only; the Mac and a password sign-in see all.

import { pathLooksSecret } from './secretPaths.js';

/** What a phone sees instead of output that came from a secret file. */
export const HIDDEN_ON_PHONES = '[Hidden on phones: this touched a secret file]';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Argument names that hold the one file a tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

/** Files a patch touches: Codex's FileChange map, or the free-form `*** Update File: x` text. */
function patchPaths(input: unknown): string[] | null {
  if (isRec(input) && isRec(input.changes)) return Object.keys(input.changes);
  if (typeof input === 'string' && input.includes('*** Begin Patch')) {
    return [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  }
  return null;
}

/** The words of a shell command, as a string or an argv array (`bash -lc "…"` included). */
function commandWords(input: unknown): string[] {
  if (!isRec(input)) return [];
  const { command } = input;
  const text = Array.isArray(command) ? command.filter((c) => typeof c === 'string').join(' ')
    : typeof command === 'string' ? command : '';
  return text.split(/[\s'"`|;&<>()=]+/).filter(Boolean);
}

/** The tool_use as a phone may see it, and whether its result must be hidden too. */
function redactToolUse(entry: Rec): { entry: Rec; hideResult: boolean } {
  const input = entry.input;
  const patch = patchPaths(input);
  if (patch) {
    return patch.some(pathLooksSecret)
      ? { entry: { ...entry, input: { redacted: true, paths: patch } }, hideResult: true }
      : { entry, hideResult: false };
  }
  if (isRec(input)) {
    const field = PATH_FIELDS.find((f) => typeof input[f] === 'string');
    if (field && pathLooksSecret(input[field] as string)) {
      return { entry: { ...entry, input: { [field]: input[field], redacted: true } }, hideResult: true };
    }
    // A command stays visible (it is what ran); what it printed from a secret file does not.
    if (commandWords(input).some(pathLooksSecret)) return { entry, hideResult: true };
  }
  return { entry, hideResult: false };
}

/** `GET /sessions/:id/chat` for a phone: secret files' content replaced, everything else as is. */
export function filterPhoneChatAnswer(body: unknown): unknown {
  if (!isRec(body) || !isRec(body.data) || !Array.isArray(body.data.entries)) return body;
  const hidden = new Set<string>();
  const entries = body.data.entries.map((raw: unknown) => {
    if (!isRec(raw)) return raw;
    if (raw.kind === 'tool_use') {
      const { entry, hideResult } = redactToolUse(raw);
      if (hideResult && typeof raw.id === 'string') hidden.add(raw.id);
      return entry;
    }
    if (raw.kind === 'tool_result' && typeof raw.toolUseId === 'string' && hidden.has(raw.toolUseId)) {
      return { ...raw, output: HIDDEN_ON_PHONES, truncated: false };
    }
    return raw;
  });
  return { ...body, data: { ...body.data, entries } };
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
