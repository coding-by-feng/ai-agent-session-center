/**
 * ResourceTypeRail — the TYPE column: all ten resource types with counts.
 *
 * Zero rows stay, dimmed rather than removed: "Instructions 0" under
 * Claude · Global says there is no global CLAUDE.md, which a missing row
 * cannot. Counts come from `countByType` — the same predicate the list filters
 * with — so a row's number always matches the list it opens.
 */
import { useEffect, useRef } from 'react';
import type { ResourceType } from '@/types/resources';
import { revealDelta, type TypeCount } from '@/lib/resourceFilters';
import styles from '@/styles/modules/Resources.module.css';

interface ResourceTypeRailProps {
  counts: TypeCount[];
  selected: ResourceType;
  onSelect: (type: ResourceType) => void;
}

export default function ResourceTypeRail({ counts, selected, onSelect }: ResourceTypeRailProps) {
  const railRef = useRef<HTMLElement>(null);

  // Below 900px the rail is a sideways-scrolling strip: a deep link to
  // Memory must not leave the selected chip scrolled out of sight.
  useEffect(() => {
    const rail = railRef.current;
    const item = rail?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!rail || !item) return;
    const box = rail.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    rail.scrollLeft += revealDelta({ start: box.left, end: box.right }, { start: rect.left, end: rect.right });
    rail.scrollTop += revealDelta({ start: box.top, end: box.bottom }, { start: rect.top, end: rect.bottom });
  }, [selected]);

  return (
    <nav ref={railRef} className={styles.rail} aria-label="Resource types">
      <div className={styles.paneHeading} aria-hidden="true">Type</div>
      <ul className={styles.railList}>
        {counts.map(({ type, label, count }) => {
          const active = type === selected;
          const className = [
            styles.railItem,
            active ? styles.railItemActive : '',
            count === 0 ? styles.railItemEmpty : '',
          ].filter(Boolean).join(' ');
          return (
            <li key={type} className={styles.railEntry}>
              <button type="button" className={className} aria-pressed={active} onClick={() => onSelect(type)}>
                <span className={styles.railLabel}>{label}</span>{' '}
                <span className={styles.railCount}>{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
