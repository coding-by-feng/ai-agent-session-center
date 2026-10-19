/**
 * ChangesView — what this session edited (AASC-44), the Changes segment:
 *
 *   3 files changed by this session           +42 −7
 *   ┌───────────────────────────────────────────────┐
 *   │ icons.tsx                         +1 −1     › │
 *   │ src/components/ui/ · 2 min ago                │
 *   └───────────────────────────────────────────────┘
 *   Source: this session’s edits, not the whole project.
 *
 * Newest edit first; a file opens its diff (DiffScreen). Built from the session's
 * own edit calls (§6.4), so it shows the agent's work, not the working tree. A
 * secret file is listed but its content is hidden on phones.
 */
import type { Session } from '@/types';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import type { PhoneChangedFile } from '@/lib/chat/changesApi';
import { useSessionChanges } from '@/stores/changesStore';
import { basename, countsLabel, dirname, plural, relativeTime } from '@/lib/chat/chatFormat';
import { diffPath } from '@/lib/chat/phoneRoutes';
import { Button, EmptyState, ListRow, ListSection } from '../kit';
import { LockIcon } from './chatViewIcons';
import styles from '@/styles/modules/mobile/Changes.module.css';

const MINUS = '−';

export function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.counts} role="img" aria-label={countsLabel({ added, removed })}>
      {added > 0 && <span className={styles.added} aria-hidden="true">+{added}</span>}
      {removed > 0 && <span className={styles.removed} aria-hidden="true">{MINUS}{removed}</span>}
    </span>
  );
}

/**
 * The Changes segment's badge: "+42 −7" (both counts in words for a screen reader).
 * Under 420px the segment is too narrow for both, so only the added count shows.
 */
/**
 * The Changes tab's badge: how many files changed ("Changes 12"), short enough for
 * four tabs on a phone (Oct 19 2026; it was "+748 −12"). The line counts are spoken.
 */
export function ChangesBadge({ total }: { total: { added: number; removed: number; files: number } }) {
  return (
    <>
      <span aria-hidden="true">{total.files}</span>
      <span className={styles.srOnly}>{`, ${plural(total.files, 'file')} changed, ${countsLabel(total)}`}</span>
    </>
  );
}

function FileRow({ file, onOpen }: { file: PhoneChangedFile; onOpen: () => void }) {
  const where = [dirname(file.path), relativeTime(file.lastAt)].filter(Boolean).join(' · ');
  return (
    <ListRow
      tall
      title={<span className={styles.fileName}>{basename(file.path)}</span>}
      subtitle={file.redacted
        ? <span className={styles.hidden}><LockIcon size={14} />Hidden on phones: a secret file</span>
        : <span className={styles.fileWhere}>{where}</span>}
      trailing={<Counts added={file.added} removed={file.removed} />}
      chevron
      onClick={onOpen}
      ariaLabel={`${file.path}, ${countsLabel(file)}${file.redacted ? ', hidden on phones' : ''}`}
    />
  );
}

export interface ChangesViewProps {
  session: Session;
  onTerminal: () => void;
}

export default function ChangesView({ session, onTerminal }: ChangesViewProps) {
  const { sessionId } = session;
  const push = usePhoneNavStore((s) => s.push);
  const { data, isPending, error, refetch, isFetching } = useSessionChanges(sessionId);

  if (isPending) {
    return <div className={styles.empty}><EmptyState live title="Loading changes…" /></div>;
  }

  if (!data) {
    return (
      <div className={styles.empty}>
        <EmptyState
          title="Couldn’t load the changes"
          message={error ?? undefined}
          action={<Button variant="primary" onClick={() => void refetch()} loading={isFetching}>Try again</Button>}
        />
      </div>
    );
  }

  if (data.files.length === 0) {
    const noTranscript = data.cli === null;
    return (
      <div className={styles.empty} data-testid="changes-empty">
        <EmptyState
          title={noTranscript ? 'This session has no transcript' : 'No edits yet'}
          message={noTranscript
            ? 'It’s a shell or another tool. Use Terminal.'
            : 'Files this session edits show up here, newest first.'}
          action={noTranscript ? <Button variant="primary" onClick={onTerminal}>Open Terminal</Button> : undefined}
        />
      </div>
    );
  }

  return (
    <div className={styles.changes} data-testid="phone-changes">
      <div className={styles.summary}>
        <span className={styles.summaryText}>{plural(data.files.length, 'file')} changed by this session</span>
        <Counts added={data.total.added} removed={data.total.removed} />
      </div>
      <ListSection
        label="Changed files"
        footer={data.truncated
          ? 'Source: this session’s edits. More than 200 files: the ones edited longest ago are left out.'
          : 'Source: this session’s edits, not the whole project.'}
      >
        {data.files.map((file, index) => (
          <FileRow key={file.path} file={file} onOpen={() => push(diffPath(sessionId, index))} />
        ))}
      </ListSection>
      {error && <p className={styles.stale} role="status">Couldn’t refresh ({error}): showing the last list.</p>}
    </div>
  );
}
