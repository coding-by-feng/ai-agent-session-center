// phoneResourceRedact.ts — what of the RESOURCES catalog a phone may see (plan 16). The desktop's
// catalog speaks for the whole Mac; a remote viewer gets only what its shared sessions open:
//
// - **Projects**: a project's resources (its skills, instructions, memory) only when the project
//   sits inside the folder of a session shared with remote devices (`phoneMayRead`, the rule
//   `/commands` and the project files follow). The open set is a string pre-check, then the
//   real-path rule for the few candidates, kept OPEN_SET_TTL_MS per scan and shared set — the
//   real-path rule costs syscalls, and the Library polls while the Mac scans.
// - **Paths inside a visible resource**: a global config (`~/.claude.json`, Codex `config.toml`)
//   keys every project the Mac ever opened (`projects["~/code/app"]…`), and a finding or a symlink
//   target can name another project's path. For a remote viewer a config field whose key names a
//   closed path is dropped, an unmasked value naming one is masked, findings are left out (the
//   phone shows none; their messages quote paths) and `linkTarget` goes.
// - **Cloud sync rows** are named by their last path segment, as AASC-51's More → Cloud did, and
//   carry a reason only when the phone may see the local resource it is about.
//
// A request from the Mac itself (`local`) sees everything, like the desktop.

import { join, resolve, sep } from 'path';
import type { ResourceCatalog, ResourceDetail, ResourceField, ResourceSummary } from '../../src/types/resources.js';
import type { SyncItem } from '../../src/types/cloudResources.js';
import { phoneMayRead } from './phoneProfile.js';

/** Who is asking: the Mac itself sees everything, a phone (or another remote device) its share. */
export interface PhoneViewer {
  local: boolean;
}

export const OPEN_SET_TTL_MS = 10_000;
const MASK = '******';
/** A quoted key segment that is a path: `projects["~/code/app"]`, `projects["/Volumes/x"]`. */
const KEY_PATH_RE = /\["((?:~|\/)[^"]*)"\]/g;
/** A home-ish path in a value: `~/…`, or absolute under /Users, /Volumes or /home. */
const VALUE_PATH_RE = /(?:~|\/(?:Users|Volumes|home))\/[^\s"'`,;)\]]+/g;

/** A display path (`~/x`) back to the absolute path the phone rule checks. */
export function absolutePath(display: string, home: string): string {
  if (display === '~') return home;
  return display.startsWith('~/') ? join(home, display.slice(2)) : display;
}

const within = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** Ids of the catalog projects inside a shared session's folder (the real-path rule only for candidates). */
export function openProjectIds(
  projects: ResourceCatalog['projects'],
  sharedProjects: readonly string[],
  home: string,
): Set<string> {
  const shared = sharedProjects.map((p) => resolve(p));
  return new Set(
    projects
      .filter((p) => {
        const abs = resolve(absolutePath(p.path, home));
        return shared.some((s) => within(abs, s)) && phoneMayRead(abs, sharedProjects, home);
      })
      .map((p) => p.id),
  );
}

/** `openProjectIds`, kept per scan and shared set for OPEN_SET_TTL_MS. */
export function createOpenProjects(now: () => number) {
  let kept: { key: string; at: number; ids: Set<string> } | null = null;
  return (catalog: Pick<ResourceCatalog, 'projects' | 'scannedAt'>, sharedProjects: readonly string[], home: string): Set<string> => {
    const key = `${catalog.scannedAt ?? 0}|${[...sharedProjects].sort().join('\n')}`;
    const t = now();
    if (kept && kept.key === key && t - kept.at < OPEN_SET_TTL_MS) return kept.ids;
    const ids = openProjectIds(catalog.projects, sharedProjects, home);
    kept = { key, at: t, ids };
    return ids;
  };
}

/** Which of the catalog's resources the viewer may see, given the open project ids. */
export function visibleWith(viewer: PhoneViewer, open: ReadonlySet<string>): (r: Pick<ResourceSummary, 'projectId'>) => boolean {
  if (viewer.local) return () => true;
  return (r) => !r.projectId || open.has(r.projectId);
}

/** `visibleWith` over a fresh open set (no cache): for one-off checks and tests. */
export function visibleFilter(
  viewer: PhoneViewer,
  catalog: Pick<ResourceCatalog, 'projects'>,
  sharedProjects: readonly string[],
  home: string,
): (r: Pick<ResourceSummary, 'projectId'>) => boolean {
  return visibleWith(viewer, viewer.local ? new Set() : openProjectIds(catalog.projects, sharedProjects, home));
}

/** Every path a phone may see named: the agent roots and the open projects' folders (display paths). */
export function openPathGate(catalog: Pick<ResourceCatalog, 'roots' | 'projects'>, open: ReadonlySet<string>): (path: string) => boolean {
  const roots = [catalog.roots.claude, catalog.roots.codex, catalog.roots.shared, ...catalog.projects.filter((p) => open.has(p.id)).map((p) => p.path)]
    .filter((r): r is string => !!r && r !== '~');
  return (path) => roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function namesClosedPath(text: string, re: RegExp, open: (path: string) => boolean): boolean {
  for (const match of text.matchAll(re)) {
    if (!open(match[1] ?? match[0])) return true;
  }
  return false;
}

/** A field a remote viewer may see: dropped when its key names a closed path, masked when its value does. */
function redactField(f: ResourceField, open: (path: string) => boolean): ResourceField | null {
  if (namesClosedPath(f.key, KEY_PATH_RE, open)) return null;
  if (!f.masked && namesClosedPath(f.value, VALUE_PATH_RE, open)) return { ...f, value: MASK, masked: true };
  return f;
}

/** A summary without the symlink target (it can name another project's folder). */
export function redactSummary(r: ResourceSummary): ResourceSummary {
  if (r.linkTarget === undefined) return r;
  const { linkTarget: _target, ...rest } = r;
  return rest;
}

export function redactDetail(detail: ResourceDetail, open: (path: string) => boolean): ResourceDetail {
  return {
    ...detail,
    summary: redactSummary(detail.summary),
    findings: [],
    ...(detail.fields ? { fields: detail.fields.map((f) => redactField(f, open)).filter((f): f is ResourceField => f !== null) } : {}),
  };
}

/** A sync row as a phone sees it: the last segment of its name, its reason only about a resource it may see. */
export function redactSyncItem(item: SyncItem, localVisible: boolean): SyncItem {
  const name = item.name.split(/[/\\]/).map((s) => s.trim()).filter(Boolean).at(-1) ?? item.kind;
  if (localVisible || item.reason === undefined) return { ...item, name };
  const { reason: _reason, ...rest } = item;
  return { ...rest, name };
}
