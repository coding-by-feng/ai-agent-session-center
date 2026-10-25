/**
 * ResourceList — the middle column: one type's resources under the current
 * filters, each row naming where it lives and how it relates to its copies.
 *
 * Badges answer the questions a row raises before it is opened: which agent,
 * which scope (or project), who produced it (plugin/system/synced/linked),
 * whether the agent-skills repo agrees (no chip when the repo doesn't collect
 * that category — "not tracked" on every memory row would be noise), and
 * whether its Claude/Codex twin has drifted. Since Oct 23 2026 a row also ends in its cloud state
 * (CloudStateGlyph; nothing when it does not sync), and the list header holds **Select**: on, each
 * row gets a checkbox, the header a Select all, and the bulk bar slot shows under the rows.
 * Oct 23 2026: a skill or command row's second line ends in its uses over the last 90 days
 * ("17 uses", or "—"), and those two lists can be sorted by them (`sort`, `onSort`). The count
 * sits on the description line, not the first: in the 336 px column the badges fill the first
 * line, and a count wrapping there took a line of its own.
 */
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import type { RepoStatus, ResourceProject, ResourceSummary, ResourceType, ResourceUsage } from '@/types/resources';
import type { SyncState } from '@/types/cloudResources';
import { stripShortcutPrefix, type ResourceShortcuts } from '@/lib/commandShortcuts';
import {
  AGENT_LABELS,
  RESOURCE_TYPE_LABELS,
  hasVariantDiff,
  originTag,
  repoChipLabel,
  revealDelta,
  scopeName,
} from '@/lib/resourceFilters';
import { useSkillNotesStore } from '@/stores/skillNotesStore';
import { isNotable, noteForResource, type SkillNote } from '@/lib/skillNotes';
import { FavToggle } from './SkillNotes';
import CloudStateGlyph from './CloudStateGlyph';
import type { LibraryUsage } from './useResourceUsage';
import { isUsageCounted, sharedNote, totalUses, usesLabel, type ResourceSort } from '@/lib/resourceUsage';
import Button from '@/components/ui/Button';
import NativeSelect from '@/components/ui/NativeSelect';
import noteStyles from '@/styles/modules/SkillNotes.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';
import styles from '@/styles/modules/Resources.module.css';
import selectionStyles from '@/styles/modules/ResourceSelection.module.css';

/** A row's cloud state (only resources that sync have one). */
export interface RowCloudState {
  state: SyncState;
  moving: boolean;
}

interface ResourceListProps {
  /** Checked rows, while Select is on; absent while it is off. */
  selectionIds?: ReadonlySet<string>;
  onResourceSelect?: (id: string, include: boolean) => void;
  /** The header's Select toggle; without it the list has no selection. */
  onToggleSelecting?: () => void;
  /** Check or uncheck every listed row. */
  onSelectAll?: (ids: readonly string[], include: boolean) => void;
  /** Library id → cloud state, for the rows that sync. */
  cloud?: ReadonlyMap<string, RowCloudState>;
  /** Shown pinned under the rows (the bulk bar). */
  footer?: ReactNode;
  /** Skill/command uses, once read; absent until then (no count shows). */
  usage?: LibraryUsage | null;
  /** The list's order; the Sort select shows only for skills and commands. */
  sort?: ResourceSort;
  onSort?: (sort: ResourceSort) => void;
  type: ResourceType;
  resources: ResourceSummary[];
  selectedId: string | null;
  projectsById: ReadonlyMap<string, ResourceProject>;
  emptyMessage: string;
  /**
   * Changes whenever the list's contents are redefined (type or any filter).
   * The pane element is reused across those changes, so without a reset a
   * list opens at whatever offset the previous one was scrolled to.
   */
  scrollResetKey: string;
  /** Shortcut commands ↔ their targets (src/lib/commandShortcuts.ts). */
  shortcuts: ResourceShortcuts;
  onSelect: (id: string) => void;
}

const SORT_OPTIONS = [
  { value: 'name', label: 'By name' },
  { value: 'uses', label: 'Most used' },
] as const;

