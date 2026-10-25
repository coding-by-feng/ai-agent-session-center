// router.ts — where a task goes: the pipeline scope → project → handoff? → eligible → score → reuse or create.
//
// A route is a DRY RUN. It reads (the project index, a project's history, the known projects, the edited files of its
// best few candidates) and decides; it opens nothing and types nothing. `task_route` shows the decision,
// `task_delegate(to: "auto")` carries it out (openWorker.ts, ledger.ts), and every decision comes with its reasons, in
// AASC's words, ready for the activity log (`explain`).
//
//   scope     a project central sees its folder and below; a room central its room's sessions; a global one all
//   project   resolveProject.ts: a path, a name, the room's projects, the most recent folder; `none` is INVALID
//   handoff   a global central hands the task DOWN to a live project central whose folder holds the project
//             (preferred, the closest one), else to a live room central whose room is the project's usual room;
//             never up or sideways, and never when a new session was asked for or a failed one is being replaced.
//             Each child is asked the policy's hand-off rails (Ruling P4-27): one they refuse (hands-off, busy, a
//             person at it) is passed over with its code as a reason, and the next is asked, then reuse, then create
//   eligible  `eligible`: not a central, popup, external card or SSH session; has a terminal; inside the project (P4-1;
//             by its real path too, so a card opened under a link spelling of the folder is the project's);
//             idle or waiting (P4-2); no open dialog; context below the ceiling; the CLI asked for; and the P2 steering
//             policy (hands-off, a person drove it in the last minute, it holds a task)
//   score     routeScore.ts; the edited files of the best 8 candidates are read to refine the task-words term, and
//             every candidate is read again after those reads (a status can change while they are awaited)
//   decide    reuse the best eligible session scoring at least the threshold, else create (a new session in the
//             project's folder with the CLI, model, effort and room its latest session used)
//
// The policy is asked through ONE adapter, `steerRefusal`, and last: `ctx.mayDrive` writes every refusal it throws to
// the activity log, so the router settles everything it can without it, and asks it only about sessions that could win
// (in score order, stopping at the first that may be steered, and never below the threshold or when a new session was
// asked for). A session the policy refuses shows up in `runnersUp` with its code as `skipped`.
//
// Pure of side effects but for reads through `ctx.client`; the disk (a folder's existence, its real path) is reached
// only through the deps. Never changes a session it is handed.

import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import type { Session } from '../../src/types/session.js';
import { startPending } from '../heardTerminals.js';
import { resolveCentralSession } from './centrals.js';
import { expandHomePath, inCentralScope, launchRefusal } from './launchRule.js';
import { normalizeFolder } from './paths.js';
import { listProjects, profileOf, type KnownProject, type ProjectProfile } from './projectIndex.js';
import type { DriveOptions, ToolContext } from './registry.js';
import {
  fsExists,
  fsRealpath,
  resolveProject,
  type ProjectBy,
  type ProjectHints,
  type ProjectResolution,
  type ResolveEnv,
} from './resolveProject.js';
import { editedFiles, hasTaskWords, hasWordMatch, scoreSession, type SessionScore } from './routeScore.js';
import { ROUTER_DEFAULTS, routerSettings, type RouterSettings } from './routerConfig.js';
import { isLocalSession, isWithin, shortIdOf, toSessionCard } from './scope.js';
import { cleanTitle } from './titleRule.js';
import { notInScope, oneLine } from './tools/define.js';
import { waitsOnPerson } from './tools/views.js';
import { ToolError, type CentralRecord, type CliKind } from './types.js';
import { knownRootsOf } from './workerDeps.js';
import { workers as serverWorkers } from './workers.js';

export { resolveProject } from './resolveProject.js';
export type { ProjectBy, ProjectConfidence, ProjectHints, ProjectResolution, RankedProject, ResolveEnv } from './resolveProject.js';
export { scoreSession } from './routeScore.js';
export type { SessionScore } from './routeScore.js';

// ---------------------------------------------------------------------------
// The spec's types
// ---------------------------------------------------------------------------

