// phoneProfile.ts — what a paired phone may do on this Mac (AASC-28).
//
// A password sign-in (an iPad's browser) keeps the dashboard's full power. A
// paired phone can be lost or stolen, so its session token gets a narrower set:
// watch and drive shared sessions, start claude or codex in a known project
// folder, and read files inside shared sessions' projects. Nothing that starts a
// free-form command (startup commands, ops shells, SSH, tmux), writes files,
// loads or saves the workspace, or changes how the Mac itself is set up.
//
// Deny by default: a route missing from PHONE_ROUTES is refused, so a route added
// later stays closed to phones until someone decides otherwise. Mounted after
// authMiddleware, before the API router; the routes' own visibility and baton
// checks still run after it.
//
// A phone types into an agent terminal only while the agent itself is the
// terminal's foreground program: every agent terminal is a login shell with the
// CLI typed into it, so once the agent exits the same keystrokes would reach the
// shell. (A phone that never holds a terminal gets no keystrokes at all.)
//
// What this does NOT contain: driving an agent is driving everything the agent
// can do. Claude Code's `!` prefix runs a shell command straight from the prompt,
// and the agent itself acts within its own permission mode. The profile limits
// what the DASHBOARD does on a phone's behalf; what reaches the agent's prompt is
// the agent's business. See AASC-28 for the open decision on `!` from phones.

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import log from '../logger.js';
import { HOME_SECRET_SEGMENTS, segmentLooksSecret } from './secretPaths.js';
import {
  filterPhoneChangesAnswer,
  filterPhoneChatAnswer,
  filterPhoneSubagentTranscriptAnswer,
  filterPhoneTranscriptAnswer,
} from './phoneChatFilter.js';

/** The one permission set a paired phone has. The desktop shows it next to each phone. */
export const PHONE_ACCESS = 'sessions-only' as const;
export type PhoneAccess = typeof PHONE_ACCESS;

/**
 * How a phone request is judged:
 * - allow     the route's own visibility and baton checks are enough
 * - terminal  never an ops shell (a plain command prompt)
 * - type      a terminal write: not an ops shell, and the agent must be in the foreground
 * - prompt    a prompt the Mac types and confirms (AASC-42), within the phone's per-minute
 *             prompt budget; the route itself checks the baton and that the agent is running
 * - answer    a waiting request's answer: a shared session whose agent is in the foreground
 * - files     read-only, inside a shared session's project
 * - commands  the autocomplete catalog, for a shared project or none
 * - upload    an image upload, within the phone's per-minute budget
 * - launch    a known project folder and a CLI AASC launches, nothing else
 * - origin    an AI popup: from a shared session, asked from a shared session's terminal
 * On top of the rule, every route that opens a new agent terminal (opensTerminal)
 * counts against the phone's per-minute terminal budget (AASC-32).
 */
export type PhoneRule = 'allow' | 'terminal' | 'type' | 'prompt' | 'answer' | 'files' | 'commands' | 'upload' | 'launch' | 'origin';

interface PhoneRoute {
  method: RegExp;
  path: RegExp;
  rule: PhoneRule;
}

function route(method: string, path: string, rule: PhoneRule): PhoneRoute {
  return {
    method: new RegExp(`^(?:${method})$`),
    path: new RegExp(`^${path.replace(/:id\b/g, '[^/]+')}/?$`),
    rule,
  };
}

