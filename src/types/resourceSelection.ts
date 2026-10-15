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

/** Cloud policy is independent of legacy SSH transfer adapters. */
export function cloudPublicationBlocker(r: ResourceSummary): string | null {
  if (r.managedAlias)
    return 'Managed alias: publish its real target and synchronize its notes intent instead.';
  if (r.origin !== 'user' || r.linkTarget)
    return 'Only user-owned resources without links can be published. Reinstall managed resources using their provider.';
  if (!['skill', 'command', 'rule', 'agent', 'instructions', 'memory'].includes(r.type))
    return 'This resource needs a dedicated credential-free adapter.';
  if (r.orphaned) return 'Map this memory to an existing local project before publication.';
  if (!r.hash) return 'Rescan: the resource could not be fully hashed.';
  return null;
}
