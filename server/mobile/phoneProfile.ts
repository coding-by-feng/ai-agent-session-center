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
// What this does NOT contain: a phone that drives an agent can ask the agent to
// do anything the agent may do. That is the agent's permission mode. This
// profile limits what the dashboard itself does on a phone's behalf.

import { realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import log from '../logger.js';

/** The one permission set a paired phone has. The desktop shows it next to each phone. */
export const PHONE_ACCESS = 'sessions-only' as const;
export type PhoneAccess = typeof PHONE_ACCESS;

/**
 * How a phone request is judged:
 * - allow     the route's own visibility and baton checks are enough
 * - terminal  never an ops shell (a plain command prompt)
 * - files     read-only, inside a shared session's project
 * - launch    a known project folder and a CLI AASC launches, nothing else
 */
export type PhoneRule = 'allow' | 'terminal' | 'files' | 'launch';

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
  route('GET', '/commands', 'allow'),
  route('GET', '/codex/models', 'allow'),
  route('GET', '/presence', 'allow'),
  route('POST', '/presence/control/(claim|release|release-all|request|grant)', 'allow'),
  route('GET|POST', '/agenda', 'allow'),
  route('PUT|DELETE', '/agenda/:id', 'allow'),
  route('PATCH', '/agenda/:id/toggle', 'allow'),
  route('POST', '/tts/(synthesize|status)', 'allow'),
  // A shared session: the /sessions/:id gate answers 404 for every other one.
  route('GET', '/sessions/:id/(source|transcript|queue)', 'allow'),
  route('PUT', '/sessions/:id/(queue|title|remark|muted|alerted|accent-color|character-model|ai-popup)', 'allow'),
  route('POST', '/sessions/:id/(queue/resume|kill|resume|restart-terminal|reconnect-terminal|fork|clone)', 'allow'),
  route('DELETE', '/sessions/:id', 'allow'),
  route('POST', '/queue-images', 'allow'),
  // Notes and history of a shared session (the history and note gates check the owner).
  route('GET', '/db/sessions/:id', 'allow'),
  route('GET|POST', '/db/sessions/:id/notes', 'allow'),
  route('POST', '/db/sessions/:id/note-media', 'allow'),
  route('PUT|DELETE', '/db/notes/:id', 'allow'),
  route('GET', '/note-media/:id', 'allow'),
  route('GET', '/db/prompts', 'allow'),
  // Terminals of shared sessions, never an ops shell.
  route('GET', '/terminals/:id/output', 'terminal'),
  route('POST', '/terminals/:id/write', 'terminal'),
  route('DELETE', '/terminals/:id', 'terminal'),
  // Starting a session.
  route('POST', '/terminals', 'launch'),
  // The project tab, read-only.
  route('GET', '/files/(list|read|stream|search|grep|resolve)', 'files'),
];

/** The rule for a phone request, or null when phones may not call it at all. */
export function phoneRuleFor(method: string, path: string): PhoneRule | null {
  const match = PHONE_ROUTES.find((r) => r.method.test(method) && r.path.test(path));
  return match?.rule ?? null;
}

// ── Files ────────────────────────────────────────────────────────────────────

/** Never read by a phone, wherever they sit: keys, cloud and registry credentials. */
const SECRET_NAMES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.netrc', '.git-credentials', '.npmrc', '.pypirc', 'Keychains',
]);

function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

function inside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Where a project lives on disk, or null when it is too broad to serve to a
 * phone: `/`, the home folder or anything above it would expose ~/.ssh and every
 * other project.
 */
export function phoneProjectRoot(projectPath: string, home: string): string | null {
  const real = realOrNull(projectPath);
  if (!real) return null;
  const realHome = realOrNull(home) ?? home;
  if (real === sep || inside(realHome, real)) return null;
  return real;
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
 * and never inside a secrets folder.
 */
export function phoneMayRead(target: string, sharedProjects: readonly string[], home: string): boolean {
  if (!isAbsolute(target)) return false;
  const real = realTarget(resolve(target));
  if (!real) return false;
  return sharedProjects.some((projectPath) => {
    const root = phoneProjectRoot(projectPath, home);
    if (!root || !inside(real, root)) return false;
    return !relative(root, real).split(sep).some((segment) => SECRET_NAMES.has(segment));
  });
}

const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '');

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** The paths a project-tab request reads: its root and the file or folder in it. */
function filesTargets(req: Request, home: string): string[] | null {
  if (req.path.startsWith('/files/resolve')) {
    const raw = one(req.query.path).trim();
    return raw ? [expandHome(raw, home)] : null;
  }
  const root = one(req.query.root);
  if (!root || !isAbsolute(root)) return null;
  return [root, resolve(root, one(req.query.path).replace(/^\/+/, ''))];
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

// ── Middleware ───────────────────────────────────────────────────────────────

export interface PhoneProfileDeps {
  /** The paired phone a request's session token belongs to, or null (a password sign-in, or the Mac). */
  phoneOf(req: Request): string | null;
  /** Project folders of the sessions shared with remote devices right now. */
  sharedProjectPaths(): string[];
  /** The quick-launch list (known project folders). */
  knownProjectPaths(): string[];
  isOpsTerminal(terminalId: string): boolean;
  home?: string;
}

const NOT_FOUND = { error: 'Not found', code: 'PHONE_NOT_ALLOWED' } as const;

export function createPhoneProfile(deps: PhoneProfileDeps): RequestHandler {
  const home = deps.home ?? homedir();

  function refusal(rule: PhoneRule, req: Request): string | null {
    switch (rule) {
      case 'allow':
        return null;
      case 'terminal': {
        const id = decodeURIComponent(req.path.split('/')[2] ?? '');
        return deps.isOpsTerminal(id) ? 'an ops shell' : null;
      }
      case 'files': {
        const targets = filesTargets(req, home);
        const shared = deps.sharedProjectPaths();
        return targets && targets.every((t) => phoneMayRead(t, shared, home)) ? null : 'outside shared projects';
      }
      case 'launch':
        return phoneLaunchRefusal(req.body, [...deps.knownProjectPaths(), ...deps.sharedProjectPaths()], home);
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
      reason = rule ? refusal(rule, req) : 'not open to phones';
    } catch {
      reason = 'malformed request';
    }
    if (reason === null) {
      next();
      return;
    }
    log.warn('mobile', `Paired phone ${phone.slice(0, 8)} refused: ${req.method} ${req.path} (${rule === 'launch' ? 'launch' : reason})`);
    // A launch says why, so the phone can show it. Everything else answers like
    // a missing route, so a refused path can't be told from one that isn't there.
    if (rule === 'launch') {
      res.status(403).json({ ok: false, error: reason, code: 'PHONE_NOT_ALLOWED' });
      return;
    }
    res.status(404).json(NOT_FOUND);
  };
}
