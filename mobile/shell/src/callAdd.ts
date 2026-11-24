// callAdd.ts — the voice call screen's ＋ Add (Nov 24 2026): a camera photo, a picked photo or video, a recorded
// video, any file, a command or skill, and the call memory. What is added waits on the Mac for the person's next
// spoken question, which takes it to the Voice central (server/voice/callAttach.ts); nothing is sent on its own.
//
// A file goes as raw bytes: CapacitorHttp sends `dataType: 'file'` base64 as the body's bytes (iOS and Android), as
// application/octet-stream so the Mac's JSON parser leaves it alone; its name and type ride headers.
import { bearer, field, jsonHeaders, type HttpRequester } from './http.js';
import { CALL_MESSAGES, type CallLine } from './voiceCall.js';

export type AddedKind = 'photo' | 'video' | 'file' | 'skill';

/** What waits for the next question, as the Mac shows it (no saved path). */
export interface AddedItem {
  id: string;
  kind: AddedKind;
  name: string;
}

/** The Mac's cap (callAttach.ts CALL_ATTACH_MAX_BYTES). */
export const CALL_FILE_MAX_BYTES = 100 * 1024 * 1024;

export interface FileToAdd {
  name: string;
  type: string;
  base64: string;
  size: number;
}

export type AddResult = { ok: true; item: AddedItem } | { ok: false; message: string };

const KINDS: readonly string[] = ['photo', 'video', 'file', 'skill'];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const callUrl = (line: CallLine, callId: string, rest: string) => `${line.origin}/api/voice/call/${encodeURIComponent(callId)}/${rest}`;

function parseItem(v: unknown): AddedItem | null {
  return isObj(v) && typeof v.id === 'string' && typeof v.name === 'string' && KINDS.includes(String(v.kind))
    ? { id: v.id, kind: v.kind as AddedKind, name: v.name }
    : null;
}

/** The progress answer's `pending`, well-formed items only. */
export function parsePending(data: unknown): AddedItem[] {
  return Array.isArray(data) ? data.map(parseItem).filter((i): i is AddedItem => i !== null) : [];
}

function added(status: number, data: unknown): AddResult {
  const item = status === 201 ? parseItem(field(data, ['data', 'item'])) : null;
  if (item) return { ok: true, item };
  if (status === 404) return { ok: false, message: 'The call can no longer take it. Update AASC on the Mac if this keeps happening.' };
  const reason = field(data, ['error']);
  return { ok: false, message: typeof reason === 'string' && reason ? reason.slice(0, 200) : 'The Mac couldn’t take it.' };
}

export async function uploadToCall(http: HttpRequester, line: CallLine, callId: string, file: FileToAdd): Promise<AddResult> {
  if (file.size > CALL_FILE_MAX_BYTES) return { ok: false, message: `${file.name} is over 100 MB.` };
  try {
    const res = await http.request({
      method: 'POST',
      url: callUrl(line, callId, 'attach'),
      headers: {
        ...bearer(line.token),
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(file.name),
        'X-File-Type': file.type,
      },
      bytes: file.base64,
      timeoutMs: 120_000,
    });
    return added(res.status, res.data);
  } catch {
    return { ok: false, message: CALL_MESSAGES.offline };
  }
}

export async function addSkillToCall(http: HttpRequester, line: CallLine, callId: string, name: string): Promise<AddResult> {
  try {
    const res = await http.request({ method: 'POST', url: callUrl(line, callId, 'skill'), headers: jsonHeaders(line.token), body: { name }, timeoutMs: 10_000 });
    return added(res.status, res.data);
  } catch {
    return { ok: false, message: CALL_MESSAGES.offline };
  }
}

