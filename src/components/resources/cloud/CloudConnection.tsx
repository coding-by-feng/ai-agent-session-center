import { useState } from 'react';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import { cloudApi } from '@/lib/cloudApi';
import type { CloudStatus } from '@/types/cloud';
import { useSkillNotesStore, refreshNotesConnection } from '@/stores/skillNotesStore';
import CloudAliasControls from '../CloudAliasControls';
import { useCloudAction, useCloudSession, bindingKey } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudConnection({ onStatus }: { onStatus: (s: CloudStatus) => void }) {
  const session = useCloudSession(),
    action = useCloudAction();
  const [url, setUrl] = useState(session.status.connection?.backendOrigin ?? ''),
    [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [aliasKey, setAliasKey] = useState('');
  const notes = useSkillNotesStore();
  const [noteError, setNoteError] = useState<string | null>(null),
    [noteBusy, setNoteBusy] = useState(false);
  const same = bindingKey(notes.connection) === bindingKey(session.status.connection),
    ready = notes.ready && same && !noteBusy;
  function changed(s: CloudStatus) {
    onStatus(s);
    setCode('');
    void refreshNotesConnection().catch(() => {});
  }
  function noteRun(work: () => Promise<unknown>) {
    if (!notes.ready) return;
    setNoteBusy(true);
    setNoteError(null);
    void work()
      .catch((e) => setNoteError(e instanceof Error ? e.message : 'Notes action failed.'))
      .finally(() => setNoteBusy(false));
  }
  return (
    <div className={styles.grid}>
      <section className={styles.card}>
        <h3>Device connection</h3>
        <p>
          {session.status.state}{' '}
          {session.status.connection ? `· ${session.status.connection.deviceName}` : ''}
        </p>
        {session.status.connection && (
          <p className={styles.hint}>
            {session.status.connection.backendOrigin}
            <br />
            Account {session.status.connection.accountId}
          </p>
        )}
        <div className={styles.form}>
          <Field label="Backend URL">
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://cloud.example.com"
            />
          </Field>
          <Field label="Device name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="One-use pairing code">
            <TextInput
              type="password"
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </Field>
          <Button
            disabled={action.busy || !url || !name || !code}
            onClick={() =>
              action.run(
                (_b, s) =>
                  cloudApi.connect({ backendUrl: url, pairingCode: code, deviceName: name }, s),
                (connection) => changed({ connection, state: 'connected', lastError: null }),
                true,
              )
            }
          >
            Connect device
          </Button>
        </div>
        {session.status.connection && (
          <div className={styles.toolbar}>
            <Button
              disabled={action.busy}
              onClick={() => action.run((b, s) => cloudApi.disconnect(b, s), changed, true)}
            >
              Disconnect
            </Button>
            <Button
              disabled={action.busy || !action.enabled}
              onClick={() => action.run((b, s) => cloudApi.revoke(b, s), changed)}
            >
              Revoke this device
            </Button>
          </div>
        )}
        <p className={styles.hint}>
          Disconnecting stops every cloud request. Local resources and saved notes remain on this
          device, and account notes stay editable offline. Connecting makes notes available; choose
          below to activate them.
        </p>
        {action.error && (
          <p role="alert" className={styles.error}>
            {action.error}
          </p>
        )}
      </section>
      <section className={styles.card}>
        <h3>Notes and CLI aliases</h3>
        <p>
          Active notes:{' '}
          {notes.identity
            ? `${notes.identity.backendOrigin} · ${notes.identity.accountId}`
            : 'Local notes'}
        </p>
        <p>
          Available account:{' '}
          {notes.connection
            ? `${notes.connection.backendOrigin} · ${notes.connection.accountId}`
            : 'None'}
        </p>
        <p role="status">
          {notes.ready ? 'Ready' : 'Loading saved notes'} · {notes.sync.pending} pending ·{' '}
          {notes.sync.conflicts} conflicts ·{' '}
          {notes.sync.durable ? 'Saved on this device' : 'Not yet durable'}
        </p>
        {notes.message && (
          <p role="alert" className={styles.error}>
            {notes.message}
          </p>
        )}
        {notes.historyReset && <p>Cloud history was rebuilt. Pending edits were retained.</p>}
        <div className={styles.toolbar}>
          <Button
            disabled={!ready || !action.enabled}
            onClick={() => noteRun(() => useSkillNotesStore.getState().previewImport())}
          >
            Review notes activation
          </Button>
          <Button
            disabled={!notes.ready || noteBusy || !notes.identity}
            onClick={() => noteRun(() => useSkillNotesStore.getState().useLocalNotes())}
          >
            Use local notes
          </Button>
          <Button
            disabled={
              !ready ||
              !action.enabled ||
              bindingKey(notes.identity) !== bindingKey(notes.connection)
            }
            onClick={() => noteRun(() => useSkillNotesStore.getState().refresh())}
          >
            Sync notes now
          </Button>
        </div>
        {notes.review && (
          <div className={styles.banner}>
            <h4>Notes activation review</h4>
            <p>
              {notes.review.localRecords} local records · {notes.review.cloudRecords} cloud records
            </p>
            <p>
              Import combines favourites and tags; existing cloud fields are preserved. Abbreviation
              and tag conflicts must be resolved.
            </p>
            {notes.review.conflicts.map((c) => (
              <p key={c.key} className={styles.error}>
                {c.key}: {c.reason}
              </p>
            ))}
            <div className={styles.toolbar}>
              <Button
                disabled={!ready || !action.enabled}
                onClick={() =>
                  noteRun(() =>
                    useSkillNotesStore.getState().useCloudNotes('separate', notes.review!),
                  )
                }
              >
                Use cloud notes; keep local notes separate
              </Button>
              <Button
                disabled={!ready || !action.enabled || !!notes.review.conflicts.length}
                onClick={() =>
                  noteRun(() =>
                    useSkillNotesStore.getState().useCloudNotes('import', notes.review!),
                  )
                }
              >
                Import local notes and use cloud notes
              </Button>
            </div>
          </div>
        )}
        {notes.conflicts.map((c) => (
          <div key={c.mutation.mutationId} className={styles.banner}>
            <p>
              {c.mutation.key}: {c.conflict?.error.code ?? 'Conflict'}
            </p>
            <p className={styles.hint}>
              Discard this pending change to use the cloud value, then edit the note again in
              Library.
            </p>
            <Button
              disabled={!ready || noteBusy}
              onClick={() =>
                noteRun(() => useSkillNotesStore.getState().resolveConflict(c.mutation.mutationId))
              }
            >
              Discard conflicting change
            </Button>
          </div>
        ))}
        {notes.quarantined.length > 0 && (
          <p>
            {notes.quarantined.reduce((n, p) => n + p.pending, 0)} pending changes remain in other
            account partitions; they are not uploaded here.
          </p>
        )}
        {noteError && (
          <p role="alert" className={styles.error}>
            {noteError}
          </p>
        )}
        <p className={styles.hint}>
          CLI intent is separate from installation on this device. Review the server-saved
          abbreviation and target before Apply.
        </p>
        {notes.identity && (
          <>
            <Field label="Alias note">
              <NativeSelect
                value={aliasKey}
                onChange={setAliasKey}
                options={[
                  { value: '', label: 'Choose a saved note' },
                  ...Object.keys(notes.notes).map((k) => ({ value: k, label: k })),
                ]}
              />
            </Field>
            {aliasKey && (
              <CloudAliasControls
                key={`${aliasKey}:${bindingKey(notes.identity)}:${notes.selectionGeneration}`}
                noteKey={aliasKey}
                identity={notes.identity}
                ready={notes.ready}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
