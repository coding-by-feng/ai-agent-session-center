// openWorker.ts — the one way a central opens a session: its own worker (Ruling P4-3), over POST /api/terminals.
//
// In order, and nothing is opened until every check has passed:
//   1. the spec (Zod): a CLI AASC runs, a model and an effort that CLI takes, a title that passes the title rule
//      (titleRule.ts, Ruling P3-23: it is typed as `-n "<title>"` and stored back as loose words), a room id; then, before
//      anything is awaited, a slot of the central's worker budgets is reserved (at most 8 live own workers, 10 opens a rolling
//      minute, opens still in flight counted: Ruling P4-18), and given back when the open fails or is done
//   2. the folder: the launch rule (launchRule.ts) and the central's scope, on the folder as written, then again on
//      its real path (a link is judged by where it leads); a folder that is not there is INVALID
//   3. the room: one the Mac has (NOT_FOUND); a room central files into its own room only (DENIED), by default
//   4. the permission cap from the central's card (Ruling P4-5): `plan` < `default` < `acceptEdits` < `auto`/`dontAsk`
//      < `bypassPermissions`. A mode looser than the central's is DENIED; a central whose mode AASC does not know (a
//      Codex central's card has none) caps at `default`; nothing asked gives the stricter of `default` and the
//      central's. The flag goes into `command` (`--dangerously-skip-permissions` only for a bypassing central's ask)
//      and `permissionMode` is sent so a resume rebuilds it. A Codex worker takes no permission mode in P4.
//   5. the plan budget (BUDGET): none while that CLI's 5-hour plan window is above 90 %
//   6. POST /terminals with exactly the fields below; never `central` (the route refuses it from a central, P4-4),
//      `startupCommand`, SSH, tmux, an API key, an ops shell, sharing, hands-off, pinning or other card metadata
//   7. the worker is recorded as the central's own (workers.ts), then filed into its room via POST /rooms/ops (with no
//      AASC window open nothing files it: it stays out of the room's list, in the central's scope as its own worker)
//
// `openThroughRoute` is the same gate for a relaunch of a card (resume, reconnect, fork, clone; Ruling P3-8): the folder
// rules on the folder the route opens in and on every other folder the tool names (Ruling P3-24: a card's folder and
// its SSH config's workingDir, which is where the routes open it), the cap (permissionCap.ts, on the mode the card would
// run in), the plan window and the budgets, then the route the tool names. Fork and clone become the central's own
// workers, recorded in the folder that opens; resume and reconnect count against the minute's opens only
// (`workers.noteOpen`).
//
// The words of every refusal are AASC's own: they never repeat the folder, the title or what the route said.

import { z } from 'zod';
import log from '../logger.js';
import type { InternalResponse } from './client.js';
import { expandHomePath, inCentralScope, isKnownProject, launchRefusal, LAUNCH_REFUSALS } from './launchRule.js';
import type { ActivityNote } from './activity.js';
import { assertWithinCap, BYPASS_MODE, centralCap, DEFAULT_MODE, MODE_RANK } from './permissionCap.js';
import type { ToolContext } from './registry.js';
import { ToolError, type CliKind } from './types.js';
import { titleRefusal } from './titleRule.js';
import { workers as serverWorkers, type WorkerRegistry } from './workers.js';

/** What a central asks for. Left-out model and effort are the CLI's own defaults. */
export interface WorkerSpec {
  cli: CliKind;
  folder: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  title: string;
  /** The room to file it into; a room central's own room when left out. */
  roomId?: string | null;
}

export interface OpenedWorker {
  terminalId: string;
  /** Its card's id now (the terminal id until the CLI's first hook re-keys it). */
  sessionId: string;
  /** The real path it was opened in. */
  folder: string;
  cli: CliKind;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  roomId: string | null;
  /** The room has it now. */
  filed: boolean;
  /** Why it is not filed yet, in AASC's words; null when nothing is to be said. */
  note: string | null;
}

export interface OpenWorkerDeps {
  /** The known project roots (folders the CLI has worked in). */
  knownProjects(): Promise<readonly string[]>;
  home: string;
  /** The folder's real path; rejects when it is not there. */
  realpath(p: string): Promise<string>;
  /** How full the CLI's 5-hour plan window is, 0–100; null when AASC does not know. */
  planWindowPct(cli: CliKind): number | null;
  now(): number;
  /** The own-worker registry; the server's by default. */
  workers?: WorkerRegistry;
}

