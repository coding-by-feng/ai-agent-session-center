// sessionSleep.ts — put idle sessions to sleep to free memory (Oct 28 2026, by request).
//
// Each idle Claude/Codex CLI holds ~250–310 MB (plus its MCP servers) while doing nothing; a restored
// workspace of 30+ cards kept ~10 GB resident. With the setting on (Settings → ADVANCED, OFF by default),
// a session that has been quiet for `idleMinutes` has its terminal closed, so its CLI and MCP tree exit. The
// card stays, marked `asleepAt`, and reads as ended: nothing can be sent to it. Opening it (or RESUME)
// runs the ordinary resume path (`POST /api/sessions/:id/resume`, a fresh PTY with `--resume <id>`), which
// clears the mark (sessionStore.reconnectSessionTerminal).
//
// A session never sleeps when sleeping could lose work or could not be undone (see `sleepRefusal`).
//
//   GET /api/session-sleep-setting → { ok, idleMinutes }        (0 = off)
//   PUT /api/session-sleep-setting { idleMinutes }               (one of SLEEP_CHOICES)
//
// Both this Mac only. The choice is saved beside server-config.json (`session-sleep.json`, atomic write)
// and applies at once: the sweep reads it each minute.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import log from './logger.js';
import { isLocalRequest } from './requestLocality.js';
import type { Session } from '../src/types/session.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Minutes a person may pick; 0 is off. */
export const SLEEP_CHOICES = [0, 15, 30, 60, 120, 240] as const;
export const SWEEP_EVERY_MS = 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// ---- the setting ----

function settingFile(): string {
  if (process.env.AASC_SESSION_SLEEP_FILE) return process.env.AASC_SESSION_SLEEP_FILE;
  return process.env.APP_USER_DATA
    ? join(process.env.APP_USER_DATA, 'session-sleep.json')
    : join(__dirname, '..', 'data', 'session-sleep.json');
}

let cachedMinutes: number | null = null;

function isChoice(value: unknown): value is number {
  return typeof value === 'number' && (SLEEP_CHOICES as readonly number[]).includes(value);
}

/** Minutes of quiet before a session sleeps; 0 (the default) is off. */
export function getSleepIdleMinutes(): number {
  if (cachedMinutes === null) {
    try {
      const value = (JSON.parse(readFileSync(settingFile(), 'utf8')) as { idleMinutes?: unknown }).idleMinutes;
      cachedMinutes = isChoice(value) ? value : 0;
    } catch {
      cachedMinutes = 0;
    }
  }
  return cachedMinutes;
}

export function setSleepIdleMinutes(minutes: number): void {
  if (!isChoice(minutes)) throw new RangeError(`Not a sleep choice: ${String(minutes)}`);
  const file = settingFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ idleMinutes: minutes })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cachedMinutes = minutes;
}

/** @internal — test only. */
export function __resetSleepSettingForTest(): void {
  cachedMinutes = null;
}

// ---- the rules ----

export interface SleepContext {
  now: number;
  idleMinutes: number;
  /** Is this terminal open, and not a window onto tmux (closing tmux's PTY would not stop the agent)? */
  terminalSleepable: (terminalId: string) => boolean;
  /** When the terminal last printed (typing echoes, so a person at the prompt counts). */
  lastOutputAt: (terminalId: string) => number | undefined;
  /** Does the session's shared queue hold an item that is switched on (a prompt, loop or schedule)? */
  hasArmedQueue: (sessionId: string) => boolean;
}

type SleepSession = Pick<
  Session,
  'sessionId' | 'status' | 'terminalId' | 'pinned' | 'central' | 'handsOff' | 'backgroundTaskCount'
  | 'pendingRequest' | 'lastActivityAt' | 'asleepAt' | 'startupCommand' | 'sshConfig' | 'isFloating' | 'isFork'
>;

/** The CLI word a launch line starts with (after any `VAR=value` prefixes). */
function commandWord(line: string | undefined): string {
  for (const word of (line ?? '').trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word.split('/').pop() ?? '';
  }
  return '';
}

