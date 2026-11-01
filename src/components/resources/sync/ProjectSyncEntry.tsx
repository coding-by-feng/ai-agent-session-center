/**
 * One row of a sync review: a path with how it changed and what the run does with it (EntryRow),
 * or a repository decided as one unit (RepoRow). A path whose change leaves a choice gets a
 * select; a text diff opens under it, never for a credential file.
 */
import { useState } from 'react';
import {
  possibleActions,
  type SyncAction,
  type SyncChange,
  type SyncDirection,
  type SyncEntry,
  type SyncFlag,
  type SyncGroup,
  type SyncGroupDecision,
  type SyncRun,
} from '@/types/projectSync';
import { projectSyncApi } from '@/lib/projectSyncApi';
import { actionLabel, changeLabel, REPO_STATE_LABEL } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import styles from '@/styles/modules/ProjectSync.module.css';

/** Red is for what removes a file; a path that waits for a choice is amber, like a repository's. */
const CHANGE_TONE: Partial<Record<SyncChange, 'info' | 'success' | 'warning' | 'danger'>> = {
  add: 'success',
  change: 'info',
  delete: 'danger',
  drift: 'info',
  extra: 'info',
  conflict: 'warning',
  different: 'warning',
  blocked: 'warning',
};
/** Flags a row names, beside its change: what to check before taking the server's version. */
const FLAG_CHIP: Partial<Record<SyncFlag, string>> = {
  executable: 'executable',
  'link-outside': 'leads outside',
  'git-config': 'git config',
};
const short = (sha?: string) => (sha ? sha.slice(0, 10) : '—');

/** The choices a repository offers in a link of this direction. */
function repoOptions(
  group: SyncGroup,
  direction: SyncDirection,
): NativeSelectOption<SyncGroupDecision>[] {
  const both = group.state === 'both-changed' || group.state === 'different-repo';
  const theirs = group.state === 'device-changed' || group.state === 'different-repo';
  const pending: NativeSelectOption<SyncGroupDecision>[] =
    group.decision === 'review' ? [{ value: 'review', label: 'Choose…' }] : [];
  if (direction === 'push')
    return [
      ...pending,
      { value: 'sync', label: 'Sync changes', disabled: theirs },
      { value: 'overwrite', label: 'Overwrite the server repository (backups kept)' },
      { value: 'skip', label: 'Skip this repository' },
    ];
  return [
    ...pending,
    { value: 'sync', label: 'Sync changes', disabled: both },
    { value: 'overwrite', label: 'Use this computer’s repository (backups kept)' },
    { value: 'take-device', label: 'Use the server’s repository (backups kept)' },
    { value: 'skip', label: 'Skip this repository' },
  ];
}

export function RepoRow({
  group,
  run,
  direction,
  busy,
  onDecide,
}: {
  group: SyncGroup;
  run: SyncRun;
  direction: SyncDirection;
  busy: boolean;
  onDecide: (groupId: string, d: SyncGroupDecision) => void;
}) {
  const state = group.state ?? 'in-step';
  const tense = state !== 'in-step' && state !== 'local-ahead' && state !== 'device-ahead';
  return (
    <li className={styles.repoRow}>
      <div className={styles.repoHead}>
        <span className={styles.mono}>⎇ {group.id}</span>
        <Chip tone={tense ? 'warning' : 'neutral'}>{REPO_STATE_LABEL[state]}</Chip>
      </div>
      <p className={styles.hint}>
        This computer {group.local?.head ?? '—'} {short(group.local?.commit)} · server{' '}
        {group.device?.head ?? '—'} {short(group.device?.commit)}
      </p>
      {run.state === 'review' && state !== 'busy' && state !== 'in-step' ? (
        <Field label="Repository" className={styles.repoField}>
          <NativeSelect<SyncGroupDecision>
            className={styles.repoSelect}
            value={group.decision ?? 'review'}
            disabled={busy}
            onChange={(d) => onDecide(group.id, d)}
            options={repoOptions(group, direction)}
          />
        </Field>
      ) : null}
    </li>
  );
}

