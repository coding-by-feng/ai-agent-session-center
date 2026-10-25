// centralLaunch.ts — making a launch a central's: the checks it must pass before anything is minted or
// spawned, the mint (or re-mint) that gives it a fresh token, and what a route answers when it cannot be one.
//
// A central is a property of its session card (`Session.central`), asked for when the card is created
// (POST /api/terminals `central`) and carried by every launch that spawns a new PTY for that card: restart,
// resume, reconnect, workspace restore, pinned respawn. Each of those mints the central again under the id
// it already has, so the new PTY gets a new token and the old one stops working. A relaunch into the shell
// that is still open (resume of a live terminal) mints nothing: that shell already holds a valid token.
// Forks and clones are never centrals.
//
// The checks run up front, before the mint. A NEW central that could not be wired is refused with a reason
// instead of starting as an ordinary agent that only looks like a central, and only this Mac may ask for one.
// A relaunch of a central that exists (it names its `centralId`) is never refused over its central (Ruling
// 16): when the central cannot be established again, the session is launched as a plain one and its card's
// marker is cleared, because losing the card is worse than losing its central status. Where the caller is
// does not count for a relaunch (Ruling 18): a paired phone's Restart keeps a central a central. The checks
// mirror what `createTerminal` needs to wire one (launch.ts): this Mac, no tmux, a bare `claude` or `codex`.

import { homedir } from 'node:os';
import { parse, sep } from 'node:path';
import { z } from 'zod';
import type { Session } from '../../src/types/session.js';
import { simpleCommands } from '../config.js';
import log from '../logger.js';
import { CentralScopeTakenError, centrals, resolveCentralSession } from './centrals.js';
import { normalizeFolder } from './paths.js';
import { isMcpEnabled } from './runtime.js';
import {
  ToolError,
  type CentralKind,
  type CentralRecord,
  type CliKind,
  type SessionCentralMarker,
} from './types.js';

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/**
 * POST /api/terminals' `central`. A new central sends its kind (and a room id, or a project folder that
 * defaults to the launch's own); a relaunch (restore, respawn) sends the marker its card carries, `centralId`
 * included, and `scopeRef: null` for a global one. The id is always one `randomUUID` made, and it ends up in
 * logs and request headers, so nothing else is accepted.
 */
export const centralRequestSchema = z.object({
  kind: z.enum(['global', 'room', 'project']),
  scopeRef: z.string().max(1024).nullish(),
  centralId: z.uuid().optional(),
});

export interface CentralLaunchInput {
  kind: CentralKind;
  scopeRef?: string | null;
  /**
   * The id of the central being relaunched; absent for a new one. Only an id this Mac vouches for: a card's
   * own marker, or one a caller on this Mac sends (a restore of its own snapshot). An id a remote device sends
   * is checked against the cards it can see first, and their marker is passed instead: an id taken on trust
   * would let it create a central (Ruling 18).
   */
  centralId?: string;
}

export interface CentralLaunchContext {
  /** The line that launches the agent: its first word must be a bare `claude` or `codex`. */
  command: string;
  permissionMode: string | null;
  /** Where the agent starts: a project central's folder unless it names another. */
  workingDir: string;
  /** Did the request come from this Mac (`isLocalRequest`)? */
  isLocal: boolean;
  roomExists: (roomId: string) => boolean;
  /** The agent would run on another machine. */
  remoteHost?: boolean;
  /** The agent would run in tmux (a new session or an attach). */
  tmux?: boolean;
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * A central launch refused before anything was minted or spawned. It is a `ToolError('INVALID')` like every
 * refusal in this folder, and carries the HTTP status a route answers with: 403 for a caller that is not this
 * Mac, 400 for the rest.
 */
export class CentralLaunchError extends ToolError {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string, hint?: string) {
    super('INVALID', message, hint);
    this.name = 'CentralLaunchError';
    this.status = status;
  }
}

/** Why a caller that is not this Mac is refused, here and in the route that checks it first. */
export const CENTRAL_LOCAL_ONLY = 'A central session can only be started from this Mac';

/** A command's first word, short enough for a message. */
function firstWordOf(command: string): string {
  const word = command.trim().split(/\s+/)[0] ?? '';
  return word.length > 60 ? `${word.slice(0, 57)}...` : word;
}

// ---------------------------------------------------------------------------
// The checks and the mint
// ---------------------------------------------------------------------------

