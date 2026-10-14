/**
 * QuickLaunchSheet — "New session" on a phone (AASC-18): one row per project
 * you have worked in, each with a Claude and a Codex chip that start a NEW
 * session there, and a way to the full new-session form for anything else.
 *
 * Reached from the LIVE page and from the session drawer. A paired phone may
 * start only claude or codex in a known project folder (server/mobile/
 * phoneProfile.ts), which is exactly what a chip asks for; a session a phone
 * starts is shared with remote devices from its first broadcast (AASC-28), so
 * it shows up here. lib/launchSession.ts selects the new session, which opens
 * its panel, and toasts the outcome.
 */
import { useCallback, useRef, useState } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import { CLI_LAUNCHERS, type CliCommand } from '@/components/layout/cliLaunchers';
import { useKnownProjects } from '@/hooks/useKnownProjects';
import { launchBlocker, launchSession, shortenPath } from '@/lib/launchSession';
import { useUiStore } from '@/stores/uiStore';
import styles from '@/styles/modules/QuickLaunch.module.css';

interface QuickLaunchSheetProps {
  open: boolean;
  onClose: () => void;
  /** A session was started (or the full form opened): the caller may close more than this sheet. */
  onDone?: () => void;
}

function ProjectRow({
  dir,
  pending,
  onLaunch,
}: {
  dir: string;
  /** The launch in flight anywhere in the list, as `dir\0command`. */
  pending: string | null;
  onLaunch: (dir: string, command: CliCommand) => void;
}) {
  const name = shortenPath(dir);
  const blocker = launchBlocker(dir);
  return (
    <li className={styles.row}>
      <span className={styles.project}>
        <span className={styles.name}>{name}</span>
        <span className={styles.path}>{blocker ? `Can't start here: ${blocker}` : dir}</span>
      </span>
      <span className={styles.chips}>
        {CLI_LAUNCHERS.map(({ command, label, Icon }) => {
          const key = `${dir}\u0000${command}`;
          return (
            <Button
              key={command}
              className={styles.chip}
              icon={<Icon size={16} />}
              disabled={blocker !== null || (pending !== null && pending !== key)}
              aria-busy={pending === key ? true : undefined}
              aria-label={`New ${label} session in ${name}`}
              onClick={() => onLaunch(dir, command)}
            >
              {pending === key ? 'Starting…' : label}
            </Button>
          );
        })}
      </span>
    </li>
  );
}

/** The list itself: mounted only while the sheet is open, so the known-projects fetch runs then. */
function QuickLaunchList({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const dirs = useKnownProjects();
  const openModal = useUiStore((s) => s.openModal);
  const [pending, setPending] = useState<string | null>(null);
  // `pending` changes on the next render; this stops a second tap before it.
  const inFlight = useRef(false);

  const launch = useCallback(async (dir: string, command: CliCommand) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(`${dir}\u0000${command}`);
    try {
      const result = await launchSession({ workingDir: dir, command, forceNew: true, requireExistingDir: true });
      if (result.ok) {
        onClose();
        onDone?.();
      }
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  }, [onClose, onDone]);

  const openFullForm = useCallback(() => {
    onClose();
    onDone?.();
    openModal('new-session');
  }, [onClose, onDone, openModal]);

  return (
    <div className={styles.body}>
      <p className={styles.lead}>Start Claude or Codex in a project you have worked in.</p>
      {dirs.length > 0 ? (
        <ul className={styles.list} aria-label="Projects">
          {dirs.map((dir) => (
            <ProjectRow key={dir} dir={dir} pending={pending} onLaunch={launch} />
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>No projects yet. Use the full form to choose a folder.</p>
      )}
      <div className={styles.footer}>
        <Button variant="primary" onClick={openFullForm}>More options…</Button>
      </div>
    </div>
  );
}

export default function QuickLaunchSheet({ open, onClose, onDone }: QuickLaunchSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} title="New session">
      <QuickLaunchList onClose={onClose} onDone={onDone} />
    </BottomSheet>
  );
}
