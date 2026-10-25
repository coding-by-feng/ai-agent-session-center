/**
 * CloudProjects — RESOURCES → Cloud → Projects (AASC-63). The cloud keeps only each project's
 * GitHub repository (name, link, branch); its files move through GitHub. Every device lists the
 * saved projects and clones, pulls or pushes them with the GitHub account chosen for each here
 * (the GitHub CLI's accounts: AASC never sees a token). A checkout already on a device links
 * itself; nobody picks a folder by hand.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type {
  GithubAccounts,
  LocalProject,
  ProjectCandidate,
  ProjectRecord,
} from '@/types/cloudProjects';
import type { CloudJob as Job } from '@/types/cloudResources';
import type { CloudReviewBinding } from '@/lib/cloudApi';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount } from '@/lib/cloudFormat';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import TextInput from '@/components/ui/TextInput';
import CloudDialog from './CloudDialog';
import CloudJob from './CloudJob';
import CloudProjectRow, { OWN_SIGN_IN } from './CloudProjectRow';
import CloudProjectSave, { type SaveChoice } from './CloudProjectSave';
import { useCloudAction, useCloudSession } from './cloudSession';
import { cacheKey, readCache, writeCache, rememberJob, type SavedJob } from './cloudCache';
import styles from '@/styles/modules/CloudResources.module.css';

const ACTIVE: Job['state'][] = ['queued', 'running'];
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_PAGES = 20;
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

export default function CloudProjects({ visible = true }: { visible?: boolean }) {
  const session = useCloudSession(),
    action = useCloudAction(),
    key = cacheKey(session.status.connection),
    activityId = useId();
  const [page, setPage] = useState<{ key: string; projects: ProjectRecord[]; stale: boolean }>({
      key: '',
      projects: [],
      stale: true,
    }),
    [locals, setLocals] = useState<Record<string, LocalProject>>({}),
    [accounts, setAccounts] = useState<GithubAccounts | null>(null),
    [jobs, setJobs] = useState<{ key: string; rows: SavedJob[] }>({ key: '', rows: [] }),
    [running, setRunning] = useState<string[]>([]),
    [saving, setSaving] = useState<{ candidates: ProjectCandidate[] | null } | null>(null),
    [cloning, setCloning] = useState<{
      project: ProjectRecord;
      parent: string;
      name: string;
    } | null>(null),
    [activityOpen, setActivityOpen] = useState(false);
  const watching = useRef(new Set<string>());
  if (!visible && (saving || cloning)) {
    setSaving(null);
    setCloning(null);
  }
  const projects = page.key === key ? page.projects : [],
    savedJobs = jobs.key === key ? jobs.rows : [];

  function load() {
    action.run(
      async (b, s) => {
        const [list, gh] = await Promise.all([allProjects(b, s), cloudApi.githubAccounts(b, s)]);
        const states: Record<string, LocalProject> = {};
        for (const p of list) states[p.id] = await cloudApi.localProject(p.id, b, s);
        return { list, gh, states };
      },
      ({ list, gh, states }) => {
        setPage({ key, projects: list, stale: false });
        setAccounts(gh);
        setLocals(states);
        writeCache(key, { projects: list, savedAt: Date.now() });
      },
    );
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const cached = readCache(key);
      setPage({ key, projects: cached.projects.filter((p) => !p.deleted), stale: true });
      setJobs({ key, rows: cached.jobs.filter((j) => j.projectId) });
      setLocals({});
      if (key && session.status.state === 'connected' && !session.changed) load();
    });
    return () => {
      cancelled = true;
    };
    // An account transition reloads the list only, never a running job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.epoch]);

  const refreshLocal = (id: string) =>
    action.run(
      (b, s) => cloudApi.localProject(id, b, s),
      (l) => setLocals((old) => ({ ...old, [id]: l })),
    );
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
  function openSave() {
    setSaving({ candidates: null });
    action.run(
      (b, s) => cloudApi.projectCandidates(b, s),
      (c) => setSaving((open) => (open ? { candidates: c.items } : open)),
    );
  }
  function save(choice: SaveChoice) {
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
        setSaving(null);
        load();
      },
    );
  }
  function openClone(project: ProjectRecord) {
    const linked = Object.values(locals).find((l) => l.path)?.path;
    setCloning({ project, parent: linked ? parentOf(linked) : '', name: project.repository.name });
  }
  const runningFor = (id: string) =>
    savedJobs.filter((j) => j.projectId === id && running.includes(j.job.id));
  const history = savedJobs.filter((j) => !running.includes(j.job.id));
  const off = !action.enabled || action.busy || page.stale;
  const signedIn = (accounts?.accounts ?? []).filter((a) => a.ok);
  return (
    <>
      <SectionHeader label="GitHub accounts on this Mac" count={signedIn.length} />
      <div className={styles.accounts}>
        {accounts && !accounts.installed ? (
          <p className={styles.hint}>
            Install the GitHub CLI to clone, pull and push with your GitHub accounts: run{' '}
            <code>brew install gh</code>, then <code>gh auth login</code>. Until then projects use{' '}
            {OWN_SIGN_IN.toLowerCase()}.
          </p>
        ) : (
          <>
            {signedIn.length > 0 && (
              <p className={styles.accountList}>
                {signedIn.map((a) => (
                  <span key={a.login}>
                    {a.login}
                    {a.active ? ' (active)' : ''}
                  </span>
                ))}
              </p>
            )}
            <p className={styles.hint}>
              To add an account, run <code>gh auth login</code> in a terminal (once per account),
              then press Refresh. The GitHub CLI keeps the tokens; AASC only sees the account names.
            </p>
          </>
        )}
      </div>
      <SectionHeader
        label="Saved projects"
        count={projects.length}
        countLabel={cloudCount(projects.length, 'saved project')}
      />
      <div className={styles.toolbar}>
        <Button variant="primary" disabled={!action.enabled || action.busy} onClick={openSave}>
          Save a project
        </Button>
        <Button disabled={!action.enabled || action.busy} onClick={load}>
          Refresh
        </Button>
      </div>
      {projects.length > 0 &&
        !action.busy &&
        (page.stale || session.status.state !== 'connected') && (
          <StaleNote>
            Showing projects saved in this browser. Refresh while connected to clone, pull or push.
          </StaleNote>
        )}
      {action.error && !saving && !cloning && (
        <div role="alert" className={styles.error}>
          {action.error}
        </div>
      )}
      {!projects.length &&
        (action.busy ? (
          <EmptyState compact busy title="Loading projects…" />
        ) : (
          <EmptyState
            compact
            title="No projects saved to cloud yet."
            hint="Save a project from a GitHub folder on this Mac, or paste its GitHub link. Every device can then clone it."
          />
        ))}
      {projects.length > 0 && (
        <ul className={styles.syncList} aria-label="Saved projects">
          {projects.map((p) => (
            <CloudProjectRow
              key={p.id}
              project={p}
              local={locals[p.id]}
              accounts={accounts}
              disabled={off}
              working={runningFor(p.id).length > 0}
              onClone={() => openClone(p)}
              onPull={() =>
                action.run(
                  (b, s) => cloudApi.pullProject(p.id, b, s),
                  (j) => started(j, p.id),
                )
              }
              onPush={() =>
                action.run(
                  (b, s) => cloudApi.pushProject(p.id, b, s),
                  (j) => started(j, p.id),
                )
              }
              onCheck={() =>
                action.run(
                  (b, s) => cloudApi.checkProject(p.id, b, s),
                  (l) => setLocals((old) => ({ ...old, [p.id]: l })),
                )
              }
              onAccount={(login) =>
                action.run(
                  (b, s) => cloudApi.setProjectAccount(p.id, login, b, s),
                  (l) => setLocals((old) => ({ ...old, [p.id]: l })),
                )
              }
              onRemove={() =>
                action.run(
                  (b, s) => cloudApi.removeProject(p.id, b, s),
                  () =>
                    setPage((old) => ({
                      ...old,
                      projects: old.projects.filter((x) => x.id !== p.id),
                    })),
                )
              }
            >
              {runningFor(p.id).map((j) => (
                <CloudJob
                  key={j.job.id}
                  job={j.job}
                  owned={j.generation === session.status.connection?.generation}
                  openUrl={locals[p.id]?.openUrl}
                  onChange={(next) => jobChanged(next, j)}
                />
              ))}
            </CloudProjectRow>
          ))}
        </ul>
      )}
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
      {saving && (
        <CloudDialog
          returnFocus={action.origin.current}
          title="Save a project"
          onClose={() => setSaving(null)}
        >
          <CloudProjectSave
            candidates={saving.candidates}
            loading={!saving.candidates && action.busy}
            busy={action.busy}
            disabled={!action.enabled}
            onSave={save}
            onClose={() => setSaving(null)}
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
            {locals[cloning.project.id]?.account ?? OWN_SIGN_IN.toLowerCase()}.
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
