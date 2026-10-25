/**
 * @module cloudSyncStates
 * One name, tone and order per AASC-62 sync state, shared by the Library row glyph, the detail
 * pane's cloud button, the bulk bar and the Cloud sync list (Oct 23 2026), so a state reads the
 * same everywhere. Import-free apart from types.
 */
import type { SyncItem, SyncState } from '@/types/cloudResources';

export type SyncTone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
/** Where the Cloud sync list files a state (Needs you → Waiting → Synced → Stopped → Removed). */
export type SyncGroup = 'needs-you' | 'waiting' | 'synced' | 'stopped' | 'removed';

export const SYNC_STATE_INFO: Readonly<
  Record<SyncState, { label: string; tone: SyncTone; group: SyncGroup }>
> = {
  conflict: { label: 'Changed in both places', tone: 'warning', group: 'needs-you' },
  blocked: { label: "Can't sync", tone: 'danger', group: 'needs-you' },
  'local-changed': { label: 'Changed on this Mac', tone: 'info', group: 'waiting' },
  'cloud-newer': { label: 'Newer in cloud', tone: 'info', group: 'waiting' },
  'cloud-only': { label: 'Only in cloud', tone: 'neutral', group: 'waiting' },
  synced: { label: 'Synced', tone: 'success', group: 'synced' },
  stopped: { label: 'Stopped on this Mac', tone: 'neutral', group: 'stopped' },
  removed: { label: 'Removed from cloud', tone: 'neutral', group: 'removed' },
};

export const SYNC_GROUPS: readonly { id: SyncGroup; label: string }[] = [
  { id: 'needs-you', label: 'Needs you' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'synced', label: 'Synced' },
  { id: 'stopped', label: 'Stopped on this Mac' },
  { id: 'removed', label: 'Removed from cloud' },
];

/** States Sync now moves (a conflict only with a choice, memory only with an OK). */
export const MOVING_STATES: readonly SyncState[] = [
  'local-changed',
  'cloud-newer',
  'cloud-only',
  'conflict',
];

/** The group an item is filed under: memory that would move waits for your OK, so it needs you. */
export function syncGroup(item: Pick<SyncItem, 'state' | 'memory'>): SyncGroup {
  if (item.memory && MOVING_STATES.includes(item.state)) return 'needs-you';
  return SYNC_STATE_INFO[item.state].group;
}

/** "v3 here · v4 in cloud", "cloud has v2", "not in cloud yet", "v3", or nothing. */
export function syncVersionText(
  i: Pick<SyncItem, 'state' | 'cloudVersion' | 'syncedVersion'>,
): string {
  if (i.state === 'local-changed')
    return i.cloudVersion ? `cloud has v${i.cloudVersion}` : 'not in cloud yet';
  if ((i.state === 'cloud-newer' || i.state === 'conflict') && i.syncedVersion && i.cloudVersion)
    return `v${i.syncedVersion} here · v${i.cloudVersion} in cloud`;
  if (i.state === 'removed') return i.syncedVersion ? `was v${i.syncedVersion}` : '';
  return i.cloudVersion ? `v${i.cloudVersion}` : '';
}

/**
 * Library types that can be saved to cloud: the server's portable adapters (skill, command, rule,
 * agent, instructions, memory), user-owned and not a link. The server still reviews each one
 * (secrets, packet limits) before anything uploads.
 */
const SAVABLE_TYPES = new Set(['skill', 'command', 'rule', 'agent', 'instructions', 'memory']);
export function canSaveToCloud(r: {
  type: string;
  origin: string;
  linkTarget?: string | null;
}): boolean {
  return SAVABLE_TYPES.has(r.type) && r.origin === 'user' && !r.linkTarget;
}
