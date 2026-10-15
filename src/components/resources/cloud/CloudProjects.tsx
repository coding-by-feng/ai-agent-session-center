import { useEffect, useRef, useState } from 'react';
import { canonicalGithub, ProjectRecordSchema, type ProjectRecord } from '@/types/cloudProjects';
import type { ResourceCatalog } from '@/types/resources';
import type {
  CloudJob as Job,
  InstallPlan,
  ResourceRef,
  ResourceVersion,
} from '@/types/cloudResources';
import { cloudApi } from '@/lib/cloudApi';
import { cloudCount } from '@/lib/cloudFormat';
import Button from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonClass';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import TextInput from '@/components/ui/TextInput';
import TextArea from '@/components/ui/TextArea';
import NativeSelect from '@/components/ui/NativeSelect';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import CloudDialog from './CloudDialog';
import CloudReview from './CloudReview';
import CloudJob from './CloudJob';
import { useCloudAction, useCloudSession } from './cloudSession';
import { cacheKey, readCache, writeCache, rememberJob, type SavedJob } from './cloudCache';
import styles from '@/styles/modules/CloudResources.module.css';
type Local = Awaited<ReturnType<typeof cloudApi.localProject>>;
const refKey = (r: ResourceRef) => r.resourceId + ':' + r.version;
const labels: Record<Local['state'], string> = {
  missing: 'Not downloaded',
  ready: 'Ready',
  dirty: 'Local changes',
  diverged: 'Needs attention: local ahead or diverged',
  detached: 'Needs attention: detached HEAD',
  'wrong-remote': 'Needs attention: remote or branch mismatch',
  busy: 'Busy: active session or Git operation',
};
const tones: Record<Local['state'], ChipTone> = {
  missing: 'neutral',
  ready: 'success',
  dirty: 'warning',
  diverged: 'warning',
  detached: 'warning',
  'wrong-remote': 'warning',
  busy: 'info',
};
function newRecord(): ProjectRecord {
  return {
    id: crypto.randomUUID(),
    version: 1,
    name: '',
    repository: { provider: 'github', owner: '', name: '', url: '', branch: 'main' },
    description: '',
    resources: [],
    deleted: false,
  };
}
export default function CloudProjects({
  catalog,
  visible = true,
}: {
  catalog: ResourceCatalog;
  visible?: boolean;
}) {
  const session = useCloudSession(),
    action = useCloudAction(),
    key = cacheKey(session.status.connection);
  const [page, setPage] = useState<{
      key: string;
      projects: ProjectRecord[];
      versions: ResourceVersion[];
      cursor: string | null;
      stale: boolean;
    }>({ key: '', projects: [], versions: [], cursor: null, stale: true }),
    [jobs, setJobs] = useState<{ key: string; rows: SavedJob[] }>({ key: '', rows: [] }),
    [locals, setLocals] = useState<Record<string, Local>>({});
  const [draft, setDraft] = useState<{
      value: ProjectRecord;
      base: number | null;
      mutationId: string;
      owner: string;
    } | null>(null),
    [comparison, setComparison] = useState<{
      value: ProjectRecord;
      editor: number;
      owner: string;
      epoch: number;
    } | null>(null),
    [associate, setAssociate] = useState(''),
    [receive, setReceive] = useState<{
      project: ProjectRecord;
      epoch: number;
      jobId?: string;
      returnFocus: HTMLElement | null;
    } | null>(null),
    [parent, setParent] = useState(''),
    [directory, setDirectory] = useState(''),
    [transport, setTransport] = useState<'https' | 'ssh'>('https'),
    [pins, setPins] = useState<ResourceRef[]>([]),
    [review, setReview] = useState<{
      plan: InstallPlan;
      jobId: string;
      epoch: number;
      returnFocus: HTMLElement | null;
    } | null>(null);
  const editorSession = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  if (!visible && review) setReview(null);
  if (!visible && receive) setReceive(null);
  const projects = page.key === key ? page.projects : [],
    versions = page.key === key ? page.versions : [],
    savedJobs = jobs.key === key ? jobs.rows : [];
  function local(id: string) {
    action.run(
      (b, s) => cloudApi.localProject(id, b, s),
      (l) => setLocals((old) => ({ ...old, [id]: l })),
    );
  }
  function load(more = false) {
    action.run(
      async (b, s) => {
        const p = await cloudApi.listProjects(
          b,
          more && page.cursor ? { cursor: page.cursor } : {},
          s,
        );
        let r = await cloudApi.listResources(b, {}, s);
        const all = [...r.items];
        while (r.nextCursor) {
          r = await cloudApi.listResources(b, { cursor: r.nextCursor }, s);
          all.push(...r.items);
        }
        return { p, all };
      },
      ({ p, all }) => {
        const next = more ? [...projects, ...p.items] : p.items;
        setPage({ key, projects: next, versions: all, cursor: p.nextCursor, stale: false });
        writeCache(key, { projects: next, resources: all, savedAt: Date.now() });
        for (const p of next) local(p.id);
      },
    );
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const cached = readCache(key);
      setPage({
        key,
        projects: cached.projects,
        versions: cached.resources,
        cursor: null,
        stale: true,
      });
      setJobs({ key, rows: cached.jobs.filter((j) => j.projectId) });
      setLocals({});
      if (key && session.status.state === 'connected' && !session.changed) load();
    });
    return () => {
      cancelled = true;
    };
    // An account transition reloads browsing only, never a pending mutation or edited draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.epoch]);
  function saveJob(j: Job, projectId: string, generation = session.status.connection!.generation) {
    setJobs((prev) => ({
      key,
      rows: [{ job: j, generation, projectId }, ...prev.rows.filter((r) => r.job.id !== j.id)],
    }));
    rememberJob(key, j, generation, projectId);
    if (!['queued', 'running'].includes(j.state)) local(projectId);
  }
  function edit(p: ProjectRecord | null) {
    editorSession.current++;
    setDraft({
      value: p ?? newRecord(),
      base: p?.version ?? null,
      mutationId: crypto.randomUUID(),
      owner: key,
    });
    setComparison(null);
    action.setError(null);
  }
  function closeEditor() {
    editorSession.current++;
    setDraft(null);
    setComparison(null);
  }
  function patch(p: Partial<ProjectRecord>) {
    setDraft((d) =>
      d ? { ...d, value: { ...d.value, ...p }, mutationId: crypto.randomUUID() } : d,
    );
  }
  function receiveProject(project: ProjectRecord, jobId?: string) {
    if (!visibleRef.current) return;
    setReceive({
      project,
      epoch: session.epoch,
      jobId,
      returnFocus: jobId ? action.origin.current : (document.activeElement as HTMLElement),
    });
    setPins(project.resources);
    setDirectory(project.repository.name);
  }
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const currentDraft = draft?.owner === key,
    canonical = draft ? canonicalGithub(draft.value.repository.url) : null;
  // Account guards alone cannot distinguish two editors for the same record.
  // Increment on every open/close, including A -> B -> A before an await completes.
  function editorReview() {
    const editor = editorSession.current,
      owner = key,
      id = draft!.value.id,
      epoch = session.epoch;
    return {
      editor,
      owner,
      id,
      epoch,
      current: () =>
        editorSession.current === editor &&
        session.current() === epoch &&
        draftRef.current?.owner === owner &&
        draftRef.current?.value.id === id,
    };
  }
  const latest =
    comparison &&
    comparison.editor === editorSession.current &&
    comparison.owner === key &&
    comparison.epoch === session.epoch &&
    comparison.value.id === draft?.value.id
      ? comparison.value
      : null;
  function compareLatest() {
    if (!draft || !currentDraft) return;
    const review = editorReview();
    action.run(
      (b, s) => cloudApi.project(review.id, b, s),
      (p) => {
        if (review.current() && p.id === review.id)
          setComparison({
            value: p,
            editor: review.editor,
            owner: review.owner,
            epoch: review.epoch,
          });
      },
      false,
      review.current,
    );
  }
  function save() {
    if (!draft || !currentDraft) return;
    const url = canonicalGithub(draft.value.repository.url);
    if (!url) {
      action.setError('Enter a canonical GitHub HTTPS URL or git@github.com:owner/repo.git.');
      return;
    }
    const [owner, name] = url.slice('https://github.com/'.length).split('/');
    const parsed = ProjectRecordSchema.safeParse({
      ...draft.value,
      repository: { ...draft.value.repository, owner, name, url },
    });
    if (!parsed.success) {
      action.setError('Check project name, GitHub URL, branch and exact resource pins.');
      return;
    }
    const review = editorReview();
    action.run(
      (b, s) =>
        cloudApi.saveProject(
          { mutationId: draft.mutationId, baseVersion: draft.base, value: parsed.data },
          b,
          s,
        ),
      (p) => {
        if (!review.current() || p.id !== review.id) return;
        if (draftRef.current?.mutationId === draft.mutationId) {
          setDraft({ value: p, base: p.version, mutationId: crypto.randomUUID(), owner: key });
          setComparison(null);
        } else {
          // A successful save acknowledges only its submitted snapshot. Keep later typing.
          setComparison({
            value: p,
            editor: review.editor,
            owner: review.owner,
            epoch: review.epoch,
          });
        }
        load();
      },
      false,
      review.current,
    );
  }
  return (
    <>
      <SectionHeader
        label="Projects"
        count={projects.length}
        countLabel={cloudCount(projects.length, 'cloud project')}
      />
      <p className={styles.hint}>
        Save the project’s GitHub details, choose its local folder, then add resource versions.
      </p>
      <div className={styles.toolbar}>
        <Button variant="primary" onClick={() => edit(null)}>
          Add project
        </Button>
        <Button disabled={!action.enabled || action.busy} onClick={() => load()}>
          Refresh projects
        </Button>
      </div>
      {projects.length > 0 &&
        !action.busy &&
        (page.stale || session.status.state !== 'connected') && (
          <StaleNote>
            Showing projects saved in this browser. Refresh before Git or metadata changes.
          </StaleNote>
        )}
      {draft && (
        <section className={styles.card}>
          <h3>
            {draft.base === null ? 'New project' : 'Edit project'}
            {draft.base !== null ? ` · revision ${draft.base}` : ''}
          </h3>
          {!currentDraft && (
            <div role="alert" className={styles.banner}>
              Draft belongs to another account and is preserved. Return to that account or start a
              new record.
            </div>
          )}
          <div className={styles.form}>
            <Field label="Project name">
              <TextInput
                value={draft.value.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="GitHub repository URL">
              <TextInput
                value={draft.value.repository.url}
                onChange={(e) =>
                  patch({ repository: { ...draft.value.repository, url: e.target.value } })
                }
              />
            </Field>
            {canonical && <p className={styles.hint}>GitHub repository: {canonical}</p>}
            <Field label="Branch">
              <TextInput
                value={draft.value.repository.branch}
                onChange={(e) =>
                  patch({ repository: { ...draft.value.repository, branch: e.target.value } })
                }
              />
            </Field>
            <Field label="Description">
              <TextArea
                value={draft.value.description}
                onChange={(e) => patch({ description: e.target.value })}
              />
            </Field>
          </div>
          <h4>Add resource versions</h4>
          <p className={styles.hint}>
            Saving an empty list is valid. Refresh resources after publication to select new
            versions.
          </p>
          {[
            ...new Map(
              [
                ...draft.value.resources,
                ...versions
                  .filter(
                    (v) => v.manifest.scope === 'global' || v.manifest.projectId === draft.value.id,
                  )
                  .map((v) => ({ resourceId: v.manifest.resourceId, version: v.version })),
              ].map((r) => [refKey(r), r]),
            ).values(),
          ].map((r) => (
            <label className={styles.check} key={refKey(r)}>
              <input
                type="checkbox"
                checked={draft.value.resources.some((x) => refKey(x) === refKey(r))}
                onChange={(e) =>
                  patch({
                    resources: e.target.checked
                      ? [...draft.value.resources.filter((x) => x.resourceId !== r.resourceId), r]
                      : draft.value.resources.filter((x) => refKey(x) !== refKey(r)),
                  })
                }
              />
              {versions.find((v) => v.manifest.resourceId === r.resourceId)?.manifest.name ??
                r.resourceId}{' '}
              · v{r.version}
            </label>
          ))}
          <div className={styles.toolbar}>
            <Button
              variant="primary"
              disabled={!action.enabled || action.busy || !currentDraft}
              onClick={save}
            >
              Save project details
            </Button>
            {draft.base !== null && (
              <Button
                disabled={!action.enabled || action.busy || !currentDraft}
                onClick={compareLatest}
              >
                Load latest for comparison
              </Button>
            )}
            <Button onClick={closeEditor}>Close editor</Button>
          </div>
          {latest && (
            <div className={styles.banner}>
              <h4>Latest revision {latest.version}</h4>
              <section aria-label="Revision comparison" className={styles.comparison}>
                {(
                  [
                    ['Latest saved', latest],
                    ['Your draft', draft.value],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <h4>{label}</h4>
                    <dl>
                      <dt>Project name</dt>
                      <dd>{value.name}</dd>
                      <dt>Repository</dt>
                      <dd>{value.repository.url}</dd>
                      <dt>Branch</dt>
                      <dd>{value.repository.branch}</dd>
                      <dt>Description</dt>
                      <dd>{value.description || 'No description'}</dd>
                      <dt>Resource versions</dt>
                      <dd>
                        {value.resources.length ? (
                          <ul>
                            {value.resources.map((r) => (
                              <li key={refKey(r)}>
                                {versions.find((v) => v.manifest.resourceId === r.resourceId)
                                  ?.manifest.name ?? r.resourceId}{' '}
                                · v{r.version}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          'No resources'
                        )}
                      </dd>
                    </dl>
                  </div>
                ))}
              </section>
              <p>
                Your fields above are unchanged. Review this revision before replacing its metadata
                with your draft.
              </p>
              <Button
                disabled={!action.enabled || !currentDraft || latest.deleted}
                onClick={() => {
                  if (
                    !comparison ||
                    comparison.editor !== editorSession.current ||
                    comparison.epoch !== session.current() ||
                    comparison.owner !== key ||
                    latest.id !== draftRef.current?.value.id
                  )
                    return;
                  setDraft((d) =>
                    d && d.value.id === latest.id && d.owner === comparison.owner
                      ? {
                          ...d,
                          base: latest.version,
                          value: { ...d.value, version: latest.version },
                          mutationId: crypto.randomUUID(),
                        }
                      : d,
                  );
                  setComparison(null);
                  action.setError(null);
                }}
              >
                Keep my draft using this reviewed revision
              </Button>
            </div>
          )}
          {draft.base !== null && (
            <>
              <h4>Choose an existing project folder on this device</h4>
              <Field label="Local project folder">
                <NativeSelect
                  value={associate}
                  onChange={setAssociate}
                  options={[
                    { value: '', label: 'Choose local project folder' },
                    ...catalog.projects
                      .filter((p) => p.exists)
                      .map((p) => ({ value: p.path, label: `${p.name} · ${p.path}` })),
                  ]}
                />
              </Field>
              <Button
                disabled={!associate || !action.enabled || action.busy || !currentDraft}
                onClick={() =>
                  action.run(
                    (b, s) => cloudApi.associateProject(draft.value.id, associate, b, s),
                    (l) => setLocals((old) => ({ ...old, [draft.value.id]: l })),
                  )
                }
              >
                Use this local folder
              </Button>
            </>
          )}
        </section>
      )}
      {action.error && (
        <div role="alert" className={styles.error}>
          {action.error}
        </div>
      )}
      <div className={styles.grid}>
        {projects.map((p) => (
          <article className={styles.card} key={p.id}>
            <h4>{p.name}</h4>
            <p className={styles.hint}>
              {p.repository.url} · {p.repository.branch} · revision {p.version}
            </p>
            {p.description && <p>{p.description}</p>}
            <p className={styles.stepLine}>
              {savedJobs.some((j) => j.projectId === p.id && j.job.state === 'partial') ? (
                <Chip tone="warning">Partial · Git and resources have separate results</Chip>
              ) : locals[p.id] ? (
                <Chip tone={tones[locals[p.id].state]}>{labels[locals[p.id].state]}</Chip>
              ) : (
                <Chip>Local state not checked</Chip>
              )}
            </p>
            <p className={styles.hint}>
              {cloudCount(p.resources.length, 'resource version')} included
            </p>
            <div className={styles.toolbar}>
              <Button disabled={page.stale} onClick={() => edit(p)}>
                Edit project
              </Button>
              <Button
                disabled={!action.enabled || action.busy || page.stale}
                onClick={() => local(p.id)}
              >
                Check local state
              </Button>
              {(!locals[p.id] || locals[p.id].state === 'missing') && (
                <Button
                  disabled={!action.enabled || action.busy || page.stale}
                  onClick={() => receiveProject(p)}
                >
                  Get project
                </Button>
              )}
              {locals[p.id]?.state === 'ready' && (
                <Button
                  disabled={!action.enabled || action.busy || page.stale}
                  onClick={() =>
                    action.run(
                      (b, s) => cloudApi.pullProject(p.id, b, s),
                      (j) => saveJob(j, p.id),
                    )
                  }
                >
                  Pull updates
                </Button>
              )}
              {locals[p.id]?.openUrl && (
                <a
                  className={buttonClass()}
                  href={locals[p.id].openUrl!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open project
                </a>
              )}
            </div>
            {locals[p.id] && !['ready', 'missing'].includes(locals[p.id].state) && (
              <p className={styles.hint}>
                Resolve local work, branch, remote or active sessions in your checkout, then check
                again. Pull never resets, stashes or rebases.
              </p>
            )}
          </article>
        ))}
      </div>
      {page.cursor && (
        <Button disabled={!action.enabled || action.busy} onClick={() => load(true)}>
          More projects
        </Button>
      )}
      {!projects.length &&
        (action.busy ? (
          <EmptyState compact busy title="Loading cloud projects…" />
        ) : (
          <EmptyState
            compact
            title="No cloud project records yet."
            hint="A project record keeps a GitHub repository and the resource versions it needs together."
            action={<Button onClick={() => edit(null)}>Add project</Button>}
          />
        ))}
      {savedJobs.length > 0 && (
        <SectionHeader
          label="Jobs"
          count={savedJobs.length}
          countLabel={cloudCount(savedJobs.length, 'job')}
        />
      )}
      {savedJobs.map((j) => (
        <CloudJob
          key={j.job.id}
          job={j.job}
          owned={j.generation === session.status.connection?.generation}
          onChange={(next) => saveJob(next, j.projectId!, j.generation)}
          onResourcesReview={
            j.job.kind === 'get-project' && j.generation === session.status.connection?.generation
              ? () =>
                  action.run(
                    (b, s) => cloudApi.project(j.projectId!, b, s),
                    (p) => receiveProject(p, j.job.id),
                  )
              : undefined
          }
        />
      ))}
      {receive && (
        <CloudDialog
          returnFocus={receive.returnFocus}
          title={receive.jobId ? 'Retry project resources' : 'Get project'}
          onClose={() => setReceive(null)}
        >
          <p>
            {receive.project.name} · {receive.project.repository.url} ·{' '}
            {receive.project.repository.branch}
          </p>
          {!receive.jobId && (
            <div className={styles.form}>
              <Field label="Parent folder on this device">
                <TextInput
                  value={parent}
                  onChange={(e) => setParent(e.target.value)}
                  placeholder="/Users/you/Projects"
                />
              </Field>
              <Field label="New directory name">
                <TextInput value={directory} onChange={(e) => setDirectory(e.target.value)} />
              </Field>
              <Field label="Git transport">
                <NativeSelect
                  value={transport}
                  onChange={setTransport}
                  options={[
                    { value: 'https', label: 'HTTPS · native credential helper' },
                    { value: 'ssh', label: 'SSH · local keys and host trust' },
                  ]}
                />
              </Field>
            </div>
          )}
          <h4>Choose resource versions</h4>
          {receive.project.resources.map((r) => (
            <label className={styles.check} key={refKey(r)}>
              <input
                type="checkbox"
                checked={pins.some((p) => refKey(p) === refKey(r))}
                onChange={(e) =>
                  setPins((old) =>
                    e.target.checked ? [...old, r] : old.filter((p) => refKey(p) !== refKey(r)),
                  )
                }
              />
              {r.resourceId} · v{r.version}
            </label>
          ))}
          <p className={styles.hint}>
            {receive.jobId
              ? 'An empty selection explicitly skips resources; the existing checkout remains.'
              : 'Git and resource results are separate. Local authentication stays on this device.'}
          </p>
          <Button
            variant="primary"
            disabled={
              !action.enabled ||
              action.busy ||
              receive.epoch !== session.epoch ||
              (!receive.jobId && (!parent || !directory))
            }
            onClick={() => {
              if (receive.jobId)
                action.run(
                  (b, s) => cloudApi.projectResourcePlan(receive.jobId!, b, pins, s),
                  (plan) => {
                    if (!visibleRef.current) return;
                    setReview({
                      plan,
                      jobId: receive.jobId!,
                      epoch: session.epoch,
                      returnFocus: receive.returnFocus,
                    });
                    setReceive(null);
                  },
                );
              else
                action.run(
                  (b, s) =>
                    cloudApi.getProject(
                      receive.project.id,
                      {
                        parentPath: parent,
                        directoryName: directory,
                        transport,
                        resourceVersions: pins,
                      },
                      b,
                      s,
                    ),
                  (j) => {
                    saveJob(j, receive.project.id);
                    setReceive(null);
                  },
                );
            }}
          >
            {receive.jobId ? 'Compare resources for retry' : 'Start Get project'}
          </Button>
          {action.error && (
            <div role="alert" className={styles.error}>
              {action.error}
            </div>
          )}
        </CloudDialog>
      )}
      {review && (
        <CloudDialog
          returnFocus={review.returnFocus}
          title="Review project resource retry"
          onClose={() => setReview(null)}
        >
          <CloudReview
            key={review.plan.id}
            install={review.plan}
            busy={action.busy}
            disabled={!action.enabled || !!action.error || review.epoch !== session.epoch}
            onClose={() => setReview(null)}
            onConfirm={(decisions) =>
              action.run(
                (b, s) =>
                  cloudApi.retryProjectResources(
                    review.jobId,
                    b,
                    { planId: review.plan.id, decisions },
                    s,
                  ),
                (j) => {
                  const owner = savedJobs.find((x) => x.job.id === j.id)?.projectId;
                  if (owner) saveJob(j, owner);
                  setReview(null);
                },
              )
            }
          />
          {action.error && (
            <div role="alert" className={styles.error}>
              {action.error} Close and create a fresh review after any active job finishes.
            </div>
          )}
        </CloudDialog>
      )}
    </>
  );
}