/** The most live workers a central keeps. */
export const MAX_LIVE_WORKERS = 8;
/** The most sessions a central opens in a rolling minute. */
export const MAX_OPENS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;
/** Above this, no worker of that CLI is opened. */
export const PLAN_WINDOW_MAX_PCT = 90;

/**
 * The note of a worker no AASC window was open to file (no workspace writer). Nothing files it later: it is the
 * central's own worker (workers.ts), so a room central reaches it all the same, but the room's list does not show it.
 */
export const ROOM_FILED_LATER =
  'not in the room’s list: no AASC window was open to file it; it is your own worker, so it is in your scope all the same';
const ROOM_NOT_FILED = 'it is open, but AASC could not file it into the room';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Is this an effort the CLI takes (what the spec check below accepts)? */
export const isEffortFor = (cli: CliKind, effort: string): boolean =>
  (cli === 'claude' ? CLAUDE_EFFORTS : CODEX_EFFORTS).some((e) => e === effort);

const specSchema = z
  .object({
    cli: z.enum(['claude', 'codex']),
    folder: z.string().min(1).max(4_096),
    model: z
      .string()
      .max(100)
      .regex(/^[a-zA-Z0-9._-]+$/)
      .optional(),
    effort: z.string().max(20).optional(),
    permissionMode: z.string().max(40).optional(),
    title: z.string().trim().min(1).max(500),
    roomId: z.string().min(1).max(200).nullable().optional(),
  })
  .refine((s) => s.effort === undefined || isEffortFor(s.cli, s.effort));

/** What POST /terminals answers when it opened a session. */
const openedSchema = z.object({
  ok: z.literal(true),
  terminalId: z.string().min(1).max(200),
  deduplicated: z.boolean().optional(),
});

const PICK_FOLDER = 'Pick a project folder inside the home folder.';

function invalid(message: string, hint: string): ToolError {
  return new ToolError('INVALID', message, hint);
}

/** The folder rules on one spelling of the folder (as written, then real): null when it may be opened there. */
function folderRefusal(ctx: ToolContext, folder: string, known: readonly string[], home: string): ToolError | null {
  const refusal = launchRefusal(folder, known, home);
  if (refusal === LAUNCH_REFUSALS.notAbsolute) return invalid(refusal, PICK_FOLDER);
  if (refusal !== null) return new ToolError('DENIED', refusal, PICK_FOLDER);
  const absolute = expandHomePath(folder, home) ?? folder;
  if (!inCentralScope(ctx, absolute)) {
    return new ToolError('DENIED', 'A project central opens sessions in its own project only.', 'Pick a folder inside your project.');
  }
  return null;
}

/** The folder's real path, judged again there; throws the refusal. */
async function realFolder(ctx: ToolContext, folder: string, known: readonly string[], deps: OpenWorkerDeps): Promise<string> {
  const written = folderRefusal(ctx, folder, known, deps.home);
  if (written !== null) throw written;
  let real: string;
  try {
    real = await deps.realpath(expandHomePath(folder, deps.home) ?? folder);
  } catch {
    throw invalid('That folder is not there on this Mac.', 'Pick a project folder that exists (project_resolve lists them).');
  }
  const refusal = folderRefusal(ctx, real, known, deps.home);
  if (refusal === null) return real;
  // A project central's own folder may itself be reached through a link: judge the real path against its real one.
  const { kind, scopeRef } = ctx.central;
  if (refusal.code === 'DENIED' && kind === 'project' && scopeRef !== null && launchRefusal(real, known, deps.home) === null) {
    const realScope = await deps.realpath(scopeRef).catch(() => null);
    if (realScope !== null && inCentralScope({ central: { ...ctx.central, scopeRef: realScope } }, real)) return real;
  }
  throw refusal;
}

/** The room the worker is filed into, checked before anything opens. */
function roomFor(ctx: ToolContext, asked: string | null | undefined): string | null {
  const { kind, scopeRef } = ctx.central;
  const roomId = asked ?? (kind === 'room' ? scopeRef : null);
  if (roomId === null) return null;
  if (kind === 'room' && roomId !== scopeRef) {
    throw new ToolError('DENIED', 'A room central files its sessions into its own room only.', 'Leave the room out.');
  }
  if (!ctx.rooms().some((r) => r.id === roomId)) {
    throw new ToolError('NOT_FOUND', 'There is no room with that id.', 'room_list shows the rooms.');
  }
  return roomId;
}

