import { useEffect, useRef, useState } from 'react';
import type { ResourceCatalog } from '@/types/resources';
import type { ResourceSelection as Selection } from '@/types/resourceSelection';
import { cloudPublicationBlocker } from '@/types/resourceSelection';
import {
  type CloudJob as Job,
  type PublicationPlan,
  type InstallPlan,
  type ResourceVersion,
} from '@/types/cloudResources';
import { cloudApi } from '@/lib/cloudApi';
import ResourceSelection from '../ResourceSelection';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import CloudReview from './CloudReview';
import CloudDialog from './CloudDialog';
import CloudJob from './CloudJob';
import { useCloudAction, useCloudSession } from './cloudSession';
import { cacheKey, readCache, writeCache, rememberJob, type SavedJob } from './cloudCache';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudResources({
  catalog,
  selection,
  onSelection,
  onProjects,
  visible = true,
}: {
  catalog: ResourceCatalog;
  selection: Selection;
  onSelection: (s: Selection) => void;
  onProjects: () => void;
  visible?: boolean;
}) {
  const session = useCloudSession(),
    action = useCloudAction(),
    key = cacheKey(session.status.connection);
  const [data, setData] = useState<{
      key: string;
      rows: ResourceVersion[];
      cursor: string | null;
      stale: boolean;
    }>({ key: '', rows: [], cursor: null, stale: true }),
    [jobs, setJobs] = useState<{ key: string; rows: SavedJob[] }>({ key: '', rows: [] }),
    [destination, setDestination] = useState(''),
    [review, setReview] = useState<{
      epoch: number;
      publication?: PublicationPlan;
      install?: InstallPlan;
    } | null>(null),
    [cacheError, setCacheError] = useState(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  if (!visible && review) setReview(null);
  const rows = data.key === key ? data.rows : [],
    savedJobs = jobs.key === key ? jobs.rows : [];
  function load(more = false) {
    action.run(
      (b, s) =>
        cloudApi.listResources(b, { ...(more && data.cursor ? { cursor: data.cursor } : {}) }, s),
      (page) => {
        const next = more ? [...rows, ...page.items] : page.items;
        setData({ key, rows: next, cursor: page.nextCursor, stale: false });
        if (!writeCache(key, { resources: next, savedAt: Date.now() })) setCacheError(true);
      },
    );
  }
  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      const cached = readCache(key);
      setData({ key, rows: cached.resources, cursor: null, stale: true });
      setJobs({ key, rows: cached.jobs.filter((j) => !j.projectId) });
      if (key && session.status.state === 'connected' && !session.changed) load();
    });
    return () => {
      cancelled = true;
    };
    // An account transition reloads browsing only, never a pending mutation or edited draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, session.epoch]); // account-bound read only; never retry a mutation
  function job(next: Job) {
    const generation = session.status.connection!.generation;
    setJobs((prev) => ({
      key,
      rows: [{ job: next, generation }, ...prev.rows.filter((j) => j.job.id !== next.id)],
    }));
    if (!rememberJob(key, next, generation)) setCacheError(true);
  }
  const close = () => setReview(null);
  return (
    <>
      <div className={styles.grid}>
        <section>
          <div className={styles.title}>
            <h3>Save from this device</h3>
            <Button
              disabled={!action.enabled || action.busy || !selection.length}
              onClick={() =>
                action.run(
                  (b, s) => cloudApi.buildPublicationPlan(selection, b, s),
                  (publication) => {
                    if (visibleRef.current) setReview({ epoch: session.epoch, publication });
                  },
                )
              }
            >
              Review selected resources
            </Button>
          </div>
          <p className={styles.hint}>
            Save the project’s GitHub details and choose its local folder before saving its
            resources to cloud. Then add the saved versions to the project.
          </p>
          <Button onClick={onProjects}>Save project first</Button>
          <ResourceSelection
            resources={catalog.resources}
            projects={catalog.projects}
            selection={selection}
            onChange={onSelection}
            blocker={cloudPublicationBlocker}
          />
        </section>
        <section>
          <div className={styles.title}>
            <h3>Cloud resource versions</h3>
            <Button disabled={!action.enabled || action.busy} onClick={() => load()}>
              Refresh resources
            </Button>
          </div>
          {(data.stale || session.status.state !== 'connected') && (
            <p className={styles.banner}>
              Cached browse · stale. Refresh while connected before choosing a version.
            </p>
          )}
          <Field className={styles.selectField} label="Project install folder">
            <NativeSelect
              value={destination}
              onChange={setDestination}
              options={[
                { value: '', label: 'Choose a local project folder' },
                ...catalog.projects.map((p) => ({ value: p.id, label: `${p.name} · ${p.path}` })),
              ]}
            />
          </Field>
          <p className={styles.hint}>
            Global packages use this device’s agent roots. Project packages require an explicitly
            associated local checkout.
          </p>
          {!rows.length && <p>No saved resources in this account.</p>}
          {rows.map((r) => (
            <article className={styles.card} key={`${r.manifest.resourceId}:${r.version}`}>
              <h4>{r.manifest.name}</h4>
              <p>
                v{r.version} · {r.manifest.agent} · {r.manifest.kind} · {r.manifest.scope}
              </p>
              <details>
                <summary>Files and exact dependencies</summary>
                <ul className={styles.files}>
                  {r.manifest.files.map((f) => (
                    <li key={f.path}>{f.path}</li>
                  ))}
                </ul>
                <p className={styles.hint}>
                  {r.manifest.dependencies.map((d) => `${d.resourceId} v${d.version}`).join(', ') ||
                    'No dependencies'}
                </p>
              </details>
              <div className={styles.toolbar}>
                <Button
                  disabled={!action.enabled || action.busy || data.stale}
                  onClick={() =>
                    action.run(
                      (b, s) =>
                        cloudApi.download(
                          { resourceId: r.manifest.resourceId, version: r.version },
                          b,
                          s,
                        ),
                      job,
                    )
                  }
                >
                  Download
                </Button>
                <Button
                  disabled={
                    !action.enabled ||
                    action.busy ||
                    data.stale ||
                    (r.manifest.scope === 'project' && !destination)
                  }
                  onClick={() =>
                    action.run(
                      (b, s) =>
                        cloudApi.planInstall(
                          {
                            resourceId: r.manifest.resourceId,
                            version: r.version,
                            ...(r.manifest.scope === 'project'
                              ? { localProjectId: destination }
                              : {}),
                          },
                          b,
                          s,
                        ),
                      (install) => {
                        if (visibleRef.current) setReview({ epoch: session.epoch, install });
                      },
                    )
                  }
                >
                  Install on this device
                </Button>
              </div>
            </article>
          ))}
          {data.cursor && (
            <Button disabled={!action.enabled || action.busy} onClick={() => load(true)}>
              More resources
            </Button>
          )}
          <p className={styles.hint}>
            Download prepares a portable ZIP. Installation is a separate reviewed operation.
          </p>
        </section>
      </div>
      {cacheError && (
        <p role="alert">
          Browser history could not be saved. Keep this window open to retain job links.
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      )}
      {savedJobs.map((j) => (
        <CloudJob
          key={j.job.id}
          job={j.job}
          owned={j.generation === session.status.connection?.generation}
          onChange={(next) => {
            setJobs((prev) => ({
              ...prev,
              rows: prev.rows.map((row) => (row.job.id === next.id ? { ...row, job: next } : row)),
            }));
            rememberJob(key, next, j.generation);
          }}
        />
      ))}
      {review && (
        <CloudDialog
          returnFocus={action.origin.current}
          title={review.publication ? 'Save selected to cloud' : 'Install on this device'}
          onClose={close}
        >
          <CloudReview
            key={review.publication?.id ?? review.install?.id}
            publication={review.publication}
            install={review.install}
            onClose={close}
            disabled={!action.enabled || !!action.error || review.epoch !== session.epoch}
            busy={action.busy}
            onConfirm={(decisions) => {
              if (review.epoch !== session.epoch) return;
              action.run(
                (b, s) =>
                  review.publication
                    ? cloudApi.publishPlan(review.publication.id, b, s)
                    : cloudApi.runInstall(review.install!.id, decisions, b, s),
                (next) => {
                  job(next);
                  close();
                },
              );
            }}
          />
          {review.epoch !== session.epoch && (
            <p role="alert">Connection changed. Close this review and compare again.</p>
          )}
          {action.error && (
            <p role="alert" className={styles.error}>
              {action.error}
            </p>
          )}
        </CloudDialog>
      )}
    </>
  );
}
