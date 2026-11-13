/**
 * phoneResourcesModel.ts — the words More → Resources shows (plan 16). Each comes from the
 * desktop RESOURCES tab's own helper where one exists (resourceFilters, resourceUsage,
 * projectState), so a resource or a checkout reads the same on both. Pure: no DOM, no store.
 */
import type { ResourceSummary, ResourceType } from '@/types/resources';
import type { GithubAccounts } from '@/types/cloudProjects';
import type { PhoneLibrary, PhoneProject, PhoneUsageScope } from '@/types/phoneResources';
import type { ResourcesTab } from './phoneRoutes';
import { AGENT_LABELS, RESOURCE_TYPE_SINGULAR, SCOPE_LABELS, formatBytes, originTag, relativeAge } from '../resourceFilters';
import { isUsageCounted, totalUses, usesLabel } from '../resourceUsage';
import type { SyncTone } from '../cloudSyncStates';
import { cloudCount } from '../cloudFormat';
import { projectStatus } from '@/components/resources/cloud/projectState';

export const RESOURCES_TAB_LABELS: Record<ResourcesTab, string> = {
  library: 'Library',
  projects: 'Projects',
};

export type PhoneProjectRef = PhoneLibrary['projects'][number];

/** "Global", the owning project's name, or "Project" when the phone doesn't know it. */
export function whereWords(r: Pick<ResourceSummary, 'scope' | 'projectId'>, projects: ReadonlyMap<string, PhoneProjectRef>): string {
  if (r.scope === 'global' && !r.projectId) return SCOPE_LABELS.global;
  return (r.projectId && projects.get(r.projectId)?.name) || (r.scope === 'global' ? SCOPE_LABELS.global : SCOPE_LABELS.project);
}

/** A row's first line under the name: "Claude · Global", "Codex · shared-app · plugin". */
export function resourceMeta(r: ResourceSummary, projects: ReadonlyMap<string, PhoneProjectRef>): string {
  return [AGENT_LABELS[r.agent], whereWords(r, projects), originTag(r)].filter(Boolean).join(' · ');
}

/** A row's use count: "17 uses", or "—" read as "not used"; null for a type nothing invokes or while unknown. */
export function rowUses(r: Pick<ResourceSummary, 'id' | 'type'>, usage: PhoneLibrary['usage']): { text: string; label: string } | null {
  if (!usage || !isUsageCounted(r.type)) return null;
  const n = totalUses(usage.byId[r.id]);
  return n > 0 ? { text: usesLabel(n), label: usesLabel(n) } : { text: '—', label: 'not used' };
}

/** Said once under the counts, because a phone's number can be lower than the Mac's. */
export function usageScopeNote(scope: PhoneUsageScope | undefined): string | null {
  return scope === 'shared' ? 'Uses count only the sessions shared with this phone.' : null;
}

/** The detail screen's facts, as the desktop's detail header lists them. */
export function resourceFacts(
  r: ResourceSummary,
  projects: ReadonlyMap<string, PhoneProjectRef>,
  now: number,
): { title: string; value: string }[] {
  return [
    { title: 'Kind', value: RESOURCE_TYPE_SINGULAR[r.type] },
    { title: 'For', value: AGENT_LABELS[r.agent] },
    { title: 'Where', value: whereWords(r, projects) },
    ...(r.origin !== 'user' ? [{ title: 'From', value: r.pluginName ? `${r.origin} · ${r.pluginName}` : r.origin }] : []),
    { title: 'Size', value: `${formatBytes(r.bytes)}${r.fileCount > 1 ? ` · ${r.fileCount} files` : ''}` },
    { title: 'Changed', value: relativeAge(r.mtimeMs, now) },
  ];
}

/** Why a rule (and the other always-loaded types) has no count. */
export function noCountWords(type: ResourceType): string | null {
  if (isUsageCounted(type)) return null;
  return type === 'rule' || type === 'instructions' || type === 'memory'
    ? `No use count: ${type === 'memory' ? 'memory' : `a ${RESOURCE_TYPE_SINGULAR[type].toLowerCase()}`} loads into every session, and nothing invokes it.`
    : null;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export function repoWords(p: Pick<PhoneProject, 'owner' | 'repo' | 'branch'>): string {
  return `github.com/${p.owner}/${p.repo} · ${p.branch}`;
}

/** What a project's row says about its checkout on the Mac (the desktop's `projectStatus`). */
export function projectStateWords(p: PhoneProject): { label: string; tone: SyncTone; hint?: string } {
  if (!p.local) return { label: 'Couldn’t check', tone: 'neutral', hint: 'Your Mac couldn’t read this checkout just now.' };
  // The phone only reads: a live agent changes nothing it can do, so it never says so.
  const { label, tone, hint } = projectStatus({ ...p.local, openUrl: null, localProjectId: null, agentActive: false }, p.branch);
  return { label, tone: tone === 'accent' ? 'info' : tone, ...(hint ? { hint } : {}) };
}

/** A project's detail rows about its checkout on the Mac; empty when the Mac has none to read. */
export function checkoutFacts(p: PhoneProject): { title: string; value: string }[] {
  const local = p.local;
  if (!local?.path) return [];
  const facts = [{ title: 'Branch here', value: local.branch ?? 'None (detached)' }];
  if (local.ahead !== null) facts.push({ title: 'To push', value: local.ahead === 0 ? 'Nothing' : cloudCount(local.ahead, 'commit') });
  if (local.behind !== null) facts.push({ title: 'To pull', value: local.behind === 0 ? 'Nothing' : cloudCount(local.behind, 'commit') });
  if (local.account) facts.push({ title: 'GitHub account', value: local.account });
  return facts;
}

export function accountsWords(a: GithubAccounts): string {
  if (!a.installed) return 'The GitHub CLI isn’t on your Mac. Projects use its own Git sign-in.';
  if (a.accounts.length === 0) return 'No GitHub account is signed in on your Mac.';
  return a.accounts.map((x) => `${x.login}${x.active ? ' (active)' : ''}`).join(', ');
}
