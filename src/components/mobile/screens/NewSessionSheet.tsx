/**
 * NewSessionSheet — ＋ on the Sessions tab (AASC-40, design §5.9).
 *
 *   New session
 *   [ Browse folders… ] [ More options… ]
 *   RECENT PROJECTS
 *   agent-manager            [Claude] [Codex]
 *   ~/Documents/claude/agent-manager
 *   …
 *
 * One tap starts Claude or Codex in a project you have worked in; the new
 * session is selected, and the frame's selection bridge opens its Chat.
 * The projects come most used first (GET /known-projects ranks them by
 * sessions in the last 30 days, then latest activity); this phone's own
 * history doesn't jump the queue, and no rows show until that ranking arrives,
 * so a row never moves under a tap. Browse and More options sit above the list
 * so a long list never pushes them out of sight.
 * "Browse folders…" (AASC-54) picks any folder under the home folder
 * that isn't hidden or private; it then sits at the top with the same chips,
 * and a folder no agent has worked in asks "Start in a new folder?" first.
 * "More options…" opens the full form (title, room, model, effort), full screen
 * on a phone, with the chosen folder in it. A paired phone may start only claude or codex, in a folder the
 * Mac allows (server/mobile/phoneProfile.ts), which is exactly what a chip
 * sends; the Mac says why when it refuses (launchSession toasts it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ListSection, Sheet } from '../kit';
import NewFolderConfirm from '../NewFolderConfirm';
import PhoneFolderBrowser from '../PhoneFolderBrowser';
import { CLI_LAUNCHERS, type CliCommand } from '@/components/layout/cliLaunchers';
import { useRankedProjects } from '@/hooks/useKnownProjects';
import { isKnownFolder } from '@/lib/folderBrowser';
import { launchBlocker, launchSession, shortenPath } from '@/lib/launchSession';
import { useSessionStore } from '@/stores/sessionStore';
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
/** The recent projects listed; the folder browser and the full form reach any other folder. */
export const RECENT_PROJECT_LIMIT = 8;

const cliLabel = (command: CliCommand): string => CLI_LAUNCHERS.find((c) => c.command === command)?.label ?? command;

/** Folders an agent has worked in: known projects, this phone's recent folders, live sessions' projects. */
function useUsedFolders(known: readonly string[]): string[] {
  const sessions = useSessionStore((s) => s.sessions);
  return useMemo(() => {
    const used = new Set(known);
    for (const s of sessions.values()) if (s.projectPath) used.add(s.projectPath);
    return [...used];
  }, [known, sessions]);
}

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
  // null until the Mac answers: nothing is listed rather than a list that reorders.
  const ranked = useRankedProjects();
  const known = useMemo(() => ranked ?? [], [ranked]);
  const used = useUsedFolders(known);
  const dirs = (preferDir ? [preferDir, ...known.filter((d) => d !== preferDir)] : known).slice(0, RECENT_PROJECT_LIMIT);
  const [pending, setPending] = useState<string | null>(null);
  // `pending` lands on the next render; this stops a second tap before it.
  const inFlight = useRef(false);
  const [browsing, setBrowsing] = useState(false);
  /** A folder picked in the browser, with the Mac's home folder. */
  const [chosen, setChosen] = useState<{ dir: string; home: string } | null>(null);
  /** A launch waiting for "Start in a new folder?". */
  const [confirm, setConfirm] = useState<{ dir: string; command: CliCommand } | null>(null);
  // The chosen folder lands above the list, out of sight when the sheet was scrolled to its buttons.
  const chosenRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (chosen) chosenRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [chosen]);

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

  // A recent project starts at once; a folder no agent has worked in asks first.
  const requestLaunch = useCallback((dir: string, command: CliCommand) => {
    if (isKnownFolder(dir, used, chosen?.home)) void launch(dir, command);
    else setConfirm({ dir, command });
  }, [used, chosen, launch]);

  const confirmLaunch = useCallback(() => {
    if (!confirm) return;
    setConfirm(null);
    void launch(confirm.dir, confirm.command);
  }, [confirm, launch]);

  const pick = useCallback((dir: string, home: string) => {
    setChosen({ dir, home });
    setBrowsing(false);
  }, []);

  const openFullForm = useCallback(() => {
    onClose();
    useUiStore.getState().openNewSession(chosen?.dir);
  }, [onClose, chosen]);

  return (
    <>
      <div className={styles.sheetActions}>
        <Button block onClick={() => setBrowsing(true)} disabledReason={blocker ?? undefined}>Browse folders…</Button>
        <Button block onClick={openFullForm} disabledReason={blocker ?? undefined}>More options…</Button>
      </div>
      {/* A marker, not a wrapper: the sheet styles its lists as its direct children. */}
      <span ref={chosenRef} aria-hidden="true" />
      {chosen && (
        <ListSection header="Chosen folder" footer={isKnownFolder(chosen.dir, used, chosen.home) ? undefined : 'No agent has worked here yet.'}>
          <ProjectRow dir={chosen.dir} pending={pending} blocker={blocker} onLaunch={requestLaunch} />
        </ListSection>
      )}
      {dirs.length > 0 ? (
        <ListSection header="Recent projects" footer="Most used first. One tap starts the session and opens its chat.">
          {dirs.map((dir) => (
            <ProjectRow key={dir} dir={dir} pending={pending} blocker={blocker} onLaunch={requestLaunch} />
          ))}
        </ListSection>
      ) : (
        ranked !== null && !chosen && <p className={styles.sheetLead}>No projects yet. Browse the Mac’s folders to choose one.</p>
      )}
      <PhoneFolderBrowser
        open={browsing}
        onClose={() => setBrowsing(false)}
        onPick={pick}
        startPath={chosen?.dir ?? null}
        known={used}
      />
      <NewFolderConfirm
        dir={confirm?.dir ?? null}
        cliLabel={confirm ? cliLabel(confirm.command) : ''}
        onConfirm={confirmLaunch}
        onCancel={() => setConfirm(null)}
      />
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
