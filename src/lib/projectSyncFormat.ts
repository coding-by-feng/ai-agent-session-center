/** Pure labels and formatting for Project Sync (kept out of component files for Fast Refresh). */
import type {
  SyncAction,
  SyncChange,
  SyncConflictPolicy,
  SyncDirection,
  SyncEntry,
  SyncGroup,
  SyncLink,
  SyncPull,
  SyncRun,
} from '@/types/projectSync';

/** How a path moved since the last sync, from this computer's point of view. */
export const CHANGE_LABEL: Record<SyncChange, string> = {
  same: 'same',
  add: 'new here',
  change: 'changed here',
  delete: 'deleted here',
  drift: 'changed on the server',
  conflict: 'changed on both',
  extra: 'only on the server',
  different: 'different',
  blocked: 'skipped',
};

export function changeLabel(e: Pick<SyncEntry, 'change' | 'device'>): string {
  return e.change === 'drift' && !e.device ? 'deleted on the server' : CHANGE_LABEL[e.change];
}

const CHOICE = (e: Pick<SyncEntry, 'change'>) =>
  e.change === 'conflict' || e.change === 'different';

/** What an action does to this entry. A conflict reads as a choice between the two versions. */
export function actionLabel(e: Pick<SyncEntry, 'change' | 'device'>, a: SyncAction): string {
  switch (a) {
    case 'push':
      return CHOICE(e) ? 'Keep this computer’s' : 'Copy to the server';
    case 'pull':
      return CHOICE(e) ? 'Keep the server’s' : 'Copy here';
    case 'delete-device':
      return 'Delete on the server (undo keeps it)';
    case 'delete-local':
      return 'Delete here (undo keeps it)';
    case 'keep-both':
      return 'Keep both';
    case 'keep':
      return e.device ? 'Keep the server copy' : 'Leave it deleted on the server';
    case 'skip':
      return 'Skip';
    case 'review':
      return 'Choose…';
  }
}

export const DIRECTION_LABEL: Record<SyncDirection, string> = {
  'two-way': 'Both ways',
  push: 'This computer → server',
};
/** What a direction means, under its select. */
export const DIRECTION_HINT: Record<SyncDirection, string> = {
  'two-way': 'Changes on either side carry over.',
  push: 'The server mirrors this computer. Changes made there are listed for review, never copied here.',
};

/** Two-way: what happens to a file both sides changed since the last sync. */
export const POLICY_LABEL: Record<SyncConflictPolicy, string> = {
  ask: 'Ask me',
  local: 'This computer wins',
};
export const POLICY_OPTIONS: { value: SyncConflictPolicy; label: string }[] = [
  { value: 'ask', label: POLICY_LABEL.ask },
  { value: 'local', label: POLICY_LABEL.local },
];
export const POLICY_HINT: Record<SyncConflictPolicy, string> = {
  ask: 'Each file changed on both sides waits for your choice.',
  local:
    "This computer's version replaces the server's, and a file deleted here is deleted there (undo restores it). The first compare and git repositories still ask.",
};

/** What a pull plan does: "3 new · 1 replaced · 2 kept as they are · 4 already the same". */
export function pullSummary(c: SyncPull['counts']): string {
  const parts: string[] = [];
  if (c.new) parts.push(`${c.new} new`);
  if (c.replace) parts.push(`${c.replace} replaced`);
  if (c.keep) parts.push(`${c.keep} kept as ${c.keep === 1 ? 'it is' : 'they are'} here`);
  if (c.same) parts.push(`${c.same} already the same`);
  if (c.skip) parts.push(`${c.skip} skipped`);
  return parts.join(' · ') || 'Nothing to pull';
}

export const LINK_STATE_LABEL: Record<SyncLink['state'], string> = {
  never: 'Not compared yet',
  'in-sync': 'In sync',
  pending: 'Review waiting',
  attention: 'Needs attention',
  running: 'Working…',
};
export const LINK_STATE_TONE: Record<
  SyncLink['state'],
  'neutral' | 'success' | 'info' | 'warning' | 'accent'
> = {
  never: 'neutral',
  'in-sync': 'success',
  pending: 'info',
  attention: 'warning',
  running: 'accent',
};

export const REPO_STATE_LABEL: Record<NonNullable<SyncGroup['state']>, string> = {
  'in-step': 'in step',
  'local-ahead': 'changed here',
  'device-ahead': 'changed on the server',
  'both-changed': 'changed on both sides',
  'device-changed': 'changed on the server',
  'different-repo': 'a different repository on each side',
  busy: 'git is busy (.lock file)',
};

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024,
    i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export const runSummary = (r: SyncRun) =>
  (Object.entries(r.counts) as [SyncChange, number][])
    .filter(([c, n]) => c !== 'same' && n > 0)
    .map(([c, n]) => `${n} ${CHANGE_LABEL[c]}`)
    .join(' · ') || 'Nothing to change';

/** What a run moves each way, for its head line: "3 to apply · 2.0 KB to send · 1 KB to get". */
export function runTraffic(r: SyncRun): string {
  const parts = [`${r.total} to apply`];
  if (r.bytes.toSend) parts.push(`${formatBytes(r.bytes.toSend)} to send`);
  if (r.bytes.toGet) parts.push(`${formatBytes(r.bytes.toGet)} to get`);
  return parts.join(' · ');
}

/** `~/Documents/x` on this computer → `<server home>/Documents/x` on the server. */
export function suggestRemoteRoot(localPath: string, deviceHome: string): string {
  return localPath.startsWith('~/') ? `${deviceHome}/${localPath.slice(2)}` : '';
}

/** A link's leave-out list as the text box shows it, and back. */
export const excludesText = (list: readonly string[]) => list.join('\n');
export const excludesOf = (text: string) =>
  text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