/** A session considered for the task: its score, why, and, when it cannot be used, why not. */
export interface Candidate {
  sessionId: string;
  shortId: string;
  score: number;
  reasons: readonly string[];
  /** Why this session cannot take the task (a status, `has an open dialog`, a policy code such as `HUMAN_ACTIVE`). */
  skipped?: string;
}

export type RouteDecision =
  | { kind: 'reuse'; sessionId: string; score: number; reasons: string[] }
  | {
      kind: 'create';
      folder: string;
      cli: CliKind;
      model?: string;
      effort?: string;
      roomId?: string;
      title: string;
      reasons: string[];
    }
  | { kind: 'handoff'; centralId: string; reasons: string[] };

export interface RouteResult {
  decision: RouteDecision;
  /** The other candidates by score, best first, skipped ones included (a skipped one says why). At most `runnersUp`. */
  runnersUp: Candidate[];
  /** How sure AASC is of the project (the decision itself is never a guess). */
  confidence: 'high' | 'medium' | 'low';
  /** The project the task is about and how it was found (`source`, in AASC's words). */
  project: { folder: string; source: string } | null;
}

export interface RouteInput {
  task: string;
  /** Only sessions of this CLI are reused, and a new one is this CLI. */
  cli?: CliKind;
  /** A project folder (absolute or `~/…`) or a project name. An explicit project is honoured or refused, never ignored. */
  project?: string;
  /** The model a new session starts with. */
  model?: string;
  /** Never reuse: always a new session. */
  newOnly?: boolean;
  /** Sessions to leave out (a re-route after the first one failed); aliases are followed. */
  exclude?: readonly string[];
}

/** What a route needs besides the context; every field has a real default, tests hand in stand-ins. */
export interface RouteDeps {
  settings?: RouterSettings;
  /** The real home folder. */
  home?: string;
  exists?: (folder: string) => boolean;
  realpath?: (folder: string) => string | null;
  /** The known project roots (default: GET /known-projects). */
  known?: () => Promise<readonly string[]>;
  /** Which central opened this session as its own worker, or null (the server's workers registry by default). */
  ownerOf?: (s: Session) => string | null;
}

// ---------------------------------------------------------------------------
// Eligible
// ---------------------------------------------------------------------------

/** What a caller wants of a session besides the policy's say. */
export interface EligibleWant {
  cli?: CliKind;
  /** The project's folder: a session must sit in it or below it (P4-1). */
  folder?: string | null;
  /** A session whose context window is this full (%) or more is not eligible (default 80). */
  contextCeilingPct?: number;
  exclude?: ReadonlySet<string>;
  /** True for a session another central opened as its own worker: it is spoken for (Ruling P4-56). */
  spokenFor?: (s: Session) => boolean;
}

/**
 * The one place the router asks the P2 steering policy (policy.ts `assertMaySteer`, through `ctx.mayDrive`, which also
 * knows presence and the ledger's lock), or, with `handOffTo`, its hand-off rails (`assertMayHandOff`). Null when the
 * central may steer the session (or hand it the task), else the policy's code. A change to the policy's signature
 * touches this function only.
 */
export function steerRefusal(
  session: Session,
  ctx: Pick<ToolContext, 'mayDrive'>,
  opts?: Pick<DriveOptions, 'handOffTo'>,
): string | null {
  try {
    if (opts === undefined) ctx.mayDrive(session);
    else ctx.mayDrive(session, opts);
    return null;
  } catch (err) {
    if (err instanceof ToolError) return err.code;
    throw err;
  }
}

/** What a session is that no central gives work to, or null. The policy refuses the same sessions; this says why, quietly. */
function kindRefusal(s: Session): string | null {
  if (s.central) return 'is a central';
  if (s.isFloating) return 'is a floating popup';
  if (s.isExternal) return 'is an external card';
  if (!isLocalSession(s)) return 'runs on another machine';
  if (!s.terminalId) return 'has no terminal';
  if (s.isSubagent) return 'is a subagent';
  if (s.projectPath.trim() === '') return 'has no folder';
  return null;
}