/** Why `s` must stay awake now, or null when it may sleep. */
export function sleepRefusal(s: SleepSession, ctx: SleepContext): string | null {
  if (ctx.idleMinutes <= 0) return 'off';
  if (s.asleepAt) return 'asleep';
  if (s.status !== 'idle' && s.status !== 'waiting') return 'busy';
  if (!s.terminalId || !ctx.terminalSleepable(s.terminalId)) return 'no-terminal';
  if (s.pinned) return 'pinned';
  if (s.central) return 'central';
  if (s.handsOff) return 'hands-off';
  if (s.isFloating || s.isFork) return 'floating';
  if ((s.backgroundTaskCount ?? 0) > 0) return 'background-shells';
  if (s.pendingRequest) return 'asking';
  // Only a CLI session `--resume` can bring back: a real session id, a claude/codex launch, this Mac.
  if (!UUID_RE.test(s.sessionId)) return 'not-resumable';
  const word = commandWord(s.startupCommand || s.sshConfig?.command);
  if (word !== 'claude' && word !== 'codex') return 'not-resumable';
  const host = s.sshConfig?.host;
  if (host && !LOCAL_HOSTS.has(host)) return 'remote';
  const quietSince = Math.max(s.lastActivityAt ?? 0, ctx.lastOutputAt(s.terminalId) ?? 0);
  if (ctx.now - quietSince < ctx.idleMinutes * 60_000) return 'recent';
  if (ctx.hasArmedQueue(s.sessionId)) return 'queue-armed';
  return null;
}

// ---- the sweep ----

export interface SleepDeps {
  sessions: () => SleepSession[];
  idleMinutes?: () => number;
  terminalSleepable: SleepContext['terminalSleepable'];
  lastOutputAt: SleepContext['lastOutputAt'];
  hasArmedQueue: SleepContext['hasArmedQueue'];
  /**
   * The session as it should be judged, run before the rules: a split pair folds into one card here
   * (sessionStore.healSplitCard), so the card's pin, hands-off, central and queue are what is checked.
   */
  prepare?: (s: SleepSession) => SleepSession;
  /** Mark the card asleep (sessionStore.setSessionAsleep). */
  markAsleep: (sessionId: string, at: number) => void;
  /** Close the terminal and wait for its processes to exit (sshManager.closeTerminalAndWait). */
  closeTerminal: (terminalId: string) => Promise<boolean>;
  now?: () => number;
}

/** One pass: every session that may sleep is marked asleep, then its terminal is closed. Answers the ids put to sleep. */
export async function sweepIdleSessions(deps: SleepDeps): Promise<string[]> {
  const now = (deps.now ?? Date.now)();
  const ctx: SleepContext = {
    now,
    idleMinutes: (deps.idleMinutes ?? getSleepIdleMinutes)(),
    terminalSleepable: deps.terminalSleepable,
    lastOutputAt: deps.lastOutputAt,
    hasArmedQueue: deps.hasArmedQueue,
  };
  if (ctx.idleMinutes <= 0) return [];
  const slept: string[] = [];
  for (const listed of deps.sessions()) {
    const s = deps.prepare ? deps.prepare(listed) : listed;
    if (sleepRefusal(s, ctx) !== null) continue;
    const terminalId = s.terminalId!;
    // Marked first, so the card reads as ended (and nothing is sent to it) before its CLI goes away.
    deps.markAsleep(s.sessionId, now);
    try {
      const clean = await deps.closeTerminal(terminalId);
      if (!clean) log.warn('sleep', `Session ${s.sessionId.slice(0, 8)}: some processes outlived the close`);
    } catch (err) {
      log.warn('sleep', `Closing ${terminalId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log.info('sleep', `Session ${s.sessionId.slice(0, 8)} asleep after ${ctx.idleMinutes} min idle`);
    slept.push(s.sessionId);
  }
  return slept;
}

/** Sweep every SWEEP_EVERY_MS; one sweep at a time. Answers the stop function. */
export function startSessionSleep(deps: SleepDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    sweepIdleSessions(deps)
      .catch((err) => log.warn('sleep', `Sweep failed: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => { running = false; });
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---- the routes ----

const bodySchema = z.object({ idleMinutes: z.number().int() });

export function createSessionSleepRouter(isLocal: (req: Request) => boolean = (req) => isLocalRequest(req)): Router {
  const router = Router();
  router.get('/session-sleep-setting', (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    res.json({ ok: true, idleMinutes: getSleepIdleMinutes(), choices: SLEEP_CHOICES });
  });
  router.put('/session-sleep-setting', (req: Request, res: Response) => {
    if (!isLocal(req)) { res.status(404).json({ ok: false, error: 'Not found' }); return; }
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success || !isChoice(parsed.data.idleMinutes)) {
      res.status(400).json({ ok: false, error: `idleMinutes must be one of ${SLEEP_CHOICES.join(', ')}` });
      return;
    }
    try {
      setSleepIdleMinutes(parsed.data.idleMinutes);
    } catch (err) {
      log.error('sleep', `Saving the sleep setting failed: ${err instanceof Error ? err.message : String(err)}`);
      res.status(500).json({ ok: false, error: 'Could not save the setting' });
      return;
    }
    log.info('sleep', `Sleep idle sessions: ${parsed.data.idleMinutes === 0 ? 'off' : `${parsed.data.idleMinutes} min`}`);
    res.json({ ok: true, idleMinutes: parsed.data.idleMinutes, choices: SLEEP_CHOICES });
  });
  return router;
}
