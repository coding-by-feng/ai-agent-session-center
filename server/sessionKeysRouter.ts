// sessionKeysRouter.ts — two small routes a central's key_send and terminal_clear call (MCP P3, Task 13):
//
//   POST /api/sessions/:id/keys     { key }  presses one key of `KEY_BYTES` in the session's terminal
//   POST /api/terminals/:id/clear            empties a terminal's replay and tells its viewers, as the toolbar's
//                                            "Clear output" does (wsManager TERMINAL_CLEAR)
//
// Both answer this Mac only (403 to a remote caller): a phone presses keys through its own terminal view, under the
// control baton. The keys are a fixed map, never bytes a caller sends: esc, enter, tab, up, down and 1–9 (Ruling
// P3-11). There is no ctrl-c: a second one ends the CLI, and a turn is stopped another way.
//
// A key other than esc goes only to a menu AASC knows is open (finding D-I1): a dialog it tracks (a structured request,
// or the card shows approval or input), or the menu Codex's `/review` opens, which command_run marks
// (server/mcp/menuMark.ts: until a hook more than 5 s after the mark, or 60 s). An enter, digit or esc that the mark
// alone lets through uses it up (it picks, confirms or closes the menu); up, down and tab keep it (ruling P3-37). A
// mark opens no key while the card is mid-turn (working, prompting, approval, input: ruling P3-40). On
// an idle prompt up and enter would replay the prompt history, and enter alone would send the person's draft. esc keeps its own rule, and on a card with no menu
// known open a second esc within `DOUBLE_ESC_MS` of the last one pressed is refused: two open rewind.
//
// The keys route refuses, in this order:
//   403 remote caller · 404 no card, or no terminal · 400 bad-key (not in the map) · 409 not_started (AASC has not
//   heard the terminal's CLI, or the card carries the never-started marker: it may be showing its trust question,
//   Ruling P4-58) · 409 agent_not_running (a shell is in front, so the key would reach the shell; also an ended
//   card) · 409 mid_turn (esc while working, prompting, approval or input: it would interrupt the turn) ·
//   409 awaiting_answer (a digit, enter or tab while a dialog is open: the central answers a dialog with
//   request_answer, which never sends allow_always) · 409 no_menu (any key but esc with no dialog or menu mark) ·
//   409 double_esc (a second esc within 2 s with neither).
// Then it writes the key's bytes and answers 200 { ok: true }.
//
// Every dependency is injected (`SessionKeysDeps`): the module imports no store, PTY or socket, so the live harness
// and the tests mount it with fakes. apiRouter.ts mounts it with the real ones. The menu marks are menuMark.ts's
// in-memory map, which command_run writes in the same process; the last esc per terminal is this router's own.

import { Router, type Request, type Response } from 'express';
import log from './logger.js';
import { endMenuMark, menuMarked } from './mcp/menuMark.js';

/** The keys a caller may press, and the bytes each one types. Nothing else is ever written. */
export const KEY_BYTES = Object.freeze({
  esc: '\x1b',
  enter: '\r',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  1: '1',
  2: '2',
  3: '3',
  4: '4',
  5: '5',
  6: '6',
  7: '7',
  8: '8',
  9: '9',
} as const);

export type KeyName = keyof typeof KEY_BYTES & string;

/** The key names, as key_send's schema takes them. */
export const KEY_NAMES = Object.freeze(Object.keys(KEY_BYTES)) as readonly [KeyName, ...KeyName[]];

/** A turn is running, or the CLI shows a dialog: esc would end it. */
const MID_TURN: ReadonlySet<string> = new Set(['working', 'prompting', 'approval', 'input']);

/** The CLI shows a dialog: a digit, enter or tab would answer it. */
const DIALOG_STATUS: ReadonlySet<string> = new Set(['approval', 'input']);

/** The keys that leave a menu open: they only move in it. Any other key a menu mark lets through uses the mark up. */
const MOVING_KEYS: ReadonlySet<string> = new Set(['up', 'down', 'tab']);

/** The keys that would pick or confirm a dialog's option. */
const ANSWERING_KEYS: ReadonlySet<string> = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'enter', 'tab']);

/** A second esc this soon after the last one, with no menu known open, would open rewind. */
export const DOUBLE_ESC_MS = 2_000;

/** What the route reads of a session. */
export interface SessionKeysSession {
  sessionId: string;
  terminalId?: string | null;
  status: string;
  /** A dialog AASC tracks (server/pendingRequests.ts); any value but null or undefined means one is open. */
  pendingRequest?: unknown;
  /** `false`: the connecting timeout turned it idle before its terminal sent a hook. */
  startHeard?: boolean;
  /** When the card last changed, which every hook bumps: a hook after a menu mark ends it. */
  lastActivityAt?: number;
}

