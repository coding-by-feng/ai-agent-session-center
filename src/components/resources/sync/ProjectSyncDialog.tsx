/**
 * ProjectSyncDialog — one project's sync with its server (Oct 31 2026). Not linked yet: the
 * setup form. Linked: where it syncs, Compare, the latest review or run (ProjectSyncRun), and
 * Settings for the direction and what is left out, or to remove the link (files stay).
 */
import { useState } from 'react';
import type { SyncConflictPolicy, SyncDirection, SyncLink } from '@/types/projectSync';
import type { ResourceProject } from '@/types/resources';
import { projectSyncApi } from '@/lib/projectSyncApi';
import {
  DIRECTION_HINT,
  DIRECTION_LABEL,
  excludesOf,
  excludesText,
  POLICY_HINT,
  POLICY_OPTIONS,
} from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextArea from '@/components/ui/TextArea';
import CloudDialog from '../cloud/CloudDialog';
import ProjectSyncRun from './ProjectSyncRun';
import ProjectSyncSetup from './ProjectSyncSetup';
import PullFromServer from './PullFromServer';
import type { ProjectSync } from './useProjectSync';
import styles from '@/styles/modules/ProjectSync.module.css';

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function LinkSettings({
  link,
  busy,
  onSave,
  onRemove,
  onDone,
}: {
  link: SyncLink;
  busy: boolean;
  onSave: (patch: {
    direction: SyncDirection;
    excludes: string[];
    conflictPolicy: SyncConflictPolicy;
  }) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const [direction, setDirection] = useState(link.direction);
  const [policy, setPolicy] = useState<SyncConflictPolicy>(link.conflictPolicy ?? 'ask');
  const [excludes, setExcludes] = useState(excludesText(link.excludes));
  const [removeAsk, setRemoveAsk] = useState(false);
  const changed =
    direction !== link.direction ||
    policy !== (link.conflictPolicy ?? 'ask') ||
    JSON.stringify(excludesOf(excludes)) !== JSON.stringify(link.excludes);
  return (
    <div className={styles.settings} role="group" aria-label="Sync settings">
      <div className={styles.form}>
        <Field label="Direction" className={`${styles.formField} ${styles.formWide}`}>
          <NativeSelect<SyncDirection>
            value={direction}
            onChange={setDirection}
            options={[
              { value: 'two-way', label: DIRECTION_LABEL['two-way'] },
              { value: 'push', label: DIRECTION_LABEL.push },
            ]}
          />
        </Field>
        <p className={`${styles.hint} ${styles.formWide}`}>{DIRECTION_HINT[direction]}</p>
        {direction === 'two-way' ? (
          <>
            <Field label="When both changed" className={`${styles.formField} ${styles.formWide}`}>
              <NativeSelect<SyncConflictPolicy>
                value={policy}
                onChange={setPolicy}
                options={POLICY_OPTIONS}
              />
            </Field>
            <p className={`${styles.hint} ${styles.formWide}`}>{POLICY_HINT[policy]}</p>
          </>
        ) : null}
        <Field
          label="Leave out (one per line)"
          className={`${styles.formField} ${styles.formWide}`}
        >
          <TextArea
            rows={Math.min(10, Math.max(4, excludes.split('\n').length + 1))}
            value={excludes}
            onChange={(e) => setExcludes(e.target.value)}
          />
        </Field>
        <div className={styles.formActions}>
          <Button
            variant="primary"
            disabled={busy || !changed}
            onClick={() =>
              onSave({ direction, excludes: excludesOf(excludes), conflictPolicy: policy })
            }
          >
            Save
          </Button>
          <Button variant="quiet" onClick={onDone}>
            Done
          </Button>
          {!removeAsk ? (
            <Button variant="danger" disabled={busy} onClick={() => setRemoveAsk(true)}>
              Remove link…
            </Button>
          ) : null}
        </div>
      </div>
      {removeAsk ? (
        <div role="alert" className={styles.confirm}>
          <span>
            Remove the link? Files stay on both sides, but its undo copies are deleted; linking
            again compares them from scratch.
          </span>
          <Button size="sm" variant="danger" disabled={busy} onClick={onRemove}>
            Remove link
          </Button>
          <Button size="sm" onClick={() => setRemoveAsk(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export default function ProjectSyncDialog({
  project,
  name,
  sync,
  onClose,
}: {
  project: ResourceProject;
  /** The card's name for the project. */
  name: string;
  sync: ProjectSync;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const [pulling, setPulling] = useState(false);
  const overview = sync.overview;
  const link = overview?.links.find((l) => l.projectId === project.id);
  const device = link ? overview?.devices.find((d) => d.id === link.deviceId) : undefined;
  const run = link?.lastRunId ? overview?.runs.find((r) => r.id === link.lastRunId) : undefined;
  const active = overview?.runs.some((r) => r.state === 'comparing' || r.state === 'running');
  /** This link's own compare or run is working. */
  const working = run?.state === 'comparing' || run?.state === 'running';
  /** Nothing is left to do with the latest run: Compare is the next step. */
  const settled = !run || run.state === 'complete' || run.state === 'undone';

  const act = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      await sync.refresh().catch(() => {});
      setBusy(false);
    }
  };
  const compare = (id: string) => act(() => projectSyncApi.compare(id), 'Could not compare.');

  let body;
  if (!overview)
    body = sync.error ? (
      <EmptyState tone="error" title={sync.error} />
    ) : (
      <EmptyState busy title="Loading project sync…" />
    );
  else if (pulling)
    body = (
      <PullFromServer
        project={project}
        devices={overview.devices}
        deviceId={link?.deviceId}
        onDone={() => setPulling(false)}
      />
    );
  else if (!link)
    body = (
      <>
        {overview.devices.length ? (
          <div className={styles.linkHead}>
            <span className={styles.hint}>Only need a few files from a server?</span>
            <span className={styles.linkTools}>
              <Button variant="quiet" onClick={() => setPulling(true)}>
                Pull files…
              </Button>
            </span>
          </div>
        ) : null}
        <ProjectSyncSetup
          project={project}
          devices={overview.devices}
          onDevices={sync.refresh}
          onLinked={(l) => compare(l.id)}
          onCancel={onClose}
        />
      </>
    );
  else
    body = (
      <>
        <dl className={styles.paths}>
          <dt>This computer</dt>
          <dd className={styles.mono}>{link.localPath}</dd>
          <dt>{device?.name ?? 'Removed server'}</dt>
          <dd className={styles.mono}>{link.remoteRoot}</dd>
        </dl>
        {/* The run below has its own state; the head says only how the link syncs. */}
        <div className={styles.linkHead}>
          <Chip>{DIRECTION_LABEL[link.direction]}</Chip>
          <span className={styles.linkTools}>
            {working ? null : (
              <Button
                variant={settled ? 'primary' : 'default'}
                disabled={busy || !!active || !device}
                onClick={() => void compare(link.id)}
              >
                {run ? 'Compare again' : 'Compare'}
              </Button>
            )}
            <Button
              variant="quiet"
              disabled={busy || !!active || !device}
              onClick={() => setPulling(true)}
            >
              Pull files…
            </Button>
            <Button
              variant="quiet"
              aria-expanded={settings}
              disabled={busy}
              onClick={() => setSettings((s) => !s)}
            >
              Settings
            </Button>
          </span>
        </div>
        {settings ? (
          <LinkSettings
            // Saved settings, not updatedAt: every run's end touches the link, and would wipe edits.
            key={`${link.direction}\n${link.conflictPolicy ?? 'ask'}\n${link.excludes.join('\n')}`}
            link={link}
            busy={busy || !!active}
            onDone={() => setSettings(false)}
            onSave={(patch) =>
              void act(() => projectSyncApi.updateLink(link.id, patch), 'Could not save.')
            }
            onRemove={() =>
              void act(async () => {
                await projectSyncApi.removeLink(link.id);
                setSettings(false);
              }, 'Could not remove the link.')
            }
          />
        ) : null}
        {error ? (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        ) : null}
        {run ? (
          <ProjectSyncRun
            key={run.id}
            run={run}
            direction={link.direction}
            onRun={(r) => {
              sync.replaceRun(r);
              // The card's state comes from the server; undo changes it without a poll running.
              if (r.state === 'undone') void sync.refresh().catch(() => {});
            }}
          />
        ) : (
          <EmptyState
            compact
            title="Not compared yet."
            hint="Compare reads both sides and lists what changed. Nothing is copied until you sync."
          />
        )}
      </>
    );
  return (
    <CloudDialog title={`Sync ${name}`} onClose={onClose}>
      <div className={styles.sync}>{body}</div>
    </CloudDialog>
  );
}
