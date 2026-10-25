// permissionCap.ts — the permission-mode cap (Ruling P4-5): a central opens or relaunches nothing looser than the mode
// its own card runs in. `openWorker` (a new worker's mode) and `openThroughRoute` (a resume, reconnect, fork or clone
// of a card) both ask here.
//
// The cap is the central's CARD (`resolveCentralSession(...).permissionMode`), else its record's mode, never anything a
// request body says; a mode AASC does not know (a Codex central's card has none) caps at `default`.
//
// A card's own mode is the looser of what the card says and what its stored commands would launch (its startupCommand,
// sshCommand and SSH config's command: the relaunch routes reuse them): a relaunch runs that command, so a card the
// person later switched to `plan` that was started with `--dangerously-skip-permissions` relaunches as bypass. Claude's
// `--permission-mode X` and `--dangerously-skip-permissions`; Codex's `--dangerously-bypass-approvals-and-sandbox`,
// `--yolo`, `danger-full-access`, an approval policy of `never` and a `--profile`/`-p` (a profile can set any approval
// policy and sandbox) (bypass) and `--full-auto` (acceptEdits). A mode AASC does not know, on the card or after
// `--permission-mode`, is kept as it is and ranks loosest (Ruling P3-26).

import type { Session } from '../../src/types/session.js';
import { resolveCentralSession } from './centrals.js';
import type { ToolContext } from './registry.js';
import { ToolError } from './types.js';

/** How loose each permission mode is; `auto` and `dontAsk` are as loose as each other. */
export const MODE_RANK: Readonly<Record<string, number>> = Object.freeze({
  plan: 0,
  default: 1,
  acceptEdits: 2,
  auto: 3,
  dontAsk: 3,
  bypassPermissions: 4,
});
export const DEFAULT_MODE = 'default';
export const BYPASS_MODE = 'bypassPermissions';

const known = (mode: string | null | undefined): mode is string =>
  typeof mode === 'string' && Object.prototype.hasOwnProperty.call(MODE_RANK, mode);

/** A mode's rank; one AASC does not know counts as the loosest (a cap never lets an unknown through). */
const rankOf = (mode: string): number => (known(mode) ? MODE_RANK[mode] : MODE_RANK[BYPASS_MODE]);

/** What a stored command launches with, as flags read as text (a quoted title cannot make a mode stricter). */
const COMMAND_MODES: ReadonlyArray<[RegExp, string]> = [
  [/--dangerously-skip-permissions\b/, BYPASS_MODE],
  [/--dangerously-bypass-approvals-and-sandbox\b/, BYPASS_MODE],
  [/(?:^|\s)--yolo\b/, BYPASS_MODE],
  [/\bdanger-full-access\b/, BYPASS_MODE],
  [/(?:^|\s)(?:-a|--ask-for-approval)(?:\s+|=)["']?never\b/, BYPASS_MODE],
  [/\bapproval_policy\s*=\s*["']?never\b/, BYPASS_MODE],
  [/(?:^|\s)(?:-p|--profile)(?:\s+|=)/, BYPASS_MODE],
  [/(?:^|\s)--full-auto\b/, 'acceptEdits'],
];
const PERMISSION_MODE_FLAG = /--permission-mode(?:\s+|=)["']?([^\s"']+)/g;

/** The loosest mode a stored command names, or null when it names none. */
function commandMode(command: string): string | null {
  let found: string | null = null;
  const take = (mode: string): void => {
    if (found === null || rankOf(mode) > rankOf(found)) found = mode;
  };
  for (const [shape, mode] of COMMAND_MODES) if (shape.test(command)) take(mode);
  for (const match of command.matchAll(PERMISSION_MODE_FLAG)) take(match[1]);
  return found;
}

/**
 * The mode a card runs in, and would relaunch in: the looser of its own and its stored commands'; else `default`. A
 * mode AASC does not know is answered as it is, so `rankOf` ranks it loosest.
 */
export function effectiveModeOf(s: Session): string {
  const own = typeof s.permissionMode === 'string' && s.permissionMode !== '' ? s.permissionMode : null;
  const stored = [s.startupCommand, s.sshCommand, s.sshConfig?.command].filter((c): c is string => typeof c === 'string' && c !== '');
  const fromCommand = stored.map(commandMode).filter((m): m is string => m !== null);
  const modes = [...(own === null ? [] : [own]), ...fromCommand];
  if (modes.length === 0) return DEFAULT_MODE;
  return modes.reduce((loosest, m) => (rankOf(m) > rankOf(loosest) ? m : loosest));
}

/** The central's cap: its card's mode, else its record's; one AASC does not know is `default`. */
export function centralCap(ctx: Pick<ToolContext, 'central' | 'sessions'>): string {
  const card = resolveCentralSession(ctx.central.centralId, ctx.sessions());
  const own = card?.permissionMode ?? ctx.central.permissionMode ?? null;
  return known(own) ? own : DEFAULT_MODE;
}

/** DENIED when `mode` is looser than the central's cap. The words never repeat the mode. */
export function assertWithinCap(ctx: Pick<ToolContext, 'central' | 'sessions'>, mode: string): void {
  if (rankOf(mode) > MODE_RANK[centralCap(ctx)]) {
    throw new ToolError(
      'DENIED',
      'A central opens or relaunches sessions no looser than its own permission mode.',
      'Pick a session that runs in your own mode or a stricter one, or ask the person.',
    );
  }
}
