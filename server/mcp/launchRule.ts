// launchRule.ts — where a central may open a session: the phone's folder rule, as a pure function, and the one
// extra rule a project central adds.
//
// A central that opens a worker (openWorker.ts, P4) has no more right to a folder than a paired phone does, so the
// rule mirrors `phoneLaunchDecision` (server/mobile/phoneProfile.ts), which a phone's POST /terminals goes through:
//
//   * a KNOWN project root (a folder Claude Code has worked in) is allowed, even inside a hidden folder or outside
//     home (an external drive: its exact folder only), but never
//     one that passes through a private one (`.ssh`, `.git`, `.claude`, `~/Library`, key and env files …);
//   * any other folder is allowed only when it sits inside the home folder with no hidden (dot) or private segment;
//   * the home folder itself and everything above it (`/`, `/home`) is never allowed: the agent would take the
//     whole home folder as its project.
//
// Pure: nothing here reads the disk. `folder` is the path the caller already resolved to a real path (links
// followed), so a link out of home is judged by where it leads. A folder written with `..` is normalized before it
// is judged, so `~/proj/../.ssh` is `~/.ssh`. The words of a refusal never repeat the folder.
//
// `inCentralScope` is the extra rule: a project central opens sessions in its own folder or below it, never
// elsewhere (a room or global central is held to the launch rule only).

import { isAbsolute, join, relative, sep } from 'node:path';
import { touchesSecret } from '../mobile/homeFolders.js';
import { normalizeFolder } from './paths.js';
import type { ToolContext } from './registry.js';
import { isWithin } from './scope.js';

/** The refusals, in AASC's words. Constants: a refusal never repeats the folder it refuses. */
export const LAUNCH_REFUSALS = {
  notAbsolute: 'A folder is an absolute path, or one that starts with ~.',
  homeOrAbove: 'A central never opens a session in the home folder or above it: pick the project folder inside it.',
  outsideHome: 'A central opens sessions only in a folder inside the home folder.',
  hiddenOrPrivate: 'A central never opens a session in a hidden or private folder.',
} as const;

/**
 * The folder as an absolute path, `~` and `~/…` meaning the `home` given (not whoever's home this process runs as, so a
 * caller that is handed a home stays deterministic); null when it is blank or relative.
 */
export function expandHomePath(folder: string, home: string): string | null {
  const text = typeof folder === 'string' ? folder.trim() : '';
  if (text === '') return null;
  if (text === '~') return home;
  if (text.startsWith('~/') || text.startsWith(`~${sep}`)) return join(home, text.slice(2));
  return isAbsolute(text) ? text : null;
}

/**
 * Is this folder one of the known project roots? Exactly the root, in any spelling: a folder below a known project
 * is not known (it is judged by the full rule). A known project is also the only folder Claude's trust prompt may
 * be confirmed for (openWorker sends `autoConfirmTrust: false` for any other).
 */
export function isKnownProject(folder: string, known: readonly string[]): boolean {
  if (typeof folder !== 'string' || folder.trim() === '') return false;
  const target = normalizeFolder(folder);
  return known.some((root) => root.trim() !== '' && normalizeFolder(root) === target);
}

/** A hidden (dot) segment anywhere along a path that starts at the home folder. */
const hasHiddenSegment = (pathInHome: string): boolean => pathInHome.split(sep).some((segment) => segment.startsWith('.'));

/**
 * Why a central may not open a session in `folder`, or null when it may (as far as this rule goes: the folder must
 * still exist, which openWorker asks the disk). `known` is the known project roots, `home` the real home folder.
 */
export function launchRefusal(folder: string, known: readonly string[], home: string): string | null {
  const written = expandHomePath(folder, home);
  if (written === null) return LAUNCH_REFUSALS.notAbsolute;
  const target = normalizeFolder(written);
  const root = normalizeFolder(home);
  if (target === root || isWithin(root, target)) return LAUNCH_REFUSALS.homeOrAbove;
  if (!isWithin(target, root)) {
    // As the phone allows it: a known project root may sit outside home (an external drive), its exact folder only.
    if (!isKnownProject(target, known)) return LAUNCH_REFUSALS.outsideHome;
    return touchesSecret(target) ? LAUNCH_REFUSALS.hiddenOrPrivate : null;
  }
  const inHome = relative(root, target);
  if (touchesSecret(inHome)) return LAUNCH_REFUSALS.hiddenOrPrivate;
  if (hasHiddenSegment(inHome) && !isKnownProject(target, known)) return LAUNCH_REFUSALS.hiddenOrPrivate;
  return null;
}

/**
 * May this central open a session in `folder`, by what kind of central it is? A project central: its own folder or
 * below. A room or global central: any folder (the launch rule decides). A central with no folder to hold it to, or
 * of a kind this build does not know, opens nothing: an unclear scope never widens.
 */
export function inCentralScope(ctx: Pick<ToolContext, 'central'>, folder: string): boolean {
  const { kind, scopeRef } = ctx.central;
  if (kind === 'global' || kind === 'room') return true;
  if (kind !== 'project') return false;
  if (scopeRef === null || scopeRef.trim() === '') return false;
  return isWithin(normalizeFolder(folder), normalizeFolder(scopeRef));
}
