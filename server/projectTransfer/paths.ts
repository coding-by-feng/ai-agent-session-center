/**
 * Where a project's pieces live on a computer, and the path rules both sides of a transfer use
 * (docs/plans/project-transfer.md).
 */
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { HOME_SECRET_SEGMENTS, segmentLooksSecret } from '../mobile/secretPaths.js';

/** Claude Code's folder name for a project: every character that is not a letter or digit becomes `-`. */
export function claudeProjectDirName(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` when that is set (as Claude Code reads it). */
export function claudeProjectsRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configDir = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  if (!configDir) return join(home, '.claude', 'projects');
  const expanded = configDir === '~' || configDir.startsWith('~/') ? join(home, configDir.slice(1)) : configDir;
  return join(expanded, 'projects');
}

/** `<CODEX_HOME>/sessions`, `~/.codex/sessions` by default. */
export function codexSessionsRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'sessions');
}

/** Codex keeps each rollout under the day its session began. */
export const CODEX_REL_RE = /^\d{4}\/\d{2}\/\d{2}\/rollout-[\w.:-]{1,200}\.jsonl$/;

/**
 * A relative path an item may have: `/`-separated, no empty, `.` or `..` part, no backslash or NUL,
 * not absolute, under 4096 characters, and no part naming a transfer's own staging folder.
 */
export function safeRel(rel: unknown): boolean {
  return (
    typeof rel === 'string' &&
    rel.length > 0 &&
    rel.length < 4096 &&
    !rel.includes('\\') &&
    !rel.includes('\0') &&
    !rel.startsWith('/') &&
    rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !isStagingName(part))
  );
}

/** A transfer's staging folder (`.aasc-transfer-<id>`): never scanned, never written as an item. */
export function isStagingName(name: string): boolean {
  return name.startsWith('.aasc-transfer-');
}

/** Git hooks are programs git runs; Project Sync never carries them, and neither does a transfer. */
const HOOKS_RE = /(^|\/)\.git\/(?:(?:modules\/.+|worktrees\/[^/]+)\/)?hooks(\/|$)/i;
export function isGitHookPath(rel: string): boolean {
  return HOOKS_RE.test(rel.normalize('NFKC'));
}

/** `~/…` for a folder inside `home`, or null when it isn't inside. */
export function homeRelative(path: string, home: string = homedir()): string | null {
  if (path === home) return null;
  return path.startsWith(home + sep) ? path.slice(home.length + 1).split(sep).join('/') : null;
}

export class TransferPathError extends Error {
  constructor(message: string, readonly code: string = 'path_not_allowed') {
    super(message);
  }
}

const NOT_ALLOWED =
  'Choose a folder inside the home folder, outside hidden configuration, Library and secrets folders.';

/**
 * The absolute destination for a `~/…` the source asked for. Every part must be an ordinary name:
 * not hidden, not secret-looking, and the first not `Library`. The folder itself may not exist yet;
 * `confinedProjectPath` checks its parent on disk later.
 */
export function resolveDestination(destination: unknown, home: string = homedir()): string {
  if (typeof destination !== 'string' || !destination.startsWith('~/') || destination.length > 4096) {
    throw new TransferPathError(NOT_ALLOWED);
  }
  const rel = destination.slice(2).replace(/\/+$/, '');
  if (!safeRel(rel)) throw new TransferPathError(NOT_ALLOWED);
  const parts = rel.split('/');
  if (HOME_SECRET_SEGMENTS.has(parts[0].toLowerCase())) throw new TransferPathError(NOT_ALLOWED);
  if (parts.some((part) => part.startsWith('.') || segmentLooksSecret(part))) throw new TransferPathError(NOT_ALLOWED);
  const absolute = normalize(join(home, ...parts));
  if (!isAbsolute(absolute) || !absolute.startsWith(home + sep)) throw new TransferPathError(NOT_ALLOWED);
  return absolute;
}

/** The display form of a destination inside home. */
export function displayPath(absolute: string, home: string = homedir()): string {
  const rel = homeRelative(absolute, home);
  return rel === null ? absolute : `~/${rel}`;
}