/** The mode the worker runs in (Ruling P4-5), or the refusal. Null for a Codex worker. */
function permissionFor(ctx: ToolContext, cli: CliKind, asked: string | undefined): string | null {
  if (cli === 'codex') {
    if (asked !== undefined) {
      throw invalid('A Codex session takes no permission mode here.', 'Leave the permission mode out for a Codex session.');
    }
    return null;
  }
  if (asked !== undefined && MODE_RANK[asked] === undefined) {
    throw invalid(
      'That is not a permission mode.',
      'Use plan, default, acceptEdits, auto, dontAsk or bypassPermissions, or leave it out.',
    );
  }
  const cap = centralCap(ctx);
  if (asked === undefined) return MODE_RANK[cap] < MODE_RANK[DEFAULT_MODE] ? cap : DEFAULT_MODE;
  if (MODE_RANK[asked] > MODE_RANK[cap]) {
    throw new ToolError(
      'DENIED',
      'A central opens sessions no looser than its own permission mode.',
      'Ask for your own mode or a stricter one, or leave it out.',
    );
  }
  return asked;
}

/** Opens in flight per registry and central: reserved before the first await, given back once the open settles. */
const inFlight = new WeakMap<WorkerRegistry, ReadonlyMap<string, number>>();

const inFlightOf = (registry: WorkerRegistry, centralId: string): number => inFlight.get(registry)?.get(centralId) ?? 0;

function setInFlight(registry: WorkerRegistry, centralId: string, n: number): void {
  const next = new Map(inFlight.get(registry) ?? []);
  if (n > 0) next.set(centralId, n);
  else next.delete(centralId);
  inFlight.set(registry, next);
}

/**
 * Checks the worker budgets with the opens still in flight counted, and reserves a slot, all synchronously (P4-18):
 * two calls at the last slot cannot both pass. Answers the release, to call once the open has settled.
 */
function reserveSlot(ctx: ToolContext, registry: WorkerRegistry, deps: OpenWorkerDeps): () => void {
  const { centralId } = ctx.central;
  const pending = inFlightOf(registry, centralId);
  if (registry.liveCount(centralId, ctx.sessions()) + pending >= MAX_LIVE_WORKERS) {
    throw new ToolError(
      'BUDGET',
      `A central keeps at most ${MAX_LIVE_WORKERS} sessions of its own open.`,
      'Reuse one of them, or wait for one to finish.',
    );
  }
  if (registry.opensSince(centralId, deps.now() - MINUTE_MS) + pending >= MAX_OPENS_PER_MINUTE) {
    throw new ToolError('BUDGET', `A central opens at most ${MAX_OPENS_PER_MINUTE} sessions a minute.`, 'Try again in a minute.');
  }
  setInFlight(registry, centralId, pending + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setInFlight(registry, centralId, inFlightOf(registry, centralId) - 1);
  };
}

function assertPlanBudget(cli: CliKind, deps: OpenWorkerDeps): void {
  const pct = deps.planWindowPct(cli);
  if (pct !== null && pct > PLAN_WINDOW_MAX_PCT) {
    throw new ToolError(
      'BUDGET',
      `The plan's 5-hour window is over ${PLAN_WINDOW_MAX_PCT} % used: AASC opens no new session of that CLI now.`,
      'Reuse a session that is open, or wait for the window to roll on.',
    );
  }
}

/** The CLI with at most its permission flag: the command a worker is opened with (relaunchRule.ts allows it). */
export function workerCommandFor(cli: CliKind, mode: string | null): string {
  if (cli === 'codex' || mode === null || mode === DEFAULT_MODE) return cli;
  return mode === BYPASS_MODE ? 'claude --dangerously-skip-permissions' : `claude --permission-mode ${mode}`;
}

/** What the route's refusal means to the central, in fixed words. */
function routeRefusal(status: number): ToolError {
  if (status === 429) {
    return new ToolError('BUDGET', 'AASC is at its session limit.', 'Close a session, or reuse one that is open.');
  }
  if (status === 400) return invalid('AASC refused the new session as asked.', 'Check the folder, the model and the effort.');
  if (status === 403 || status === 409) {
    return new ToolError('DENIED', 'AASC did not let that session open.', 'Pick another folder, or ask the person.');
  }
  return new ToolError('UPSTREAM', 'AASC could not open the session.', 'Try again in a moment.');
}

