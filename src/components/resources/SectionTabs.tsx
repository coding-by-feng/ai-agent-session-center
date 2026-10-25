/**
 * SectionTabs — the RESOURCES tab row (Oct 23 2026): Library · Cloud sync · Projects · Health ·
 * Connection. One row instead of two (the old Cloud section had its own tabs). A count rides on
 * Cloud sync (what is waiting to sync) and on Health (errors and warnings) so neither needs a
 * visit to be noticed. The row scrolls sideways at narrow widths and keeps the open tab in view.
 */
import { useEffect, useRef } from 'react';
import type { ResourceSection } from '@/lib/resourceFilters';
import { RESOURCE_SECTIONS } from '@/lib/resourceFilters';
import CountBadge from '@/components/ui/CountBadge';
import styles from '@/styles/modules/Resources.module.css';
import lib from '@/styles/modules/ResourceLibrary.module.css';

const SECTION_LABELS: Record<ResourceSection, string> = {
  library: 'Library',
  sync: 'Cloud sync',
  projects: 'Projects',
  health: 'Health',
  connection: 'Connection',
};
const BADGE_LABELS: Partial<Record<ResourceSection, (n: number) => string>> = {
  sync: (n) => `${n} waiting to sync`,
  health: (n) => `${n} ${n === 1 ? 'issue' : 'issues'} to look at`,
};

export default function SectionTabs({
  baseId,
  section,
  badges,
  onSelect,
}: {
  baseId: string;
  section: ResourceSection;
  /** A count shown on a tab; 0 or absent shows none. */
  badges: Partial<Record<ResourceSection, number>>;
  onSelect: (section: ResourceSection) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  // Keep the open tab in view by scrolling the strip itself: scrollIntoView would scroll every
  // ancestor too, the page included. Again when a count changes, since a badge that loads after the
  // tab opened widens the tabs before it.
  const counts = RESOURCE_SECTIONS.map((s) => badges[s] ?? 0).join(',');
  useEffect(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !tab) return;
    const strip = list.getBoundingClientRect();
    const open = tab.getBoundingClientRect();
    if (open.left < strip.left) list.scrollLeft -= strip.left - open.left;
    else if (open.right > strip.right) list.scrollLeft += open.right - strip.right;
  }, [section, counts]);
  return (
    <div ref={listRef} className={styles.sectionTabs} role="tablist" aria-label="Resource sections">
      {RESOURCE_SECTIONS.map((s) => {
        const count = badges[s] ?? 0;
        return (
          <button
            key={s}
            type="button"
            role="tab"
            id={`${baseId}-tab-${s}`}
            aria-selected={s === section}
            aria-controls={`${baseId}-panel`}
            className={s === section ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => onSelect(s)}
          >
            <span className={lib.tabLabel}>
              {SECTION_LABELS[s]}
              {/* The space keeps the spoken name "Health 4 issues to look at", not "Health4…"; the
                  flex gap does the visual spacing. */}
              {count > 0 && (
                <>
                  {' '}
                  <CountBadge
                    count={count}
                    max={99}
                    tone="accent"
                    label={BADGE_LABELS[s]?.(count)}
                  />
                </>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
