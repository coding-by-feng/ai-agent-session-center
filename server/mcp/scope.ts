// scope.ts — which sessions a central may see, and the compact card a read tool returns for one.
//
// What a central can reach is decided here and nowhere else. A tool asks its context (`ctx.inScope`,
// `ctx.scopedSessions`, both built from `scopePredicate` with the central's own workers); `isInScope` and
// `sessionsInScope` are for code that judges sessions outside a call (a saved workspace).
//
//   global   every session
//   room     the sessions its room lists (`Room.sessionIds`), plus the workers the central itself opened, which the
//            workspace writer may not have filed into the room yet (workers.ts, by terminal)
//   project  sessions on this machine whose `projectPath` is the project's folder or anywhere below it
//
// Pure: nothing here reads a store, the disk or the clock, and nothing it is given is changed (a card's `started`
// reads the in-memory set of heard terminals, heardTerminals.ts, and changes nothing). A scope
// that lacks what it needs (a room central with no room id, a project central with no folder, a kind
// this build does not know) sees nothing: an unclear scope never widens to "everything".

import { sep } from 'node:path';
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { startPending } from '../heardTerminals.js';
import { planCliOf } from '../planUsageCodec.js';
import { normalizeFolder } from './paths.js';
import type { CliKind, SessionCentralMarker } from './types.js';

// ---------------------------------------------------------------------------
// Which sessions are on this machine
// ---------------------------------------------------------------------------

/**
 * Hosts that mean "this machine": the rule the session strip uses to call a project local (`LOCAL_HOSTS` in
 * src/lib/projectGroups.ts; server/chat/transcriptLocator.ts has the same set). Neither is exported, and the
 * strip's file cannot be imported here (it reaches the client's types through the `@/` alias, which
 * tsconfig.server.json has no path for), so this is a copy. test/mcp/scope.test.ts runs a table of hosts
 * through this rule and the strip's, so the two cannot drift.
 */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['', 'localhost', '127.0.0.1', '::1']);

/** No host is this machine; a value that is not text is unknown, and unknown is not local. */
function isLocalHost(host: unknown): boolean {
  if (host === undefined || host === null) return true;
  return typeof host === 'string' && LOCAL_HOSTS.has(host.trim().toLowerCase());
}

/**
 * Does the session run on this machine? A card the dashboard made carries `sshHost` and `sshConfig`; one
 * made from a hook can carry `sshConfig` alone. It is local only if every host it carries is, so two fields
 * that disagree count as another machine. (policy.ts refuses to steer a session that is not.)
 */
