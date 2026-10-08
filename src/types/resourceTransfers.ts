import type { ResourceAgent, ResourceScope, ResourceSummary, ResourceType } from './resources.js';

export interface ResourceSelector {
  scope?: ResourceScope;
  projectId?: string;
  type?: ResourceType;
  agent?: ResourceAgent;
  resourceId?: string;
}
/** Ordered rules: the last matching rule wins, so a leaf can exclude a parent selection. */
export interface ResourceSelectionRule extends ResourceSelector {
  include: boolean;
}
export type ResourceSelection = ResourceSelectionRule[];
export function matchesResourceSelector(r: ResourceSummary, s: ResourceSelector): boolean {
  return (
    (s.scope === undefined || s.scope === r.scope) &&
    (s.projectId === undefined || s.projectId === r.projectId) &&
    (s.type === undefined || s.type === r.type) &&
    (s.agent === undefined || s.agent === r.agent) &&
    (s.resourceId === undefined || s.resourceId === r.id)
  );
}
/** Replace duplicate selectors while preserving the order of overlapping parent/leaf rules. */
export function withResourceSelection(
  selection: ResourceSelection,
  additions: ResourceSelection,
): ResourceSelection {
  const latest = new Map<string, ResourceSelectionRule>();
  for (const rule of [...selection, ...additions]) {
    const key = JSON.stringify([
      rule.scope,
      rule.projectId,
      rule.type,
      rule.agent,
      rule.resourceId,
    ]);
    latest.delete(key);
    latest.set(key, rule);
  }
  return [...latest.values()];
}
export function resourceIsSelected(r: ResourceSummary, rules: ResourceSelection): boolean {
  let selected = false;
  for (const rule of rules) if (matchesResourceSelector(r, rule)) selected = rule.include;
  return selected;
}
export function transferBlocker(r: ResourceSummary): string | null {
  if (r.origin !== 'user' || r.linkTarget)
    return 'Only user-owned resources without links can be copied. Reinstall managed resources on the destination.';
  if (!['skill', 'command', 'rule', 'agent'].includes(r.type))
    return 'This resource needs a dedicated migration adapter; it is not copied in this version.';
  if (!r.hash) return 'Rescan: the resource could not be fully hashed.';
  return null;
}
export interface TransferDeviceInput {
  name: string;
  host: string;
  username: string;
  port: number;
}
export interface TransferDevice extends TransferDeviceInput {
  id: string;
  fingerprint: string;
  home: string;
  platform: string;
  checkedAt: number;
}
export interface TransferTarget {
  deviceId: string;
  projects: Record<string, string>;
}
export interface TransferDraft {
  name: string;
  selection: ResourceSelection;
  targets: TransferTarget[];
}
export type TransferAction = 'add' | 'replace' | 'skip' | 'review';
export interface TransferItem {
  id: string;
  deviceId: string;
  resourceId: string;
  name: string;
  sourcePath: string;
  destinationPath: string;
  sourceHash?: string;
  destinationHash?: string | null;
  action: TransferAction;
  state: 'pending' | 'copying' | 'complete' | 'failed' | 'skipped' | 'restored';
  reason?: string;
  warnings?: string[];
  patch?: string;
  files?: { path: string; status: 'add' | 'change' | 'remove' | 'same' }[];
  requiredBy?: string[];
  backupId?: string;
  error?: string;
}
export interface TransferTask extends TransferDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  state:
    | 'draft'
    | 'review'
    | 'running'
    | 'complete'
    | 'partial'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  items: TransferItem[];
}
export interface TransferOverview {
  devices: TransferDevice[];
  tasks: TransferTask[];
}