/** Every reason a session is out that needs no policy and writes nothing: the first one is the answer. */
function screenRefusal(s: Session, want: EligibleWant): string | null {
  if (want.exclude?.has(s.sessionId)) return 'excluded (re-route)';
  const kind = kindRefusal(s);
  if (kind !== null) return kind;
  if (want.spokenFor?.(s) === true) return 'another central’s own worker';
  if (want.folder && !isWithin(normalizeFolder(s.projectPath), normalizeFolder(want.folder))) return 'outside the project';
  const card = toSessionCard(s, []);
  if (want.cli !== undefined && card.cli !== want.cli) return card.cli === null ? 'runs an unknown CLI' : `runs ${card.cli}`;
  if (waitsOnPerson(s)) return 'has an open dialog';
  if (s.status !== 'idle' && s.status !== 'waiting') return s.status;
  // Idle by the connecting timeout, or unheard since AASC restarted: its CLI may still be at a prompt only a person
  // answers (Rulings P4-44, P4-58). The prompt route would refuse it, so it is passed over, not picked and failed.
  if (startPending(s)) return 'has not reported that it started';
  const ceiling = want.contextCeilingPct ?? ROUTER_DEFAULTS.contextCeilingPct;
  if (card.contextPct !== null && card.contextPct >= ceiling) return `context at ${card.contextPct} %`;
  return null;
}

/**
 * Why this session may not take the task, or null when it may: the cheap facts first, then the P2 steering policy
 * (`steerRefusal`). The reason is in AASC's words, or the policy's code (`HANDS_OFF`, `HUMAN_ACTIVE`, `BUSY`, …).
 */
export function eligible(session: Session, ctx: Pick<ToolContext, 'mayDrive'>, want: EligibleWant = {}): string | null {
  return screenRefusal(session, want) ?? steerRefusal(session, ctx);
}

// ---------------------------------------------------------------------------
// Words that go into the answer
// ---------------------------------------------------------------------------

const SOURCES: Record<ProjectBy, string> = {
  own: 'its own project',
  hint: 'the project named',
  path: 'a path in the task',
  name: 'a project named in the task',
  room: 'the room’s projects',
  recent: 'the most recently active project',
};

const SUMMARY_MAX = 300;

/** The decision as one line for the activity log and the tool's text: ids, statuses, numbers and AASC's words only. */
export function explain(result: RouteResult): string {
  const { decision, runnersUp, confidence } = result;
  const guess = confidence === 'high' ? '' : ` (${confidence} confidence in the project)`;
  const runner = runnersUp[0];
  const alongside = runner === undefined ? '' : `; runner-up #${runner.shortId} ${runner.skipped ?? `scored ${runner.score}`}`;
  const why = decision.reasons.join(', ');
  switch (decision.kind) {
    case 'reuse':
      return oneLine(`routed to #${shortIdOf(decision.sessionId)}: ${why}${guess}${alongside}`, SUMMARY_MAX);
    case 'create':
      return oneLine(`opens a new session: ${why}${guess}${alongside}`, SUMMARY_MAX);
    case 'handoff':
      return oneLine(`hands off to central #${shortIdOf(decision.centralId)}: ${why}${guess}`, SUMMARY_MAX);
  }
}

const TITLE_MAX = 60;

/**
 * The task as a session title: one line, at most 60 characters, cut at a word boundary with an ellipsis, and cleaned
 * by the title rule first (titleRule.ts `cleanTitle`: it is typed as `-n "<title>"` and stored back as loose words).
 */