/** Everything a paired phone may call under /api. Paths are relative to /api. */
export const PHONE_ROUTES: readonly PhoneRoute[] = [
  // What the app reads to draw itself; each answer is already filtered for remote devices.
  route('GET', '/config', 'allow'),
  route('GET', '/health-check', 'allow'),
  route('GET', '/sessions', 'allow'),
  route('GET', '/queues', 'allow'),
  route('GET', '/terminals', 'allow'),
  route('GET', '/known-projects', 'allow'),
  route('GET', '/commands', 'commands'),
  route('GET', '/codex/models', 'allow'),
  route('GET', '/presence', 'allow'),
  route('POST', '/presence/control/(claim|release|release-all|request|grant)', 'allow'),
  route('GET|POST', '/agenda', 'allow'),
  route('PUT|DELETE', '/agenda/:id', 'allow'),
  route('PATCH', '/agenda/:id/toggle', 'allow'),
  route('POST', '/tts/(synthesize|status)', 'allow'),
  // A shared session: the /sessions/:id gate answers 404 for every other one. The phone's
  // transcript reader is an AI popup's sheet ("Read last answer"); the chat has its own route.
  route('GET', '/sessions/:id/(source|transcript|queue)', 'allow'),
  // A subagent's own messages (AGENTS tab): the same session's content as its transcript.
  route('GET', '/sessions/:id/subagents/[^/]+/transcript', 'allow'),
  // The phone chat (AASC-41) and what a session edited (AASC-44): the chat router's own
  // /sessions/:id gate answers 404 for a session that isn't shared.
  route('GET', '/sessions/:id/(chat|changes)', 'allow'),
  route('GET', '/sessions/:id/changes/\\d+', 'allow'),
  route('PUT', '/sessions/:id/(queue|title|remark|muted|alerted|accent-color|character-model|ai-popup)', 'allow'),
  route('POST', '/sessions/:id/(queue/resume|kill|resume|restart-terminal|reconnect-terminal|fork|clone)', 'allow'),
  route('DELETE', '/sessions/:id', 'allow'),
  // An AI popup (AASC-20): a floating fork of a shared session, started from its
  // Conversation text. The API's own gate checks the same thing; this keeps the
  // profile honest about what it lets through.
  route('POST', '/sessions/spawn-floating', 'origin'),
  route('POST', '/queue-images', 'upload'),
  // Shared from the Mac (AASC-20): a paused append, the QUEUE badge record, saved prompts.
  route('POST', '/sessions/:id/queue/items', 'upload'), // may carry shared images
  route('GET|POST', '/sessions/:id/queue/sent', 'allow'),
  route('GET|POST', '/snippets', 'allow'),
  route('PATCH|DELETE', '/snippets/:id', 'allow'),
  route('POST', '/snippets/:id/use', 'allow'),
  // Rooms come from the Mac (AASC-20): read the cut it may see, and ask the Mac
  // for a change. Never PUT /rooms: only the Mac's window sets the list.
  route('GET', '/rooms', 'allow'),
  route('POST', '/rooms/ops', 'allow'),
  // Notes and history of a shared session (the history and note gates check the owner).
  route('GET', '/db/sessions/:id', 'allow'),
  route('GET|POST', '/db/sessions/:id/notes', 'allow'),
  route('POST', '/db/sessions/:id/note-media', 'upload'),
  route('PUT|DELETE', '/db/notes/:id', 'allow'),
  route('GET', '/note-media/:id', 'allow'),
  route('GET', '/db/prompts', 'allow'),
  // Terminals of shared sessions, never an ops shell.
  route('GET', '/terminals/:id/output', 'terminal'),
  route('POST', '/terminals/:id/write', 'type'),
  // A prompt for a shared session's agent, typed and confirmed by the Mac (AASC-42).
  route('POST', '/sessions/:id/prompt', 'prompt'),
  // What became of that prompt: typed and confirmed, or why not.
  route('GET', '/sessions/:id/prompt/[A-Za-z0-9._:-]+', 'allow'),
  // Answering a waiting request from its card (AASC-43): the Mac picks the keys and types
  // them into the session's own agent terminal. The route checks visibility, the baton
  // and a per-device limit itself.
  route('POST', '/sessions/:id/requests/[^/]+/answer', 'answer'),
  route('DELETE', '/terminals/:id', 'terminal'),
  // Starting a session.
  route('POST', '/terminals', 'launch'),
  // The project tab, read-only.
  route('GET', '/files/(list|read|stream|search|grep|resolve)', 'files'),
  // Skill-note favourites for the compose autocomplete (AASC-20, M9): key, fav, tags, abbr only.
  route('GET', '/skill-notes/favorites', 'allow'),
];

