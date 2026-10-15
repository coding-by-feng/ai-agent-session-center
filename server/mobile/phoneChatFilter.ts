// phoneChatFilter.ts — what a paired phone sees of the files an agent touched (AASC-41 / AASC-44).
//
// The chat and changes routes return what the agent read and wrote, straight from its
// transcript. A phone may read a shared session's project, but never a secret file in it
// (AASC-28, secretPaths.ts): the project browser refuses `.env` or `~/.ssh/config`, so the
// chat must not hand over the same content as a Read result or an Edit's new text. The phone
// still sees that the agent touched the file, and which one, just not what was in it.
//
// Applied by the phone profile to paired phones only; the Mac and a password sign-in see all. What
// touched a secret file is decided by the chat's page reader, on each call's whole input and across
// pages, and marked on the entries (server/chat/secretMarks.ts); this hides by those marks, and hides a
// result whose call the reader couldn't find (fail closed, for phones only).

import { pathLooksSecret } from './secretPaths.js';

/** What a phone sees instead of output that came from a secret file. */
export const HIDDEN_ON_PHONES = '[Hidden on phones: this touched a secret file]';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Argument names that hold the one file a tool reads or writes. */
const PATH_FIELDS = ['file_path', 'path', 'notebook_path'] as const;

/** A tool_use whose input carries a secret file's content: which file(s) it was, not what was in them. */
function redactedInput(entry: Rec): unknown {
  const input = entry.input;
  const field = isRec(input) ? PATH_FIELDS.find((f) => typeof input[f] === 'string') : undefined;
  if (isRec(input) && field) return { [field]: input[field], redacted: true };
  return { redacted: true, paths: Array.isArray(entry.editPaths) ? entry.editPaths : [] };
}

/** `GET /sessions/:id/chat` for a phone: secret files' content replaced, everything else as is. */
export function filterPhoneChatAnswer(body: unknown): unknown {
  if (!isRec(body) || !isRec(body.data) || !Array.isArray(body.data.entries)) return body;
  const entries = body.data.entries.map((raw: unknown) => {
    if (!isRec(raw)) return raw;
    if (raw.kind === 'tool_use' && raw.secretInput === true) {
      const { inputTruncated: _cut, ...rest } = raw;
      return { ...rest, input: redactedInput(raw) };
    }
    if (raw.kind === 'tool_result' && (raw.secret === true || raw.callUnknown === true)) {
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
