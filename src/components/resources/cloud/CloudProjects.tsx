/**
 * CloudProjects — RESOURCES → Projects (AASC-63; one list since Oct 29 2026): every project folder
 * on this Mac, most used first (the /known-projects order), then the saved projects that are not
 * on this Mac. A saved project is its GitHub repository (name, link, branch) with a ♥ and tags,
 * all in AASC Cloud, so every device on the account lists it; its files move through GitHub with
 * the account chosen for it here (the GitHub CLI's: AASC never sees a token). A checkout already
 * on a device links itself. Each row says where its project stands and offers one action.
 *
 * The tab reads everything again each time it is shown. Each saved checkout here is then read and
 * checked with GitHub in the background (useProjectReads.ts), and ♥ and tag changes go to the cloud
 * one at a time per project (useProjectMeta.ts).
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  GithubAccounts,
  LocalProject,
  ProjectFolders,
  ProjectMeta,
  ProjectMetaChange,
  ProjectRecord,
} from '@/types/cloudProjects';
import type { CloudJob as Job } from '@/types/cloudResources';
import type { CloudReviewBinding } from '@/lib/cloudApi';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount } from '@/lib/cloudFormat';
import { useUiStore } from '@/stores/uiStore';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import TextInput from '@/components/ui/TextInput';
import CloudDialog from './CloudDialog';
import CloudJob from './CloudJob';
import CloudProjectRow, { OWN_SIGN_IN_MIDDLE } from './CloudProjectRow';
import CloudProjectSave from './CloudProjectSave';
import ProjectFilterBar from './ProjectFilterBar';
import ProjectFolderRow from './ProjectFolderRow';
import {
  buildProjectRows,
  filterProjectRows,
  mergeMetas,
  newerMeta,
  projectTagChoices,
  withPendingMeta,
  type ProjectFilter,
} from './projectList';
import type { SaveChoice } from './projectState';
import { useProjectMeta } from './useProjectMeta';
import { useProjectReads } from './useProjectReads';
import { cloudError, useCloudAction, useCloudSession } from './cloudSession';
import { cacheKey, readCache, writeCache, rememberJob, type SavedJob } from './cloudCache';
import styles from '@/styles/modules/CloudResources.module.css';

const ACTIVE: Job['state'][] = ['queued', 'running'];
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_PAGES = 20;
const NO_FILTER: ProjectFilter = { query: '', favOnly: false, tags: [] };
const parentOf = (path: string) =>
  path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'), 1));

async function allProjects(b: CloudReviewBinding, s: AbortSignal) {
  const items: ProjectRecord[] = [];
  let cursor: string | null = null;
  for (let n = 0; n < MAX_PAGES; n++) {
    const page = await cloudApi.listProjects(b, cursor ? { cursor } : {}, s);
    items.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return items.filter((p) => !p.deleted);
}

/** What the tab last read for one account. */
interface Loaded {
  key: string;
  projects: ProjectRecord[];
  folders: ProjectFolders | null;
  metas: Record<string, ProjectMeta>;
  /** AASC Cloud keeps project ♥ and tags (it has since its Oct 29 2026 update). */
  metaAvailable: boolean;
  stale: boolean;
}
const EMPTY: Loaded = {
  key: '',
  projects: [],
  folders: null,
  metas: {},
  metaAvailable: false,
  stale: true,
};
const metaIndex = (items: readonly ProjectMeta[]) =>
  Object.fromEntries(items.map((m) => [m.projectId, m]));

