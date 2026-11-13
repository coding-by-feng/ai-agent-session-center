/**
 * Project Sync pulls (Nov 13 2026): copy folders or files from anywhere inside a saved server's
 * home into a project here, without linking them. Plan → start → poll, like a run, but kept in
 * memory only. Files already here stay unless the pull replaces them; each picked folder (and the
 * picked files together) is one part with its own undo journal on this computer.
 */
import { randomUUID } from 'crypto';
import { posix } from 'path';
import { isCredentialPath } from '../fsSafe.js';
import log from '../logger.js';
import { applyOrder, pointsOutside, sameContent, type ManifestEntry } from './classify.js';
import { clean, SyncError } from './errors.js';
import {
  applyOps,
  listDir,
  openExport,
  readManifest,
  undoRun,
  type Exporter,
  type Launcher,
} from './helperClient.js';
import { ensureRoom, purgeJournals } from './remoteFolders.js';
import { guardFold, isGitName, isPrivateName, validRemoteRoot } from './servers.js';
import {
  DEFAULT_SYNC_EXCLUDES,
  type FileMeta,
  type SyncDevice,
  type SyncEntry,
  type SyncPull,
  type SyncPullInput,
} from '../../src/types/projectSync.js';

/** The journal folder every pull's parts share on this computer (`~/.aasc-project-sync/<id>`). */
export const PULL_JOURNAL_ID = '00000000-0000-4000-8000-00000000b011';
const PULLS_KEPT = 10;
const PLAN_TTL_MS = 30 * 60_000;
const MAX_SOURCES = 50;
/** Plans waiting to start, across all projects (each project and server keeps one). */
const PLANS_KEPT = 10;

export interface PullDeps {
  launchLocal: Launcher;
  launchDevice: (d: SyncDevice) => Launcher;
  deviceOf: (id: string) => Promise<SyncDevice>;
  /** Refuses a server whose trusted host keys changed. */
  check: (d: SyncDevice) => Promise<void>;
  /** A catalog project's real folder (inside home) and its display path. */
  projectRoot: (projectId: string) => Promise<{ root: string; display: string }>;
  /** Takes the one compare/run/undo slot, or throws that something else holds it. */
  claim: (id: string) => void;
  release: (id: string) => void;
  spaceOf: (launch: Launcher, path: string) => Promise<number | null>;
  journalMinAgeMs?: number;
}

/** One helper pass: a picked folder, or the picked files of one folder. */
interface Part {
  /** Server folder the files are read from. */
  root: string;
  /** Files only: their names in `root`. */
  only?: string[];
  /** Absolute folder here they land in. */
  dest: string;
  runId: string;
  entries: SyncEntry[];
  held: Map<string, FileMeta>;
}
interface Held {
  pull: SyncPull;
  parts: Part[];
  device: SyncDevice;
  cancelled: boolean;
}

const meta = (m: ManifestEntry): FileMeta => {
  const { text: _text, ...rest } = m;
  return rest;
};
/** What git reads as a pointer to its folder, or a link inside it: never written here. */
const gitRedirect = (path: string, m: FileMeta) => {
  const parts = path.split('/').map(guardFold);
  return (
    (parts[parts.length - 1] === '.git' && m.kind !== 'dir') ||
    (m.kind === 'symlink' && parts.slice(0, -1).includes('.git'))
  );
};
const GIT_CONFIG_RE = /(?:^|\/)\.git\/(?:.+\/)?config$/;
/**
 * A name a Mac reads as git's folder or git's config without being spelled so (a Linux server's
 * `.GIT/HEAD`, `.git/Config`): the helper refuses to write it, so the plan skips it.
 */
const oddGitName = (path: string) =>
  path.split('/').some((x) => x !== '.git' && isGitName(x)) ||
  (GIT_CONFIG_RE.test(guardFold(path)) && !GIT_CONFIG_RE.test(path));

