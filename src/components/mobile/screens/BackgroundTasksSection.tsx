/**
 * BackgroundTasksSection — the top of a phone session's Agents tab (Oct 25 2026): Claude Code's own
 * Background panel ("82 agents · 1 active shell", each shell and agent with its status) as of the
 * session's last Stop (`session.backgroundTasks`, server/backgroundTasks.ts). A shell opens a
 * details sheet. Read-only: Claude sends no output and AASC has no way to stop a task.
 */
import { useState } from 'react';
import { ListRow, ListSection, Sheet } from '../kit';
import { useSessionStore } from '@/stores/sessionStore';
import {
  backgroundKind,
  backgroundSummary,
  backgroundTitle,
  clockTime,
  hiddenCount,
  isRunning,
} from '@/lib/backgroundTasksView';
import type { BackgroundItem } from '@/types/session';
import styles from '@/styles/modules/mobile/BackgroundTasks.module.css';

const FAILED = new Set(['failed', 'killed', 'error']);

function StatusDot({ item }: { item: BackgroundItem }) {
  const tone = isRunning(item) ? styles.dotRunning : FAILED.has(item.status) ? styles.dotFailed : '';
  return <span className={`${styles.dot} ${tone}`} aria-hidden="true" />;
}

function ShellDetails({ item, onClose }: { item: BackgroundItem | null; onClose: () => void }) {
  return (
    <Sheet open={item !== null} onClose={onClose} title="Shell details" testId="phone-background-shell">
      {item && (
        <>
          <dl className={styles.details}>
            <dt>Status</dt>
            <dd>{item.status || 'running'}</dd>
            <dt>Seen since</dt>
            <dd>{clockTime(item.firstSeenAt)}</dd>
            {item.command && (
              <>
                <dt>Command</dt>
                <dd className={styles.command}>{item.command}</dd>
              </>
            )}
            {item.description && (
              <>
                <dt>Description</dt>
                <dd>{item.description}</dd>
              </>
            )}
          </dl>
          <p className={styles.note}>
            Claude Code doesn’t send a shell’s output or start time. Open the Terminal tab and its Background panel to see
            the output.
          </p>
        </>
      )}
    </Sheet>
  );
}

export default function BackgroundTasksSection({ sessionId }: { sessionId: string }) {
  const background = useSessionStore((s) => s.sessions.get(sessionId)?.backgroundTasks ?? null);
  const [open, setOpen] = useState<BackgroundItem | null>(null);
  if (!background) return null;
  const hidden = hiddenCount(background);
  return (
    <div className={styles.section} data-testid="phone-background">
      <ListSection
        header={`Background · as of ${clockTime(background.at)}`}
        footer="Claude Code’s Background list, updated each time the session finishes a turn."
      >
        <ListRow title={backgroundSummary(background)} />
        {background.items.map((item) => {
          const shell = item.type === 'shell';
          return (
            <ListRow
              key={item.id}
              leading={<StatusDot item={item} />}
              title={backgroundTitle(item)}
              subtitle={`${backgroundKind(item)} · ${item.status || 'running'}`}
              chevron={shell}
              onClick={shell ? () => setOpen(item) : undefined}
              ariaLabel={shell ? `Shell details: ${backgroundTitle(item)}` : undefined}
              testId={`phone-background-${item.id}`}
            />
          );
        })}
        {hidden > 0 && <ListRow title={`${hidden} more not shown`} />}
      </ListSection>
      <ShellDetails item={open} onClose={() => setOpen(null)} />
    </div>
  );
}
