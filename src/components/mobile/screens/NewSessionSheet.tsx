/**
 * NewSessionSheet — ＋ on the Sessions tab (AASC-40, design §5.9).
 *
 *   New session
 *   RECENT PROJECTS
 *   agent-manager            [Claude] [Codex]
 *   ~/Documents/claude/agent-manager
 *   …
 *   [ Other folder or more options… ]
 *
 * One tap starts Claude or Codex in a project you have worked in; the new
 * session is selected, and the frame's selection bridge opens its Chat. "Other
 * folder or more options…" opens the full form (folder, model, effort, flags,
 * room), full screen on a phone. A paired phone may start only claude or codex
 * in a known folder (server/mobile/phoneProfile.ts), which is exactly what a
 * chip sends; the Mac says why when it refuses (launchSession toasts it).
 */
import { useCallback, useRef, useState } from 'react';
import { Button, ListSection, Sheet } from '../kit';
import { CLI_LAUNCHERS, type CliCommand } from '@/components/layout/cliLaunchers';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { launchBlocker, launchSession, shortenPath } from '@/lib/launchSession';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/mobile/Sessions.module.css';

export interface NewSessionSheetProps {
  open: boolean;
  onClose: () => void;
  /** Put this folder first (a project group's "New session here"). */
  preferDir?: string | null;
  /** Why nothing can start now (reconnecting); the chips say it. */
  blocker?: string | null;
}

const DETENTS = ['medium', 'large'] as const;
/** The recent projects listed; the full form reaches any folder. */
export const RECENT_PROJECT_LIMIT = 8;

function ProjectRow({
  dir,
  pending,
  blocker,
  onLaunch,
}: {
  dir: string;
  pending: string | null;
  blocker: string | null;
  onLaunch: (dir: string, command: CliCommand) => void;
}) {
  const name = shortenPath(dir);
  const pathBlocker = launchBlocker(dir);
  const why = blocker ?? (pathBlocker ? `Can’t start here: ${pathBlocker}` : null);
  return (
    <li className={styles.projectRow}>
      <span className={styles.projectText}>
        <span className={styles.projectName}>{name}</span>
        <span className={styles.projectPath}>{dir}</span>
      </span>
      <span className={styles.projectChips}>
        {CLI_LAUNCHERS.map(({ command, label, Icon }) => {
          const key = `${dir}\u0000${command}`;
          const otherPending = pending !== null && pending !== key;
          return (
            <Button
              key={command}
              small
              icon={<Icon size={16} />}
              loading={pending === key}
              loadingLabel={`Starting ${label} in ${name}`}
              disabledReason={why ?? (otherPending ? 'Starting another session…' : undefined)}
              aria-label={`New ${label} session in ${name}`}
              onClick={() => onLaunch(dir, command)}
            >
              {label}
            </Button>
          );
        })}
      </span>
    </li>
  );
}

function NewSessionList({ onClose, preferDir, blocker }: { onClose: () => void; preferDir?: string | null; blocker: string | null }) {
  const known = useKnownProjects();
  const dirs = (preferDir ? [preferDir, ...known.filter((d) => d !== preferDir)] : known).slice(0, RECENT_PROJECT_LIMIT);
  const [pending, setPending] = useState<string | null>(null);
  // `pending` lands on the next render; this stops a second tap before it.
  const inFlight = useRef(false);

  const launch = useCallback(async (dir: string, command: CliCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(`${dir}\u0000${command}`);
    try {
      const result = await launchSession({ workingDir: dir, command, forceNew: true, requireExistingDir: true });
      if (result.ok) onClose();
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }, [onClose]);

  const openFullForm = useCallback(() => {
    onClose();
    useUiStore.getState().openModal('new-session');
  }, [onClose]);

  return (
    <>
      {dirs.length > 0 ? (
        <ListSection header="Recent projects" footer="One tap starts the session and opens its chat.">
          {dirs.map((dir) => (
            <ProjectRow key={dir} dir={dir} pending={pending} blocker={blocker} onLaunch={launch} />
          ))}
        </ListSection>
      ) : (
        <p className={styles.sheetLead}>No projects yet. Choose a folder in the full form.</p>
      )}
      <div className={styles.sheetFooter}>
        <Button block onClick={openFullForm} disabledReason={blocker ?? undefined}>Other folder or more options…</Button>
      </div>
    </>
  );
}

export default function NewSessionSheet({ open, onClose, preferDir, blocker = null }: NewSessionSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="New session" detents={DETENTS} testId="new-session-sheet">
      {/* Mounted only while open, so the known-projects fetch runs then. */}
      {open && <NewSessionList onClose={onClose} preferDir={preferDir} blocker={blocker} />}
    </Sheet>
  );
}