/** `into` as typed: '' or a relative folder path with no `..`, `.git` or odd characters. */
function intoPath(into: string | undefined): string {
  const v = (into ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!v) return '';
  const segs = v.split('/');
  if (
    v.length > 1024 ||
    /[\x00-\x1f\\]/.test(v) ||
    segs.some((s) => !s || s === '.' || s === '..' || isGitName(s))
  )
    throw new SyncError('Use a subfolder path inside the project, like imports/data.', 400);
  return segs.join('/');
}

export function createPulls(deps: PullDeps) {
  const pulls = new Map<string, Held>();
  const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  const held = (id: string) => {
    const h = pulls.get(id);
    if (!h) throw new SyncError('Pull not found.', 404);
    return h;
  };
  /** Drops plans nobody started (old ones, past the cap), and all but the newest finished pulls. */
  const tidy = () => {
    const now = Date.now();
    for (const [id, h] of pulls)
      if (h.pull.state === 'planned' && now - h.pull.createdAt > PLAN_TTL_MS) pulls.delete(id);
    const plans = [...pulls.values()]
      .filter((h) => h.pull.state === 'planned')
      .sort((a, b) => b.pull.createdAt - a.pull.createdAt);
    for (const h of plans.slice(PLANS_KEPT)) pulls.delete(h.pull.id);
    const finished = [...pulls.values()]
      .filter((h) => h.pull.state !== 'planned' && h.pull.state !== 'running')
      .sort((a, b) => b.pull.createdAt - a.pull.createdAt);
    for (const h of finished.slice(PULLS_KEPT)) pulls.delete(h.pull.id);
  };

  /** Which kind each source is, read from its folder on the server. */
  async function kindsOf(launch: Launcher, sources: string[]) {
    const kinds = new Map<string, string>();
    const unlisted: string[] = [];
    for (const parent of new Set(sources.map((s) => posix.dirname(s)))) {
      let listing: Awaited<ReturnType<typeof listDir>>;
      try {
        listing = await listDir(launch, parent);
      } catch (e) {
        throw new SyncError(clean(e));
      }
      for (const e of listing.entries) kinds.set(posix.join(parent, e.name), e.kind);
      if (listing.truncated)
        unlisted.push(...sources.filter((s) => posix.dirname(s) === parent && !kinds.has(s)));
    }
    // Past the listing's cut: a folder lists, anything else is "not a folder" (a file; a link
    // or special file is skipped when its folder is read).
    for (const s of unlisted) {
      try {
        if (!(await listDir(launch, s)).missing) kinds.set(s, 'dir');
      } catch (e) {
        if (!/not a folder/.test(clean(e))) throw new SyncError(clean(e));
        kinds.set(s, 'file');
      }
    }
    return kinds;
  }

  function partsOf(sources: string[], kinds: Map<string, string>, home: string, dest: string) {
    const parts: Omit<Part, 'entries' | 'held'>[] = [];
    const files = new Map<string, string[]>();
    for (const s of sources) {
      const kind = kinds.get(s);
      const name = posix.basename(s);
      if (!kind) throw new SyncError(`${s} does not exist on the server.`);
      if (kind === 'dir')
        parts.push({ root: s, dest: posix.join(dest, name), runId: randomUUID() });
      else if (kind === 'file') {
        if (posix.dirname(s) === home)
          throw new SyncError(
            `Files directly in the home folder can't be pulled (${name}). Pull the folder that holds it, or move it into one.`,
          );
        files.set(posix.dirname(s), [...(files.get(posix.dirname(s)) ?? []), name]);
      } else
        throw new SyncError(`${name} is a link or special file. Pick the folder it points to.`);
    }
    for (const [root, only] of files) parts.push({ root, only, dest, runId: randomUUID() });
    return parts;
  }

  /** The plan of one part: what each server path does here. */
  function planPart(
    device: Map<string, ManifestEntry>,
    local: Map<string, ManifestEntry>,
    replace: boolean,
    pull: SyncPull,
    tally: Tally,
  ): { entries: SyncEntry[]; held: Map<string, FileMeta> } {
    const entries: SyncEntry[] = [];
    for (const path of [...device.keys()].sort()) {
      const R = meta(device.get(path)!);
      const L = local.has(path) ? meta(local.get(path)!) : undefined;
      let action: SyncEntry['action'] = 'pull';
      const segs = path.split('/');
      if (segs.some(isPrivateName)) {
        // A credential folder inside a picked folder is never copied, nor anything in it.
        action = 'skip';
        pull.counts.skip++;
        if (isPrivateName(segs[segs.length - 1])) tally.privateDirs++;
      } else if (
        R.kind === 'other' ||
        gitRedirect(path, R) ||
        oddGitName(path) ||
        pointsOutside(path, R)
      ) {
        action = 'skip';
        pull.counts.skip++;
        if (pointsOutside(path, R)) tally.outside++;
      } else if (L && (sameContent(L, R) || (L.kind === 'dir' && R.kind === 'dir'))) {
        action = 'skip';
        pull.counts.same++;
      } else if (L && (!replace || L.kind !== R.kind || L.kind === 'dir')) {
        action = 'keep';
        pull.counts.keep++;
      } else if (L) pull.counts.replace++;
      else pull.counts.new++;
      if (action === 'pull') {
        if (R.kind === 'file') pull.bytes.toGet += R.size;
        if (R.kind === 'file' && R.mode & 0o111 && !(L?.kind === 'file' && L.mode & 0o111))
          tally.executable++;
        if (GIT_CONFIG_RE.test(guardFold(path))) tally.gitConfig++;
        if (isCredentialPath(path)) tally.credentials++;
      }
      entries.push({
        id: randomUUID(),
        path,
        groupId: '',
        change: L ? 'different' : 'extra',
        action,
        device: R,
        ...(L ? { local: L } : {}),
        flags: [],
        state: action === 'pull' ? 'pending' : 'skipped',
      });
    }
    const heldHere = new Map<string, FileMeta>();
    for (const [p, m] of local) heldHere.set(p, meta(m));
    return { entries, held: heldHere };
  }

  async function planPull(input: SyncPullInput): Promise<SyncPull> {
    tidy();
    const sources = [...new Set(input.sources)];
    if (!sources.length)
      throw new SyncError('Pick at least one folder or file on the server.', 400);
    if (sources.length > MAX_SOURCES)
      throw new SyncError(`Pick at most ${MAX_SOURCES} items at a time.`, 400);
    const into = intoPath(input.into);
    const project = await deps.projectRoot(input.projectId);
    const d = await deps.deviceOf(input.deviceId);
    for (const s of sources) {
      const bad = validRemoteRoot(s, d.home);
      if (bad) throw new SyncError(bad, 400);
    }
    const names = new Set<string>();
    for (const s of sources) {
      const name = posix.basename(s);
      if (isGitName(name))
        throw new SyncError(
          'A .git folder can’t be pulled: it holds git’s hooks and settings.',
          400,
        );
      if (names.has(name)) throw new SyncError(`Two picked items are both named "${name}".`, 400);
      names.add(name);
    }
    await deps.check(d);
    const id = randomUUID();
    deps.claim(id);
    try {
      const launch = deps.launchDevice(d);
      const dest = into ? posix.join(project.root, into) : project.root;
      const parts = partsOf(sources, await kindsOf(launch, sources), d.home, dest);
      const now = Date.now();
      const pull: SyncPull = {
        id,
        deviceId: d.id,
        projectId: input.projectId,
        sources,
        into,
        dest: into ? `${project.display}/${into}` : project.display,
        replace: input.replace === true,
        state: 'planned',
        counts: { new: 0, replace: 0, keep: 0, same: 0, skip: 0 },
        total: 0,
        done: 0,
        failed: 0,
        bytes: { toGet: 0, got: 0 },
        warnings: [],
        createdAt: now,
        updatedAt: now,
      };
      const tally: Tally = {
        outside: 0,
        executable: 0,
        gitConfig: 0,
        credentials: 0,
        privateDirs: 0,
      };
      const planned: Part[] = [];
      for (const part of parts) {
        const req = { excludes: [...DEFAULT_SYNC_EXCLUDES], base: new Map(), only: part.only };
        const [R, L] = await Promise.all([
          readManifest(launch, { ...req, root: part.root, inHome: true }),
          readManifest(deps.launchLocal, { ...req, root: part.dest }).catch((e) => {
            throw new SyncError(
              /not a folder/.test(clean(e))
                ? `${part.dest} is a file here, so the folder can't land there.`
                : clean(e),
            );
          }),
        ]);
        planned.push({ ...part, ...planPart(R.manifest, L.manifest, pull.replace, pull, tally) });
      }
      pull.total = planned.reduce(
        (n, p) => n + p.entries.filter((e) => e.action === 'pull').length,
        0,
      );
      pull.warnings = warningsOf(tally);
      // A new plan for the same project and server replaces the one waiting before it.
      for (const [other, h] of pulls)
        if (
          h.pull.state === 'planned' &&
          h.pull.projectId === pull.projectId &&
          h.pull.deviceId === pull.deviceId
        )
          pulls.delete(other);
      pulls.set(id, { pull, parts: planned, device: d, cancelled: false });
      return copy(pull);
    } catch (e) {
      throw e instanceof SyncError ? e : new SyncError(clean(e));
    } finally {
      deps.release(id);
    }
  }

  async function startPull(id: string): Promise<SyncPull> {
    const h = held(id);
    if (h.pull.state !== 'planned')
      throw new SyncError('This pull already ran. Plan it again to pull once more.');
    await deps.check(h.device);
    // Another start (or a newer plan) may have moved on while the host key was checked.
    if (pulls.get(id) !== h || h.pull.state !== 'planned')
      throw new SyncError('This pull already ran. Plan it again to pull once more.');
    deps.claim(id);
    let launched = false;
    try {
      const dest = h.parts[0]?.dest ?? '';
      await ensureRoom(deps.spaceOf, deps.launchLocal, dest, h.pull.bytes.toGet, 'this computer');
      h.pull.state = 'running';
      h.pull.updatedAt = Date.now();
      launched = true;
      void execute(h).finally(() => {
        deps.release(id);
        tidy();
        const keep = [...pulls.values()].flatMap((x) => x.parts.map((p) => p.runId));
        void purgeJournals(
          [{ launch: deps.launchLocal, side: 'local' }],
          PULL_JOURNAL_ID,
          keep,
          deps.journalMinAgeMs,
        );
      });
      return copy(h.pull);
    } finally {
      if (!launched) deps.release(id);
    }
  }

  /** Carries each part out: the server's helper exports, this computer's applies. Never throws. */
  async function execute(h: Held) {
    const { pull } = h;
    const launch = deps.launchDevice(h.device);
    for (const part of h.parts) {
      const ops = applyOrder(
        part.entries.filter((e) => e.state === 'pending'),
        part.held,
        'local',
      );
      if (!ops.length || h.cancelled) continue;
      const byId = new Map(part.entries.map((e) => [e.id, e]));
      for (const o of ops) byId.get(o.owner)!.state = 'applying';
      let exporter: Exporter | null = null;
      try {
        exporter = await openExport(launch, { root: part.root, inHome: true });
        await applyOps(
          deps.launchLocal,
          { root: part.dest, linkId: PULL_JOURNAL_ID, runId: part.runId, side: 'local' },
          { kind: 'remote', exporter },
          ops,
          {
            cancelled: () => h.cancelled,
            onSent: (n) => (pull.bytes.got += n),
            onAck: (ack) => {
              const e = byId.get(ack.id);
              if (!e) return;
              e.state = ack.state;
              if (ack.error) e.error = clean(new Error(ack.error)).slice(0, 300);
              if (ack.state === 'done') pull.done++;
              if (ack.state === 'failed') pull.failed++;
            },
          },
        );
      } catch (err) {
        pull.error ??= clean(err);
      } finally {
        await exporter?.close().catch(() => {});
      }
      for (const e of part.entries)
        if (e.state === 'applying') {
          e.state = h.cancelled ? 'pending' : 'failed';
          if (!h.cancelled) pull.failed++;
        }
    }
    pull.state = h.cancelled
      ? 'cancelled'
      : pull.failed === 0 && !pull.error
        ? 'complete'
        : pull.done > 0
          ? 'partial'
          : 'failed';
    pull.updatedAt = Date.now();
    if (pull.state !== 'complete')
      log.warn('project-sync', `Pull ${pull.id} ended ${pull.state}: ${pull.error ?? ''}`);
  }

  async function undoPull(id: string): Promise<SyncPull> {
    const h = held(id);
    const { pull } = h;
    if (!['complete', 'partial', 'cancelled', 'failed'].includes(pull.state) || pull.done === 0)
      throw new SyncError('Nothing from this pull changed this computer.');
    deps.claim(id);
    try {
      let restored = 0,
        skipped = 0;
      for (const part of [...h.parts].reverse()) {
        try {
          const r = await undoRun(deps.launchLocal, {
            root: part.dest,
            linkId: PULL_JOURNAL_ID,
            runId: part.runId,
            side: 'local',
          });
          restored += r.restored;
          skipped += r.skipped;
        } catch (e) {
          if (!(e instanceof Error && e.message.startsWith('Nothing to undo')))
            throw new SyncError(`Undo stopped partway: ${clean(e)} Undo again to finish.`);
        }
      }
      pull.state = 'undone';
      pull.updatedAt = Date.now();
      pull.warnings = [
        `Undo put back ${restored} item${restored === 1 ? '' : 's'}${skipped ? `; ${skipped} changed since and were left alone` : ''}.`,
        ...pull.warnings,
      ];
      return copy(pull);
    } finally {
      deps.release(id);
    }
  }

  return {
    planPull,
    startPull,
    getPull: async (id: string) => copy(held(id).pull),
    cancelPull: async (id: string) => {
      const h = held(id);
      if (h.pull.state !== 'running') throw new SyncError('That pull is not running.');
      h.cancelled = true;
      return copy(h.pull);
    },
    undoPull,
  };
}

interface Tally {
  outside: number;
  executable: number;
  gitConfig: number;
  credentials: number;
  privateDirs: number;
}

function warningsOf(t: Tally): string[] {
  const w: string[] = [];
  const n = (k: number, one: string, many: string) =>
    k === 1 ? one : many.replace('#', String(k));
  if (t.outside)
    w.push(
      n(
        t.outside,
        '1 link leads outside the picked folder and is skipped.',
        '# links lead outside the picked folders and are skipped.',
      ),
    );
  if (t.executable)
    w.push(
      n(
        t.executable,
        '1 executable file comes from the server. Check it before you run it.',
        '# executable files come from the server. Check them before you run them.',
      ),
    );
  if (t.gitConfig)
    w.push(
      'A git config file comes from the server. Git reads it on every command here, and it can run programs: check it first.',
    );
  if (t.privateDirs)
    w.push(
      n(
        t.privateDirs,
        '1 credential folder (such as .ssh) is left out.',
        '# credential folders (such as .ssh) are left out.',
      ),
    );
  if (t.credentials)
    w.push(
      n(
        t.credentials,
        '1 credential file (such as .env) comes from the server.',
        '# credential files (such as .env) come from the server.',
      ),
    );
  return w;
}
