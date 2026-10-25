// centrals.ts — the registry of live centrals: token <-> record, and one central per scope.
//
// A central is a session AASC launched with an MCP token (types.ts). The registry holds one record
// for each, in memory only: a token is never written to disk or to a workspace snapshot, and every
// one dies with the process. A relaunch (restart, resume, restore) mints the same central again
// under its old id, with a new token.
//
// Records go in and out as copies. Nothing a caller does to one it was given can change what the
// registry holds, which matters most for `toolsets` (it decides what the central may call).

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Session } from '../../src/types/session.js';
import { SESSION_STATUS } from '../constants.js';
import log from '../logger.js';
import { normalizeFolder } from './paths.js';
import {
  ALL_TOOLSETS,
  CORE_TOOLSETS,
  ToolError,
  type CentralKind,
  type CentralRecord,
  type CliKind,
  type SessionCentralMarker,
  type Toolset,
} from './types.js';

/** What every token starts with: `aasc_mcp_` plus 43 base64url characters, 52 in all. */
const TOKEN_PREFIX = 'aasc_mcp_';
const TOKEN_BYTES = 32;

// ---------------------------------------------------------------------------
// Toolsets
// ---------------------------------------------------------------------------

/**
 * The toolsets a central gets when its launch names none. A Claude central gets every toolset. A
 * Codex central starts from the core, because a long tool list costs it context; a room central
 * adds `rooms`, a project central `resources` and `history`.
 */
export function defaultToolsets(kind: CentralKind, cli: CliKind): Toolset[] {
  if (cli === 'claude') return [...ALL_TOOLSETS];
  if (kind === 'room') return [...CORE_TOOLSETS, 'rooms'];
  if (kind === 'project') return [...CORE_TOOLSETS, 'resources', 'history'];
  return [...CORE_TOOLSETS];
}

// ---------------------------------------------------------------------------
// Scopes
// ---------------------------------------------------------------------------

interface Scope {
  /** What two centrals must not share: `global`, `room:<id>` or `project:<normalized folder>`. */
  key: string;
  /** What the record stores as its `scopeRef`: null, the room id, or the normalized folder. */
  scopeRef: string | null;
}

/** The scope a central of this kind would hold, or null when it needs a `scopeRef` it was not given. */
function scopeOf(kind: CentralKind, scopeRef: string | null): Scope | null {
  if (kind === 'global') return { key: 'global', scopeRef: null };
  if (typeof scopeRef !== 'string' || scopeRef.trim() === '') return null;
  if (kind === 'room') return { key: `room:${scopeRef}`, scopeRef };
  if (kind === 'project') {
    const folder = normalizeFolder(scopeRef);
    return { key: `project:${folder}`, scopeRef: folder };
  }
  return null;
}

function missingScope(kind: CentralKind): ToolError {
  const what = kind === 'room' ? 'a room id' : 'a project folder';
  return new ToolError('INVALID', `A ${kind} central needs ${what} as its scopeRef`);
}

// ---------------------------------------------------------------------------
// Records and errors
// ---------------------------------------------------------------------------

function copyOf(record: CentralRecord): CentralRecord {
  return { ...record, toolsets: [...record.toolsets] };
}

/**
 * Thrown by `mint` when another central already holds the scope. `existing` is that central's
 * record with its token blanked: this error ends up in logs, HTTP answers and tool results, and a
 * bearer token must not travel with it.
 */
export class CentralScopeTakenError extends Error {
  readonly existing: CentralRecord;

