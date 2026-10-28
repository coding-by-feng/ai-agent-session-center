/**
 * ProjectFrameHeader — the row at the top of a PROJECT frame in the session
 * strip: a fold toggle, then one button per CLI that starts a NEW session in the
 * project's directory, so "one more Claude in this repo" is a single click from
 * the place its other sessions are listed.
 *
 * Things here that are easy to get wrong:
 *
 *  - The buttons send `forceNew`. Without it the server answers a request that
 *    matches a live session (same directory, same command) by handing that
 *    session back, and the button would look dead.
 *  - They send `requireExistingDir`. The server starts a shell in the HOME
 *    directory when the one asked for is gone, which for a project frame means an
 *    agent with write tools running in `~` under a "Launched" toast.
 *  - Because every accepted request now starts a PTY, a double-click would start
 *    two. Both buttons of the frame are held until the request returns, with
 *    `aria-disabled` rather than `disabled`: a focused button that becomes
 *    `disabled` drops keyboard focus to <body>.
 *  - The session the server starts has no room, and with a room filter on the
 *    strip would never show it. It joins the project's room (`projectLaunchRoom`).
 *  - A button opens a menu of permission modes (`launchPermission`) rather than
 *    launching: the menu opens on the mode picked last for that CLI, checked and
 *    focused, so the usual launch is still one more click or Enter. A held button
 *    does not open it. The menu is portaled, but React still bubbles its clicks
 *    through this tree, so the wrapper stops them before they reach the frame.
 *
 * Three cases get no usable launch buttons:
 *
 *  - A project on another machine: the request carries no host, so it would start
 *    a local session in a directory that may not exist here.
 *  - A device that is not the machine hosting the dashboard (a phone on the LAN).
 *    A session is created hidden from every device but the host until it is
 *    shared, so each tap there would start a PTY running an AI CLI that the phone
 *    can never see, select or kill, under a "Launched" toast. The server's own
 *    presence list says who is local; "not confirmed local" fails closed, as it
 *    does for the RESOURCES tab.
 *  - A path the server always refuses (`launchBlocker`: parentheses, `$`, …). The
 *    buttons stay, disabled, and say why: a folder named `site (old)` is ordinary,
 *    and a button that fails with a toast on every click looks broken.
 */
import { useCallback, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { CLI_LAUNCHERS, type CliCommand } from '@/components/layout/cliLaunchers';
import Menu from '@/components/ui/Menu';
import { getClientId } from '@/lib/deviceIdentity';
import {
  commandForMode,
  lastPermissionMode,
  permissionModes,
  permissionModesSnapshot,
  rememberPermissionMode,
  subscribePermissionModes,
} from '@/lib/launchPermission';
import { launchBlocker } from '@/lib/launchSession';
import type { ProjectGroup } from '@/lib/projectGroups';
import { launchInProjectGroup } from '@/lib/projectLaunch';
import { isLocalDevice, usePresenceStore } from '@/stores/presenceStore';
import { FrameCollapseIcon } from './SessionFrameIcons';
import styles from '@/styles/modules/DetailPanel.module.css';

interface Props {
  group: ProjectGroup;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

/** The "new" in "new session". Beside a brand mark it keeps the button from
 *  reading as a CLI badge, which is what a lone Claude or Codex mark means on
 *  the session cards below. */
function PlusGlyph() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" aria-hidden="true">
      <path d="M4 1v6M1 4h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Keeps a click on a chip, or on its portaled menu, from reaching the frame around it. */
const stopClick = (e: MouseEvent) => e.stopPropagation();

export default function ProjectFrameHeader({ group, collapsed, onToggleCollapse }: Props) {
  const [pending, setPending] = useState<CliCommand | null>(null);
  // `pending` only changes on the next render; this closes the gap for a second
  // click that arrives before it.
  const inFlight = useRef(false);
  const onHostMachine = usePresenceStore((s) => isLocalDevice(s.devices, getClientId()));
  const blocker = group.local ? launchBlocker(group.launchPath) : null;
  // Re-render when any frame records a pick; the value itself is read below.
  useSyncExternalStore(subscribePermissionModes, permissionModesSnapshot);

  const launch = useCallback(
    async (cli: CliCommand, modeId: string) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(cli);
      rememberPermissionMode(cli, modeId);
      try {
        await launchInProjectGroup(group, commandForMode(cli, modeId));
      } finally {
        inFlight.current = false;
        setPending(null);
      }
    },
    [group],
  );

  return (
    <div className={styles.roomHeaderRow}>
      <button
        type="button"
        className={styles.roomCollapseToggle}
        onClick={(e) => {
          e.stopPropagation();
          onToggleCollapse();
        }}
        title={collapsed ? `Expand ${group.label}` : `Collapse ${group.label}`}
        aria-label={collapsed ? `Expand project ${group.label}` : `Collapse project ${group.label}`}
        aria-expanded={!collapsed}
      >
        <FrameCollapseIcon collapsed={collapsed} />
      </button>
      {group.local && onHostMachine && (
        <>
          <span className={styles.roomHeaderDivider} aria-hidden="true" />
          {CLI_LAUNCHERS.map(({ command, label, Icon }) => {
            const unavailable = blocker !== null || pending !== null;
            const lastMode = lastPermissionMode(command);
            const modes = permissionModes(command);
            const lastLabel = modes.find((m) => m.id === lastMode)?.label;
            return (
              <span key={command} className={styles.projectLaunchMenu} onClick={stopClick}>
                <Menu
                  label={`${label} permission mode`}
                  triggerLabel={`New ${label} session in ${group.label}`}
                  sections={[{
                    id: 'mode',
                    title: 'Permission mode',
                    items: modes.map((mode) => ({
                      kind: 'radio' as const,
                      id: mode.id,
                      label: mode.label,
                      hint: commandForMode(command, mode.id),
                      checked: mode.id === lastMode,
                      onSelect: () => void launch(command, mode.id),
                    })),
                  }]}
                  plainTrigger={{
                    className: styles.projectLaunchBtn,
                    held: unavailable,
                    busy: pending === command,
                    title: blocker ? `Can't start a session here: ${blocker}` : `New ${label} session in ${group.label} · last: ${lastLabel}`,
                    content: (
                      <>
                        <Icon size={14} />
                        <PlusGlyph />
                      </>
                    ),
                  }}
                />
              </span>
            );
          })}
        </>
      )}
      {collapsed && <span className={styles.roomCollapsedCount}>{group.sessions.length}</span>}
    </div>
  );
}
