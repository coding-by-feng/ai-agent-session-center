/**
 * ResourceList — the middle column: one type's resources under the current
 * filters, each row naming where it lives and how it relates to its copies.
 *
 * Badges answer the questions a row raises before it is opened: which agent,
 * which scope (or project), who produced it (plugin/system/synced/linked),
 * whether the agent-skills repo agrees (no chip when the repo doesn't collect
 * that category — "not tracked" on every memory row would be noise), and
 * whether its Claude/Codex twin has drifted.
 */
import { useEffect, useId, useLayoutEffect, useRef } from 'react';
import type { RepoStatus, ResourceProject, ResourceSummary, ResourceType } from '@/types/resources';
import {
  AGENT_LABELS,
  RESOURCE_TYPE_LABELS,
  hasVariantDiff,
  originTag,
  repoChipLabel,
  revealDelta,
  scopeName,
} from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

interface ResourceListProps {
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
  onSelect: (id: string) => void;
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
  onSelect,
}: {
  resource: ResourceSummary;
  selected: boolean;
  projectsById: ReadonlyMap<string, ResourceProject>;
  onSelect: (id: string) => void;
}) {
  const origin = originTag(r);
  const repo = repoChipLabel(r.repo.status);
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
      </span>{' '}
      <span className={styles.rowSecondary}>{r.description || r.path}</span>
    </button>
  );
}

export default function ResourceList({
  type,
  resources,
  selectedId,
  projectsById,
  emptyMessage,
  scrollResetKey,
  onSelect,
}: ResourceListProps) {
  const headingId = useId();
  const paneRef = useRef<HTMLElement>(null);

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
      <h2 id={headingId} className={styles.paneHeading}>
        {RESOURCE_TYPE_LABELS[type]} · {resources.length}
      </h2>
      {resources.length === 0 ? (
        <p className={styles.emptyNote}>{emptyMessage}</p>
      ) : (
        <ul className={styles.list} aria-label="Resources">
          {resources.map((r) => (
            <li key={r.id}>
              <ResourceRow
                resource={r}
                selected={r.id === selectedId}
                projectsById={projectsById}
                onSelect={onSelect}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