export interface SessionKeysDeps {
  /** Did the request come from this Mac (requestLocality `isLocalRequest`)? */
  isLocal(req: Request): boolean;
  /** A session by any id it has gone by, or null. */
  getSession(id: string): SessionKeysSession | null | undefined;
  writeToTerminal(terminalId: string, bytes: string): void;
  /** Empties the terminal's replay ring; false when there is no such terminal. */
  clearTerminalOutput(terminalId: string): boolean;
  /** Tells every viewer of the terminal that its output was cleared. */
  broadcastTerminalCleared(terminalId: string): void;
  /** Is the terminal's foreground program the agent (not the shell under it)? */
  foregroundIsAgent(terminalId: string): boolean;
  /** Has AASC heard a hook from the CLI in this terminal (heardTerminals.ts)? */
  terminalHeard(terminalId: string): boolean;
  /** The clock (Date.now unless a test gives one). */
  now?: () => number;
}

/** Express 5 may give a param as an array; the routes use single values. */
const param = (value: unknown): string => (typeof value === 'string' ? value : Array.isArray(value) ? String(value[0] ?? '') : '');

/** The key the body names, when it is one of the map's own (never an inherited name such as `constructor`). */
function keyOf(body: unknown): KeyName | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const key = (body as { key?: unknown }).key;
  return typeof key === 'string' && Object.hasOwn(KEY_BYTES, key) ? (key as KeyName) : null;
}

interface KeyVerdict {
  /** Why the key may not be pressed now, or null when it may. */
  refusal: string | null;
  /** Only a menu mark lets it through. */
  byMark: boolean;
}

const refused = (refusal: string): KeyVerdict => ({ refusal, byMark: false });
const PASSES: KeyVerdict = { refusal: null, byMark: false };

/** May the key be pressed now? `lastEscAt` is when esc was last pressed in the terminal. */
function keyVerdict(
  deps: SessionKeysDeps, s: SessionKeysSession, terminalId: string, key: KeyName, now: number, lastEscAt: number | undefined,
): KeyVerdict {
  if (s.startHeard === false || !deps.terminalHeard(terminalId)) return refused('not_started');
  if (s.status === 'ended' || !deps.foregroundIsAgent(terminalId)) return refused('agent_not_running');
  if (key === 'esc' && MID_TURN.has(s.status)) return refused('mid_turn');
  const dialogOpen = (s.pendingRequest !== null && s.pendingRequest !== undefined) || DIALOG_STATUS.has(s.status);
  if (ANSWERING_KEYS.has(key) && dialogOpen) return refused('awaiting_answer');
  if (dialogOpen) return PASSES;
  if (!MID_TURN.has(s.status) && menuMarked(terminalId, s.lastActivityAt ?? 0, now)) return { refusal: null, byMark: true };
  if (key !== 'esc') return refused('no_menu');
  return lastEscAt !== undefined && now - lastEscAt < DOUBLE_ESC_MS ? refused('double_esc') : PASSES;
}

export function createSessionKeysRouter(deps: SessionKeysDeps): Router {
  const router = Router();
  const now = deps.now ?? Date.now;
  /** When esc was last pressed, per terminal. */
  const lastEsc = new Map<string, number>();

  router.post('/sessions/:id/keys', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) {
      res.status(403).json({ ok: false, error: 'This Mac only' });
      return;
    }
    const session = deps.getSession(param(req.params.id));
    const terminalId = session?.terminalId;
    if (!session || typeof terminalId !== 'string' || terminalId === '') {
      res.status(404).json({ ok: false, error: 'Session not found' });
      return;
    }
    const key = keyOf(req.body);
    if (key === null) {
      res.status(400).json({ ok: false, error: 'bad-key' });
      return;
    }
    const at = now();
    const { refusal, byMark } = keyVerdict(deps, session, terminalId, key, at, lastEsc.get(terminalId));
    if (refusal !== null) {
      res.status(409).json({ ok: false, error: refusal });
      return;
    }
    deps.writeToTerminal(terminalId, KEY_BYTES[key]);
    if (byMark && !MOVING_KEYS.has(key)) endMenuMark(terminalId);
    if (key === 'esc') lastEsc.set(terminalId, at);
    log.info('api', `Pressed ${key} in terminal ${terminalId.slice(0, 12)}`);
    res.json({ ok: true });
  });

  router.post('/terminals/:id/clear', (req: Request, res: Response) => {
    if (!deps.isLocal(req)) {
      res.status(403).json({ ok: false, error: 'This Mac only' });
      return;
    }
    const terminalId = param(req.params.id);
    if (terminalId === '' || !deps.clearTerminalOutput(terminalId)) {
      res.status(404).json({ ok: false, error: 'Terminal not found' });
      return;
    }
    deps.broadcastTerminalCleared(terminalId);
    res.json({ ok: true, cleared: true });
  });

  return router;
}