/**
 * The CLI a launch line starts: its first word when that is a bare `claude` or `codex`, else null. The same
 * rule as the status-line tap and `--no-daemon`: a path, a quoted word, `npx claude` or `FOO=1 claude` is not
 * one, because `applyCentralLaunch` puts its flags only on a bare command word.
 */
export function centralCliOf(line: string): CliKind | null {
  const [first] = simpleCommands(line)[0] ?? [];
  if (first === undefined) return null;
  const word = line.slice(first.start, first.end);
  return word === 'claude' || word === 'codex' ? word : null;
}

/** The scope the central gets: null for a global one, a room that exists, or a normalized project folder. */
function scopeRefOf(input: CentralLaunchInput, ctx: CentralLaunchContext): string | null {
  const given =
    typeof input.scopeRef === 'string' && input.scopeRef.trim() !== '' ? input.scopeRef : null;
  if (input.kind === 'global') return null;
  if (input.kind === 'room') {
    if (given === null) {
      throw new CentralLaunchError(400, 'A room central needs the id of its room');
    }
    if (!ctx.roomExists(given)) throw new CentralLaunchError(400, `Room "${given}" does not exist`);
    return given;
  }
  const named = given ?? ctx.workingDir;
  if (named.trim() === '') {
    throw new CentralLaunchError(400, 'A project central needs a project folder');
  }
  const folder = normalizeFolder(named);
  const home = normalizeFolder(homedir());
  // A scope takes in every session under its folder (scope.ts): the root, the home folder, or any folder that
  // holds the home folder (`/Users`) would take in all of them. The phone's launch rule refuses the home
  // folder for the same reason (phoneLaunchDecision).
  if (isWithin(home, folder)) {
    const which =
      parse(folder).root === folder
        ? 'the root folder'
        : folder === home
          ? 'your home folder'
          : `${folder}, which holds your home folder`;
    throw new CentralLaunchError(
      400,
      `A project central needs a project folder, not ${which}: its scope would take in every session`,
    );
  }
  return folder;
}

/**
 * Is `folder` the same folder as `root`, or inside it? Both normalized. The rule scope.ts matches sessions by:
 * the match is anchored at a separator, so `/a/proj` is not above `/a/project2`.
 */
