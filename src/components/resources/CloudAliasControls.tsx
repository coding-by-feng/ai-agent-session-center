/** Local controller controls; desired CLI intent remains in the notes store. */
import { useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import { cloudAliasesApi } from '@/lib/cloudAliasesApi';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import type { AliasIdentity, AliasPreview, AliasStatus } from '@/types/cloudAliases';
import styles from '@/styles/modules/SkillNotes.module.css';
const binding = (i: AliasIdentity | null) =>
  i ? JSON.stringify([i.backendOrigin, i.accountId, i.generation]) : null;
export default function CloudAliasControls({
  noteKey,
  identity,
  ready,
}: {
  noteKey: string;
  identity: AliasIdentity;
  ready: boolean;
}) {
  const connection = useSkillNotesStore((s) => s.connection);
  const active = useSkillNotesStore((s) => s.identity);
  const matching =
    ready && binding(identity) === binding(active) && binding(identity) === binding(connection);
  const [enabled, setEnabled] = useState(false),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [review, setReview] = useState<AliasPreview | null>(null),
    [status, setStatus] = useState<AliasStatus | null>(null);
  const controller = useRef<AbortController | null>(null);
  const current = () => {
    const s = useSkillNotesStore.getState();
    return (
      s.ready &&
      binding(s.identity) === binding(identity) &&
      binding(s.connection) === binding(identity) &&
      !controller.current?.signal.aborted
    );
  };
  useEffect(() => {
    const c = new AbortController();
    controller.current = c;
    if (matching)
      void cloudAliasesApi
        .status(noteKey, identity, c.signal)
        .then((data) => {
          if (current()) {
            setEnabled(data.enabled);
            setStatus(data.statuses[0] ?? null);
            setLoaded(true);
          }
        })
        .catch((err) => {
          if (!c.signal.aborted && current())
            setError(err instanceof Error ? err.message : 'Local alias status unavailable.');
        });
    return () => c.abort();
    // Parent keys this controller to exact active/available identity and resource.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (fn: () => Promise<void>) => {
    if (!current()) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (current()) {
        setReview(null);
        setError(err instanceof Error ? err.message : 'Local alias action failed.');
      }
    } finally {
      if (current()) setBusy(false);
    }
  };
  return (
    <div className={styles.cliBlock}>
      <p className={styles.hint}>
        Local result: {status?.state ?? 'not checked'}
        {status?.message ? ` · ${status.message}` : ''}
      </p>
      {!matching && (
        <p className={styles.hint}>
          Reconnect this notes account to review installation. Existing command files remain
          available.
        </p>
      )}
      <label className={styles.cliLabel}>
        <input
          type="checkbox"
          aria-label="Install cloud aliases on this device"
          checked={enabled}
          disabled={!matching || busy || !loaded}
          onChange={(e) => {
            const on = e.target.checked;
            void run(async () => {
              const data = await cloudAliasesApi.setEnabled(
                on,
                identity,
                controller.current?.signal,
              );
              if (current()) {
                setEnabled(data.enabled);
                setReview(null);
              }
            });
          }}
        />
        Install cloud aliases on this device
      </label>
      <p className={styles.hint}>
        This device preference is saved locally. Uses the latest notes saved to your cloud account;
        pending edits must sync first.
      </p>
      <Button
        size="sm"
        disabled={!matching || busy || !loaded}
        onClick={() =>
          void run(async () => {
            const data = await cloudAliasesApi.preview(
              noteKey,
              identity,
              controller.current?.signal,
            );
            if (current()) {
              setReview(data);
              setStatus(data.statuses[0] ?? null);
            }
          })
        }
      >
        Review alias for this device
      </Button>
      {review && (
        <div role="region" aria-label="Alias installation review">
          <p className={styles.hint}>
            {review.cached
              ? 'Uses notes last saved to your cloud account while this connection is offline.'
              : 'Uses the latest notes saved to your cloud account.'}
          </p>
          {review.intents.map(intent => <div key={intent.key} aria-label="Saved cloud alias to approve">
            <p className={styles.hint}>Saved cloud abbreviation: <strong>{intent.abbr ?? 'none'}</strong></p>
            <p className={styles.hint}>Target: <code>{intent.target}</code> · CLI: {intent.agent}</p>
            <p className={styles.hint}>CLI command requested: {intent.cli ? 'yes' : 'no'}</p>
          </div>)}
          {review.changes.map((change, i) => (
            <div key={i}>
              <p className={styles.hint}>
                {change.action}
                {change.message ? ` · ${change.message}` : ''}
              </p>
              <ul className={styles.fileList}>
                {change.files.map((file) => (
                  <li key={file}>
                    <code>{file}</code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <Button
            size="sm"
            disabled={!matching || busy || !enabled}
            onClick={() =>
              void run(async () => {
                const rows = await cloudAliasesApi.reconcile(
                  noteKey,
                  review.reviewId,
                  identity,
                  controller.current?.signal,
                );
                if (current()) {
                  setStatus(rows[0] ?? null);
                  setReview(null);
                }
              })
            }
          >
            Apply reviewed alias
          </Button>
          <p className={styles.hint}>
            A missing target can be approved for a later verified install retry. Changed intent
            always needs a new review.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
