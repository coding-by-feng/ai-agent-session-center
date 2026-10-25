/**
 * FilterBar — the Library's one row of filters (Oct 23 2026): search, Agent, Scope (and Project),
 * Favourites, and a Filters menu that holds what is used less (Show plugin & system, the tags).
 * Before, those took four rows above the list. Whatever the menu has on shows under the bar as a
 * removable chip, so a hidden filter never explains an empty list by itself.
 */
import { useMemo } from 'react';
import type { ResourceProject } from '@/types/resources';
import type { AgentFilter, ResourceViewParams, ScopeFilter } from '@/lib/resourceFilters';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import Menu, { type MenuSection } from '@/components/ui/Menu';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import styles from '@/styles/modules/Resources.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';

const AGENT_OPTIONS: readonly NativeSelectOption<AgentFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'shared', label: 'Shared' },
];
const SCOPE_OPTIONS: readonly NativeSelectOption<ScopeFilter>[] = [
  { value: 'all', label: 'All' },
  { value: 'global', label: 'Global' },
  { value: 'project', label: 'Project' },
];

export interface FilterBarProps {
  params: ResourceViewParams;
  queryDraft: string;
  projects: readonly ResourceProject[];
  onQuery: (query: string) => void;
  onAgent: (agent: AgentFilter) => void;
  onScope: (scope: ScopeFilter) => void;
  onProject: (projectId: string) => void;
  onTogglePlugins: () => void;
  /** Favourites and tags (the user's own notes, src/lib/skillNotes.ts). */
  favOnly: boolean;
  tags: readonly string[];
  tagChoices: readonly { tag: string; count: number }[];
  onFav: () => void;
  onTag: (tag: string) => void;
  /** Turn off the menu's filters (plugin & system, tags). */
  onClearMore: () => void;
}

export default function FilterBar({
  params,
  queryDraft,
  projects,
  onQuery,
  onAgent,
  onScope,
  onProject,
  onTogglePlugins,
  favOnly,
  tags,
  tagChoices,
  onFav,
  onTag,
  onClearMore,
}: FilterBarProps) {
  const projectOptions = useMemo<NativeSelectOption[]>(
    () => [
      { value: '', label: 'All projects' },
      ...[...projects]
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
        .map((p) => ({ value: p.id, label: p.duplicateName ? `${p.name} — ${p.path}` : p.name })),
    ],
    [projects],
  );
  const moreOn = (params.showPluginSystem ? 1 : 0) + tags.length;
  const sections: MenuSection[] = [
    {
      id: 'show',
      title: 'Show',
      items: [
        {
          kind: 'checkbox',
          id: 'plugins',
          label: 'Plugin & system resources',
          hint: 'Shipped by plugins or the CLIs; hidden and uncounted until this is on.',
          checked: params.showPluginSystem,
          onSelect: onTogglePlugins,
        },
      ],
    },
  ];
  if (tagChoices.length > 0) {
    sections.push({
      id: 'tags',
      title: 'Tags',
      items: tagChoices.map(({ tag, count }) => ({
        kind: 'checkbox' as const,
        id: `tag:${tag}`,
        label: `#${tag} · ${count}`,
        checked: tags.includes(tag),
        onSelect: () => onTag(tag),
      })),
    });
  }
  return (
    <>
      <div className={styles.filters}>
        <TextInput
          type="search"
          className={styles.search}
          aria-label="Search resources"
          placeholder="Search name, description, path…"
          value={queryDraft}
          onChange={(e) => onQuery(e.target.value)}
        />
        <Field label="Agent" className={styles.filterField}>
          <NativeSelect
            className={styles.filterSelect}
            value={params.agent}
            onChange={onAgent}
            options={AGENT_OPTIONS}
          />
        </Field>
        <Field label="Scope" className={styles.filterField}>
          <NativeSelect
            className={styles.filterSelect}
            value={params.scope}
            onChange={onScope}
            options={SCOPE_OPTIONS}
          />
        </Field>
        {params.scope === 'project' && (
          <Field label="Project" className={styles.filterField}>
            <NativeSelect
              className={styles.filterSelect}
              value={params.projectId ?? ''}
              onChange={onProject}
              options={projectOptions}
            />
          </Field>
        )}
        <Button pressed={favOnly} onClick={onFav}>
          <span aria-hidden="true">{favOnly ? '♥ ' : '♡ '}</span>Favourites
        </Button>
        <Menu
          label="More filters"
          triggerLabel={moreOn > 0 ? `More filters, ${moreOn} on` : 'More filters'}
          triggerText={moreOn > 0 ? `Filters · ${moreOn}` : 'Filters'}
          active={moreOn > 0}
          size="md"
          align="end"
          sections={sections}
        />
      </div>
      {moreOn > 0 && (
        <div className={lib.activeFilters} role="group" aria-label="Filters that are on">
          {params.showPluginSystem && (
            <Button
              size="sm"
              onClick={onTogglePlugins}
              aria-label="Stop showing plugin and system resources"
            >
              Plugin & system <span aria-hidden="true">✕</span>
            </Button>
          )}
          {tags.map((tag) => (
            <Button
              key={tag}
              size="sm"
              onClick={() => onTag(tag)}
              aria-label={`Remove the #${tag} filter`}
            >
              #{tag} <span aria-hidden="true">✕</span>
            </Button>
          ))}
          {moreOn > 1 && (
            <Button size="sm" variant="quiet" onClick={onClearMore}>
              Clear these
            </Button>
          )}
        </div>
      )}
    </>
  );
}