/** Files the worker into its room: filed, or not yet with why. */
async function fileIntoRoom(ctx: ToolContext, terminalId: string, roomId: string): Promise<{ filed: boolean; note: string | null }> {
  const res = await ctx.client.post('/rooms/ops', { type: 'move', sessionId: terminalId, roomId });
  if (res.ok) return { filed: true, note: null };
  const noWriter = res.status === 409 && (res.data as { error?: unknown } | null)?.error === 'no-writer';
  if (!noWriter) log.warn('mcp', `Filing a central's new worker into its room failed (HTTP ${res.status})`);
  return { filed: false, note: noWriter ? ROOM_FILED_LATER : ROOM_NOT_FILED };
}

/**
 * Opens a session as the calling central's own worker, or throws a ToolError (in the order the header gives) before
 * anything opens. Once POST /terminals has answered, the worker is open: a room that cannot take it yet is a note.
 */
export async function openWorker(ctx: ToolContext, spec: WorkerSpec, deps: OpenWorkerDeps): Promise<OpenedWorker> {
  const parsed = specSchema.safeParse(spec);
  if (!parsed.success) {
    throw invalid(
      'That session cannot be opened as asked.',
      'Give claude or codex, a folder, a title of up to 500 characters, a plain model name and an effort that CLI takes.',
    );
  }
  const s = parsed.data;
  const badTitle = titleRefusal(s.title);
  if (badTitle !== null) throw invalid(badTitle, 'Give a title of plain words.');
  const registry = deps.workers ?? serverWorkers;
  const release = reserveSlot(ctx, registry, deps);
  try {
    return await openReserved(ctx, s, registry, deps, release);
  } finally {
    release();
  }
}

/**
 * openWorker once its slot is reserved: the folder, room, mode and plan checks, then the open and its record. The
 * reservation is handed back as soon as the worker is recorded (it counts as a live card from then on), not after the
 * room filing: a slow filing would otherwise count the worker twice against the next open (Ruling P4-44).
 */
async function openReserved(
  ctx: ToolContext,
  s: z.infer<typeof specSchema>,
  registry: WorkerRegistry,
  deps: OpenWorkerDeps,
  release: () => void,
): Promise<OpenedWorker> {
  const known = await deps.knownProjects();
  const folder = await realFolder(ctx, s.folder, known, deps);
  const roomId = roomFor(ctx, s.roomId);
  const permissionMode = permissionFor(ctx, s.cli, s.permissionMode);
  assertPlanBudget(s.cli, deps);

  const knownFolder = isKnownProject(folder, known) || isKnownProject(expandHomePath(s.folder, deps.home) ?? '', known);
  const body = {
    forceNew: true,
    requireExistingDir: true,
    workingDir: folder,
    command: workerCommandFor(s.cli, permissionMode),
    sessionTitle: s.title,
    ...(s.model !== undefined ? { model: s.model } : {}),
    ...(s.effort !== undefined ? { effortLevel: s.effort } : {}),
    ...(permissionMode !== null ? { permissionMode } : {}),
    ...(knownFolder ? {} : { autoConfirmTrust: false as const }),
  };
  const res = await ctx.client.post('/terminals', body);
  if (!res.ok) throw routeRefusal(res.status);
  const answer = openedSchema.safeParse(res.data);
  if (!answer.success || answer.data.deduplicated === true) {
    log.warn('mcp', `POST /terminals answered a central's new worker without a new session (HTTP ${res.status})`);
    throw new ToolError('UPSTREAM', 'AASC did not open a new session.', 'Try again in a moment.');
  }
  const { terminalId } = answer.data;
  registry.add({ centralId: ctx.central.centralId, terminalId, openedAt: deps.now(), folder, cli: s.cli });
  release();
  log.info('mcp', `A central opened its own ${s.cli} worker in terminal ${terminalId.slice(0, 12)}`);

  const filing = roomId === null ? { filed: false, note: null } : await fileIntoRoom(ctx, terminalId, roomId);
  return {
    terminalId,
    sessionId: terminalId,
    folder,
    cli: s.cli,
    model: s.model ?? null,
    effort: s.effort ?? null,
    permissionMode,
    roomId,
    ...filing,
  };
}

// ---------------------------------------------------------------------------
// A relaunch of a card (Ruling P3-8): the same checks, then the route the tool names
// ---------------------------------------------------------------------------