function DiffView({ diff }: { diff: { patch: string | null; note?: string } }) {
  if (!diff.patch) return <p className={styles.hint}>{diff.note}</p>;
  return (
    <pre className={styles.diff}>
      {diff.patch.split('\n').map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith('+') && !line.startsWith('+++')
              ? styles.diffAdd
              : line.startsWith('-') && !line.startsWith('---')
                ? styles.diffDel
                : undefined
          }
        >
          {line + '\n'}
        </span>
      ))}
    </pre>
  );
}

export function EntryRow({
  entry,
  run,
  direction,
  repo,
  busy,
  onAction,
}: {
  entry: SyncEntry;
  run: SyncRun;
  direction: SyncDirection;
  /** Inside a repository: it goes with the repository's decision. */
  repo: boolean;
  busy: boolean;
  onAction: (id: string, a: SyncAction) => void;
}) {
  const [diff, setDiff] = useState<{ patch: string | null; note?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const options = possibleActions(entry, direction);
  const editable = run.state === 'review' && !repo && options.length > 1;
  const kind = (entry.local ?? entry.device)?.kind;
  const canDiff = !entry.flags.includes('credential') && kind === 'file' && entry.change !== 'same';
  const showDiff = async () => {
    if (diff) return setDiff(null);
    setLoading(true);
    try {
      setDiff(await projectSyncApi.diff(run.id, entry.id));
    } catch (e) {
      setDiff({ patch: null, note: e instanceof Error ? e.message : 'Preview failed.' });
    } finally {
      setLoading(false);
    }
  };
  const note = entry.error ?? entry.reason;
  const diffButton = canDiff ? (
    <Button
      size="sm"
      variant="quiet"
      aria-expanded={!!diff}
      onClick={() => void showDiff()}
      disabled={loading}
    >
      {diff ? 'Hide diff' : loading ? 'Loading…' : 'Diff'}
    </Button>
  ) : (
    // Holds Diff's place, so a credential or a link lines up with the rows around it.
    <Button
      size="sm"
      variant="quiet"
      className={styles.slot}
      disabled
      tabIndex={-1}
      aria-hidden="true"
    >
      Diff
    </Button>
  );
  return (
    <li className={styles.entry}>
      <div className={styles.entryMain}>
        <span className={styles.path} title={entry.path}>
          {entry.flags.includes('credential') ? '🔒 ' : ''}
          {kind === 'symlink' ? '↪ ' : ''}
          {entry.path}
        </span>
        <span className={styles.chips}>
          <Chip tone={CHANGE_TONE[entry.change]}>{changeLabel(entry)}</Chip>
          {entry.flags.map((f) =>
            FLAG_CHIP[f] ? (
              <Chip key={f} tone="warning">
                {FLAG_CHIP[f]}
              </Chip>
            ) : null,
          )}
          {entry.state === 'done' ? <Chip tone="success">done</Chip> : null}
          {entry.state === 'failed' ? <Chip tone="danger">failed</Chip> : null}
        </span>
        {/* Diff, then the action at the right edge: the same column in a review and in a run. */}
        {editable ? (
          <span className={styles.entryAct}>
            {diffButton}
            <NativeSelect<SyncAction>
              aria-label={`Action for ${entry.path}`}
              className={styles.actionSelect}
              value={entry.action}
              disabled={busy}
              onChange={(a) => onAction(entry.id, a)}
              options={[
                ...(entry.action === 'review' ? (['review'] as const) : []),
                ...options,
              ].map((a) => ({ value: a, label: actionLabel(entry, a) }))}
            />
          </span>
        ) : (
          <span className={styles.entryAct}>
            {diffButton}
            <span className={styles.actionText}>
              {repo && entry.change !== 'same'
                ? 'with its repository'
                : actionLabel(entry, entry.action)}
            </span>
          </span>
        )}
      </div>
      {entry.action === 'keep-both' && entry.copyPath ? (
        <p className={styles.hint}>
          The server’s version is kept beside it as{' '}
          <span className={styles.mono}>{entry.copyPath}</span>, on both sides.
        </p>
      ) : null}
      {note ? <p className={entry.error ? styles.error : styles.hint}>{note}</p> : null}
      {diff ? <DiffView diff={diff} /> : null}
    </li>
  );
}