export async function removeFromCall(http: HttpRequester, line: CallLine, callId: string, id: string): Promise<boolean> {
  try {
    const res = await http.request({ method: 'DELETE', url: callUrl(line, callId, `attach/${encodeURIComponent(id)}`), headers: bearer(line.token), timeoutMs: 10_000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

// ── Commands and skills (GET /api/commands) ─────────────────────────────────────────────────────────────────────

export interface CommandChoice {
  /** What the Voice central is told to use, sigil included (`/name`, `$name` for a Codex skill). */
  token: string;
  description: string;
}

/** The Mac's command index → tokens, the most used first, then by name (src/lib/commandIndex.ts entryToken). */
export function commandChoices(data: unknown): CommandChoice[] {
  const entries = field(data, ['entries']);
  const usage = field(data, ['usage']);
  const used = (token: string): number => {
    const n = isObj(usage) ? usage[token] : 0;
    return typeof n === 'number' && Number.isFinite(n) ? n : 0;
  };
  if (!Array.isArray(entries)) return [];
  const choices = entries
    .filter((e): e is Record<string, unknown> & { name: string } => isObj(e) && typeof e.name === 'string' && e.name !== '')
    .map((e) => {
      const name = e.source === 'plugin' && typeof e.pluginName === 'string' ? `${e.pluginName}:${e.name}` : e.name;
      const sigil = e.cli === 'codex' && e.kind === 'skill' ? '$' : '/';
      return { token: `${sigil}${name}`, description: typeof e.description === 'string' ? e.description : '' };
    });
  return choices.sort((a, b) => used(b.token) - used(a.token) || a.token.slice(1).localeCompare(b.token.slice(1)));
}

export async function requestCommands(http: HttpRequester, line: CallLine, cli: 'claude' | 'codex'): Promise<CommandChoice[] | null> {
  try {
    const res = await http.request({ method: 'GET', url: `${line.origin}/api/commands?cli=${cli}`, headers: bearer(line.token), timeoutMs: 10_000 });
    return res.status === 200 ? commandChoices(res.data) : null;
  } catch {
    return null;
  }
}

// ── Call memory (GET/POST /api/voice/memory) ────────────────────────────────────────────────────────────────────

export interface MemoryRow {
  id: string;
  kind: string;
  meant: string;
  heard: string;
  status: 'proposed' | 'kept';
}

/** Proposals (newest first), then kept items: skipped and retired ones are not shown. */
export function parseMemory(data: unknown): MemoryRow[] {
  const items = field(data, ['items']);
  if (!Array.isArray(items)) return [];
  const rows = items
    .filter((i): i is Record<string, unknown> => isObj(i) && typeof i.id === 'string' && typeof i.meant === 'string'
      && (i.status === 'proposed' || i.status === 'kept'))
    .map((i) => ({
      id: String(i.id),
      kind: typeof i.kind === 'string' ? i.kind : '',
      meant: String(i.meant),
      heard: typeof i.heard === 'string' ? i.heard : '',
      status: i.status as MemoryRow['status'],
      createdAt: typeof i.createdAt === 'number' ? i.createdAt : 0,
    }));
  const order = (r: (typeof rows)[number]) => (r.status === 'proposed' ? 0 : 1);
  return rows.sort((a, b) => order(a) - order(b) || b.createdAt - a.createdAt).map(({ createdAt: _c, ...r }) => r);
}

export async function requestMemory(http: HttpRequester, line: CallLine): Promise<MemoryRow[] | null> {
  try {
    const res = await http.request({ method: 'GET', url: `${line.origin}/api/voice/memory`, headers: bearer(line.token), timeoutMs: 10_000 });
    return res.status === 200 ? parseMemory(field(res.data, ['data'])) : null;
  } catch {
    return null;
  }
}

export async function decideMemory(http: HttpRequester, line: CallLine, id: string, action: 'keep' | 'skip' | 'retire'): Promise<boolean> {
  try {
    const res = await http.request({
      method: 'POST', url: `${line.origin}/api/voice/memory/${encodeURIComponent(id)}`, headers: jsonHeaders(line.token), body: { action }, timeoutMs: 10_000,
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** A picked file's bytes as base64 (FileReader's data URL, its prefix dropped). */
export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}