/** The rule for a phone request, or null when phones may not call it at all. */
export function phoneRuleFor(method: string, path: string): PhoneRule | null {
  const match = PHONE_ROUTES.find((r) => r.method.test(method) && r.path.test(path));
  return match?.rule ?? null;
}

// ── Files ────────────────────────────────────────────────────────────────────


function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Does a path under the home folder pass through anything a phone may never read? */
function touchesSecret(pathInHome: string): boolean {
  const segments = pathInHome.split(sep).filter(Boolean).map((s) => s.toLowerCase());
  if (segments.length > 0 && HOME_SECRET_SEGMENTS.has(segments[0])) return true;
  return segments.some(segmentLooksSecret);
}

/**
 * Where a project lives on disk, or null when a phone may not use it: it must
 * sit strictly inside the home folder (never `/`, the home folder itself, `/tmp`
 * or another volume) and never in a secrets or agent-config folder.
 */
export function phoneProjectRoot(projectPath: string, home: string): string | null {
  const real = realOrNull(projectPath);
  const realHome = realOrNull(home);
  if (!real || !realHome || real === realHome || !inside(real, realHome)) return null;
  return touchesSecret(relative(realHome, real)) ? null : real;
}

/** The real path a request points at; a missing file resolves through its folder. */
function realTarget(p: string): string | null {
  return realOrNull(p) ?? (() => {
    const parent = realOrNull(dirname(p));
    return parent ? join(parent, basename(p)) : null;
  })();
}

/**
 * May a phone read `target` (absolute)? Only inside a shared session's project,
 * after links are followed (a link in the project to ~/.ssh is still ~/.ssh),
 * and never a secrets folder or secret-looking file.
 */
export function phoneMayRead(target: string, sharedProjects: readonly string[], home: string): boolean {
  if (!isAbsolute(target)) return false;
  const real = realTarget(resolve(target));
  const realHome = realOrNull(home);
  if (!real || !realHome || !inside(real, realHome) || touchesSecret(relative(realHome, real))) return false;
  return sharedProjects.some((projectPath) => {
    const root = phoneProjectRoot(projectPath, home);
    return root !== null && inside(real, root);
  });
}

// ── Typing ───────────────────────────────────────────────────────────────────

/** Foreground programs that are an agent, not a shell (node-pty reports the process name). */
const AGENT_PROCESS_NAMES = new Set(['claude', 'codex', 'gemini', 'node']);

/** Is this terminal's foreground program an agent? Unknown (null) is not. */
export function isAgentProcessName(name: string | null | undefined): boolean {
  return typeof name === 'string' && AGENT_PROCESS_NAMES.has(name.toLowerCase());
}

/** Uploads (queue images, note media) one phone may make per minute. */
export const PHONE_UPLOADS_PER_MINUTE = 20;

/**
 * New agent terminals one phone may open per minute (AASC-32). Each one is a
 * PTY on the Mac, and the Mac has a hard ceiling (terminalCapacity.ts): a stuck
 * retry or a misbehaving app must not fill it. A person tapping makes a few.
 */
export const PHONE_TERMINALS_PER_MINUTE = 10;

/**
 * Prompts one phone may send through the Mac per minute (AASC-42). Each one types
 * into an agent's input box and presses Enter until the CLI takes it; a person sends
 * a few, a stuck retry loop sends many.
 */
export const PHONE_PROMPTS_PER_MINUTE = 20;

const BUDGET_WINDOW_MS = 60_000;

/** The routes that open a new agent terminal: launch, resume, restart, reconnect, fork, clone, AI popup. */
const TERMINAL_OPENING: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'POST', path: /^\/terminals\/?$/ },
  { method: 'POST', path: /^\/sessions\/[^/]+\/(resume|restart-terminal|reconnect-terminal|fork|clone)\/?$/ },
  { method: 'POST', path: /^\/sessions\/spawn-floating\/?$/ },
];

