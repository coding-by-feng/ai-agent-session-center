/**
 * TabBar — the phone frame's bottom navigation (AASC-38/39): icon + label per
 * tab, an optional count badge, 56px plus the home-indicator inset.
 *
 * Presentational: the frame decides which tab is active, what a tap on the
 * ACTIVE tab does (scroll to top, then pop to root) and when the bar hides
 * (keyboard open, inside a session). Hidden means removed from the layout and
 * the accessibility tree, not just covered.
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/mobile/TabBar.module.css';

export interface TabBarItem<T extends string> {
  id: T;
  label: string;
  icon: ReactNode;
  /** A count worth a badge (> 0), e.g. sessions waiting for you. */
  badge?: number;
  /** How the badge reads aloud: "3 waiting". */
  badgeLabel?: (count: number) => string;
}

export interface TabBarProps<T extends string> {
  items: ReadonlyArray<TabBarItem<T>>;
  active: T;
  onSelect: (id: T) => void;
  hidden?: boolean;
}

export const BADGE_CAP = 99;

export default function TabBar<T extends string>({ items, active, onSelect, hidden }: TabBarProps<T>) {
  if (hidden) return null;
  return (
    <nav className={styles.bar} aria-label="Main">
      {items.map((item) => {
        const count = item.badge ?? 0;
        const isActive = item.id === active;
        const spoken = count > 0 ? `${item.label}, ${item.badgeLabel ? item.badgeLabel(count) : count}` : item.label;
        return (
          <button
            key={item.id}
            type="button"
            className={styles.tab}
            aria-current={isActive ? 'page' : undefined}
            aria-label={spoken}
            data-tab={item.id}
            onClick={() => onSelect(item.id)}
          >
            <span className={styles.iconWrap}>
              {item.icon}
              {count > 0 && (
                <span className={styles.badge} aria-hidden="true" data-testid={`tab-badge-${item.id}`}>
                  {count > BADGE_CAP ? `${BADGE_CAP}+` : count}
                </span>
              )}
            </span>
            <span className={styles.label} aria-hidden="true">{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
