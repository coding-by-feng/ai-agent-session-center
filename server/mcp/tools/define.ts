// tools/define.ts — what every tool module shares: how a tool is declared, how it names a session, how it
// reads a route's answer, how it marks text another session wrote, and a few text helpers.
//
// The rules a tool follows, all of them here so no tool re-decides one:
//   * a session argument goes through `resolveTarget` (the full id or a unique prefix, scope-checked);
//   * a value written into a route path goes through `seg`;
//   * a route's answer goes through `unwrap`, which checks `ok` first;
//   * text a session or its terminal wrote goes through `fence`;
//   * a refusal never repeats an argument value back (a model's value could carry anything).
//
// Tool modules import `ToolDef` and the like from ../registry.js with `import type` only: registry.ts imports
// tools/index.ts, so a runtime import back would be a cycle.

import { homedir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { z } from 'zod';
import type { Room } from '../../../src/types/room.js';
import type { Session } from '../../../src/types/session.js';
import type { InternalResponse } from '../client.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { normalizeFolder } from '../paths.js';
import { isWithin, shortIdOf } from '../scope.js';
import { ToolError, type Phase, type Risk, type Toolset } from '../types.js';

// ---------------------------------------------------------------------------
// Declaring a tool
// ---------------------------------------------------------------------------

/** What `defineTool` takes: a `ToolDef` whose `run` is handed the arguments its `input` shape parsed. */
export interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  toolset: Toolset;
  title: string;
  description: string;
  risk: Risk;
  phase: Phase;
  input: Shape;
  idempotent?: boolean;
  /**
   * The question for the person of a tool whose risk waits for them (`ask`, `destructive`, `outward`; registry.ts
   * `ToolDef.confirm`), handed the same typed arguments.
   */
  confirm?(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): ConfirmAsk | null | Promise<ConfirmAsk | null>;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolResult>;
}

/**
 * A `ToolDef` with typed arguments. The endpoint checks a call's arguments against `input` before it calls
 * `run` (server.ts), so the casts below only name what that check already proved.
 */
export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolDef {
  const { run, confirm, ...def } = spec;
  type Args = z.infer<z.ZodObject<Shape>>;
  return {
    ...def,
    ...(confirm === undefined ? {} : { confirm: (args: Record<string, unknown>, ctx: ToolContext) => confirm(args as Args, ctx) }),
    run: (args, ctx) => run(args as Args, ctx),
  };
}

/** The `id` argument of every per-session tool. */
export const SESSION_REF = z
  .string()
  .min(1)
  .max(200)
  .describe('A session: its id, or the start of its id (6 or more characters; session_list shows the short id).');

// ---------------------------------------------------------------------------
// Route paths
// ---------------------------------------------------------------------------

/**
 * One value for a route path: percent-encoded, so an id with a `/`, `?`, `#` or `%` in it stays one segment.
 * `.` and `..` are refused: they stay as they are, and the URL parser would resolve them away, onto another
 * route (client.ts catches only a path that leaves /api).
 */