/** Does this request open a new agent terminal on the Mac? */
export function opensTerminal(method: string, path: string): boolean {
  return TERMINAL_OPENING.some((r) => r.method === method.toUpperCase() && r.path.test(path));
}

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** The paths a project-tab request reads: its root and the file or folder in it. */
function filesTargets(req: Request, home: string): string[] | null {
  // A glob can make ripgrep include hidden folders the denylist protects.
  if (req.query.glob !== undefined) return null;
  if (req.path.startsWith('/files/resolve')) {
    const raw = one(req.query.path).trim();
    return raw ? [expandHome(raw, home)] : null;
  }
  const root = one(req.query.root);
  if (!root || !isAbsolute(root)) return null;
  return [root, resolve(root, one(req.query.path).replace(/^\/+/, ''))];
}

/**
 * A search answers with paths of its own: a text search returns lines from any
 * file under the root (ripgrep skips only hidden and ignored files, and the grep
 * fallback not even those), and a name search lists every name. A phone gets
 * only the hits it could open (AASC-20): `credentials.json`, `server.pem` or
 * `.claude/settings.json` never reach it, not even one line.
 */
export function filterPhoneSearchAnswer(body: unknown, root: string, shared: readonly string[], home: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !isAbsolute(root)) return body;
  const answer = body as { matches?: unknown; results?: unknown };
  const mayOpen = (p: unknown) => typeof p === 'string' && phoneMayRead(resolve(root, p.replace(/^\/+/, '')), shared, home);
  const field = (item: unknown, key: 'file' | 'path') => (item && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined);
  return {
    ...answer,
    ...(Array.isArray(answer.matches) ? { matches: answer.matches.filter((m) => mayOpen(field(m, 'file'))) } : {}),
    ...(Array.isArray(answer.results) ? { results: answer.results.filter((r) => mayOpen(field(r, 'path'))) } : {}),
  };
}

// ── Launch ───────────────────────────────────────────────────────────────────

/** The CLIs AASC launches. */
export const PHONE_CLIS: ReadonlySet<string> = new Set(['claude', 'codex']);

/**
 * What a phone's launch may carry: the quick-launch request plus the new-session
 * form's name, model and effort. Anything else is refused, among them a startup
 * command, an ops shell, SSH or tmux settings, a resume id and a permission mode.
 */
const PHONE_LAUNCH_FIELDS = new Set([
  'workingDir', 'command', 'forceNew', 'requireExistingDir', 'sessionTitle', 'label', 'model', 'effortLevel',
]);

/** Why a phone may not start this session, or null when it may. */
export function phoneLaunchRefusal(body: unknown, allowedDirs: readonly string[], home: string): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Choose a project folder and a CLI';
  const fields = body as Record<string, unknown>;
  const extra = Object.keys(fields).filter((k) => fields[k] !== undefined && !PHONE_LAUNCH_FIELDS.has(k));
  if (extra.length > 0) return `A phone can't set ${extra.sort().join(', ')} when starting a session`;
  if (typeof fields.command !== 'string' || !PHONE_CLIS.has(fields.command)) {
    return 'A phone can start only claude or codex';
  }
  if (typeof fields.workingDir !== 'string' || fields.workingDir === '') return 'Choose a project folder';
  const real = realOrNull(expandHome(fields.workingDir, home));
  if (real && allowedDirs.some((dir) => phoneProjectRoot(dir, home) === real)) return null;
  return 'A phone can start sessions only in a known project folder';
}

// ── AI popups ────────────────────────────────────────────────────────────────

/**
 * Is this AI popup refused? It forks a session's conversation, so the session it
 * comes from must be shared, and so must the session of the terminal it was asked
 * from (`spawnTerminalId`), which the spawner forks instead when it is set.
 */
export function phoneFloatingRefusal(
  body: unknown,
  deps: Pick<PhoneProfileDeps, 'isSharedSession' | 'sessionOfTerminal'>,
): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return true;
  const { originSessionId, spawnTerminalId } = body as Record<string, unknown>;
  if (typeof originSessionId !== 'string' || !originSessionId || !deps.isSharedSession(originSessionId)) return true;
  if (spawnTerminalId === undefined) return false;
  if (typeof spawnTerminalId !== 'string') return true;
  const host = deps.sessionOfTerminal(spawnTerminalId);
  return !host || !deps.isSharedSession(host);
}