function isWithin(folder: string, root: string): boolean {
  if (folder === root) return true;
  // The root of a drive already ends in a separator; every other folder gets one before the match.
  return folder.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Make this launch a central's, or refuse it before anything is minted or spawned:
 *   403  a NEW central (no `centralId`) for a caller that is not this Mac. A relaunch of one that exists is
 *        not refused for where the caller is (Ruling 18): the token is minted here and goes only into the
 *        new PTY's environment, never back to the caller, so re-establishing a central it already drives
 *        grants nothing;
 *   400  a remote host or tmux (the token belongs on this Mac, in one PTY); a command whose first word is not
 *        a bare `claude` / `codex`; a room central with no room, or one that does not exist; a new central
 *        while central sessions are switched off (`mcp.enabled: false`).
 * Then it mints the central, or mints it again under `centralId` (a relaunch: the same central with a new
 * token, attached to no terminal until the new one is), with the CLI taken from the command word. A project
 * central's scope defaults to the launch folder. `CentralScopeTakenError` comes through when another central
 * holds the scope. With central sessions switched off, a relaunch keeps its marker and mints nothing: the
 * card stays a central, and its next launch with them on is wired again.
 *
 * Call it as late as the launch allows, right before the PTY is spawned: a re-mint ends the token the
 * central's current terminal holds. Spawn with `spawnCentralTerminal`.
 */
export function prepareCentralLaunch(
  input: CentralLaunchInput,
  ctx: CentralLaunchContext,
): SessionCentralMarker {
  if (!ctx.isLocal && input.centralId === undefined) {
    throw new CentralLaunchError(403, CENTRAL_LOCAL_ONLY);
  }
  if (ctx.remoteHost) {
    throw new CentralLaunchError(
      400,
      'A central session runs on this Mac only, and this launch is for a remote host',
    );
  }
  if (ctx.tmux) {
    throw new CentralLaunchError(
      400,
      'A central session cannot run in tmux: a tmux server keeps its environment, and the token in it, for every later session',
    );
  }
  const cli = centralCliOf(ctx.command);
  if (cli === null) {
    const word = firstWordOf(ctx.command);
    throw new CentralLaunchError(
      400,
      `A central session must launch a bare claude or codex command, not ${word === '' ? 'an empty one' : `"${word}"`}`,
    );
  }
  const scopeRef = scopeRefOf(input, ctx);
  if (!isMcpEnabled()) {
    if (input.centralId === undefined) {
      throw new CentralLaunchError(
        400,
        'Central sessions are switched off on this Mac (mcp.enabled is false in server-config.json)',
      );
    }
    return { centralId: input.centralId, kind: input.kind, scopeRef };
  }
  const record = centrals.mint({
    centralId: input.centralId,
    kind: input.kind,
    scopeRef,
    cli,
    permissionMode: ctx.permissionMode,
  });
  return { centralId: record.centralId, kind: record.kind, scopeRef: record.scopeRef };
}

/** Who asked for a relaunch, as far as a central is concerned. */
export interface CentralCaller {
  /**
   * Whether the caller is this Mac. A relaunch does not depend on it (Ruling 18: a card that already is a
   * central is relaunched as one, whoever asks); it is passed so the launch context says who asked.
   */
  isLocal: boolean;
  roomExists: (roomId: string) => boolean;
  /** Whether a terminal is open now: a central attached to another one that is is not minted again. */
  isTerminalLive: (terminalId: string) => boolean;
}

/** Where a relaunch stands toward the terminal its central is attached to now. */
export interface CentralRelaunchTerminals {
  /** The terminal the card being relaunched has now (a restart's old one), or null for a new card. */
  own: string | null;
  /** Whether a terminal is open now. */
  isLive: (terminalId: string) => boolean;
}

/** The launch a relaunch is about to spawn. */
export interface CentralRelaunch {
  command: string;
  workingDir: string;
  remoteHost: boolean;
  tmux?: boolean;
}

/** What a relaunch of a card launches with. */
export interface CentralRelaunchPlan {
  /** The marker to launch with (`config.central`), or undefined: a plain session. */
  central: SessionCentralMarker | undefined;
  /**
   * Set when a central's card is relaunched as a plain session: why its central could not be established
   * again. The caller clears the card's marker (`clearSessionCentral`) once the new terminal is its own.
   */
  dropped?: string;
}

/**
 * A launch that relaunches a central that exists (it names its `centralId`): a restart, a resume or reconnect
 * into a new PTY, a workspace restore, a pinned respawn. The central is minted again as `prepareCentralLaunch`
 * mints it, whoever asks (Ruling 18: where the caller is matters only for a NEW central); when that fails, for
 * whatever reason (its room is gone, another central now holds its scope, it is live in a terminal that is not
 * this card's, the launch cannot carry it: a remote host, tmux, a command that is not a bare claude or codex),
 * the launch goes ahead as a plain session instead of failing, and the reason is logged under `sessionId`
 * (never a token). Losing the card is worse than losing its central status (Ruling 16). With central sessions
 * switched off nothing fails: the marker is kept and nothing is minted, so the card is wired again once they
 * are back on.
 */
export function relaunchCentralOrPlain(
  input: CentralLaunchInput & { centralId: string },
  ctx: CentralLaunchContext,
  sessionId: string,
  terminals: CentralRelaunchTerminals,
): CentralRelaunchPlan {
  try {
    // Two cards, one central: minting it again would end the token a live agent holds in another terminal.
    const holder = centrals.byId(input.centralId)?.terminalId ?? null;
    if (holder !== null && holder !== terminals.own && terminals.isLive(holder)) {
      throw new CentralLaunchError(400, `It is live in another session's terminal (${holder})`);
    }
    return { central: prepareCentralLaunch(input, ctx) };
  } catch (err: unknown) {
    const dropped = err instanceof Error ? err.message : String(err);
    logCentralDropped(sessionId, input.centralId, dropped);
    return { central: undefined, dropped };
  }
}

/** The one log line for a session launched plain instead of as its central (never a token). */
export function logCentralDropped(sessionId: string, centralId: string, reason: string): void {
  log.warn(
    'mcp',
    `Session ${sessionId} relaunched as a plain session: its central ${centralId} could not be established again (${reason})`,
  );
}

/**
 * For a relaunch that spawns a new PTY for this card: its central minted again under its own id, kind and
 * scope, or a plain session when it cannot be (`relaunchCentralOrPlain`); `{ central: undefined }` for a card
 * that is no central.
 */
export function prepareCentralRelaunch(
  session: Pick<Session, 'sessionId' | 'central' | 'permissionMode'> & {
    terminalId?: string | null;
  },
  launch: CentralRelaunch,
  caller: CentralCaller,
): CentralRelaunchPlan {
  const marker = session.central;
  if (!marker) return { central: undefined };
  return relaunchCentralOrPlain(
    { kind: marker.kind, scopeRef: marker.scopeRef, centralId: marker.centralId },
    {
      command: launch.command,
      permissionMode: session.permissionMode ?? null,
      workingDir: launch.workingDir,
      isLocal: caller.isLocal,
      roomExists: caller.roomExists,
      remoteHost: launch.remoteHost,
      tmux: launch.tmux ?? false,
    },
    session.sessionId,
    // A restart replaces the card's own terminal, so its central may be attached there.
    { own: session.terminalId ?? null, isLive: caller.isTerminalLive },
  );
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/**
 * Spawn the terminal of a launch `prepareCentralLaunch` made a central's (`spawn` is the `createTerminal`
 * call). The central is revoked when the spawn fails, and when the terminal came up without it attached
 * (`createTerminal` launched it unwired): either way no PTY holds its token, and a record nobody can use must
 * not keep its scope. The card keeps its marker, so its next relaunch mints the central again.
 */
export async function spawnCentralTerminal(
  marker: SessionCentralMarker | undefined,
  spawn: () => Promise<string>,
): Promise<string> {
  if (marker === undefined) return spawn();
  let terminalId: string;
  try {
    terminalId = await spawn();
  } catch (err) {
    centrals.revoke(marker.centralId);
    log.warn('mcp', `Central ${marker.centralId} revoked: its terminal failed to start`);
    throw err;
  }
  const record = centrals.byId(marker.centralId);
  if (record !== null && record.terminalId !== terminalId) {
    centrals.revoke(marker.centralId);
    log.warn(
      'mcp',
      `Central ${marker.centralId} revoked: terminal ${terminalId} started without its MCP wiring`,
    );
  }
  return terminalId;
}

/**
 * A central's terminal that ended up with no card: something failed after the spawn (the ops shell, the card,
 * the re-bind). Its PTY holds a token nobody can see or stop, so it is closed and the central revoked; a card
 * it was meant for keeps its marker, and its next relaunch mints the central again. `close` is the terminal
 * manager's `closeTerminal`.
 */
export function discardCentralTerminal(
  marker: SessionCentralMarker | undefined,
  terminalId: string,
  close: (terminalId: string) => void,
): void {
  if (marker === undefined) return;
  close(terminalId);
  centrals.revoke(marker.centralId);
  log.warn(
    'mcp',
    `Central ${marker.centralId} revoked: its terminal ${terminalId} was left without a card`,
  );
}

/**
 * A stored command typed as a central's launch: a path to `claude` or `codex` in front becomes the bare word,
 * so `applyCentralLaunch` can put the flags on it (ps records Codex as its native binary's full path). The
 * same normalization the resume line gets (`buildResumeCommand`); everything else is left as it is.
 */
export function bareCliCommand(line: string): string {
  return line.replace(/^(\s*)\S*\/(claude|codex)(?=\s|$)/, '$1$2');
}

// ---------------------------------------------------------------------------
// The answer a route gives
// ---------------------------------------------------------------------------

export interface CentralRefusal {
  status: 400 | 403 | 409;
  body: { ok: false; error: string; existing?: Omit<CentralRecord, 'token'> };
}

/**
 * How a route answers a NEW central it refused (a relaunch is never refused: `relaunchCentralOrPlain`), or
 * null for an error that is no refusal (answer that as the failure it is). 409 when another central holds
 * the scope, naming the card it runs in (the id `resolveCentralSession` finds, else its terminal) and
 * carrying that central without its token; a `CentralLaunchError`'s own status; 400 for a registry
 * `INVALID` (a scope or id the mint refused).
 */
export function centralLaunchRefusal(
  err: unknown,
  sessions: readonly Session[],
): CentralRefusal | null {
  if (err instanceof CentralScopeTakenError) {
    const { token: _token, ...existing } = err.existing;
    void _token;
    const where =
      resolveCentralSession(existing.centralId, sessions)?.sessionId ??
      existing.terminalId ??
      existing.centralId;
    return {
      status: 409,
      body: {
        ok: false,
        error: `A ${existing.kind} central is already running (#${where})`,
        existing,
      },
    };
  }
  if (err instanceof CentralLaunchError)
    return { status: err.status, body: { ok: false, error: err.message } };
  if (err instanceof ToolError && err.code === 'INVALID')
    return { status: 400, body: { ok: false, error: err.message } };
  return null;
}
