/**
 * ProjectFilterBar — the Projects tab's one row of filters (Oct 29 2026), in the Library's shape
 * (FilterBar): search, ♥ Favourites and a Tags menu whose choices show under the row as removable
 * chips, so a hidden filter never explains a short list by itself. ♥ and Tags are left out while
 * AASC Cloud keeps no project tags, and all of them while nothing is listed. Then the List / Cards
 * switch, and the row ends with the tab's one action, Add a GitHub link.
 */
import type { ReactNode } from 'react';
import type { ProjectViewMode } from '@/stores/uiStore';
import Button from '@/components/ui/Button';
import IconButton from '@/components/ui/IconButton';
import Menu from '@/components/ui/Menu';
import SearchInput from '@/components/ui/SearchInput';
import { CompactModeIcon, DetailedModeIcon } from '@/components/ui/icons';
import res from '@/styles/modules/Resources.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';
import styles from '@/styles/modules/CloudResources.module.css';

export default function ProjectFilterBar({
  empty,
  query,
  onQuery,
  withMeta,
  favOnly,
  onFav,
  tags,
  tagChoices,
  onTag,
  onClearTags,
  view,
  onView,
  children,
}: {
  /** Nothing is listed: there is nothing to search or filter. */
  empty: boolean;
  query: string;
  onQuery: (query: string) => void;
  /** AASC Cloud keeps project ♥ and tags. */
  withMeta: boolean;
  favOnly: boolean;
  onFav: () => void;
  tags: readonly string[];
  tagChoices: readonly { tag: string; count: number }[];
  onTag: (tag: string) => void;
  onClearTags: () => void;
  /** Rows or cards (uiStore's projectViewMode). */
  view: ProjectViewMode;
  onView: (view: ProjectViewMode) => void;
  /** The row's action, after the filters. */
  children?: ReactNode;
}) {
  if (empty) return <div className={res.filters}>{children}</div>;
  return (
    <>
      <div className={res.filters}>
        <SearchInput
          variant="field"
          className={res.search}
          value={query}
          onChange={onQuery}
          debounceMs={150}
          placeholder="Search name, folder, repository, tag…"
          ariaLabel="Search projects"
        />
        {withMeta && (
          <Button pressed={favOnly} onClick={onFav}>
            <span aria-hidden="true">{favOnly ? '♥ ' : '♡ '}</span>Favourites
          </Button>
        )}
        {withMeta && tagChoices.length > 0 && (
          <Menu
            label="Tags"
            triggerLabel={tags.length > 0 ? `Tags, ${tags.length} on` : 'Tags'}
            triggerText={tags.length > 0 ? `Tags · ${tags.length}` : 'Tags'}
            active={tags.length > 0}
            size="md"
            align="end"
            sections={[
              {
                id: 'tags',
                items: tagChoices.map(({ tag, count }) => ({
                  kind: 'checkbox' as const,
                  id: `tag:${tag}`,
                  label: `#${tag} · ${count}`,
                  checked: tags.includes(tag),
                  onSelect: () => onTag(tag),
                })),
              },
            ]}
          />
        )}
        <span className={styles.viewSwitch} role="group" aria-label="View">
          <IconButton label="List view" pressed={view === 'list'} onClick={() => onView('list')}>
            <CompactModeIcon />
          </IconButton>
          <IconButton label="Card view" pressed={view === 'card'} onClick={() => onView('card')}>
            <DetailedModeIcon />
          </IconButton>
        </span>
        {children}
      </div>
      {withMeta && tags.length > 0 && (
        <div className={lib.activeFilters} role="group" aria-label="Tags that are on">
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
          {tags.length > 1 && (
            <Button size="sm" variant="quiet" onClick={onClearTags}>
              Clear these
            </Button>
          )}
        </div>
      )}
    </>
  );
}