/** "17 uses", or a dash when it was not used in the window. */
function UsesCount({ usage, windowDays }: { usage: ResourceUsage | undefined; windowDays: number }) {
  const n = totalUses(usage);
  if (!usage || n === 0) {
    return (
      <span className={lib.rowUses} title={`Not used in the last ${windowDays} days`}>
        <span aria-hidden="true">—</span>
        <span className={styles.visuallyHidden}>not used</span>
      </span>
    );
  }
  const split = [usage.typed > 0 && `${usage.typed} typed by you`, usage.agent > 0 && `${usage.agent} by the agent`].filter(Boolean).join(', ');
  return (
    <span className={lib.rowUses} title={`${usesLabel(n)} in the last ${windowDays} days: ${split}${sharedNote(usage)}`}>
      {usesLabel(n)}
    </span>
  );
}

const REPO_CHIP_CLASS: Record<RepoStatus, string> = {
  same: styles.chipOk,
  differs: styles.chipWarn,
  'not-in-repo': styles.chipMuted,
  'not-tracked': '',
};

function Badge({ className, children }: { className?: string; children: string }) {
  return <span className={className ? `${styles.badge} ${className}` : styles.badge}>{children}</span>;
}

function ResourceRow({
  resource: r,
  selected,
  projectsById,
  shortcuts,
  note,
  cloud,
  usage,
  onSelect,
}: {
  resource: ResourceSummary;
  selected: boolean;
  projectsById: ReadonlyMap<string, ResourceProject>;
  shortcuts: ResourceShortcuts;
  /** The user's own marks on it (tags, abbreviation); the heart is separate. */
  note: SkillNote | null;
  cloud?: RowCloudState;
  usage?: LibraryUsage | null;
  onSelect: (id: string) => void;
}) {
  const origin = originTag(r);
  const repo = repoChipLabel(r.repo.status);
  const target = shortcuts.targetOf.get(r.id);
  const aliases = shortcuts.aliasesOf.get(r.id);
  const secondary = <span className={styles.rowSecondary}>{(target ? stripShortcutPrefix(r.description ?? '') : r.description) || r.path}</span>;
  return (
    <button
      type="button"
      className={selected ? `${styles.row} ${styles.rowSelected}` : styles.row}
      aria-current={selected ? 'true' : undefined}
      title={r.path}
      onClick={() => onSelect(r.id)}
    >
      <span className={styles.rowName}>{r.name}</span>{' '}
      {/* The {' '} between badges gives screen readers word breaks; a flex
          container drops whitespace-only text, so it costs nothing visually. */}
      <span className={styles.rowBadges}>
        <Badge>{AGENT_LABELS[r.agent]}</Badge>{' '}
        <Badge>{scopeName(r, projectsById)}</Badge>
        {origin && <>{' '}<Badge className={styles.chipOrigin}>{origin}</Badge></>}
        {repo && <>{' '}<Badge className={REPO_CHIP_CLASS[r.repo.status]}>{repo}</Badge></>}
        {hasVariantDiff(r) && <>{' '}<Badge className={styles.chipWarn}>≠ variant</Badge></>}
        {r.orphaned && <>{' '}<Badge className={styles.chipError}>orphaned</Badge></>}
        {target && <>{' '}<Badge className={styles.chipOrigin}>{`→ ${target.name}`}</Badge></>}
        {aliases && <>{' '}<Badge className={styles.chipOrigin}>{`shortcut ${aliases.map((a) => `/${a.name}`).join(' ')}`}</Badge></>}
        {note?.abbr && <>{' '}<Badge className={styles.chipOrigin}>{`abbr ${note.abbr}`}</Badge></>}
        {note?.tags.map((t) => <span key={t}>{' '}<Badge className={styles.chipMuted}>{`#${t}`}</Badge></span>)}
      </span>{' '}
      {cloud && <span className={lib.rowCloud}><CloudStateGlyph state={cloud.state} moving={cloud.moving} /></span>}{' '}
      {usage && isUsageCounted(r.type) ? (
        <span className={lib.rowFoot}>
          {secondary}{' '}
          <UsesCount usage={usage.byId.get(r.id)} windowDays={usage.windowDays} />
        </span>
      ) : secondary}
    </button>
  );
}