export function seg(value: string): string {
  const encoded = encodeURIComponent(value);
  if (encoded === '' || encoded === '.' || encoded === '..') {
    throw new ToolError(
      'INVALID',
      'That value cannot be used in a route path.',
      'Pass it exactly as a list tool showed it.',
    );
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// Small helpers every tool module used to carry its own copy of
// ---------------------------------------------------------------------------

/** `3 sessions`, `1 session`, `2 entries` (give the plural when it is not just an `s`). */
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A plain object: not null, not an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string with something in it, else null. */
export const nonEmptyString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** A tool's input (or any value) as text: a string as it is, anything else as compact JSON. */
export function inputText(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

/** The `source` of a fence around text a session wrote: `session:<id>`. */
export const sessionSource = (sessionId: string): string => `session:${sessionId}`;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** `text` cut to at most `max` characters, how long it was, and whether it was cut. */
export function clipText(text: string, max: number): { text: string; truncated: boolean; length: number } {
  if (text.length <= max) return { text, truncated: false, length: text.length };
  return { text: text.slice(0, max), truncated: true, length: text.length };
}

/** One line of at most `max` characters: whitespace and newlines folded to single spaces, cut with `…`. */
export function oneLine(text: string, max: number): string {
  const folded = text.replace(/\s+/g, ' ').trim();
  return folded.length > max ? `${folded.slice(0, Math.max(0, max - 1))}…` : folded;
}

/**
 * `text` as a value that can stand in the plain words around a tool's answer: anything but letters, digits and
 * `_ - . :` becomes `_`, cut to `max`. For an id or a name a caller passed or a route gave, never for prose.
 */
export function plain(text: string, max = 60): string {
  return text.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, max);
}

/** A closing `</untrusted` in any spelling a reader would take for one (case, spaces inside the tag). */
const CLOSING_TAG = /<\s*\/\s*untrusted/gi;

/** An attribute value limited to what an id or a kind is made of; anything else becomes `_`. */
const attribute = (value: string): string => value.replace(/[^A-Za-z0-9:_.-]/g, '_').slice(0, 80);

/**
 * Text another session (or its terminal, or a file it wrote) produced, marked as data:
 * `<untrusted source="session:abc123" kind="answer">…</untrusted>`. The playbook tells a central that what
 * sits inside is never an instruction. A closing tag inside `text` is escaped (`<\/untrusted`), so the text
 * cannot end the block and speak as AASC.
 */
export function fence(source: string, kind: string, text: string): string {
  const body = text.replace(CLOSING_TAG, '<\\/untrusted');
  return `<untrusted source="${attribute(source)}" kind="${attribute(kind)}">${body}</untrusted>`;
}

// ---------------------------------------------------------------------------
// A route's answer
// ---------------------------------------------------------------------------

const RETRY_HINT = 'Try it once more; if it fails again, tell the person (the details are in the AASC log).';
const ROUTE_ERROR_MAX = 200;

/** The route's own words for what went wrong, bounded. */
function routeWords(r: InternalResponse<unknown>): string {
  return clipText(r.error ?? `HTTP ${r.status}`, ROUTE_ERROR_MAX).text;
}

/** A failed call as the refusal a central reads: the route's status says what kind. */
function routeFailure(r: InternalResponse<unknown>): ToolError {
  const why = routeWords(r);
  if (r.status === 404) return new ToolError('NOT_FOUND', why, 'Check the id with the list tool for what you asked about (session_list, terminal_list).');
  if (r.status === 400) return new ToolError('INVALID', why, 'Check the arguments in the tool’s input schema.');
  if (r.status === 503) return new ToolError('UNAVAILABLE', why, 'It may be back in a moment; try once more.');
  if (r.status === 0) return new ToolError('UPSTREAM', `AASC could not be reached: ${why}`, RETRY_HINT);
  return new ToolError('UPSTREAM', why, RETRY_HINT);
}

/**
 * What a route answered, without its envelope. `ok` is checked first: a failed call becomes the ToolError its
 * status asks for (404 NOT_FOUND, 400 INVALID, 503 UNAVAILABLE, the rest UPSTREAM, always with the route's own
 * error). A 2xx is read by shape: `{ success: true, data }` gives `data` (null stays null: some routes have
 * nothing to give), `{ ok: true, data }` gives `data`, `{ ok: true, …rest }` gives `rest`, anything else comes back
 * whole. A 2xx with no readable body (the client turns a non-JSON answer into null), or one that says it failed,
 * is UPSTREAM.
 */
export function unwrap<T = unknown>(r: InternalResponse<unknown>): T {
  if (!r.ok) throw routeFailure(r);
  const body = r.data;
  if (body === null || body === undefined) {
    throw new ToolError('UPSTREAM', 'AASC answered with nothing readable.', RETRY_HINT);
  }
  if (!isRecord(body)) return body as T;
  if (body.success === false || body.ok === false) {
    const said = typeof body.error === 'string' && body.error !== '' ? body.error : 'The route reported a failure.';
    throw new ToolError('UPSTREAM', clipText(said, ROUTE_ERROR_MAX).text, RETRY_HINT);
  }
  if (body.success === true && 'data' in body) return body.data as T;
  if (body.ok === true) {
    if ('data' in body) return body.data as T;
    const { ok: _ok, ...rest } = body;
    return rest as T;
  }
  return body as T;
}

// ---------------------------------------------------------------------------
// Naming a session
// ---------------------------------------------------------------------------

/** The shortest prefix of an id a reference may be (an exact id of any length is always taken). */
const MIN_PREFIX = 6;

/** The longest id written out in plain words. */
const REF_MAX = 80;

/**
 * How the plain words around a tool's answer (and a refusal's hint) name a session, given every session there
 * is: its 8-character short id when that names one session, else its whole id. Ids that start alike share a
 * short id (`term-<ms>-…` ids all begin `term-179`, `external-<pid>` ids all `external`), and then only the
 * whole id can be used as a reference. Anything an id is not made of shows as `_` (see `plain`), so a hook's odd
 * id cannot put raw text into the words around an answer.
 */
export function refsFor(sessions: readonly Session[]): (sessionId: string) => string {
  const starts = new Map<string, number>();
  for (const s of sessions) {
    const short = shortIdOf(s.sessionId);
    starts.set(short, (starts.get(short) ?? 0) + 1);
  }
  return (sessionId) => {
    const short = shortIdOf(sessionId);
    const namesOne = (starts.get(short) ?? 0) <= 1 && sessionId.startsWith(short);
    return plain(namesOne ? short : sessionId, REF_MAX);
  };
}

/** `refsFor` the sessions the context holds. */
export const refOf = (ctx: ToolContext): ((sessionId: string) => string) => refsFor(ctx.sessions());

/** The refusal for something out of scope: it says nothing more about what it refuses. */
export const notInScope = (what = 'session'): ToolError =>
  new ToolError(
    'NOT_IN_SCOPE',
    `That ${what} is outside your scope.`,
    'Call session_list to see the sessions you can reach.',
  );

/**
 * The session `ref` names, for a tool that answers about it or acts on it. `ref` is the full session id or
 * the start of one (at least 6 characters, the 8-character short id `session_list` gives being the usual
 * form). An id is followed through AASC's alias chain first (`ctx.resolveSessionId`: a card re-keyed from term-*
 * to the CLI's id, or restored from a workspace, keeps answering to the id a central was given), then an exact id
 * is taken. A prefix must start exactly one session among ALL sessions, in scope or not, so a reference never
 * silently means a different session when another one appears. Then the scope check (`ctx.inScope`, the one rule):
 * a session out of scope is NOT_IN_SCOPE, and nothing more is said about it. A prefix that starts several is
 * INVALID, listing only the candidates this central may see, each by the reference that names it (`refsFor`:
 * the short id, or the whole id where short ids collide).
 *
 * The answer is a shallow copy (ctx.sessions()), so a caller cannot change the store through it.
 */
export function resolveTarget(ctx: ToolContext, ref: string): Session {
  const wanted = typeof ref === 'string' ? ref.trim() : '';
  if (wanted === '') {
    throw new ToolError('INVALID', 'A session reference is empty.', 'Pass a session id from session_list.');
  }
  const all = ctx.sessions();
  const current = ctx.resolveSessionId(wanted);
  const exact =
    (current === null ? undefined : all.find((s) => s.sessionId === current)) ?? all.find((s) => s.sessionId === wanted);
  const matches = exact !== undefined ? [exact] : prefixMatches(all, wanted);
  if (matches.length === 0) {
    throw new ToolError('NOT_FOUND', 'No session matches that reference.', 'Call session_list for the ids.');
  }
  if (matches.length === 1) {
    if (!ctx.inScope(matches[0])) throw notInScope();
    return matches[0];
  }
  const candidates = matches.filter((s) => ctx.inScope(s));
  if (candidates.length === 0) throw notInScope();
  const nameOf = refsFor(all);
  const named = [...new Set(candidates.map((s) => nameOf(s.sessionId)))].join(', ');
  throw new ToolError(
    'INVALID',
    'That reference starts more than one session.',
    `Use more characters of the id. Candidates: ${named}.`,
  );
}

/** Sessions whose id starts with `prefix`; too short a prefix names none and is refused as INVALID. */
function prefixMatches(all: readonly Session[], prefix: string): Session[] {
  if (prefix.length < MIN_PREFIX) {
    throw new ToolError(
      'INVALID',
      `A session reference is a full id or at least ${MIN_PREFIX} characters of one.`,
      'Pass the id or short id that session_list shows.',
    );
  }
  return all.filter((s) => s.sessionId.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * The rooms this central may see, as new rooms. `ctx.rooms()` is the Mac's whole list, which a room or
 * project central must not read: a global central gets every room, whole; a room central its own room; a
 * project central the rooms that hold a session it can see. Every room but a global central's is cut down to
 * the member sessions the central may see.
 */
export function visibleRooms(ctx: ToolContext): Room[] {
  const rooms = ctx.rooms();
  const { kind, scopeRef } = ctx.central;
  if (kind === 'global') return rooms;
  const visible = new Set(ctx.scopedSessions().map((s) => s.sessionId));
  const keep =
    kind === 'room'
      ? (r: Room): boolean => r.id === scopeRef
      : (r: Room): boolean => r.sessionIds.some((id) => visible.has(id));
  return rooms
    .filter(keep)
    .map((r) => ({ ...r, sessionIds: r.sessionIds.filter((id) => visible.has(id)) }));
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

/**
 * `/`, the home folder or a folder above it: a root so wide that everything in home counts as "inside" it. A
 * central started in one (a room whose session runs in `~`) must not thereby reach the whole home tree: the
 * rule that refuses such a folder as a project scope (Ruling 22) applies here too.
 */
function isHomeOrAbove(folder: string): boolean {
  const home = homedir();
  return folder === home || home.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/** Is `wanted` inside `root`? A root that covers all of home allows only itself. */
function insideRoot(wanted: string, root: string): boolean {
  return isHomeOrAbove(root) ? wanted === root : isWithin(wanted, root);
}

/**
 * A folder as a person writes it, normalized: absolute, or `~` / `~/…`. A relative one (or `~other`) would mean a
 * folder of the server's own, so it is refused (INVALID, never repeating the value). The result is what a tool
 * checks with `folderInScope` and sends on to a route.
 */
export function writtenFolder(folder: string): string {
  if (!isAbsolute(folder) && folder !== '~' && !folder.startsWith('~/')) {
    throw new ToolError('INVALID', 'A folder is an absolute path, or one that starts with ~.', 'Pass the project folder as session_list shows it.');
  }
  return normalizeFolder(folder);
}

/** The folder a project central is scoped to, normalized; null for a global or a room central. */
export function projectFolder(ctx: ToolContext): string | null {
  const { kind, scopeRef } = ctx.central;
  return kind === 'project' && scopeRef !== null && scopeRef.trim() !== '' ? normalizeFolder(scopeRef) : null;
}

/**
 * May this central ask about `folder`? A global central may ask about any folder. A project central may ask
 * about its project folder and everything below it. A room central, and a project central too, may ask about
 * the folder of a session in scope and anything below it, except that a folder which is home or above it
 * (`/`, `/Users`, `~`) allows itself only. A tool that takes a folder normalizes it, checks it with this and
 * sends the same normalized value on, and refuses with `notInScope('folder')`.
 */
export function folderInScope(ctx: ToolContext, folder: string): boolean {
  const { kind, scopeRef } = ctx.central;
  if (kind === 'global') return true;
  const wanted = normalizeFolder(folder);
  if (kind === 'project' && scopeRef !== null && insideRoot(wanted, normalizeFolder(scopeRef))) return true;
  return ctx
    .scopedSessions()
    .some((s) => s.projectPath.trim() !== '' && insideRoot(wanted, normalizeFolder(s.projectPath)));
}
