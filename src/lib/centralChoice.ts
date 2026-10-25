/**
 * @module centralChoice
 * The pure half of starting and showing a central session (server/mcp): what the Central picker may
 * offer for the room and folder a new session has, what the launch request for a choice is, and the words
 * a central's badge and tooltip use. The picker, the two creation modals and the badge all read these, so
 * what the select shows, what the request carries and what the card says cannot drift apart.
 *
 * A central is one per scope: one global, one per room, one per project folder (the server refuses a
 * second with 409). The picker knows which scopes are held from the live list (`mcpStore`), so it greys
 * them out instead of letting the launch fail; the server stays the judge, and its refusal is shown as it
 * comes.
 */
import type { CentralKind, CentralLaunchRequest, CentralSummary } from '@/types';

/** What the picker's select holds: no central, or the scope the new session will have. */
export type CentralChoice = 'off' | CentralKind;

/** What the picker needs to know about the session being created, and about the centrals running now. */
export interface CentralContext {
  /** The room the new session will join. A room central needs one. */
  roomId?: string | null;
  /** The folder it starts in. A project central needs one. */
  folder?: string | null;
  /** The live centrals. A scope that has one cannot have a second. */
  centrals: ReadonlyMap<string, CentralSummary>;
}

/**
 * What one scope offers right now: `absent` when the new session lacks what the scope needs (no room, no
 * folder), `taken` when a central already holds it, `open` otherwise.
 */
export type ChoiceAvailability = 'absent' | 'taken' | 'open';

const hasText = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.trim() !== '';

/**
 * One name for a folder, to compare two spellings of it: padding and trailing separators dropped, runs of
 * `/` made one. It reads only the text. `~` is not expanded (the client does not know the home folder), so
 * `~/app` and the absolute folder the server wrote down do not match here; the server's 409 covers that.
 */
export function folderKey(path: string): string {
  const text = path.trim();
  const key = text.replace(/[\\/]+$/, '').replace(/\/{2,}/g, '/');
  return key === '' && /^[\\/]/.test(text) ? '/' : key;
}

/** The last folder of a path, for a badge: `'/Users/me/app/'` → `'app'`; the root stays `'/'`. */
export function folderName(path: string): string {
  const key = folderKey(path);
  if (key === '/') return key;
  return key.slice(Math.max(key.lastIndexOf('/'), key.lastIndexOf('\\')) + 1) || key;
}

/** Is a central of this kind holding exactly this scope? */
function held(
  centrals: ReadonlyMap<string, CentralSummary>,
  kind: CentralKind,
  matches: (scopeRef: string | null) => boolean,
): boolean {
  for (const row of centrals.values()) {
    if (row.kind === kind && matches(row.scopeRef)) return true;
  }
  return false;
}

export function choiceAvailability(kind: CentralKind, ctx: CentralContext): ChoiceAvailability {
  if (kind === 'global') return held(ctx.centrals, 'global', () => true) ? 'taken' : 'open';
  if (kind === 'room') {
    if (!hasText(ctx.roomId)) return 'absent';
    const wantedRoom = ctx.roomId.trim();
    return held(ctx.centrals, 'room', (ref) => ref === wantedRoom) ? 'taken' : 'open';
  }
  if (!hasText(ctx.folder)) return 'absent';
  const wanted = folderKey(ctx.folder);
  return held(ctx.centrals, 'project', (ref) => ref !== null && folderKey(ref) === wanted) ? 'taken' : 'open';
}

/**
 * The choice that will really be made: `choice` while its scope is open, Off when the room or folder it
 * needed is gone or a central has taken the scope since. The picker shows this, and the launch sends this.
 */
export function effectiveChoice(choice: CentralChoice, ctx: CentralContext): CentralChoice {
  if (choice === 'off') return 'off';
  return choiceAvailability(choice, ctx) === 'open' ? choice : 'off';
}

/**
 * The `central` a launch carries for `choice`, or undefined to leave it out (Off, or a choice that is not
 * open). A new central: it never names a `centralId`. The folder goes as typed, trimmed: the server expands
 * a `~` and refuses `/`, the home folder and any folder that holds it.
 */
export function centralRequestFor(choice: CentralChoice, ctx: CentralContext): CentralLaunchRequest | undefined {
  const made = effectiveChoice(choice, ctx);
  if (made === 'global') return { kind: 'global' };
  // `effectiveChoice` has seen the room and the folder; the checks here are for the type, not the case.
  if (made === 'room' && hasText(ctx.roomId)) return { kind: 'room', scopeRef: ctx.roomId.trim() };
  if (made === 'project' && hasText(ctx.folder)) return { kind: 'project', scopeRef: ctx.folder.trim() };
  return undefined;
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** The scope in words, without the star: `global`, `room Backend` (`room` when its name is not known), `project app`. */
export function scopeName(central: { kind: CentralKind; scopeRef: string | null }, roomName?: string | null): string {
  if (central.kind === 'global') return 'global';
  if (central.kind === 'room') return hasText(roomName) ? `room ${roomName}` : 'room';
  const name = hasText(central.scopeRef) ? folderName(central.scopeRef) : '';
  return name === '' ? 'project' : `project ${name}`;
}

/** What a card's badge says: `★ global`, `★ room Backend` (`★ room` when its name is not known), `★ project app`. */
export function centralBadgeText(
  central: { kind: CentralKind; scopeRef: string | null },
  roomName?: string | null,
): string {
  return `★ ${scopeName(central, roomName)}`;
}

/** A central's live own workers in words (P4): `1 worker`, `3 workers`; empty for none. */
export function workersText(count: number): string {
  if (!Number.isInteger(count) || count <= 0) return '';
  return count === 1 ? '1 worker' : `${count} workers`;
}

/** The badge's name for a screen reader when it shows the star alone: `Central session: project app`. */
export function centralLabel(
  central: { kind: CentralKind; scopeRef: string | null },
  roomName?: string | null,
): string {
  return `Central session: ${scopeName(central, roomName)}`;
}

/** The badge's tooltip: the full scope, which the badge itself may have cut short. */
export function centralTooltip(
  central: { kind: CentralKind; scopeRef: string | null },
  roomName?: string | null,
): string {
  if (central.kind === 'global') return 'Global central: can reach every session.';
  if (central.kind === 'room') {
    return hasText(roomName)
      ? `Room central for "${roomName}": can reach the sessions in that room.`
      : 'Room central: can reach the sessions in its room.';
  }
  return hasText(central.scopeRef)
    ? `Project central for ${central.scopeRef}: can reach the sessions in that folder and below.`
    : 'Project central: can reach the sessions in its folder and below.';
}

/** The picker's line under the select: what the chosen scope reaches, or null when there is nothing to say. */
export function centralChoiceHint(
  choice: CentralChoice,
  subject: { roomName?: string | null; folder?: string | null },
): string | null {
  if (choice === 'global') return 'Can reach every session on this Mac.';
  if (choice === 'room') {
    return hasText(subject.roomName) ? `Can reach the sessions in room "${subject.roomName}".` : null;
  }
  if (choice === 'project') {
    return hasText(subject.folder) ? `Can reach the sessions in ${subject.folder.trim()} and below.` : null;
  }
  return null;
}
