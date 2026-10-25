// paths.ts — how the central-session MCP server names a folder.
//
// A project central is filed under its folder, and scope.ts matches sessions against it, so two
// spellings of one folder ('/a/proj', '/a/proj/', '~/proj') have to come out as one string.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * `~` and `~/…` mean this user's home folder. `~other/…` is not expanded: it is not a form AASC
 * accepts, so it resolves like any other relative name.
 */
function expandHome(p: string): string {
  if (p === '~') return homedir();
  return p.startsWith('~/') || p.startsWith(`~${sep}`) ? join(homedir(), p.slice(2)) : p;
}

/**
 * The one name for a folder: a leading `~` expanded, `.` and `..` resolved, a relative path made
 * absolute, and no trailing `/` (`path.resolve` drops it, and keeps the root as `/`).
 *
 * It only works on the text. It never touches the disk, so a folder that does not exist, or a link,
 * is named by what was written. An empty string resolves to the server's own working folder, so a
 * caller that takes the text from a person checks it is not blank first.
 */
export function normalizeFolder(p: string): string {
  return resolve(expandHome(p));
}