export default function CloudProjects({ visible = true }: { visible?: boolean }) {
  const session = useCloudSession(),
    action = useCloudAction(),
    key = cacheKey(session.status.connection),
    activityId = useId();
  const [page, setPage] = useState<Loaded>(EMPTY),
    [accounts, setAccounts] = useState<GithubAccounts | null>(null),
    [metaError, setMetaError] = useState<string | null>(null),
    [jobs, setJobs] = useState<{ key: string; rows: SavedJob[] }>({ key: '', rows: [] }),
    [running, setRunning] = useState<string[]>([]),
    [adding, setAdding] = useState(false),
    [cloning, setCloning] = useState<{
      project: ProjectRecord;
      parent: string;
      name: string;
    } | null>(null),
    [filter, setFilter] = useState<ProjectFilter>(NO_FILTER),
    [activityOpen, setActivityOpen] = useState(false);
  // Cards (the default) or rows, remembered in this browser.
  const layout = useUiStore((s) => s.projectViewMode),
    setLayout = useUiStore((s) => s.setProjectViewMode);
  const watching = useRef(new Set<string>());
  /** Projects with a running Clone, Pull or Push: the tab's checks pass them by. */
  const workingRef = useRef<ReadonlySet<string>>(new Set());
  const reads = useProjectReads(() => workingRef.current),
    locals = reads.locals;
  const metaSync = useProjectMeta({
    isCurrent: (epoch) => session.current() === epoch,
    onAnswer: (id, meta) =>
      setPage((old) =>
        old.key !== key ? old : { ...old, metas: { ...old.metas, [id]: newerMeta(old.metas[id], meta)! } },
      ),
    onError: (message) => action.setError(message),
  });
  const wasVisible = useRef(visible);
  if (!visible && (adding || cloning)) {
    setAdding(false);
    setCloning(null);
  }
  const view = page.key === key ? page : EMPTY;
  const savedJobs = useMemo(() => (jobs.key === key ? jobs.rows : []), [jobs, key]);
  const connected = session.status.state === 'connected' && !session.changed;
  /** The latest `connected`: a read made offline never lands once the cloud is back. */
  const connectedRef = useRef(connected);

  function load() {
    action.run(
      async (b, s) => {
        const [list, folders, gh, meta] = await Promise.all([
          allProjects(b, s),
          cloudApi.projectFolders(b, s),
          cloudApi.githubAccounts(b, s),
          // ♥ and tags are extra: the list still loads when they can't be read.
          cloudApi.projectMeta(b, s).catch((err: unknown) => {
            if (s.aborted) throw err;
            return cloudError(err);
          }),
        ]);
        return { list, folders, gh, meta, b };
      },
      ({ list, folders, gh, meta, b }) => {
        const metas = typeof meta === 'string' ? null : meta;
        const loaded = metaIndex(metas?.items ?? []);
        setPage((old) => ({
          key,
          projects: list,
          folders,
          // A list read before a ♥ or tag change landed does not undo it.
          metas: old.key === key ? mergeMetas(old.metas, loaded) : loaded,
          metaAvailable: metas?.available ?? false,
          stale: false,
        }));
        setMetaError(typeof meta === 'string' ? meta : null);
        setAccounts(gh);
        writeCache(key, {
          projects: list,
          projectFolders: folders,
          ...(metas ? { projectMeta: metas } : {}),
          savedAt: Date.now(),
        });
        reads.readAll(list, b, { check: true });
      },
    );
  }
  /**
   * Not connected (offline, signed out, or changed in another window): this Mac's folders still
   * list, read without the cloud, and while the connection is still this browser's the cached
   * saved projects' checkouts are read too (Git on this Mac), with no GitHub check.
   */
  function loadHere(projects: readonly ProjectRecord[]) {
    const binding = session.changed ? null : session.status.connection;
    action.run(
      (_unbound, s) => cloudApi.projectFolders(null, s),
      (folders) => {
        setPage((old) => (old.key === key ? { ...old, folders } : old));
        if (binding) reads.readAll(projects, binding, { check: false });
      },
      true,
      () => !connectedRef.current,
    );
  }
  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      reads.reset();
      metaSync.reset();
      const cached = readCache(key);
      const projects = cached.projects.filter((p) => !p.deleted);
      setPage({
        key,
        projects,
        folders: cached.projectFolders ?? null,
        metas: metaIndex(cached.projectMeta?.items ?? []),
        metaAvailable: cached.projectMeta?.available ?? false,
        stale: true,
      });
      setJobs({ key, rows: cached.jobs.filter((j) => j.projectId) });
      if (key && connected) load();
      else loadHere(projects);
    });
    return () => {
      cancelled = true;
    };
    // An account transition, or the cloud going or coming back, reloads the list only, never a
    // running job (there is no Refresh button).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.epoch, connected]);
  // Shown again: read it all again (new folders, what other devices saved). No Refresh button.
  useEffect(() => {
    const shown = visible && !wasVisible.current;
    wasVisible.current = visible;
    if (!shown) return;
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (key && connected) load();
      else loadHere(view.projects);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  const workingIds = useMemo(
    () =>
      new Set(savedJobs.filter((j) => running.includes(j.job.id)).map((j) => j.projectId ?? '')),
    [savedJobs, running],
  );
  useEffect(() => {
    workingRef.current = workingIds;
  }, [workingIds]);

  /** A row's own action on its checkout: its answer outranks any read or check before it. */
  const ownAction = (id: string, work: (b: CloudReviewBinding, s: AbortSignal) => Promise<LocalProject>) =>
    action.run(work, reads.mine(id));
  const refreshLocal = (id: string) => ownAction(id, (b, s) => cloudApi.localProject(id, b, s));
  function started(job: Job, projectId: string) {
    const generation = session.status.connection!.generation;
    setJobs((prev) => ({
      key,
      rows: [{ job, generation, projectId }, ...prev.rows.filter((j) => j.job.id !== job.id)],
    }));
    rememberJob(key, job, generation, projectId);
    if (ACTIVE.includes(job.state)) {
      watching.current.add(job.id);
      setRunning([...watching.current]);
    } else refreshLocal(projectId);
  }
  function jobChanged(next: Job, row: SavedJob) {
    setJobs((prev) => ({
      ...prev,
      rows: prev.rows.map((r) => (r.job.id === next.id ? { ...r, job: next } : r)),
    }));
    rememberJob(key, next, row.generation, row.projectId);
    // A ref, not the rendered list: two jobs can end in one render (see CloudResources).
    if (!ACTIVE.includes(next.state) && watching.current.delete(next.id)) {
      setRunning([...watching.current]);
      if (row.projectId) refreshLocal(row.projectId);
    }
  }
  /** Save one repository's basic information; a folder it came from is linked here. */
  function save(choice: SaveChoice, done?: () => void) {
    const value: ProjectRecord = {
      id: crypto.randomUUID(),
      version: 1,
      name: choice.repository.name,
      repository: choice.repository,
      description: '',
      resources: [],
      deleted: false,
    };
    action.run(
      (b, s) =>
        cloudApi.saveProject(
          { mutationId: crypto.randomUUID(), baseVersion: null, value },
          b,
          s,
          choice.localPath,
        ),
      () => {
        done?.();
        load();
      },
    );
  }
  /** ♥ and tags change on the row at once; a refusal takes the change back out and says why. */
  function changeMeta(id: string, change: ProjectMetaChange) {
    const binding = session.status.connection;
    if (!binding || !action.enabled) return;
    metaSync.change(id, change, binding, session.epoch);
  }
  function openClone(project: ProjectRecord) {
    const near =
      Object.values(locals).find((l) => l.path)?.path ?? view.folders?.items[0]?.path ?? null;
    setCloning({
      project,
      parent: near ? parentOf(near) : (view.folders?.home ?? ''),
      name: project.repository.name,
    });
  }

  const metas = useMemo(
    () => withPendingMeta(view.metas, metaSync.pending),
    [view.metas, metaSync.pending],
  );
  const rows = useMemo(
    () =>
      buildProjectRows({
        folders: view.folders?.items ?? [],
        projects: view.projects,
        locals,
        metas,
      }),
    [view, locals, metas],
  );
  // How many folders here stand for each saved project that isn't linked yet.
  const unlinked = useMemo(() => {
    const count = new Map<string, number>();
    for (const r of rows)
      if (r.kind === 'folder' && r.state === 'unlinked' && r.project)
        count.set(r.project.id, (count.get(r.project.id) ?? 0) + 1);
    return count;
  }, [rows]);
  const active = view.metaAvailable ? filter : { ...filter, favOnly: false, tags: [] };
  const shown = filterProjectRows(rows, active);
  const tagChoices = projectTagChoices(rows);
  const filtering = active.query.trim() !== '' || active.favOnly || active.tags.length > 0;
  const runningFor = (id: string) =>
    savedJobs.filter((j) => j.projectId === id && running.includes(j.job.id));
  const history = savedJobs.filter((j) => !running.includes(j.job.id));
  const off = !action.enabled || action.busy || view.stale;
  const signedIn = (accounts?.accounts ?? []).filter((a) => a.ok);
  const home = view.folders?.home ?? null;
  const checkoutOf = (id: string | undefined) => (id ? (locals[id]?.path ?? null) : null);
  // The folders are read live even offline; the saved projects then come from the last visit.
  const staleNote = [
    view.stale && view.projects.length > 0 && 'Saved projects are from this browser’s last visit.',
    !connected && 'Connect to AASC Cloud to save, clone, pull or push.',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <SectionHeader
        label="Projects"
        count={rows.length}
        countLabel={cloudCount(rows.length, 'project')}
        aside={filtering ? `${shown.length} shown` : undefined}
      />
      <ProjectFilterBar
        empty={rows.length === 0}
        query={filter.query}
        onQuery={(query) => setFilter((f) => ({ ...f, query }))}
        withMeta={view.metaAvailable}
        favOnly={filter.favOnly}
        onFav={() => setFilter((f) => ({ ...f, favOnly: !f.favOnly }))}
        tags={active.tags}
        tagChoices={tagChoices}
        onTag={(tag) =>
          setFilter((f) => ({
            ...f,
            tags: f.tags.includes(tag) ? f.tags.filter((t) => t !== tag) : [...f.tags, tag],
          }))
        }
        onClearTags={() => setFilter((f) => ({ ...f, tags: [] }))}
        view={layout}
        onView={setLayout}
      >
        <Button disabled={!action.enabled || action.busy} onClick={() => setAdding(true)}>
          Add a GitHub link
        </Button>
      </ProjectFilterBar>
      {rows.length > 0 && !action.busy && staleNote && <StaleNote>{staleNote}</StaleNote>}
      {action.error && !adding && !cloning && (
        <div role="alert" className={styles.error}>
          {action.error}
        </div>
      )}
      {!rows.length &&
        (action.busy || (view.folders === null && !action.error) ? (
          <EmptyState compact busy title="Loading projects…" />
        ) : view.folders === null ? (
          <EmptyState compact title="This Mac’s project folders couldn’t be read." />
        ) : (
          <EmptyState
            compact
            title="No projects on this Mac yet."
            hint="Folders where you run Claude Code or Codex show here, most used first. Add a GitHub link to save a repository that isn’t on this Mac."
          />
        ))}
      {rows.length > 0 && !shown.length && (
        <EmptyState
          compact
          title="No projects match."
          action={
            <Button size="sm" onClick={() => setFilter(NO_FILTER)}>
              Clear filters
            </Button>
          }
        />
      )}
      {shown.length > 0 && (
        <ul
          className={`${styles.syncList} ${layout === 'card' ? styles.projectCards : styles.projectList}`}
          aria-label="Projects"
        >
          {shown.map((row) =>
            row.kind === 'folder' ? (
              <ProjectFolderRow
                key={row.key}
                layout={layout}
                row={row}
                home={home}
                favColumn={view.metaAvailable}
                linkedPath={checkoutOf(row.project?.id)}
                alike={row.project ? (unlinked.get(row.project.id) ?? 0) : 0}
                disabled={off}
                onFav={(favorite) => row.project && changeMeta(row.project.id, { favorite })}
                onSave={() =>
                  row.folder.repository &&
                  save({ repository: row.folder.repository, localPath: row.folder.path })
                }
                onLink={() =>
                  row.project &&
                  ownAction(row.project.id, (b, s) =>
                    cloudApi.associateProject(row.project!.id, row.folder.path, b, s),
                  )
                }
              />
            ) : (
              <CloudProjectRow
                key={row.key}
                layout={layout}
                project={row.project}
                path={row.path}
                lastActivityAt={row.lastActivityAt}
                home={home}
                local={locals[row.project.id]}
                meta={row.meta}
                metaAvailable={view.metaAvailable}
                tagSuggestions={tagChoices.map((t) => t.tag)}
                accounts={accounts}
                disabled={off}
                working={runningFor(row.project.id).length > 0}
                checking={
                  reads.checking === row.project.id ||
                  ((action.busy || reads.reading.has(row.project.id)) && !locals[row.project.id])
                }
                checkError={reads.errors[row.project.id]}
                onFav={(favorite) => changeMeta(row.project.id, { favorite })}
                onAddTag={(tag) => changeMeta(row.project.id, { addTags: [tag] })}
                onRemoveTag={(tag) => changeMeta(row.project.id, { removeTags: [tag] })}
                onClone={() => openClone(row.project)}
                onPull={() =>
                  action.run(
                    (b, s) => cloudApi.pullProject(row.project.id, b, s),
                    (j) => started(j, row.project.id),
                  )
                }
                onPush={() =>
                  action.run(
                    (b, s) => cloudApi.pushProject(row.project.id, b, s),
                    (j) => started(j, row.project.id),
                  )
                }
                onCheck={() =>
                  ownAction(row.project.id, (b, s) => cloudApi.checkProject(row.project.id, b, s))
                }
                onAccount={(login) =>
                  ownAction(row.project.id, (b, s) =>
                    cloudApi.setProjectAccount(row.project.id, login, b, s),
                  )
                }
                onRemove={() =>
                  action.run(
                    (b, s) => cloudApi.removeProject(row.project.id, b, s),
                    () =>
                      setPage((old) => ({
                        ...old,
                        projects: old.projects.filter((x) => x.id !== row.project.id),
                      })),
                  )
                }
              >
                {runningFor(row.project.id).map((j) => (
                  <CloudJob
                    key={j.job.id}
                    job={j.job}
                    owned={j.generation === session.status.connection?.generation}
                    openUrl={locals[row.project.id]?.openUrl}
                    onChange={(next) => jobChanged(next, j)}
                  />
                ))}
              </CloudProjectRow>
            ),
          )}
        </ul>
      )}
      <div className={styles.accounts}>
        {accounts && !accounts.installed ? (
          <p className={styles.hint}>
            Install the GitHub CLI to clone, pull and push with your GitHub accounts: run{' '}
            <code>brew install gh</code>, then <code>gh auth login</code>. Until then projects use{' '}
            {OWN_SIGN_IN_MIDDLE}.
          </p>
        ) : (
          accounts && (
            <p className={styles.hint}>
              GitHub on this Mac: {signedIn.length === 0 && 'no account signed in'}
              {signedIn.map((a, i) => (
                <Fragment key={a.login}>
                  {i > 0 && ', '}
                  <span className={styles.accountName}>
                    {a.login}
                    {a.active ? ' (active)' : ''}
                  </span>
                </Fragment>
              ))}
              . To add one, run <code>gh auth login</code> in a terminal, then come back to this
              tab. The GitHub CLI keeps the tokens; AASC only sees the account names.
            </p>
          )
        )}
        {!view.stale && !view.metaAvailable && (
          <p className={styles.hint}>
            {metaError
              ? `Favourites and tags couldn’t be read: ${metaError}`
              : 'Favourites and tags need an AASC Cloud update.'}
          </p>
        )}
      </div>
      <SectionHeader
        label="Activity"
        count={history.length}
        countLabel={cloudCount(history.length, 'past job')}
        collapsed={!activityOpen}
        onToggle={() => setActivityOpen((open) => !open)}
        controls={activityId}
      />
      <div id={activityId} hidden={!activityOpen}>
        {!history.length && (
          <p className={styles.hint}>No clones, pulls or pushes in this browser yet.</p>
        )}
        {history.map((j) => (
          <CloudJob
            key={j.job.id}
            job={j.job}
            owned={j.generation === session.status.connection?.generation}
            onChange={(next) => jobChanged(next, j)}
          />
        ))}
      </div>
      {adding && (
        <CloudDialog
          returnFocus={action.origin.current}
          title="Add a GitHub link"
          onClose={() => setAdding(false)}
        >
          <CloudProjectSave
            busy={action.busy}
            disabled={!action.enabled}
            onSave={(choice) => save(choice, () => setAdding(false))}
            onClose={() => setAdding(false)}
          />
          {action.error && (
            <div role="alert" className={styles.error}>
              {action.error}
            </div>
          )}
        </CloudDialog>
      )}
      {cloning && (
        <CloudDialog
          returnFocus={action.origin.current}
          title={`Clone ${cloning.project.repository.name}`}
          onClose={() => setCloning(null)}
        >
          <p className={styles.hint}>
            Clones github.com/{cloning.project.repository.owner}/{cloning.project.repository.name} (
            {cloning.project.repository.branch}) with{' '}
            {locals[cloning.project.id]?.account ?? OWN_SIGN_IN_MIDDLE}.
          </p>
          <div className={styles.form}>
            <Field label="Into this folder">
              <TextInput
                value={cloning.parent}
                placeholder="/Users/you/code"
                onChange={(e) => setCloning({ ...cloning, parent: e.target.value })}
              />
            </Field>
            <Field label="Folder name">
              <TextInput
                value={cloning.name}
                onChange={(e) => setCloning({ ...cloning, name: e.target.value })}
              />
            </Field>
          </div>
          {cloning.name && !FOLDER_NAME.test(cloning.name) && (
            <div className={styles.error} role="alert">
              Use letters, digits, dots, dashes or underscores, starting with a letter or digit.
            </div>
          )}
          <div className={styles.toolbar}>
            <Button
              variant="primary"
              disabled={
                !action.enabled ||
                action.busy ||
                !cloning.parent.trim() ||
                !FOLDER_NAME.test(cloning.name)
              }
              onClick={() => {
                const { project, parent, name } = cloning;
                action.run(
                  (b, s) =>
                    cloudApi.getProject(
                      project.id,
                      { parentPath: parent.trim(), directoryName: name },
                      b,
                      s,
                    ),
                  (job) => {
                    setCloning(null);
                    started(job, project.id);
                  },
                );
              }}
            >
              Clone
            </Button>
            <Button onClick={() => setCloning(null)}>Cancel</Button>
          </div>
          {action.error && (
            <div role="alert" className={styles.error}>
              {action.error}
            </div>
          )}
        </CloudDialog>
      )}
    </>
  );
}
