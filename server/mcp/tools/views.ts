// tools/views.ts — how the read tools show a session to a central: the one-line row, the request, the age.
//
// Every list tool answers twice, and a client may show the model either one (or both), so the text a
// session wrote is fenced in both. `data` (structuredContent) carries the cards as plain values with the
// free text of each fenced on its own (`dataCard`: the title; the rest of a card is ids, statuses, numbers,
// times, model and effort names and a folder path). The text summary beside it renders the rows inside ONE
// `<untrusted source="aasc" kind="session-cards">` block. The words around a block are AASC's own.

import { homedir } from 'node:os';
import { sep } from 'node:path';
import type { PendingRequest, Session } from '../../../src/types/session.js';
import type { SessionCard } from '../scope.js';
import { clipText, fence, inputText, oneLine, plain, sessionSource } from './define.js';

// ---------------------------------------------------------------------------
// Time and paths
// ---------------------------------------------------------------------------

/** How long ago, in the words a person uses: `just now`, `45s ago`, `12m ago`, `3h ago`, `2d ago`. */
export function ago(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (!Number.isFinite(seconds) || seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** A length of time in the two largest units that matter: `45s`, `12m`, `3h 12m`, `5d`, `5d 3h`. */
export function span(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 > 0 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 > 0 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** A path with the home folder written `~`. */
export function compactPath(path: string): string {
  const home = homedir();
  if (path === home) return '~';
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

// ---------------------------------------------------------------------------
// What a session waits on
// ---------------------------------------------------------------------------

/** A status that waits on a person, with or without the structured request behind it. */
const WAITING_STATUSES: ReadonlySet<string> = new Set(['approval', 'input']);

type WaitFields = Pick<Session, 'status' | 'pendingRequest'>;

/** It waits on a person: an open request, or a status that says so. */
export const waitsOnPerson = (s: WaitFields): boolean => !!s.pendingRequest || WAITING_STATUSES.has(s.status);

/** It waits on a person but no structured request says what for: a status the server guessed from a timer. */
export const isGuessedWait = (s: WaitFields): boolean => !s.pendingRequest && WAITING_STATUSES.has(s.status);

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** A card as a list tool sends it: the card, the name of its room, whether its wait is a guess. */
export interface CardView extends SessionCard {
  roomName: string | null;
  guessedWait: boolean;
}

/**
 * A card as `data` carries it: its title, which a session wrote, fenced on its own
 * (`<untrusted source="session:<id>" kind="title">…</untrusted>`); everything else on a card is an id, a status, a
 * number, a time, a model or effort name or a folder path, and stays as it is. A copy: the card is not changed.
 */
export function dataCard<T extends SessionCard>(card: T): T {
  return { ...card, title: fence(sessionSource(card.id), 'title', card.title) };
}

/**
 * One session's row for the text summary. `ref` names the session in plain words (`refOf`: the short id, or the
 * whole id where short ids collide). The title is JSON-quoted so a newline in it stays in the row.
 */
export function cardRow(card: SessionCard, now: number, ref: string, guessed = false): string {
  const parts = [
    ref,
    card.status,
    card.cli ?? 'cli unknown',
    JSON.stringify(oneLine(card.title, 80)),
    card.project === null ? 'no folder' : compactPath(card.project),
    card.contextPct === null ? null : `ctx ${card.contextPct}%`,
    card.queueCount > 0 ? `queue ${card.queueCount}` : null,
    `active ${ago(now - card.lastActivityAt)}`,
    card.needsYou ? 'NEEDS YOU' : guessed ? 'waiting on you?' : null,
    card.isCentral ? 'central' : null,
    card.handsOff ? 'hands-off' : null,
  ];
  return parts.filter((p): p is string => p !== null).join(' · ');
}

/** The rows of a card list as ONE untrusted block. */
export function cardsBlock(rows: readonly string[], source = 'aasc', kind = 'session-cards'): string {
  return fence(source, kind, rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * What the tools say about an open request. What the agent wrote in it is fenced: the tool's input as one block,
 * each choice's label and description as its own.
 */
export interface RequestView {
  requestId: string;
  kind: PendingRequest['kind'];
  cli: PendingRequest['cli'];
  tool: string;
  source: PendingRequest['source'];
  raisedAt: number;
  ambiguous: boolean;
  canAlwaysAllow: boolean;
  /** A question's choices, each label (and description) fenced as untrusted; null when it has none to pick from. */
  options: Array<{ label: string; description?: string }> | null;
  /** The tool's input, as JSON text cut to 2 000 characters, fenced as untrusted; null when the CLI sent none. */
  input: string | null;
  inputTruncated: boolean;
}

const REQUEST_INPUT_MAX = 2_000;

export function requestView(sessionId: string, req: PendingRequest): RequestView {
  const hasInput = req.input !== undefined && req.input !== null;
  const clipped = hasInput ? clipText(inputText(req.input), REQUEST_INPUT_MAX) : null;
  const source = sessionSource(sessionId);
  return {
    requestId: req.id,
    kind: req.kind,
    cli: req.cli,
    tool: req.tool,
    source: req.source,
    raisedAt: req.raisedAt,
    ambiguous: req.ambiguous === true,
    canAlwaysAllow: req.canAlwaysAllow === true,
    options: req.options
      ? req.options.map((o) => ({
          label: fence(source, 'option', o.label),
          ...(o.description ? { description: fence(source, 'option-description', o.description) } : {}),
        }))
      : null,
    input: clipped === null ? null : fence(source, 'request', clipped.text),
    inputTruncated: req.inputTruncated === true || clipped?.truncated === true,
  };
}

/**
 * One request as a line of the text summary (inside an untrusted block): its id (as a plain word: a later tool
 * answers by it), the tool and a cut of its input.
 */
export function requestLine(req: PendingRequest): string {
  const excerpt = req.input === undefined || req.input === null ? '' : oneLine(inputText(req.input), 160);
  const options = req.options?.length ? ` · options: ${req.options.map((o) => JSON.stringify(oneLine(o.label, 40))).join(', ')}` : '';
  return `${req.kind} request ${plain(req.id)} for ${req.tool}${excerpt ? `: ${excerpt}` : ''}${options}`;
}
