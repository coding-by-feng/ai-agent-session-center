/**
 * @module projectGroups
 * Groups sessions by project for the session strip's PROJECT view.
 *
 * A project is a directory on a machine: `projectPath`, plus the host when the
 * session is on another one. The same path on two hosts is two projects, and
 * the quick-launch buttons can only start a session on THIS machine, so a
 * group says whether it is `local`.
 *
 * Order, label and colour are all worked out, nothing is stored, and none of
 * them may change because a session came or went or was renamed: frames must
 * not shuffle under the cursor (the room frames' own rule). So the label is the
 * directory's name — never drawn from the sessions' own `projectName`s, which
 * disagree for one path (the server calls the home directory "Home", a card
 * discovered from a bare process is named after the folder) and would flip the
 * label, and with it the sort position, when one more of either arrived. The
 * order is alphabetical by that label, and a colour is handed out in key order
 * from the whole workspace, so neither renaming a session nor filtering what is
 * shown recolours anything. (Only a project appearing or disappearing can, and
 * only one it collides with.)
 *
 * Dependency-free (type imports only), like sessionSort / recentSessions.
 */
import type { Session } from '@/types/session';

export interface ProjectGroup {
  /** `host|path`. Identity for React keys, collapse state and colour. */
  key: string;
  /** The directory as the grouping sees it: separators unified, trailing ones stripped. */
  path: string;
  /**
   * The path to START a session in: exactly as the group's first session stored
   * it. `path` is a grouping key, tidied so that `/w/app` and `/w/app/` meet, and
   * tidying can change which directory is meant — a folder whose name ends in a
   * space, or `C:\`, which `path` would turn into the drive-relative `C:`.
   */
  launchPath: string;
  /** Lower-cased host; `'localhost'` for every local spelling. */
  host: string;
  /** Can a session be started in this directory from here? False for another host. */
  local: boolean;
  /** What the frame says. See `groupSessionsByProject`. */
  label: string;
  /** Index into the caller's palette. */
  colorIndex: number;
  /** The group's sessions, in the order they were passed in. */
  sessions: Session[];
}

export interface ProjectGrouping {
  /** One per project, alphabetical by label. */
  groups: ProjectGroup[];
  /** Sessions with no project path, in the order they were passed in. */
  ungrouped: Session[];
}

/** The strip's room palette has eight colours; the project frames borrow it. */
const DEFAULT_PALETTE_SIZE = 8;

/** Hosts that mean "this machine" however the session was started. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['', 'localhost', '127.0.0.1', '::1']);

/**
 * `'/Users/me/app/'` → `'/Users/me/app'`; `''` when there is no path at all.
 * Reads both separators and collapses doubled ones, so one directory has one
 * spelling however the OS or the hook wrote it (`C:\work\app`, `C:/work/app`).
 */
export function normalizeProjectPath(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const stripped = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  // A path of nothing but separators is the filesystem root: keep one.
  return stripped === '' ? '/' : stripped;
}

/**
 * The machine a session's directory is on. `sshHost` is set for a session the
 * dashboard created, but a card made from a hook carries only `sshConfig` (the
 * matcher copies that and not `sshHost`), and reading `sshHost` alone would
 * file a remote project as local and offer it a LOCAL launch.
 */
function hostOf(session: Session): string {
  const host = (session.sshHost ?? session.sshConfig?.host ?? '').trim().toLowerCase();
  return LOCAL_HOSTS.has(host) ? 'localhost' : host;
}

/** The session's project identity, or null when it has no path to group by. */
export function projectKey(session: Session): string | null {
  const path = normalizeProjectPath(session.projectPath);
  return path ? `${hostOf(session)}|${path}` : null;
}

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean);

/** Plain code-unit order: the same on every machine, unlike `localeCompare`. */
const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** FNV-1a over the key: the same project always lands on the same colour. */
export function projectColorIndex(key: string, paletteSize: number): number {
  if (paletteSize <= 0) return 0;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % paletteSize;
}

/**
 * Hash colours collide: eight colours, six projects, and two share one more
 * often than not. Walk the projects in KEY order and move one forward to the
 * next free colour when its own is taken, so neighbouring frames are told apart
 * while there are colours to tell them apart with. Only a colliding project
 * moves; once the palette is used up, colours repeat.
 *
 * Key order, not display order, and over the whole workspace rather than the
 * frames on screen: both would otherwise let an unrelated change recolour a
 * project — a rename that re-sorts the frames, or a room filter that hides the
 * project it was colliding with.
 */