// ── Middleware ───────────────────────────────────────────────────────────────

export interface PhoneProfileDeps {
  /** The paired phone a request's session token belongs to, or null (a password sign-in, or the Mac). */
  phoneOf(req: Request): string | null;
  /** Project folders of the sessions shared with remote devices right now. */
  sharedProjectPaths(): string[];
  /** The quick-launch list (known project folders). */
  knownProjectPaths(): string[];
  isOpsTerminal(terminalId: string): boolean;
  /** Is this session shared with remote devices right now? Unknown is not. */
  isSharedSession(sessionId: string): boolean;
  /** The session a terminal belongs to, or null when it can't be told. */
  sessionOfTerminal(terminalId: string): string | null;
  /** The agent terminal a session runs in, or null when it has none. */
  terminalOfSession(sessionId: string): string | null;
  /** The terminal's foreground program (node-pty's process name), or null when unknown. */
  foregroundProcess(terminalId: string): string | null;
  home?: string;
  now?: () => number;
}

const NOT_FOUND = { error: 'Not found', code: 'PHONE_NOT_ALLOWED' } as const;

export function createPhoneProfile(deps: PhoneProfileDeps): RequestHandler {
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  type Bucket = { windowStart: number; count: number };
  const uploads = new Map<string, Bucket>();
  const terminalsOpened = new Map<string, Bucket>();
  const prompts = new Map<string, Bucket>();

  /** Count one more in this phone's current minute; true when it goes over `limit`. */
  function overBudget(buckets: Map<string, Bucket>, phone: string, limit: number): boolean {
    const t = now();
    const bucket = buckets.get(phone);
    if (!bucket || t - bucket.windowStart >= BUDGET_WINDOW_MS) {
      buckets.set(phone, { windowStart: t, count: 1 });
      return false;
    }
    bucket.count++;
    return bucket.count > limit;
  }

  const overUploadBudget = (phone: string): boolean => overBudget(uploads, phone, PHONE_UPLOADS_PER_MINUTE);

  /** Whole seconds until this phone's budget in `buckets` starts over. */
  function retryAfter(buckets: Map<string, Bucket>, phone: string): number {
    const bucket = buckets.get(phone);
    if (!bucket) return 0;
    return Math.max(1, Math.ceil((bucket.windowStart + BUDGET_WINDOW_MS - now()) / 1000));
  }

  function refusal(rule: PhoneRule, req: Request, phone: string): string | null {
    switch (rule) {
      case 'allow':
        return null;
      case 'terminal':
      case 'type': {
        const id = decodeURIComponent(req.path.split('/')[2] ?? '');
        if (deps.isOpsTerminal(id)) return 'an ops shell';
        if (rule === 'type' && !isAgentProcessName(deps.foregroundProcess(id))) return 'the agent is not running';
        return null;
      }
      case 'answer': {
        // The keys go to the session's own agent terminal. A hidden session is refused
        // like a missing route before anything about its terminal can show.
        const sessionId = decodeURIComponent(req.path.split('/')[2] ?? '');
        if (!deps.isSharedSession(sessionId)) return 'not shared';
        const terminalId = deps.terminalOfSession(sessionId);
        return terminalId && isAgentProcessName(deps.foregroundProcess(terminalId)) ? null : 'the agent is not running';
      }
      case 'commands': {
        const projectPath = one(req.query.projectPath);
        return !projectPath || phoneMayRead(projectPath, deps.sharedProjectPaths(), home) ? null : 'outside shared projects';
      }
      case 'upload':
        return overUploadBudget(phone) ? 'too many uploads' : null;
      case 'prompt':
        return overBudget(prompts, phone, PHONE_PROMPTS_PER_MINUTE) ? 'too many prompts' : null;
      case 'files': {
        const targets = filesTargets(req, home);
        const shared = deps.sharedProjectPaths();
        return targets && targets.every((t) => phoneMayRead(t, shared, home)) ? null : 'outside shared projects';
      }
      case 'launch':
        return phoneLaunchRefusal(req.body, [...deps.knownProjectPaths(), ...deps.sharedProjectPaths()], home);
      case 'origin':
        return phoneFloatingRefusal(req.body, deps) ? 'not from a shared session' : null;
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    const phone = deps.phoneOf(req);
    if (!phone) {
      next();
      return;
    }
    const rule = phoneRuleFor(req.method, req.path);
    let reason: string | null;
    try {
      reason = rule ? refusal(rule, req, phone) : 'not open to phones';
    } catch {
      reason = 'malformed request';
    }
    if (reason === null) {
      // Counted only once the profile lets it through: a refused request opens nothing.
      if (opensTerminal(req.method, req.path) && overBudget(terminalsOpened, phone, PHONE_TERMINALS_PER_MINUTE)) {
        log.warn('mobile', `Paired phone ${phone.slice(0, 8)} refused: ${req.method} ${req.path} (terminal budget)`);
        res.status(429).json({
          error: 'This phone opened a lot of terminals in the last minute. Wait a moment and try again.',
          code: 'PHONE_TERMINAL_LIMIT',
          retryAfter: retryAfter(terminalsOpened, phone),
        });
        return;
      }
      if (rule === 'files' && /^\/files\/(grep|search)\/?$/.test(req.path)) {
        const root = one(req.query.root);
        const shared = deps.sharedProjectPaths();
        const json = res.json.bind(res);
        res.json = (body: unknown) => json(filterPhoneSearchAnswer(body, root, shared, home));
      }
      // The chat, its edits and the transcripts (a subagent's too) show what the agent read and
      // wrote: never a secret file's content. The readers mark what touched one
      // (server/chat/secretMarks.ts, transcriptMarks.ts); this hides by the marks.
      const chatRoute = /^\/sessions\/[^/]+\/(chat|changes|transcript|subagents\/[^/]+\/transcript)(?:\/[^/]+)?\/?$/.exec(req.path);
      if (rule === 'allow' && req.method === 'GET' && chatRoute) {
        const json = res.json.bind(res);
        const filter = chatRoute[1] === 'chat' ? filterPhoneChatAnswer
          : chatRoute[1] === 'transcript' ? filterPhoneTranscriptAnswer
            : chatRoute[1] === 'changes' ? filterPhoneChangesAnswer : filterPhoneSubagentTranscriptAnswer;
        res.json = (body: unknown) => json(filter(body));
      }
      next();
      return;
    }
    log.warn('mobile', `Paired phone ${phone.slice(0, 8)} refused: ${req.method} ${req.path} (${rule === 'launch' ? 'launch' : reason})`);
    // A launch says why, so the phone can show it; so does typing while the agent
    // isn't running, and an upload or a prompt over budget. Everything else answers like a
    // missing route, so a refused path can't be told from one that isn't there.
    if (rule === 'launch') {
      res.status(403).json({ ok: false, error: reason, code: 'PHONE_NOT_ALLOWED' });
      return;
    }
    if ((rule === 'type' || rule === 'answer') && reason === 'the agent is not running') {
      res.status(409).json({ error: `A phone can ${rule} only while the agent is running`, code: 'AGENT_NOT_RUNNING' });
      return;
    }
    if (rule === 'upload') {
      res.status(429).json({ error: 'Too many uploads from this phone; try again in a minute', code: 'PHONE_RATE_LIMITED' });
      return;
    }
    if (rule === 'prompt') {
      res.status(429).json({
        error: 'This phone sent a lot of prompts in the last minute. Wait a moment and try again.',
        code: 'PHONE_PROMPT_LIMIT',
        retryAfter: retryAfter(prompts, phone),
      });
      return;
    }
    res.status(404).json(NOT_FOUND);
  };
}