export function isLocalSession(s: Pick<Session, 'sshHost' | 'sshConfig'>): boolean {
  return isLocalHost(s.sshHost) && isLocalHost(s.sshConfig?.host);
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/** Is this session in a central's scope? Built once per central, so a list is filtered in one pass. */
type InScope = (s: Session) => boolean;

const EVERYTHING: InScope = () => true;
const NOTHING: InScope = () => false;

/** Not text, or nothing but whitespace: no id, no path. (The registry refuses such a `scopeRef` too.) */
const isBlank = (v: unknown): boolean => typeof v !== 'string' || v.trim() === '';

/** Does the session have a folder? A blank path is no folder, and must not be read as the server's own. */
const hasFolder = (s: Session): boolean => !isBlank(s.projectPath);

/**
 * Is `folder` the same folder as `root`, or inside it? Both normalized: `/a/proj` is not above `/a/project2`.
 * Case-sensitive, like the rest of the folder rule. Exported for the tools that take a folder.
 */
export function isWithin(folder: string, root: string): boolean {
  if (folder === root) return true;
  // The root of a drive already ends in a separator; every other folder gets one before the match.
  return folder.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Is this session one of the central's own workers (workers.ts)? The caller binds it to the central. */
export type OwnWorkerTest = (s: Session) => boolean;

function roomScope(roomId: string | null, rooms: readonly Room[], ownWorker: OwnWorkerTest | undefined): InScope {
  if (isBlank(roomId)) return NOTHING;
  const members = new Set(rooms.find((r) => r.id === roomId)?.sessionIds ?? []);
  return (s) => members.has(s.sessionId) || (ownWorker?.(s) ?? false);
}

function projectScope(folder: string | null): InScope {
  if (typeof folder !== 'string' || folder.trim() === '') return NOTHING;
  // Normalizing again changes nothing for a folder the registry already normalized; it keeps this
  // function right for a marker that came from anywhere else (a restored snapshot).
  const root = normalizeFolder(folder);
  return (s) => isLocalSession(s) && hasFolder(s) && isWithin(normalizeFolder(s.projectPath), root);
}

/**
 * The central's scope as one predicate, built once from the rooms as they are now and its own workers: what every
 * call's `ToolContext.inScope` and `scopedSessions` are made of (callContext.ts), so the two cannot disagree.
 */
export function scopePredicate(
  central: SessionCentralMarker,
  rooms: readonly Room[],
  ownWorker?: OwnWorkerTest,
): (s: Session) => boolean {
  return scopeOf(central, rooms, ownWorker);
}

function scopeOf(central: SessionCentralMarker, rooms: readonly Room[], ownWorker: OwnWorkerTest | undefined): InScope {
  switch (central.kind) {
    case 'global':
      return EVERYTHING;
    case 'room':
      return roomScope(central.scopeRef, rooms, ownWorker);
    case 'project':
      return projectScope(central.scopeRef);
    default:
      return NOTHING;
  }
}

/**
 * May this central see this session? `central` is the marker a session carries; a full `CentralRecord`
 * satisfies it. `ownWorker` says which sessions are workers the central opened itself: they widen a room scope
 * (the writer may not have filed one into the room yet) and nothing else (a project central opens its workers
 * in its folder, so its folder rule already covers them).
 */
export function isInScope(
  central: SessionCentralMarker,
  s: Session,
  rooms: readonly Room[],
  ownWorker?: OwnWorkerTest,
): boolean {
  return scopeOf(central, rooms, ownWorker)(s);
}

/** The sessions in the central's scope, in the order given, as a new array. */
export function sessionsInScope(
  central: SessionCentralMarker,
  sessions: readonly Session[],
  rooms: readonly Room[],
  ownWorker?: OwnWorkerTest,
): Session[] {
  const inScope = scopeOf(central, rooms, ownWorker);
  return sessions.filter((s) => inScope(s));
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * A session as a read tool lists it: what a central needs to pick one, nothing it must not have
 * (no prompts, output, tool log, token or command line). Plain values only, so a card shares nothing
 * with the session it came from.
 */
export interface SessionCard {
  /** The AASC session id. */
  id: string;
  /**
   * The first 8 characters of the id (the whole id when it is shorter): what the Queue view shows. Every
   * tool that takes a session accepts it, as long as it is the start of one id only.
   */
  shortId: string;
  /** What the strip calls it: the title, else the project name, else "Unnamed". */
  title: string;
  /** The session's status as AASC keeps it (`idle`, `working`, `approval`, ...). */
  status: string;
  /**
   * Its CLI has reported that it started: AASC has heard a hook from its terminal and the card has no never-started
   * marker (Ruling P4-58). False for a new worker that has not reported in yet (it may be at a trust question) and for
   * one unheard since AASC restarted: a central's prompt to it is refused (`not_started`) and the router passes it over.
   */
  started: boolean;
  /** Which CLI runs it; null when AASC does not know. */
  cli: CliKind | null;
  /**
   * The folder it works in, spelled the way a project central's `scopeRef` is (normalized). A session
   * on another machine keeps its path as written. Null when it has no folder.
   */
  project: string | null;
  /** The room that lists it; null when no room does. */
  roomId: string | null;
  /** The model it runs now, else the one it launched with. */
  model: string | null;
  /** The effort it runs at now, else the one it launched with. */
  effort: string | null;
  /** How full the context window is, 0-100; null until the CLI reports it (never a false 0). */
  contextPct: number | null;
  /** It waits on a person: a structured request (permission, question, plan) is open. */
  needsYou: boolean;
  /** How many prompts are queued for it. */
  queueCount: number;
  /** It is itself a central. */
  isCentral: boolean;
  /**
   * The person marked it hands-off: a central may read it, and every write to it is refused (HANDS_OFF). Present, and
   * true, only then: absent means steerable, as it does on the session itself.
   */
  handsOff?: true;
  /** Epoch ms of its last activity. */
  lastActivityAt: number;
}

/**
 * `claude` or `codex` from `cliSource`, any case. Another CLI named there (`gemini`) is null. With no
 * `cliSource` (absent, blank or not text) the card falls back to `planCliOf`, the rule that decides whose plan
 * limits a session carries: the launch command, then the model, then the hook events. A card made only from a
 * hook has no `cliSource`, and would otherwise report no CLI at all.
 */
function cliOf(s: Session): CliKind | null {
  const source = typeof s.cliSource === 'string' ? s.cliSource.trim().toLowerCase() : '';
  if (source === 'claude' || source === 'codex') return source;
  return source === '' ? planCliOf(s) : null;
}

/**
 * The id's first 8 characters: what the Queue view calls a session. A hook may name a session with any text up
 * to 256 characters (hookProcessor.ts checks only its length), and a short id is quoted in the plain words
 * around a tool's answer, outside any untrusted block: so anything an id is not made of (letters, digits and
 * `_ - . :`) shows as `_`. A real id (a UUID, `term-…`, `external-…`) is unchanged.
 */
const SHORT_ID_LENGTH = 8;
export const shortIdOf = (sessionId: string): string =>
  sessionId.slice(0, SHORT_ID_LENGTH).replace(/[^A-Za-z0-9_.:-]/g, '_');

/**
 * The folder, in the one spelling a project central files it under (`normalizeFolder`). A session on
 * another machine keeps its path as written: this machine's rules cannot tidy a path that is not here.
 */
function projectOf(s: Session): string | null {
  if (!hasFolder(s)) return null;
  return isLocalSession(s) ? normalizeFolder(s.projectPath) : s.projectPath;
}

/** The context window's used share as a whole number. Absent, null or not a number is null. */
function contextPctOf(s: Session): number | null {
  const pct = s.runtime?.context?.pct;
  return typeof pct === 'number' && Number.isFinite(pct) ? Math.round(pct) : null;
}

/** The first room that lists the session. */
function roomIdOf(s: Session, rooms: readonly Room[]): string | null {
  return rooms.find((r) => r.sessionIds.includes(s.sessionId))?.id ?? null;
}

/**
 * The compact card for a session. The text fields (`title`, `project`, `model`, `effort`) are whatever the
 * session holds, unfenced: a caller that hands a card to a model decides how to mark session-written text.
 */
export function toSessionCard(s: Session, rooms: readonly Room[]): SessionCard {
  return {
    id: s.sessionId,
    shortId: shortIdOf(s.sessionId),
    title: sessionDisplayTitle(s),
    status: s.status,
    started: !startPending(s),
    cli: cliOf(s),
    project: projectOf(s),
    roomId: roomIdOf(s, rooms),
    model: s.runtime?.model || s.model || null,
    effort: s.runtime?.effort || s.effortLevel || null,
    contextPct: contextPctOf(s),
    needsYou: !!s.pendingRequest,
    queueCount: s.queueCount ?? 0,
    isCentral: !!s.central,
    ...(s.handsOff === true ? { handsOff: true as const } : {}),
    lastActivityAt: s.lastActivityAt,
  };
}
