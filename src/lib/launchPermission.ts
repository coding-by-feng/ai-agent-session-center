/**
 * @module launchPermission
 * The permission modes a project frame's quick-launch button offers, per CLI,
 * and the one picked last — which the menu opens on, so relaunching the usual
 * way is Enter or one click.
 *
 * The flags are the CLIs' own (`claude --help`, `codex --help`). Bypass is
 * `--dangerously-skip-permissions` rather than `--permission-mode
 * bypassPermissions`: it is the spelling `DEFAULT_SESSION_COMMANDS` and the
 * server's `reconstructPermissionFlags` already use.
 *
 * The last pick is kept per CLI: a Codex mode must never end up on a Claude
 * command. Anything unreadable or no longer offered reads as Default, which is
 * what the buttons ran before there was a choice.
 */
import type { CliCommand } from '@/components/layout/cliLaunchers';

export const LAUNCH_PERMISSION_KEY = 'quick-launch-permission';

export interface PermissionMode {
  id: string;
  label: string;
  /** Appended to the CLI's name; empty for the plain command. */
  flags: string;
}

const DEFAULT_MODE: PermissionMode = { id: 'default', label: 'Default', flags: '' };

const MODES: Readonly<Record<CliCommand, readonly PermissionMode[]>> = {
  claude: [
    DEFAULT_MODE,
    { id: 'acceptEdits', label: 'Accept edits', flags: '--permission-mode acceptEdits' },
    { id: 'plan', label: 'Plan', flags: '--permission-mode plan' },
    { id: 'auto', label: 'Auto', flags: '--permission-mode auto' },
    { id: 'bypass', label: 'Bypass permissions', flags: '--dangerously-skip-permissions' },
  ],
  codex: [
    DEFAULT_MODE,
    { id: 'bypass', label: 'Bypass approvals & sandbox', flags: '--dangerously-bypass-approvals-and-sandbox' },
  ],
};

export function permissionModes(cli: CliCommand): readonly PermissionMode[] {
  return MODES[cli];
}

/** The command line for `cli` in `modeId`; the plain command for a mode it does not have. */
export function commandForMode(cli: CliCommand, modeId: string): string {
  const mode = MODES[cli].find((m) => m.id === modeId);
  return mode?.flags ? `${cli} ${mode.flags}` : cli;
}

// Every project frame shows the last pick, so a pick in one frame (or another
// window, via `storage`) must re-render the others: a useSyncExternalStore source.
const listeners = new Set<() => void>();

function loadAll(): Partial<Record<CliCommand, string>> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAUNCH_PERMISSION_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Partial<Record<CliCommand, string>>) : {};
  } catch {
    return {};
  }
}

/** The mode last picked for `cli`, or Default. */
export function lastPermissionMode(cli: CliCommand): string {
  const stored = loadAll()[cli];
  return MODES[cli].some((m) => m.id === stored) ? stored! : DEFAULT_MODE.id;
}

export function rememberPermissionMode(cli: CliCommand, modeId: string): void {
  try {
    localStorage.setItem(LAUNCH_PERMISSION_KEY, JSON.stringify({ ...loadAll(), [cli]: modeId }));
  } catch { /* storage full or blocked: the menu just opens on Default next time */ }
  listeners.forEach((notify) => notify());
}

export function subscribePermissionModes(onChange: () => void): () => void {
  listeners.add(onChange);
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The stored picks as a string, which compares by value between renders. */
export function permissionModesSnapshot(): string {
  try {
    return localStorage.getItem(LAUNCH_PERMISSION_KEY) ?? '';
  } catch {
    return '';
  }
}