/**
 * A resume, reconnect, fork or clone of a card, as its tool hands it here: the card's CLI and folder, whether the open
 * becomes the central's own worker (fork and clone) or not (resume and reconnect relaunch the card itself), the mode
 * it would run in (permissionCap.ts `effectiveModeOf`, never a body), and the call of its route.
 */
export interface RouteOpen {
  cli: CliKind;
  /** The folder the route opens the terminal in; recorded for an own open. */
  folder: string;
  /** Other folders that must pass the folder rules too (the card's own folder when the route opens another). */
  alsoJudged?: readonly string[];
  own: boolean;
  mode: string;
  call(): Promise<InternalResponse<unknown>>;
}

/** What a relaunch route answers when it opened a terminal. */
const relaunchedSchema = z.object({
  ok: z.literal(true),
  terminalId: z.string().min(1).max(200),
  newTerminal: z.boolean().optional(),
});

/** A route's refusal of a relaunch, in fixed words: openWorker's, plus 404 for a card the route no longer has. */
function relaunchRefusal(status: number): ToolError {
  if (status === 404) return new ToolError('NOT_FOUND', 'AASC no longer has that session.', 'Call session_list for the ids.');
  return routeRefusal(status);
}

/** The per-minute count alone (a relaunch that is not an own worker): checked, then recorded, synchronously. */
function noteMinuteOpen(ctx: ToolContext, registry: WorkerRegistry, deps: OpenWorkerDeps): void {
  const { centralId } = ctx.central;
  if (registry.opensSince(centralId, deps.now() - MINUTE_MS) + inFlightOf(registry, centralId) >= MAX_OPENS_PER_MINUTE) {
    throw new ToolError('BUDGET', `A central opens at most ${MAX_OPENS_PER_MINUTE} sessions a minute.`, 'Try again in a minute.');
  }
  registry.noteOpen(centralId, deps.now());
}

/**
 * Opens a terminal through the route `open.call` names, after the checks every open passes, in order: the folder rules
 * (the launch rule and scope, as written and real, on the folder it opens and on each of `alsoJudged`), the permission cap, the plan window, then the budgets (an own open
 * takes a slot of the 8 live and 10 a minute; any other counts against the 10 a minute only). The route's refusal is
 * told in fixed words; an own open is recorded as the central's worker in the real folder.
 */
export async function openThroughRoute(
  ctx: ToolContext,
  open: RouteOpen,
  deps: OpenWorkerDeps,
): Promise<{ terminalId: string; newTerminal: boolean }> {
  const registry = deps.workers ?? serverWorkers;
  const known = await deps.knownProjects();
  const folder = await realFolder(ctx, open.folder, known, deps);
  for (const other of open.alsoJudged ?? []) await realFolder(ctx, other, known, deps);
  assertWithinCap(ctx, open.mode);
  assertPlanBudget(open.cli, deps);
  const release = open.own ? reserveSlot(ctx, registry, deps) : null;
  try {
    if (release === null) noteMinuteOpen(ctx, registry, deps);
    const res = await open.call();
    if (!res.ok) throw relaunchRefusal(res.status);
    const answer = relaunchedSchema.safeParse(res.data);
    if (!answer.success) {
      log.warn('mcp', `A relaunch route answered a central without a terminal (HTTP ${res.status})`);
      throw new ToolError('UPSTREAM', 'AASC did not open the session.', 'Try again in a moment.');
    }
    const { terminalId } = answer.data;
    if (open.own) {
      registry.add({ centralId: ctx.central.centralId, terminalId, openedAt: deps.now(), folder, cli: open.cli });
      log.info('mcp', `A central opened its own ${open.cli} worker in terminal ${terminalId.slice(0, 12)} from a card`);
    }
    return { terminalId, newTerminal: open.own || answer.data.newTerminal === true };
  } finally {
    release?.();
  }
}

/** The activity note of an open: AASC's words and ids, never the folder or the title. */
export function openedWorkerNote(w: OpenedWorker): ActivityNote {
  const mode = w.permissionMode !== null && w.permissionMode !== DEFAULT_MODE ? ` (${w.permissionMode})` : '';
  const room = w.roomId === null ? '' : w.filed ? ', filed into its room' : `; ${w.note ?? ROOM_NOT_FILED}`;
  return { summary: `opened a ${w.cli} session of its own${mode}${room}`, targetSessionId: w.terminalId };
}
