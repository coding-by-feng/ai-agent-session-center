import { useEffect, useMemo, useState } from 'react';
import type { ResourceCatalog } from '@/types/resources';
import {
  resourceIsSelected,
  transferBlocker,
  type ResourceSelection as Selection,
  type TransferAction,
  type TransferDevice,
  type TransferItem,
  type TransferOverview,
  type TransferTarget,
  type TransferTask,
} from '@/types/resourceTransfers';
import { transfersApi } from '@/lib/resourceTransfersApi';
import { errorMessage } from '@/lib/resourcesApi';
import Button from '@/components/ui/Button';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import ResourceSelection, { SelectionCheck } from './ResourceSelection';
import styles from '@/styles/modules/ResourceTransfers.module.css';

function DeviceForm({
  busy,
  onSave,
}: {
  busy: boolean;
  onSave: (input: {
    name: string;
    host: string;
    username: string;
    port: number;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState(''),
    [host, setHost] = useState(''),
    [username, setUsername] = useState(''),
    [port, setPort] = useState('22');
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({ name, host, username, port: Number(port) }).then((ok) => {
          if (ok) {
            setName('');
            setHost('');
            setUsername('');
          }
        });
      }}
    >
      <Field label="Device name">
        <TextInput
          required
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Office Mac"
        />
      </Field>
      <Field label="Host or IP address">
        <TextInput
          required
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder="192.168.1.20 or server.example.com"
        />
      </Field>
      <Field label="SSH user">
        <TextInput
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
        />
      </Field>
      <Field label="SSH port">
        <TextInput
          required
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" disabled={busy}>
        Verify connection & save
      </Button>
    </form>
  );
}

function ReviewItem({
  item,
  device,
  value,
  disabled,
  restoreDisabled,
  onChange,
  onRestore,
}: {
  item: TransferItem;
  device?: TransferDevice;
  value: TransferAction;
  disabled: boolean;
  restoreDisabled: boolean;
  onChange: (action: TransferAction) => void;
  onRestore: () => void;
}) {
  const done = ['complete', 'restored'].includes(item.state);
  const blocked = !item.sourceHash;
  const options: { value: TransferAction; label: string }[] = [{ value: 'skip', label: 'Skip' }];
  if (!blocked)
    options.unshift(
      item.destinationHash === null
        ? { value: 'add', label: 'Add' }
        : { value: 'replace', label: 'Replace with backup' },
    );
  if (value === 'review') options.unshift({ value: 'review', label: 'Choose an action' });
  return (
    <details className={styles.item}>
      <summary>
        <span className={styles.itemName}>
          <strong>{item.name}</strong> → {device?.name ?? 'Destination'}
          <br />
          <span className={styles.hint}>
            {item.state === 'pending'
              ? item.reason ||
                (item.destinationHash === null ? 'New resource' : 'Different content')
              : item.state}
            {item.requiredBy?.length ? ' · required dependency' : ''}
          </span>
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          <NativeSelect
            aria-label={`Action for ${item.name} on ${device?.name}`}
            value={value}
            options={options}
            onChange={onChange}
            disabled={disabled || done}
          />
        </span>
      </summary>
      <p className={styles.hint}>
        Source: {item.sourcePath}
        <br />
        Destination: {item.destinationPath || 'Not resolved'}
      </p>
      {item.reason && <p>{item.reason}</p>}
      {item.warnings?.map((w) => (
        <p key={w} className={styles.notice}>
          {w}
        </p>
      ))}
      {item.error && (
        <p role="alert" className={styles.notice}>
          {item.error}
        </p>
      )}
      {!!item.files?.length && (
        <>
          <h4>Package files</h4>
          <ul className={styles.fileList}>
            {item.files.map((f) => (
              <li key={f.path}>
                {f.status} · {f.path}
              </li>
            ))}
          </ul>
        </>
      )}
      {item.patch && (
        <>
          <h4>Main file comparison</h4>
          <pre className={styles.patch}>{item.patch}</pre>
          <p className={styles.hint}>
            The file list above covers the full package. This text preview shows its main file;
            binary files are compared by checksum.
          </p>
        </>
      )}
      {item.backupId && item.state === 'complete' && (
        <Button disabled={restoreDisabled} onClick={onRestore}>
          Restore previous destination copy
        </Button>
      )}
    </details>
  );
}

