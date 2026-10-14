import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResourceCatalog } from '@/types/resources';
import type { SyncLink, SyncOverview, SyncRun } from '@/types/projectSync';
import type { TransferDevice } from '@/types/resourceTransfers';
import { projectSyncApi } from '@/lib/projectSyncApi';
import { transfersApi } from '@/lib/resourceTransfersApi';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextArea from '@/components/ui/TextArea';
import TextInput from '@/components/ui/TextInput';
import ProjectSyncRun from './ProjectSyncRun';
import { runSummary, suggestRemoteRoot } from '@/lib/projectSyncFormat';
import styles from '@/styles/modules/ProjectSync.module.css';

const POLL_ACTIVE_MS = 1000;
const POLL_RETRY_MS = 4000;
const STATE_LABEL: Record<SyncLink['state'], string> = {
  never: 'not compared yet',
  'in-sync': 'in sync',
  pending: 'review waiting',
  attention: 'needs attention',
  running: 'working…',
};
const STATE_TONE: Record<SyncLink['state'], 'neutral' | 'success' | 'info' | 'warning' | 'accent'> =
  {
    never: 'neutral',
    'in-sync': 'success',
    pending: 'info',
    attention: 'warning',
    running: 'accent',
  };

function LinkForm({
  catalog,
  devices,
  busy,
  onSave,
  onCancel,
}: {
  catalog: ResourceCatalog;
  devices: TransferDevice[];
  busy: boolean;
  onSave: (input: Parameters<typeof projectSyncApi.createLink>[0]) => Promise<boolean>;
  onCancel: () => void;
}) {
  const projects = useMemo(
    () =>
      catalog.projects
        .filter((p) => p.exists && !p.isHome && !p.worktreeOf)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [catalog.projects],
  );
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? '');
  const project = projects.find((p) => p.id === projectId);
  const device = devices.find((d) => d.id === deviceId);
  const [remoteRoot, setRemoteRoot] = useState(
    project && device ? suggestRemoteRoot(project.path, device.home) : '',
  );
  const [name, setName] = useState('');
  const [excludes, setExcludes] = useState('');
  const [ack, setAck] = useState(false);
  const pick = (pid: string, did: string) => {
    const p = projects.find((x) => x.id === pid),
      d = devices.find((x) => x.id === did);
    if (p && d) setRemoteRoot(suggestRemoteRoot(p.path, d.home));
  };
  if (!projects.length)
    return (
      <EmptyState
        compact
        title="No projects found."
        hint="Rescan, or add the folder under Sources."
      />
    );
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          name: name.trim() || `${project?.name ?? 'project'} → ${device?.name ?? 'device'}`,
          projectId,
          deviceId,
          remoteRoot: remoteRoot.trim(),
          excludes: excludes
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          credentialsAck: ack,
        });
      }}
    >
      <Field label="Project" className={styles.formField}>
        <NativeSelect
          value={projectId}
          onChange={(v) => {
            setProjectId(v);
            pick(v, deviceId);
          }}
          options={projects.map((p) => ({ value: p.id, label: `${p.name} — ${p.path}` }))}
        />
      </Field>
      <Field label="Device" className={styles.formField}>
        <NativeSelect
          value={deviceId}
          onChange={(v) => {
            setDeviceId(v);
            pick(projectId, v);
          }}
          options={devices.map((d) => ({
            value: d.id,
            label: `${d.name} (${d.username}@${d.host})`,
          }))}
        />
      </Field>
      <Field label="Folder on the device" className={`${styles.formField} ${styles.formWide}`}>
        <TextInput
          required
          value={remoteRoot}
          onChange={(e) => setRemoteRoot(e.target.value)}
          placeholder={device ? `${device.home}/…` : '/home/you/project'}
        />
      </Field>
      <Field label="Name (optional)" className={styles.formField}>
        <TextInput
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${project?.name ?? 'project'} → ${device?.name ?? 'device'}`}
        />
      </Field>
      <Field
        label="Leave out (optional, one pattern per line, e.g. node_modules/ or *.log)"
        className={`${styles.formField} ${styles.formWide}`}
      >
        <TextArea rows={3} value={excludes} onChange={(e) => setExcludes(e.target.value)} />
      </Field>
      <label className={styles.check}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>
          Every file is copied, hidden ones included — credential files such as .env and keys too. I
          want that.
        </span>
      </label>
      <div className={styles.formActions}>
        <Button
          type="submit"
          variant="primary"
          disabled={busy || !ack || !remoteRoot.trim() || !projectId || !deviceId}
        >
          Link project
        </Button>
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export default function ProjectSyncPanel({
  catalog,
  onDevices,
}: {
  catalog: ResourceCatalog;
  onDevices: () => void;
}) {
  const [overview, setOverview] = useState<SyncOverview | null>(null);
  const [devices, setDevices] = useState<TransferDevice[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [o, t] = await Promise.all([projectSyncApi.overview(), transfersApi.overview()]);
    setOverview(o);
    setDevices(t.devices);
    return o;
  }, []);
  const active =
    overview?.runs.some((r) => r.state === 'comparing' || r.state === 'running') ?? false;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      refresh()
        .then((o) => {
          if (!alive) return;
          setError(null);
          if (o.runs.some((r) => r.state === 'comparing' || r.state === 'running'))
            timer = setTimeout(tick, POLL_ACTIVE_MS);
        })
        .catch((e) => {
          if (!alive) return;
          setError(e instanceof Error ? e.message : 'Could not load project sync.');
          // One failed poll must not freeze a running view: try again, more slowly.
          if (active) timer = setTimeout(tick, POLL_RETRY_MS);
        });
    };
    tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [refresh, active]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const replaceRun = (r: SyncRun) =>
    setOverview((o) => (o ? { ...o, runs: o.runs.map((x) => (x.id === r.id ? r : x)) } : o));

  if (!overview)
    return error ? (
      <EmptyState tone="error" title={error} />
    ) : (
      <EmptyState busy title="Loading project sync…" />
    );
  const link = overview.links.find((l) => l.id === selected) ?? null;
  const lastRun = link?.lastRunId ? overview.runs.find((r) => r.id === link.lastRunId) : undefined;
  const deviceName = (id: string) => devices.find((d) => d.id === id)?.name ?? 'removed device';

  return (
    <section className={styles.panel} aria-label="Project sync">
      <div className={styles.intro}>
        <div>
          <h2>Project sync</h2>
          <p className={styles.hint}>
            Mirrors a project folder — every file, hidden ones included — to a saved SSH device.
            Each run is compared and reviewed first; anything it replaces or deletes on the device
            is kept in the device's sync journal and can be undone.
          </p>
        </div>
        {devices.length ? (
          <Button variant="primary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            {adding ? 'Close' : 'Link a project'}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {!devices.length ? (
        <EmptyState
          title="Add a device first."
          hint="Project sync uses the SSH devices saved under Devices."
          action={<Button onClick={onDevices}>Open Devices</Button>}
        />
      ) : null}
      {adding && devices.length ? (
        <div className={styles.card}>
          <LinkForm
            catalog={catalog}
            devices={devices}
            busy={busy}
            onCancel={() => setAdding(false)}
            onSave={async (input) => {
              const ok = await run(async () => {
                const l = await projectSyncApi.createLink(input);
                setSelected(l.id);
              });
              if (ok) setAdding(false);
              return ok;
            }}
          />
        </div>
      ) : null}
      {overview.links.length ? (
        <ul className={styles.links} aria-label="Project links">
          {overview.links.map((l) => {
            const last = l.lastRunId ? overview.runs.find((r) => r.id === l.lastRunId) : undefined;
            return (
              <li
                key={l.id}
                className={
                  l.id === selected ? `${styles.link} ${styles.linkSelected}` : styles.link
                }
              >
                <button
                  type="button"
                  className={styles.linkMain}
                  onClick={() => setSelected(l.id === selected ? null : l.id)}
                  aria-expanded={l.id === selected}
                >
                  <span className={styles.linkName}>{l.name}</span>
                  <span className={styles.mono}>
                    {l.localPath} → {deviceName(l.deviceId)}:{l.remoteRoot}
                  </span>
                  <span className={styles.hint}>
                    {last && last.state !== 'comparing' ? runSummary(last) : ''}
                  </span>
                </button>
                <Chip tone={STATE_TONE[l.state]}>{STATE_LABEL[l.state]}</Chip>
                <Button
                  size="sm"
                  disabled={busy || active}
                  onClick={() =>
                    void run(async () => {
                      await projectSyncApi.compare(l.id);
                      setSelected(l.id);
                    })
                  }
                >
                  Compare
                </Button>
              </li>
            );
          })}
        </ul>
      ) : devices.length && !adding ? (
        <EmptyState
          title="No projects linked yet."
          hint="Link a project to mirror it to one of your devices."
        />
      ) : null}
      {link ? (
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <h3>{link.name}</h3>
            <Button
              size="sm"
              variant="quiet"
              disabled={busy || link.state === 'running'}
              onClick={() =>
                void run(async () => {
                  await projectSyncApi.removeLink(link.id);
                  setSelected(null);
                })
              }
            >
              Remove link
            </Button>
          </div>
          <p className={styles.hint}>
            Removing the link keeps every file on the device.{' '}
            {link.excludes.length
              ? `Leaves out: ${link.excludes.join(', ')}.`
              : 'Nothing is left out.'}
          </p>
          {lastRun ? (
            <ProjectSyncRun key={lastRun.id} run={lastRun} latest onRun={replaceRun} />
          ) : (
            <EmptyState
              compact
              title="Not compared yet."
              hint="Compare to see what a run would copy."
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