export function shortTitle(task: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = cleanTitle(task.replace(/[\x00-\x1F\x7F-\x9F]/g, ' '));
  if (flat.length <= TITLE_MAX) return flat;
  const room = TITLE_MAX - 1;
  let head = flat.slice(0, room);
  if (flat[room] !== ' ') {
    const space = head.lastIndexOf(' ');
    if (space > 0) head = head.slice(0, space);
  }
  return `${head.replace(/[\s.,;:!?-]+$/, '')}…`;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** The best candidates (by the other terms) whose edited files are read. */
const FILES_FOR = 8;

/** A model name the terminals route accepts (`--model <id>`); it silently drops any other. */
const MODEL_FLAG = /^[a-zA-Z0-9._-]{1,100}$/;
const EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode']);

const flagModel = (model: string | null): string | null => (model !== null && MODEL_FLAG.test(model) ? model : null);
const flagEffort = (effort: string | null): string | null => (effort !== null && EFFORTS.has(effort) ? effort : null);

function hintsOf(project: string | undefined): ProjectHints {
  const text = typeof project === 'string' ? project.trim() : '';
  if (text === '') return {};
  return text === '~' || text.startsWith('~/') || text.startsWith('/') ? { folder: text } : { name: text };
}

const unknownProject = (): ToolError =>
  new ToolError(
    'INVALID',
    'AASC knows no project that matches the one you named.',
    'Pass a project folder or name that project_resolve lists, or delegate to a session by id.',
  );

/** The session ids to leave out, with the ids they have been re-keyed to. */
function excludedIds(ctx: ToolContext, exclude: readonly string[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const id of exclude ?? []) {
    ids.add(id);
    const current = ctx.resolveSessionId(id);
    if (current !== null) ids.add(current);
  }
  return ids;
}

/** Is there a live card (not ended, with a terminal) for this central? A central with none cannot be handed a task. */
const hasLiveCard = (sessions: readonly Session[], centralId: string): boolean =>
  sessions.some((s) => s.central?.centralId === centralId && s.status !== 'ended' && !!s.terminalId);

/**
 * May the task be handed down to this child central now? Its card is asked the policy's hand-off rails (through
 * `steerRefusal`); a refusal is written into `passedOver` as a reason, with its code.
 */
function mayHandOff(ctx: ToolContext, child: CentralRecord, sessions: readonly Session[], passedOver: string[]): boolean {
  const card = resolveCentralSession(child.centralId, sessions);
  const refusal = card === null ? 'UNAVAILABLE' : steerRefusal(card, ctx, { handOffTo: child });
  if (refusal === null) return true;
  passedOver.push(`central #${shortIdOf(child.centralId)} passed over (${refusal})`);
  return false;
}

/** What a hand-off does not pass on: the CLI and model asked for are the child central's to pick. */
function droppedReasons(input: RouteInput): string[] {
  const dropped = [...(input.cli === undefined ? [] : ['CLI']), ...(input.model === undefined ? [] : ['model'])];
  if (dropped.length === 0) return [];
  const verb = dropped.length > 1 ? 'are' : 'is';
  return [`the ${dropped.join(' and ')} asked for ${verb} not passed on: the central picks its own sessions`];
}

/**
 * The central a global central hands the task down to, or null (see the header): the project centrals that own the
 * folder, closest first, then the room central of the project's usual room, each asked the hand-off rails. One that
 * refuses is passed over, its reason in `passedOver`.
 */
async function handoff(
  ctx: ToolContext,
  folder: string,
  profile: () => Promise<ProjectProfile>,
  passedOver: string[],
): Promise<RouteDecision | null> {
  const sessions = ctx.sessions();
  const live = ctx.centrals().filter((c) => c.centralId !== ctx.central.centralId && hasLiveCard(sessions, c.centralId));
  const scopeOf = (scopeRef: string | null): string | null => (scopeRef !== null && scopeRef.trim() !== '' ? normalizeFolder(scopeRef) : null);
  const owners = live
    .flatMap((c) => {
      const root = c.kind === 'project' ? scopeOf(c.scopeRef) : null;
      return root !== null && isWithin(folder, root) ? [{ central: c, root }] : [];
    })
    .sort((a, b) => b.root.length - a.root.length);
  const owner = owners.find((o) => mayHandOff(ctx, o.central, sessions, passedOver));
  if (owner !== undefined) return { kind: 'handoff', centralId: owner.central.centralId, reasons: ['a project central owns this folder'] };

  const rooms = live.filter((c) => c.kind === 'room' && c.scopeRef !== null);
  if (rooms.length === 0) return null;
  const { roomId } = await profile();
  const room = roomId === null ? undefined : rooms.find((c) => c.scopeRef === roomId && mayHandOff(ctx, c, sessions, passedOver));
  return room === undefined ? null : { kind: 'handoff', centralId: room.centralId, reasons: ['a room central owns the project’s usual room'] };
}

interface Entry extends SessionScore {
  session: Session;
  /** Why the session cannot be used, from the cheap checks. */
  screen: string | null;
}

const byScore = (a: Entry, b: Entry): number =>
  b.score - a.score ||
  Number(a.screen !== null) - Number(b.screen !== null) ||
  b.session.lastActivityAt - a.session.lastActivityAt ||
  (a.session.sessionId < b.session.sessionId ? -1 : 1);

/** How the candidates are read: the task, the project's folder, the settings, the want, each card as the project spells it. */
interface RankInput {
  task: string;
  folder: string;
  settings: RouterSettings;
  want: EligibleWant;
  readFiles: boolean;
  spelled: (s: Session) => Session;
}

/**
 * Every candidate scored and ranked, judged as the project spells its folder (`spelled`). The edited files of the
 * best few that no other text matched are read; then every candidate is read again by id and scored once more, those
 * with their files (a session that edited `ledger.ts` knows a task about the ledger): a status can change while the
 * reads are awaited, and the policy and the ledger must be handed the session as it is now. One gone by then is left
 * out.
 */
async function rankCandidates(ctx: ToolContext, candidates: readonly Session[], r: RankInput): Promise<Entry[]> {
  const score = (session: Session, files: readonly string[] = []): Entry => {
    const seen = r.spelled(session);
    return {
      session,
      ...scoreSession(seen, r.task, { folder: r.folder }, ctx, r.settings.weights, files),
      screen: screenRefusal(seen, r.want),
    };
  };
  const first = candidates.map((s) => score(s)).sort(byScore);
  if (!r.readFiles || !hasTaskWords(r.task, r.folder)) return first;
  const unmatched = first.filter((e) => e.screen === null).slice(0, FILES_FOR).filter((e) => !hasWordMatch(e));
  if (unmatched.length === 0) return first;
  const files = new Map(
    await Promise.all(unmatched.map(async (e) => [e.session.sessionId, await editedFiles(ctx.client, e.session.sessionId)] as const)),
  );
  const current = new Map(ctx.scopedSessions().map((s) => [s.sessionId, s]));
  return first
    .flatMap((e) => {
      const session = current.get(e.session.sessionId);
      return session === undefined ? [] : [score(session, files.get(session.sessionId))];
    })
    .sort(byScore);
}

/**
 * A card as the project spells its folder: one whose folder is inside the project only by its real path (opened under
 * a link spelling) is seen at the matching place under the project's folder (a copy; the card is never changed). The
 * disk is asked through `realpath`, once per folder; a folder whose real path cannot be told keeps its text.
 */
function spellingFor(folder: string, realpath: (p: string) => string | null): (s: Session) => Session {
  const reals = new Map<string, string | null>();
  const realOf = (p: string): string | null => {
    if (!reals.has(p)) reals.set(p, realpath(p));
    return reals.get(p) ?? null;
  };
  const realFolder = realOf(folder) ?? folder;
  return (s) => {
    const path = normalizeFolder(s.projectPath);
    if (isWithin(path, folder)) return s;
    const real = realOf(path);
    if (real === null || !isWithin(real, realFolder)) return s;
    return { ...s, projectPath: normalizeFolder(join(folder, relative(realFolder, real))) };
  };
}

const asCandidate = (e: Entry, policy: ReadonlyMap<string, string>): Candidate => {
  const skipped = e.screen ?? policy.get(e.session.sessionId);
  return {
    sessionId: e.session.sessionId,
    shortId: shortIdOf(e.session.sessionId),
    score: e.score,
    reasons: e.reasons,
    ...(skipped === undefined ? {} : { skipped }),
  };
};

/** Why a new session starts as it does, in AASC's words. */
function profileReason(profile: ProjectProfile, cli: CliKind): string {
  if (profile.cli === null) return 'nothing earlier to copy: it starts as this central runs';
  if (profile.cli !== cli) return 'earlier sessions used another CLI, so no model or effort was copied';
  return `settings copied from the project’s ${profile.from === 'live' ? 'newest' : 'last'} session`;
}

/**
 * Decides where `input.task` goes. Throws INVALID when the project cannot be told (or a named one is unknown),
 * NOT_IN_SCOPE for a folder a project central may not use, DENIED when a new session could not be opened where the
 * decision puts it. See the header for the pipeline.
 */
export async function route(ctx: ToolContext, input: RouteInput, deps: RouteDeps = {}): Promise<RouteResult> {
  const task = typeof input.task === 'string' ? input.task.trim() : '';
  if (task === '') throw new ToolError('INVALID', 'Say what the task is.', 'Pass the task in words.');
  if (input.model !== undefined && flagModel(input.model) === null) {
    throw new ToolError('INVALID', 'A model name is letters, digits, dots, dashes and underscores.', 'Pass the model id as the CLI takes it.');
  }
  const settings = deps.settings ?? routerSettings();
  const home = normalizeFolder(deps.home ?? homedir());
  const known = await (deps.known ?? (() => knownRootsOf(ctx)))();
  const env: ResolveEnv = {
    central: ctx.central,
    home,
    known,
    exists: deps.exists ?? fsExists,
    realpath: deps.realpath ?? fsRealpath,
  };

  // scope + project
  const projects = await listProjects(ctx, { home });
  const resolution = resolveFor(ctx, task, hintsOf(input.project), projects, env, home);
  const top = resolution.ranked[0];
  if (top === undefined || resolution.confidence === 'none') {
    throw new ToolError(
      'INVALID',
      'AASC could not tell which project that task is about.',
      'Name the project or a session: pass the project folder or name, or the session to delegate to.',
    );
  }
  const folder = top.folder;
  const confidence = resolution.confidence;
  const project = { folder, source: SOURCES[top.by] };

  let profileOnce: Promise<ProjectProfile> | null = null;
  const profile = (): Promise<ProjectProfile> => (profileOnce ??= profileOf(ctx, folder));

  // handoff: down the tree only, and only for a first, unconstrained pass; a child the rails refuse is passed over
  const excluded = excludedIds(ctx, input.exclude);
  const passedOver: string[] = [];
  if (ctx.central.kind === 'global' && input.newOnly !== true && excluded.size === 0) {
    const handed = await handoff(ctx, folder, profile, passedOver);
    if (handed !== null) {
      const decision = { ...handed, reasons: [...handed.reasons, ...passedOver, ...droppedReasons(input)] };
      return { decision, runnersUp: [], confidence, project };
    }
  }

  // eligible + score
  const ownerOf = deps.ownerOf ?? ((s: Session) => serverWorkers.ownerOf(s));
  const spokenFor = (s: Session): boolean => {
    const owner = ownerOf(s);
    return owner !== null && owner !== ctx.central.centralId;
  };
  const want: EligibleWant = { folder, contextCeilingPct: settings.contextCeilingPct, exclude: excluded, spokenFor, ...(input.cli ? { cli: input.cli } : {}) };
  const spelled = spellingFor(folder, env.realpath ?? fsRealpath);
  const candidates = ctx
    .scopedSessions()
    .filter((s) => kindRefusal(s) === null && s.status !== 'ended' && !excluded.has(s.sessionId))
    .filter((s) => isWithin(normalizeFolder(spelled(s).projectPath), folder));
  const ranked = await rankCandidates(ctx, candidates, { task, folder, settings, want, readFiles: input.newOnly !== true, spelled });

  // reuse: the best that may be steered, asking the policy in score order and never below the threshold
  const refused = new Map<string, string>();
  let winner: Entry | null = null;
  if (input.newOnly !== true) {
    for (const entry of ranked) {
      if (entry.screen !== null) continue;
      if (entry.score < settings.reuseThreshold) break;
      const refusal = steerRefusal(entry.session, ctx);
      if (refusal === null) {
        winner = entry;
        break;
      }
      refused.set(entry.session.sessionId, refusal);
    }
  }
  const runnersUp = ranked.filter((e) => e !== winner).map((e) => asCandidate(e, refused)).slice(0, settings.runnersUp);
  if (winner !== null) {
    const reasons = [...winner.reasons, ...passedOver];
    const reuse: RouteDecision = { kind: 'reuse', sessionId: winner.session.sessionId, score: winner.score, reasons };
    return { decision: reuse, runnersUp, confidence, project };
  }

  // create
  const best = ranked.find((e) => e.screen === null && !refused.has(e.session.sessionId));
  const why =
    input.newOnly === true
      ? 'a new session was asked for'
      : ranked.length === 0
        ? 'no session in the project'
        : best === undefined
          ? 'every session in the project is busy or unavailable'
          : `the best session in the project scored ${best.score} (a reuse needs ${settings.reuseThreshold})`;
  const created = createDecision(ctx, input, { folder, task, why, profile: await profile(), home, known, env });
  return { decision: { ...created, reasons: [...created.reasons, ...passedOver] }, runnersUp, confidence, project };
}

/**
 * Which project the task is about. An explicit project is honoured or refused, never ignored: one AASC cannot find is
 * INVALID; a project central routes to the folder or project it names inside its own (a sub-folder too), refuses a
 * folder outside it (NOT_IN_SCOPE), and knows no name outside it (INVALID).
 */
function resolveFor(
  ctx: ToolContext,
  task: string,
  hints: ProjectHints,
  projects: readonly KnownProject[],
  env: ResolveEnv,
  home: string,
): ProjectResolution {
  const named = hints.folder !== undefined || hints.name !== undefined;
  if (ctx.central.kind !== 'project' || !named) {
    const resolution = resolveProject(task, hints, projects, env);
    if (named && resolution.ranked[0]?.by !== 'hint') throw unknownProject();
    return resolution;
  }
  if (hints.folder !== undefined) {
    const written = expandHomePath(hints.folder, home);
    if (written === null || !inCentralScope(ctx, written)) throw notInScope('folder');
  }
  // Resolved as a global central would (a project central's own resolution is always its root), then held to its own.
  const asGlobal = resolveProject('', hints, projects, { ...env, central: { kind: 'global', scopeRef: null } });
  const mine = asGlobal.ranked.filter((p) => p.by === 'hint' && inCentralScope(ctx, p.folder));
  if (mine.length === 0) throw unknownProject();
  return { ranked: mine, confidence: mine.length === 1 ? 'high' : 'medium' };
}

interface CreateInput {
  folder: string;
  task: string;
  why: string;
  profile: ProjectProfile;
  home: string;
  known: readonly string[];
  env: ResolveEnv;
}

/** A new session in the project: the folder checked as openWorker will, and the settings its latest session used. */
function createDecision(ctx: ToolContext, input: RouteInput, c: CreateInput): RouteDecision {
  const { folder, profile } = c;
  if (!inCentralScope(ctx, folder)) {
    throw new ToolError('DENIED', 'A project central opens sessions in its own project only.', 'Delegate to a session in your project.');
  }
  const written = launchRefusal(folder, c.known, c.home);
  if (written !== null) throw new ToolError('DENIED', written, 'Pick a project folder inside the home folder.');
  const real = (c.env.realpath ?? fsRealpath)(folder);
  if (real === null) {
    throw new ToolError('INVALID', 'That project’s folder is no longer there.', 'Pick another project, or delegate to a session by id.');
  }
  const resolved = launchRefusal(real, c.known, c.home);
  if (resolved !== null) throw new ToolError('DENIED', resolved, 'Pick a project folder inside the home folder.');

  const cli: CliKind = input.cli ?? profile.cli ?? ctx.central.cli;
  const sameCli = profile.cli === cli;
  const model = input.model ?? (sameCli ? flagModel(profile.model) : null);
  const effort = sameCli ? flagEffort(profile.effort) : null;
  const roomId = ctx.central.kind === 'room' ? ctx.central.scopeRef : profile.roomId;
  return {
    kind: 'create',
    folder,
    cli,
    ...(model === null ? {} : { model }),
    ...(effort === null ? {} : { effort }),
    ...(roomId === null || roomId === undefined ? {} : { roomId }),
    title: shortTitle(c.task),
    reasons: [c.why, profileReason(profile, cli)],
  };
}