function TaskReview({
  task,
  devices,
  busy,
  onRun,
  onCancel,
  onRepeat,
  onCompare,
  onRestore,
}: {
  task: TransferTask;
  devices: TransferDevice[];
  busy: boolean;
  onRun: (actions: Record<string, TransferAction>) => void;
  onCancel: () => void;
  onRepeat: () => void;
  onCompare: () => void;
  onRestore: (id: string) => void;
}) {
  const [actions, setActions] = useState<Record<string, TransferAction>>({});
  const [filter, setFilter] = useState<'all' | 'review' | 'failed'>('all');
  const actionFor = (i: TransferItem) => actions[i.id] ?? i.action;
  const remaining = task.items.filter((i) => !['complete', 'restored'].includes(i.state));
  const unresolved = remaining.filter((i) => actionFor(i) === 'review').length;
  const running = task.state === 'running';
  const canRun = ['review', 'failed', 'partial', 'cancelled', 'interrupted'].includes(task.state);
  const show = task.items.filter(
    (i) =>
      filter === 'all' || (filter === 'review' ? actionFor(i) === 'review' : i.state === 'failed'),
  );
  return (
    <section className={styles.card} aria-label={`Task ${task.name}`}>
      <h3>
        {task.name} · {task.state}
      </h3>
      <p className={styles.hint}>
        {task.items.filter((i) => i.state === 'complete').length}/{task.items.length} copied ·{' '}
        {task.items.filter((i) => i.reason === 'Identical').length} identical ·{' '}
        {task.items.filter((i) => !i.sourceHash).length} blocked ·{' '}
        {task.items.filter((i) => i.state === 'failed').length} failed
      </p>
      {task.state === 'draft' ? (
        <Button disabled={busy} onClick={onCompare}>
          Compare saved selection
        </Button>
      ) : (
        <>
          <div className={styles.toolbar}>
            <Field label="Results">
              <NativeSelect
                value={filter}
                onChange={setFilter}
                options={[
                  { value: 'all', label: 'All resources' },
                  { value: 'review', label: 'Needs a decision' },
                  { value: 'failed', label: 'Failed' },
                ]}
              />
            </Field>
            {canRun && (
              <Button
                disabled={busy}
                onClick={() =>
                  setActions((prev) => ({
                    ...prev,
                    ...Object.fromEntries(
                      remaining.filter((i) => !i.sourceHash).map((i) => [i.id, 'skip' as const]),
                    ),
                  }))
                }
              >
                Skip blocked items
              </Button>
            )}
          </div>
          {task.items.some((i) => i.requiredBy?.length) && (
            <p className={styles.hint}>
              Required packages were added to this review. A dependent resource cannot run if its
              dependency is skipped or fails.
            </p>
          )}
          <div>
            {show.map((item) => (
              <ReviewItem
                key={item.id}
                item={item}
                device={devices.find((d) => d.id === item.deviceId)}
                value={actionFor(item)}
                disabled={busy || !canRun}
                restoreDisabled={busy || running}
                onChange={(action) => setActions((a) => ({ ...a, [item.id]: action }))}
                onRestore={() => onRestore(item.id)}
              />
            ))}
          </div>
          <div className={styles.toolbar}>
            {canRun && (
              <Button
                variant="primary"
                disabled={busy || unresolved > 0}
                onClick={() => onRun(actions)}
              >
                {task.state === 'review' ? 'Copy reviewed resources' : 'Retry remaining items'}
              </Button>
            )}
            {unresolved > 0 && canRun && (
              <span className={styles.hint}>{unresolved} decisions remaining</span>
            )}
            {running && (
              <Button disabled={busy} onClick={onCancel}>
                Cancel remaining items
              </Button>
            )}
            {!running && (
              <Button disabled={busy} onClick={onRepeat}>
                Run again with fresh comparison
              </Button>
            )}
          </div>
          {running && (
            <p role="status" className={styles.hint}>
              Copying and verifying each package. Cancelling leaves completed copies in place and
              lets the current package finish.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export default function TransferPanel({
  section,
  catalog,
  selection,
  onSelection,
  onDevices,
}: {
  section: 'transfers' | 'devices';
  catalog: ResourceCatalog;
  selection: Selection;
  onSelection: (selection: Selection) => void;
  onDevices: () => void;
}) {
  const [data, setData] = useState<TransferOverview | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(''),
    [tick, setTick] = useState(0);
  const [targets, setTargets] = useState<TransferTarget[]>([]),
    [name, setName] = useState('Resource copy');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [creating, setCreating] = useState(true);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await transfersApi.overview();
        if (live) {
          setData(next);
          timer = setTimeout(
            () => void refresh(),
            next.tasks.some((t) => t.state === 'running') ? 1500 : 10000,
          );
        }
      } catch (e) {
        if (live) setError(errorMessage(e));
      }
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick]);
  const selected = useMemo(
    () => catalog.resources.filter((r) => resourceIsSelected(r, selection)),
    [catalog.resources, selection],
  );
  const projects = catalog.projects.filter((p) => selected.some((r) => r.projectId === p.id));
  const active = data?.tasks.find((t) => t.id === activeId);
  async function perform(label: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(label);
    setError('');
    try {
      await action();
      setTick((t) => t + 1);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      setTick((t) => t + 1);
      return false;
    } finally {
      setBusy('');
    }
  }
  function focusTask(task: TransferTask) {
    setActiveId(task.id);
    setCreating(false);
    setData(
      (prev) => prev && { ...prev, tasks: [task, ...prev.tasks.filter((t) => t.id !== task.id)] },
    );
  }
  const locked = !!busy || data?.tasks.some((t) => t.state === 'running') === true;
  return (
    <div className={styles.panel}>
      {error && (
        <div role="alert" className={`${styles.notice} ${styles.error}`}>
          {error}{' '}
          <Button
            size="sm"
            onClick={() => {
              setError('');
              setTick((t) => t + 1);
            }}
          >
            Refresh
          </Button>
        </div>
      )}
      {busy && (
        <p role="status" className={styles.notice}>
          {busy}…
        </p>
      )}
      {!data ? (
        <EmptyState
          busy={!error}
          title={error ? 'Transfer data is unavailable.' : 'Loading transfers…'}
        />
      ) : section === 'devices' ? (
        <>
          <h2>Destination devices</h2>
          <p className={styles.hint}>
            Use a local-network or internet-reachable SSH address. Each device needs macOS or Linux,
            Node.js 18+, and key-based SSH access from this machine. Verify its host key in your
            terminal first. The Resources dashboard remains local to this machine.
          </p>
          <div className={styles.columns}>
            <section className={styles.card}>
              <h3>Add a destination</h3>
              <DeviceForm
                busy={!!busy}
                onSave={(input) =>
                  perform('Verifying destination', () => transfersApi.addDevice(input))
                }
              />
            </section>
            <section className={styles.card}>
              <h3>Saved destinations · {data.devices.length}</h3>
              <ul className={styles.deviceList}>
                {data.devices.map((d) => (
                  <li key={d.id}>
                    <strong>{d.name}</strong>
                    <p>
                      {d.username}@{d.host}:{d.port} · {d.platform}
                    </p>
                    <p className={styles.hint}>
                      Home: {d.home}
                      <br />
                      Trusted host keys: {d.fingerprint}
                    </p>
                    <Button
                      size="sm"
                      disabled={
                        !!busy ||
                        data.tasks.some((t) => t.targets.some((target) => target.deviceId === d.id))
                      }
                      onClick={() =>
                        void perform('Removing destination', () => transfersApi.removeDevice(d.id))
                      }
                    >
                      Remove destination
                    </Button>
                  </li>
                ))}
              </ul>
              {!data.devices.length && <p className={styles.hint}>No destinations saved yet.</p>}
            </section>
          </div>
        </>
      ) : (
        <>
          <div className={styles.toolbar}>
            <h2>Resource transfers</h2>
            <Button
              disabled={!!busy}
              onClick={() => {
                setCreating(true);
                setActiveId(null);
              }}
            >
              New copy task
            </Button>
            <Button onClick={onDevices}>Manage devices</Button>
          </div>
          <p className={styles.hint}>
            Copy once to one or more destinations. Sources stay in place. Skills, commands, rules
            and agents are supported when user-owned and directly stored; other types remain visible
            for review.
          </p>
          {creating && (
            <div className={styles.columns}>
              <section className={styles.card}>
                <h3>1. Choose resources</h3>
                <ResourceSelection
                  resources={catalog.resources}
                  projects={catalog.projects}
                  selection={selection}
                  onChange={onSelection}
                />
              </section>
              <section className={styles.card}>
                <h3>2. Choose destinations</h3>
                <form
                  className={styles.form}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void perform('Saving and comparing destinations', async () => {
                      const draft = await transfersApi.saveDraft({ name, selection, targets });
                      focusTask(draft);
                      focusTask(await transfersApi.compare(draft.id));
                    });
                  }}
                >
                  <Field label="Task name">
                    <TextInput
                      required
                      maxLength={100}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </Field>
                  {data.devices.map((d) => (
                    <div key={d.id}>
                      <SelectionCheck
                        label={`${d.name} · ${d.host}`}
                        checked={targets.some((t) => t.deviceId === d.id)}
                        onChange={(checked) =>
                          setTargets((ts) =>
                            checked
                              ? [...ts, { deviceId: d.id, projects: {} }]
                              : ts.filter((t) => t.deviceId !== d.id),
                          )
                        }
                      />
                      {targets.some((t) => t.deviceId === d.id) && (
                        <div className={styles.form}>
                          <p className={styles.hint}>
                            Global resources go to the same agent’s resource folder. Project paths
                            must be inside {d.home}.
                          </p>
                          {projects.map((p) => (
                            <Field key={p.id} label={`${p.name} folder on ${d.name}`}>
                              <TextInput
                                required
                                value={
                                  targets.find((t) => t.deviceId === d.id)?.projects[p.id] ?? ''
                                }
                                placeholder={`${d.home}/Projects/${p.name}`}
                                onChange={(e) =>
                                  setTargets((ts) =>
                                    ts.map((t) =>
                                      t.deviceId === d.id
                                        ? {
                                            ...t,
                                            projects: { ...t.projects, [p.id]: e.target.value },
                                          }
                                        : t,
                                    ),
                                  )
                                }
                              />
                            </Field>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                  {!data.devices.length && (
                    <EmptyState
                      title="Add a destination to continue."
                      action={<Button onClick={onDevices}>Add device</Button>}
                    />
                  )}
                  <p>
                    {selected.length} selected · {selected.filter((r) => transferBlocker(r)).length}{' '}
                    require review
                  </p>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={
                      locked || !selected.length || !targets.length || catalog.state !== 'ready'
                    }
                  >
                    Save task & compare
                  </Button>
                  <p className={styles.hint}>
                    Comparison makes no resource changes. Repository metadata and dependency caches
                    are excluded. Review additions, differences and dependencies before copying.
                    This version does not schedule automatic sync or remove source files.
                  </p>
                </form>
              </section>
            </div>
          )}
          {active && (
            <TaskReview
              key={active.id}
              task={active}
              devices={data.devices}
              busy={!!busy}
              onCompare={() =>
                void perform('Comparing resources', async () =>
                  focusTask(await transfersApi.compare(active.id)),
                )
              }
              onRun={(actions) =>
                void perform('Starting copy', async () =>
                  focusTask(await transfersApi.run(active.id, actions)),
                )
              }
              onCancel={() =>
                void perform('Cancelling remaining items', async () =>
                  focusTask(await transfersApi.cancel(active.id)),
                )
              }
              onRepeat={() =>
                void perform('Creating a fresh comparison', async () => {
                  const draft = await transfersApi.repeat(active.id);
                  focusTask(draft);
                  focusTask(await transfersApi.compare(draft.id));
                })
              }
              onRestore={(itemId) =>
                void perform('Restoring previous copy', async () =>
                  focusTask(await transfersApi.restore(active.id, itemId)),
                )
              }
            />
          )}
          <section className={styles.card}>
            <h3>Saved tasks · {data.tasks.length}</h3>
            {data.tasks.length ? (
              <ul className={styles.deviceList}>
                {data.tasks.map((t) => (
                  <li key={t.id} className={styles.toolbar}>
                    <Button
                      disabled={!!busy}
                      onClick={() => {
                        setActiveId(t.id);
                        setCreating(false);
                      }}
                    >
                      {t.name}
                    </Button>
                    <span>
                      {t.state} · {t.targets.length} destinations ·{' '}
                      {new Date(t.createdAt).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.hint}>
                Your saved selection rules and transfer results will appear here.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
