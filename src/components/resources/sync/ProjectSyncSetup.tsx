/**
 * ProjectSyncSetup — links a project to a folder on an SSH server (Oct 31 2026): pick a saved
 * server or add one, name the folder there, choose the direction and what to leave out, confirm
 * that credential files travel too, then Link and compare. The server needs only ssh and Node.js
 * 18+; its host key must already be trusted in ~/.ssh/known_hosts.
 */
import { useState } from 'react';
import {
  DEFAULT_SYNC_EXCLUDES,
  type SyncConflictPolicy,
  type SyncDevice,
  type SyncDirection,
  type SyncLink,
} from '@/types/projectSync';
import type { ResourceProject } from '@/types/resources';
import { projectSyncApi } from '@/lib/projectSyncApi';
import {
  DIRECTION_HINT,
  DIRECTION_LABEL,
  excludesOf,
  excludesText,
  POLICY_HINT,
  POLICY_OPTIONS,
  suggestRemoteRoot,
} from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextArea from '@/components/ui/TextArea';
import TextInput from '@/components/ui/TextInput';
import RemoteFolderPicker from './RemoteFolderPicker';
import styles from '@/styles/modules/ProjectSync.module.css';

const ADD = '+';
const DIRECTIONS: { value: SyncDirection; label: string }[] = [
  { value: 'two-way', label: DIRECTION_LABEL['two-way'] },
  { value: 'push', label: DIRECTION_LABEL.push },
];
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function AddServer({
  onAdded,
  onCancel,
}: {
  onAdded: (d: SyncDevice) => void;
  /** Absent when there is no saved server to go back to. */
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [username, setUsername] = useState('');
  const [port, setPort] = useState('22');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const portNumber = Number(port);
  const ready =
    name.trim() &&
    host.trim() &&
    username.trim() &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535;
  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      onAdded(
        await projectSyncApi.addDevice({
          name: name.trim(),
          host: host.trim(),
          username: username.trim(),
          port: portNumber,
        }),
      );
    } catch (e) {
      setError(message(e, 'Could not add the server.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.subform} role="group" aria-label="Add a server">
      <div className={styles.form}>
        <Field label="Name" className={styles.formField}>
          <TextInput
            maxLength={64}
            value={name}
            placeholder="mini"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Host" className={styles.formField}>
          <TextInput
            maxLength={253}
            value={host}
            placeholder="mini.local or 192.168.1.20"
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setHost(e.target.value)}
          />
        </Field>
        <Field label="User" className={styles.formField}>
          <TextInput
            maxLength={32}
            value={username}
            autoCapitalize="off"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Port" className={styles.formField}>
          <TextInput inputMode="numeric" value={port} onChange={(e) => setPort(e.target.value)} />
        </Field>
      </div>
      <p className={styles.hint}>
        AASC signs in with your SSH keys and only trusts a host key already in ~/.ssh/known_hosts:
        connect once with <code>ssh</code> in a terminal first. The server needs Node.js 18 or
        newer; nothing else is installed there.
      </p>
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        <Button disabled={busy || !ready} onClick={() => void add()}>
          {busy ? 'Checking the server…' : 'Add server'}
        </Button>
        {onCancel ? (
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default function ProjectSyncSetup({
  project,
  devices,
  onDevices,
  onLinked,
  onCancel,
}: {
  project: ResourceProject;
  devices: SyncDevice[];
  /** The saved servers changed: read them again. */
  onDevices: () => Promise<unknown>;
  onLinked: (link: SyncLink) => Promise<void>;
  onCancel: () => void;
}) {
  const [deviceId, setDeviceId] = useState(devices[0]?.id ?? ADD);
  const device = devices.find((d) => d.id === deviceId);
  const [remoteRoot, setRemoteRoot] = useState(
    device ? suggestRemoteRoot(project.path, device.home) : '',
  );
  const [direction, setDirection] = useState<SyncDirection>('two-way');
  const [policy, setPolicy] = useState<SyncConflictPolicy>('ask');
  const [picking, setPicking] = useState(false);
  const [excludes, setExcludes] = useState(excludesText(DEFAULT_SYNC_EXCLUDES));
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeAsk, setRemoveAsk] = useState(false);

  const choose = (id: string, list: readonly SyncDevice[] = devices) => {
    setDeviceId(id);
    setRemoveAsk(false);
    setPicking(false);
    const d = list.find((x) => x.id === id);
    if (d) setRemoteRoot(suggestRemoteRoot(project.path, d.home));
  };
  const added = async (d: SyncDevice) => {
    await onDevices().catch(() => {});
    choose(d.id, [...devices, d]);
  };
  const removeServer = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      await projectSyncApi.removeDevice(device.id);
      await onDevices();
      const rest = devices.filter((d) => d.id !== device.id);
      choose(rest[0]?.id ?? ADD, rest);
    } catch (e) {
      setError(message(e, 'Could not remove the server.'));
    } finally {
      setBusy(false);
    }
  };
  const link = async () => {
    if (!device) return;
    setBusy(true);
    setError(null);
    try {
      const l = await projectSyncApi.createLink({
        name: `${project.name} ⇄ ${device.name}`.slice(0, 100),
        projectId: project.id,
        deviceId: device.id,
        remoteRoot: remoteRoot.trim(),
        excludes: excludesOf(excludes),
        credentialsAck: ack,
        direction,
        ...(direction === 'two-way' ? { conflictPolicy: policy } : {}),
      });
      await onLinked(l);
    } catch (e) {
      setError(message(e, 'Could not link the project.'));
      setBusy(false);
    }
  };

  const serverOptions = [
    ...devices.map((d) => ({ value: d.id, label: `${d.name} (${d.username}@${d.host})` })),
    { value: ADD, label: 'Add a server…' },
  ];
  return (
    <div className={styles.setup}>
      <p className={styles.hint}>
        Keeps <span className={styles.mono}>{project.path}</span> and a folder on an SSH server the
        same: every file, hidden ones included. Each sync is compared and reviewed first, and what
        it replaces or deletes is kept so the run can be undone.
      </p>
      <div className={styles.form}>
        <Field label="Server" className={`${styles.formField} ${styles.formWide}`}>
          <NativeSelect value={deviceId} onChange={(v) => choose(v)} options={serverOptions} />
        </Field>
      </div>
      {deviceId === ADD ? (
        <AddServer
          onAdded={(d) => void added(d)}
          onCancel={devices.length ? () => choose(devices[0].id) : undefined}
        />
      ) : device ? (
        <>
          <div className={styles.serverFacts}>
            <span className={styles.hint}>
              {device.platform} · home {device.home}
            </span>
            {removeAsk ? (
              <span role="group" aria-label={`Remove ${device.name}`} className={styles.inline}>
                <span className={styles.hint}>Forget this server? Its files stay.</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => void removeServer()}
                >
                  Remove
                </Button>
                <Button size="sm" onClick={() => setRemoveAsk(false)}>
                  Keep
                </Button>
              </span>
            ) : (
              <Button size="sm" variant="quiet" disabled={busy} onClick={() => setRemoveAsk(true)}>
                Remove server…
              </Button>
            )}
          </div>
          <form
            className={styles.form}
            onSubmit={(e) => {
              e.preventDefault();
              void link();
            }}
          >
            <Field
              label="Folder on the server"
              className={`${styles.formField} ${styles.formWide}`}
            >
              <TextInput
                required
                value={remoteRoot}
                spellCheck={false}
                placeholder={`${device.home}/…`}
                onChange={(e) => setRemoteRoot(e.target.value)}
              />
            </Field>
            <div className={`${styles.formWide} ${styles.inline}`}>
              <Button size="sm" aria-expanded={picking} onClick={() => setPicking((x) => !x)}>
                Browse…
              </Button>
              <span className={styles.hint}>Pick any folder inside {device.home}.</span>
            </div>
            {picking ? (
              <div className={styles.formWide}>
                <RemoteFolderPicker
                  device={device}
                  mode="folder"
                  start={
                    remoteRoot.trim().startsWith(device.home + '/') ? remoteRoot.trim() : undefined
                  }
                  onUse={(p) => {
                    setRemoteRoot(p);
                    setPicking(false);
                  }}
                  onCancel={() => setPicking(false)}
                />
              </div>
            ) : null}
            <Field label="Direction" className={`${styles.formField} ${styles.formWide}`}>
              <NativeSelect<SyncDirection>
                value={direction}
                onChange={setDirection}
                options={DIRECTIONS}
              />
            </Field>
            <p className={`${styles.hint} ${styles.formWide}`}>{DIRECTION_HINT[direction]}</p>
            {direction === 'two-way' ? (
              <>
                <Field
                  label="When both changed"
                  className={`${styles.formField} ${styles.formWide}`}
                >
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
                rows={DEFAULT_SYNC_EXCLUDES.length}
                value={excludes}
                onChange={(e) => setExcludes(e.target.value)}
              />
            </Field>
            <p className={`${styles.hint} ${styles.formWide}`}>
              Dependency and build folders are left out: each side rebuilds its own.
            </p>
            <label className={styles.check}>
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                Every file is copied, hidden ones included: credential files such as .env and keys
                too. I want that.
              </span>
            </label>
            {error ? (
              <p role="alert" className={`${styles.error} ${styles.formWide}`}>
                {error}
              </p>
            ) : null}
            <div className={styles.formActions}>
              <Button type="submit" variant="primary" disabled={busy || !ack || !remoteRoot.trim()}>
                {busy ? 'Linking…' : 'Link and compare'}
              </Button>
              <Button type="button" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </div>
  );
}