function assignColors(keys: ReadonlySet<string>, paletteSize: number): Map<string, number> {
  const used = new Set<number>();
  const colors = new Map<string, number>();
  for (const key of [...keys].sort(byKey)) {
    let index = projectColorIndex(key, paletteSize);
    if (used.size < paletteSize) {
      while (used.has(index)) index = (index + 1) % paletteSize;
    }
    used.add(index);
    colors.set(key, index);
  }
  return colors;
}

interface Draft {
  key: string;
  path: string;
  launchPath: string;
  host: string;
  /** The directory's name, `@host` for another machine — what the order is by. */
  base: string;
  sessions: Session[];
}

/** The last `depth` folders of the path, plus the host when it is not this machine. */
function qualified(draft: Draft, depth: number): string {
  const tail = segmentsOf(draft.path).slice(-depth).join('/');
  return draft.host === 'localhost' ? tail : `${tail}@${draft.host}`;
}

/**
 * Two projects can share a folder name (`~/work/app`, `~/play/app`). Frames
 * labelled the same would look like one project split in two, so the clashing
 * ones add parent folders until they differ. The rest keep their plain name.
 * When no depth separates them (paths that differ only in letter case) they
 * fall back to the full path.
 */
function disambiguate(drafts: readonly Draft[]): Map<string, string> {
  const labels = new Map(drafts.map((d) => [d.key, d.base]));
  const buckets = new Map<string, Draft[]>();
  for (const d of drafts) {
    const id = d.base.toLowerCase();
    buckets.set(id, [...(buckets.get(id) ?? []), d]);
  }
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    const deepest = Math.max(...bucket.map((d) => segmentsOf(d.path).length));
    let settled = false;
    for (let depth = 2; depth <= deepest && !settled; depth++) {
      const tries = bucket.map((d) => qualified(d, depth));
      if (new Set(tries.map((t) => t.toLowerCase())).size === bucket.length) {
        bucket.forEach((d, i) => labels.set(d.key, tries[i]));
        settled = true;
      }
    }
    if (!settled) {
      bucket.forEach((d) => labels.set(d.key, d.host === 'localhost' ? d.path : `${d.path}@${d.host}`));
    }
  }
  return labels;
}

/**
 * Split `sessions` into one group per project. The group's label is the
 * directory's name, `@host` for another machine, with parent folders added
 * where two projects would otherwise read the same. Sessions inside a group keep
 * the order they came in, which is the strip's status order.
 *
 * `colorUniverse` is every session the strip knows about; colours are resolved
 * among ITS projects, so showing fewer (a room filter) recolours none. It
 * defaults to `sessions` themselves.
 */
export function groupSessionsByProject(
  sessions: readonly Session[],
  paletteSize: number = DEFAULT_PALETTE_SIZE,
  colorUniverse: readonly Session[] = sessions,
): ProjectGrouping {
  const byProject = new Map<string, Draft>();
  const ungrouped: Session[] = [];

  for (const session of sessions) {
    const key = projectKey(session);
    if (key === null) {
      ungrouped.push(session);
      continue;
    }
    const existing = byProject.get(key);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    const path = normalizeProjectPath(session.projectPath);
    const host = hostOf(session);
    const name = segmentsOf(path).at(-1) ?? path;
    byProject.set(key, {
      key,
      path,
      launchPath: session.projectPath,
      host,
      base: host === 'localhost' ? name : `${name}@${host}`,
      sessions: [session],
    });
  }

  const drafts = [...byProject.values()];
  drafts.sort((a, b) => byKey(a.base.toLowerCase(), b.base.toLowerCase()) || byKey(a.key, b.key));

  const labels = disambiguate(drafts);

  const colorKeys = new Set<string>(drafts.map((d) => d.key));
  for (const s of colorUniverse) {
    const key = projectKey(s);
    if (key) colorKeys.add(key);
  }
  const colors = assignColors(colorKeys, paletteSize);

  const groups = drafts.map((d): ProjectGroup => ({
    key: d.key,
    path: d.path,
    launchPath: d.launchPath,
    host: d.host,
    local: d.host === 'localhost',
    label: labels.get(d.key) ?? d.base,
    colorIndex: colors.get(d.key) ?? projectColorIndex(d.key, paletteSize),
    sessions: d.sessions,
  }));

  return { groups, ungrouped };
}
