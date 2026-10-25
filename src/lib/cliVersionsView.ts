/**
 * What the desktop's Settings ▸ ADVANCED ▸ Agent CLIs and the phone's Settings → Advanced show for
 * one CLI: its name, one status line and whether its Update button works. Pure, so both views say
 * the same thing.
 */
import type { AgentCli, CliVersionInfo } from '@/types/cliVersions';

export const CLI_NAMES: Record<AgentCli, string> = { claude: 'Claude Code', codex: 'Codex' };

export type CliTone = 'neutral' | 'available' | 'busy' | 'ok' | 'error';

export interface CliRowView {
  name: string;
  status: string;
  tone: CliTone;
  buttonLabel: string;
  /** Why Update can't be pressed now; undefined when it can. */
  disabledReason?: string;
}

/**
 * @param info  this CLI's version info
 * @param busy  the CLI whose update is running anywhere, or null (one runs at a time)
 */
export function describeCli(info: CliVersionInfo, busy: AgentCli | null): CliRowView {
  const name = CLI_NAMES[info.cli];
  const { update } = info;
  if (update.state === 'updating') {
    return { name, status: `Updating from ${update.from ?? info.installed ?? 'an unknown version'}…`, tone: 'busy', buttonLabel: 'Updating…', disabledReason: 'The update is running.' };
  }
  const otherBusy = busy && busy !== info.cli ? `${CLI_NAMES[busy]} is updating; one update runs at a time.` : undefined;
  if (!info.installed) {
    return { name, status: 'Not found on this Mac', tone: 'neutral', buttonLabel: 'Update', disabledReason: `${name} isn’t installed where the Mac’s terminals can find it.` };
  }
  const base = {
    name,
    buttonLabel: 'Update',
    disabledReason: otherBusy ?? (info.updateAvailable || info.latest === null ? undefined : 'Already the newest version.'),
  };
  if (update.state === 'failed') return { ...base, status: `Update failed: ${update.error || 'unknown error'}`, tone: 'error', disabledReason: otherBusy };
  if (update.state === 'updated') {
    return { ...base, status: `Updated ${update.from ?? '?'} → ${update.to ?? info.installed}. New sessions use it; restart running ones to switch.`, tone: 'ok' };
  }
  if (update.state === 'current' && info.updateAvailable) {
    return { ...base, status: `${info.installed} is the newest on its release channel (npm has ${info.latest})`, tone: 'neutral', disabledReason: otherBusy ?? 'Its release channel has nothing newer.' };
  }
  if (info.updateAvailable) return { ...base, status: `${info.installed} · ${info.latest} available`, tone: 'available' };
  if (info.latest === null) return { ...base, status: `${info.installed} · couldn’t check for a newer version`, tone: 'neutral' };
  return { ...base, status: `${info.installed} · up to date`, tone: 'ok' };
}

/** "0:42", "4:05": minutes and seconds of a duration. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The finished update's log toggle: "Show log (12 lines · took 0:48)". */
export function logToggleLabel(lines: number, tookMs: number | null, open: boolean): string {
  if (open) return 'Hide log';
  const parts = [`${lines} ${lines === 1 ? 'line' : 'lines'}`];
  if (tookMs !== null) parts.push(`took ${formatElapsed(tookMs)}`);
  return `Show log (${parts.join(' · ')})`;
}