  constructor(existing: CentralRecord) {
    super(
      existing.kind === 'global'
        ? 'A global central is already running'
        : `A ${existing.kind} central is already running for ${existing.scopeRef}`,
    );
    this.name = 'CentralScopeTakenError';
    this.existing = { ...copyOf(existing), token: '' };
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface MintInput {
  /** Pass the id of a central that is being relaunched (restart, resume, restore) to mint it again. */
  centralId?: string;
  kind: CentralKind;
  /** The room id for a room central, the project folder for a project central; ignored for a global one. */
  scopeRef: string | null;
  cli: CliKind;
  permissionMode: string | null;
  /** Defaults to `defaultToolsets(kind, cli)`. */
  toolsets?: Toolset[];
}

export interface CentralRegistry {
  /**
   * Add a central and give it a token. With the `centralId` of a central the registry already holds,
   * that record is minted again: same id, new token, nothing attached to a terminal yet, the
   * `createdAt` it already had, and its launch details taken from `i`. With an id it does not hold
   * (a restore after AASC restarted), the record is created under that id.
   * Throws `CentralScopeTakenError` when another central holds the scope, and `ToolError('INVALID')`
   * for a room or project central with no scope. A failed mint changes nothing.
   */
  mint(i: MintInput): CentralRecord;
  /** Record the terminal the central runs in. Throws `ToolError` for an unknown central, a blank terminal id, or a terminal another central holds. */
  attachTerminal(centralId: string, terminalId: string): void;
  /** The central that holds exactly this token. The compare is constant-time; a wrong length is no match. */
  byToken(token: string): CentralRecord | null;
  byId(id: string): CentralRecord | null;
  byTerminal(terminalId: string): CentralRecord | null;
  /** The holder of a scope; a project folder is normalized first. */
  findByScope(kind: CentralKind, scopeRef: string | null): CentralRecord | null;
  /** A new token for the same central: the old one stops working at once. Throws `ToolError('NOT_FOUND')` for an unknown id. */
  rotate(id: string): CentralRecord;
  /** Remove a central, its token and its scope. An id the registry does not hold is ignored. */
  revoke(id: string): void;
  /** Every central, oldest first. A central minted again keeps its place and its `createdAt`. */
  list(): CentralRecord[];
  /** Called after each change that happened (not for a no-op). Returns the unsubscribe. */
  onChange(l: () => void): () => void;
}

export interface CentralRegistryOptions {
  now?: () => number;
  /** The source of a token's 32 bytes; tests inject a fake. */
  random?: (n: number) => Buffer;
}

interface Entry {
  record: CentralRecord;
  scopeKey: string;
}

export function createCentralRegistry(opts: CentralRegistryOptions = {}): CentralRegistry {
  const now = opts.now ?? Date.now;
  const random: (n: number) => Buffer = opts.random ?? randomBytes;
  // The only copy of each record. An entry is replaced, never edited, and never handed out.
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();

  const entryForScope = (scopeKey: string): Entry | undefined =>
    [...entries.values()].find((entry) => entry.scopeKey === scopeKey);

  const entryForTerminal = (terminalId: string): Entry | undefined =>
    [...entries.values()].find((entry) => entry.record.terminalId === terminalId);

  function requireEntry(centralId: string): Entry {
    const entry = entries.get(centralId);
    if (entry === undefined) throw new ToolError('NOT_FOUND', `No central ${centralId}`);
    return entry;
  }

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (err) {
        log.warn(
          'mcp',
          `A central change listener failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /** A token no central holds. A real random source does not repeat; a fake one can, and two centrals must never share a token. */
  function freshToken(): string {
    const token = TOKEN_PREFIX + random(TOKEN_BYTES).toString('base64url');
    for (const { record } of entries.values()) {
      if (record.token === token)
        throw new Error('The random source returned a token that is already in use');
    }
    return token;
  }

  function mint(input: MintInput): CentralRecord {
    const scope = scopeOf(input.kind, input.scopeRef);
    if (scope === null) throw missingScope(input.kind);
    const centralId = input.centralId ?? randomUUID();
    if (centralId.trim() === '') throw new ToolError('INVALID', 'A central id cannot be blank');
    const holder = entryForScope(scope.key);
    if (holder !== undefined && holder.record.centralId !== centralId) {
      throw new CentralScopeTakenError(holder.record);
    }
    // Set when this mint is a relaunch of a central the registry holds: it is still that central.
    const previous = entries.get(centralId);
    const record: CentralRecord = {
      centralId,
      kind: input.kind,
      scopeRef: scope.scopeRef,
      cli: input.cli,
      permissionMode: input.permissionMode,
      toolsets: input.toolsets ? [...input.toolsets] : defaultToolsets(input.kind, input.cli),
      token: freshToken(),
      terminalId: null,
      createdAt: previous?.record.createdAt ?? now(),
    };
    entries.set(centralId, { record, scopeKey: scope.key });
    notify();
    return copyOf(record);
  }

  function attachTerminal(centralId: string, terminalId: string): void {
    const entry = requireEntry(centralId);
    if (terminalId.trim() === '') throw new ToolError('INVALID', 'A terminal id cannot be blank');
    const holder = entryForTerminal(terminalId);
    if (holder !== undefined && holder.record.centralId !== centralId) {
      throw new ToolError(
        'INVALID',
        `Terminal ${terminalId} already belongs to central ${holder.record.centralId}`,
      );
    }
    if (entry.record.terminalId === terminalId) return;
    entries.set(centralId, { ...entry, record: { ...entry.record, terminalId } });
    notify();
  }

  function byToken(token: string): CentralRecord | null {
    if (typeof token !== 'string') return null;
    const candidate = Buffer.from(token);
    let match: CentralRecord | null = null;
    // Every record is compared, without stopping at a match, so the time taken says nothing about
    // which one it was. `timingSafeEqual` throws on buffers of unequal length, so only equal ones meet it.
    for (const { record } of entries.values()) {
      const stored = Buffer.from(record.token);
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) match = record;
    }
    return match === null ? null : copyOf(match);
  }

  function byId(id: string): CentralRecord | null {
    const entry = entries.get(id);
    return entry === undefined ? null : copyOf(entry.record);
  }

  function byTerminal(terminalId: string): CentralRecord | null {
    const entry = entryForTerminal(terminalId);
    return entry === undefined ? null : copyOf(entry.record);
  }

  function findByScope(kind: CentralKind, scopeRef: string | null): CentralRecord | null {
    const scope = scopeOf(kind, scopeRef);
    const entry = scope === null ? undefined : entryForScope(scope.key);
    return entry === undefined ? null : copyOf(entry.record);
  }

  function rotate(id: string): CentralRecord {
    const entry = requireEntry(id);
    const record = { ...entry.record, token: freshToken() };
    entries.set(id, { ...entry, record });
    notify();
    return copyOf(record);
  }

  function revoke(id: string): void {
    if (entries.delete(id)) notify();
  }

  function list(): CentralRecord[] {
    return [...entries.values()].map((entry) => copyOf(entry.record));
  }

  function onChange(listener: () => void): () => void {
    // Wrapped, so the same function subscribed twice is two subscriptions that end separately.
    const subscription = (): void => listener();
    listeners.add(subscription);
    return () => {
      listeners.delete(subscription);
    };
  }

  return {
    mint,
    attachTerminal,
    byToken,
    byId,
    byTerminal,
    findByScope,
    rotate,
    revoke,
    list,
    onChange,
  };
}

/** The registry the server runs on. */
export const centrals: CentralRegistry = createCentralRegistry();

// ---------------------------------------------------------------------------
// Finding a central's session
// ---------------------------------------------------------------------------

/** `central` is optional and written by the launch code, so it is read defensively. */
function markerOf(session: Session): SessionCentralMarker | undefined {
  return (session as Session & { central?: SessionCentralMarker }).central;
}

/** Does `a` beat `b` as the card of one central? A live card beats an ended one; then the more recently active wins. */
function outranks(a: Session, b: Session): boolean {
  const aEnded = a.status === SESSION_STATUS.ENDED;
  const bEnded = b.status === SESSION_STATUS.ENDED;
  if (aEnded !== bEnded) return bEnded;
  return a.lastActivityAt > b.lastActivityAt;
}

/**
 * The session a central runs in: the one whose `central.centralId` matches. A session keeps its
 * marker when it is re-keyed from `term-*` to the CLI's own id, so this still finds it. When
 * two cards carry the marker (an ended card left beside its relaunch), the live one is answered.
 */
export function resolveCentralSession(
  centralId: string,
  sessions: readonly Session[],
): Session | null {
  let best: Session | null = null;
  for (const session of sessions) {
    if (markerOf(session)?.centralId !== centralId) continue;
    if (best === null || outranks(session, best)) best = session;
  }
  return best;
}
