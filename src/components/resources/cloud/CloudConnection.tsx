import { useEffect, useRef, useState } from 'react';
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
/** While the browser is signing in with Google (AASC-61), the card re-reads the connection this often. */
const SIGN_IN_POLL_MS = 2_000;
/** = the Mac's SIGN_IN_PENDING_MS: after this the Mac has dropped the sign-in anyway. */
const SIGN_IN_WAIT_MS = 600_000;
export default function CloudConnection({ onStatus }: { onStatus: (s: CloudStatus) => void }) {
  const session = useCloudSession(),
    action = useCloudAction();
  const [url, setUrl] = useState(session.status.connection?.backendOrigin ?? ''),
    [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [aliasKey, setAliasKey] = useState('');
  const saved = session.status.connection !== null;
  // Signing in (or pairing) is offered while this Mac has no working connection: none at all, or one
  // the backend revoked.
  const offerSignIn = !saved || session.status.state === 'revoked';
  // A Mac that isn't connected starts with the AASC backend and its own name; typing first wins.
  useEffect(() => {
    if (!offerSignIn) return;
    const cut = new AbortController();
    cloudApi
      .defaults(cut.signal)
      .then((d) => {
        setUrl((u) => u || d.backendUrl);
        setName((n) => n || d.deviceName);
      })
      .catch(() => {});
    return () => cut.abort();
  }, [offerSignIn]);
  // Sign in with Google (AASC-61): the browser does the signing in; this card waits for the Mac's
  // connection to change, or for the error the pairing left on it.
  const [waiting, setWaiting] = useState(false),
    [signInError, setSignInError] = useState<string | null>(null);
  const errorAtStart = useRef<string | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const cut = new AbortController();
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started >= SIGN_IN_WAIT_MS) {
        setWaiting(false);
        setSignInError('Sign-in timed out. Try again.');
        return;
      }
      cloudApi
        .status(cut.signal)
        .then((s) => {
          if (s.connection) {
            setWaiting(false);
            changed(s);
          } else if (s.lastError && s.lastError !== errorAtStart.current) {
            setWaiting(false);
            setSignInError(s.lastError);
          }
        })
        .catch(() => {});
    }, SIGN_IN_POLL_MS);
    return () => {
      clearInterval(timer);
      cut.abort();
    };
    // `changed` only forwards to onStatus; the poll restarts on `waiting` alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  function signIn() {
    setSignInError(null);
    errorAtStart.current = session.status.lastError;
    void cloudApi
      .googleStart({ deviceName: name }, new AbortController().signal)
      .then(({ url: start }) => {
        // In the desktop app attachWindowOpenPolicy hands this to the system browser.
        window.open(start, '_blank', 'noopener');
        setWaiting(true);
      })
      .catch((e) => setSignInError(e instanceof Error ? e.message : 'Sign-in could not start.'));
  }
  function cancelSignIn() {
    setWaiting(false);
    void cloudApi.googleCancel().catch(() => {});
  }
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
          {session.status.connection?.accountEmail
            ? `Signed in as ${session.status.connection.accountEmail} · ${session.status.connection.deviceName}`
            : `${session.status.state}${session.status.connection ? ` · ${session.status.connection.deviceName}` : ''}`}
        </p>
        {session.status.connection && (
          <p className={styles.hint}>
            {session.status.connection.backendOrigin}
            <br />
            Account {session.status.connection.accountId}
          </p>
        )}
        {offerSignIn && (
          <div className={styles.form}>
            <Field label="This Mac's name">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            {waiting ? (
              <div className={styles.toolbar} role="status">
                <span>Finish signing in in your browser…</span>
                <Button onClick={cancelSignIn}>Cancel</Button>
              </div>
            ) : (
              <Button variant="primary" disabled={action.busy || !name.trim()} onClick={signIn}>
                Sign in with Google
              </Button>
            )}
            {signInError && (
              <p role="alert" className={styles.error}>
                {signInError}
              </p>
            )}
            <details className={styles.advanced}>
              <summary>Advanced: another backend or a pairing code</summary>
              <div className={styles.form}>
                <Field label="Backend URL">
                  <TextInput
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://api.aasc.work"
                  />
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
                  disabled={action.busy || waiting || !url || !name || !code}
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
            </details>
          </div>
        )}
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
          abbreviation and target before Apply. Downloading resources never opts this device in.
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