export default function ResourceList({
  selectionIds,
  onResourceSelect,
  onToggleSelecting,
  onSelectAll,
  cloud,
  footer,
  usage,
  sort = 'name',
  onSort,
  type,
  resources,
  selectedId,
  projectsById,
  emptyMessage,
  scrollResetKey,
  shortcuts,
  onSelect,
}: ResourceListProps) {
  const headingId = useId();
  const paneRef = useRef<HTMLElement>(null);
  // One subscription for every row; a row re-renders only when its note changes.
  const notes = useSkillNotesStore((s) => s.notes);

  // Before paint, so a new type never flashes at the old offset. Runs before
  // the reveal effect below, which then brings a still-listed selection back.
  useLayoutEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = 0;
  }, [scrollResetKey]);

  // A selection made elsewhere (a Checks finding, a variant jump, a deep link)
  // can sit far down a 200-row memory list; bring it into view. A row the user
  // just clicked is already visible, so this is a no-op for clicks.
  useEffect(() => {
    const pane = paneRef.current;
    const row = pane?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!pane || !row) return;
    const box = pane.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    pane.scrollTop += revealDelta({ start: box.top, end: box.bottom }, { start: rect.top, end: rect.bottom });
  }, [selectedId, scrollResetKey]);

  return (
    <section ref={paneRef} className={styles.listPane} aria-labelledby={headingId}>
      <div className={lib.listHeader}>
        <h2 id={headingId} className={`${styles.paneHeading} ${lib.listHeading}`}>
          {RESOURCE_TYPE_LABELS[type]} · {resources.length}
        </h2>
        {onSort && isUsageCounted(type) && resources.length > 1 && (
          <NativeSelect aria-label="Sort" value={sort} onChange={onSort} options={SORT_OPTIONS} />
        )}
        {selectionIds && resources.length > 0 && onSelectAll && (
          <SelectAll resources={resources} selectionIds={selectionIds} onSelectAll={onSelectAll} />
        )}
        {onToggleSelecting && (
          <Button size="sm" pressed={!!selectionIds} onClick={onToggleSelecting}>
            Select
          </Button>
        )}
      </div>
      {resources.length === 0 ? (
        <p className={styles.emptyNote}>{emptyMessage}</p>
      ) : (
        <ul className={styles.list} aria-label="Resources">
          {resources.map((r) => (
            <li
              key={r.id}
              className={[selectionIds ? selectionStyles.bulkRow : '', isNotable(r) ? noteStyles.rowWrap : ''].filter(Boolean).join(' ') || undefined}
            >
              {selectionIds && <input className={selectionStyles.bulkCheck} type="checkbox" aria-label={`Select ${r.name} (${r.agent})`} checked={selectionIds.has(r.id)} onChange={e => onResourceSelect?.(r.id, e.target.checked)} />}
              <FavToggle resource={r} />
              <ResourceRow
                resource={r}
                selected={r.id === selectedId}
                projectsById={projectsById}
                shortcuts={shortcuts}
                note={noteForResource(notes, r)}
                cloud={cloud?.get(r.id)}
                usage={usage}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
      {footer}
    </section>
  );
}

/** "Select all 353": checked when every listed row is, mixed when some are. */
function SelectAll({
  resources,
  selectionIds,
  onSelectAll,
}: {
  resources: readonly ResourceSummary[];
  selectionIds: ReadonlySet<string>;
  onSelectAll: (ids: readonly string[], include: boolean) => void;
}) {
  const checked = resources.filter((r) => selectionIds.has(r.id)).length;
  const all = checked === resources.length;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = checked > 0 && !all;
  }, [checked, all]);
  return (
    <label className={lib.selectAll}>
      <input
        ref={ref}
        type="checkbox"
        className={selectionStyles.bulkCheck}
        checked={all}
        onChange={() => onSelectAll(resources.map((r) => r.id), !all)}
      />
      Select all {resources.length}
    </label>
  );
}
