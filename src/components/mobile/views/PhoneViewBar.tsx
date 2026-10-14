/**
 * PhoneViewBar — the top of a phone view (AASC-20): search and a Filters
 * button on one row, the result summary under them. The filters themselves
 * live in a sheet, so the list keeps the screen; the bar stays put while the
 * list scrolls under it.
 *
 *   [ Search…              ] [Filters 2] [+]
 *   137 sessions · showing 1–50      Clear filters
 *
 * HostOnlyNote is the line that says what only the Mac can show (see
 * hostAccess.ts): said once, in words, instead of a control that fails.
 */
import { useCallback, useState, type ReactNode } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import SearchInput from '@/components/ui/SearchInput';
import styles from '@/styles/modules/PhoneViews.module.css';

export interface PhoneViewBarProps {
  /** The search box's accessible name. */
  searchLabel: string;
  searchPlaceholder: string;
  search: string;
  onSearch: (value: string) => void;
  searchDebounceMs?: number;
  /** The filter fields, shown in a sheet. Omit when there is nothing to filter. */
  filters?: ReactNode;
  /** How many filters are set; the button and the summary say so. */
  activeFilters?: number;
  onClearFilters?: () => void;
  /** The view's own action beside the search (New task). */
  action?: ReactNode;
  summary?: ReactNode;
  /** Under the summary: a host-only note, a stale-data note. */
  children?: ReactNode;
}

function FilterGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="7" y1="12" x2="17" y2="12" />
      <line x1="10" y1="18" x2="14" y2="18" />
    </svg>
  );
}

export default function PhoneViewBar({
  searchLabel,
  searchPlaceholder,
  search,
  onSearch,
  searchDebounceMs,
  filters,
  activeFilters = 0,
  onClearFilters,
  action,
  summary,
  children,
}: PhoneViewBarProps) {
  const [open, setOpen] = useState(false);
  // Stable: BottomSheet re-runs its focus handling whenever onClose changes.
  const close = useCallback(() => setOpen(false), []);

  return (
    <div className={styles.bar} data-testid="phone-view-bar">
      <div className={styles.barRow}>
        <SearchInput
          variant="field"
          className={styles.barSearch}
          ariaLabel={searchLabel}
          placeholder={searchPlaceholder}
          value={search}
          onChange={onSearch}
          debounceMs={searchDebounceMs}
        />
        {filters && (
          <Button
            className={styles.filterButton}
            icon={<FilterGlyph />}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={activeFilters > 0 ? `Filters, ${activeFilters} set` : 'Filters'}
            onClick={() => setOpen(true)}
          >
            Filters
            {activeFilters > 0 && <span className={styles.filterCount} aria-hidden="true">{activeFilters}</span>}
          </Button>
        )}
        {action}
      </div>
      {(summary || (activeFilters > 0 && onClearFilters)) && (
        <div className={styles.summaryRow}>
          <p className={styles.summary}>{summary}</p>
          {activeFilters > 0 && onClearFilters && (
            <Button variant="quiet" size="sm" className={styles.clearButton} onClick={onClearFilters}>
              Clear filters
            </Button>
          )}
        </div>
      )}
      {children}

      {filters && (
        <BottomSheet open={open} onClose={close} title="Filters">
          <div className={styles.filterSheet}>{filters}</div>
          <div className={styles.sheetButtons}>
            <Button variant="quiet" onClick={onClearFilters} disabled={activeFilters === 0 || !onClearFilters}>
              Clear all
            </Button>
            <Button variant="primary" onClick={close}>Done</Button>
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

function LaptopGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="5" width="16" height="11" rx="1" />
      <line x1="2" y1="19" x2="22" y2="19" />
    </svg>
  );
}

/** What only the Mac can show, said once in words (never a control that fails). */
export function HostOnlyNote({ children }: { children: ReactNode }) {
  return (
    <div className={styles.hostNote} role="note" data-testid="host-only-note">
      <LaptopGlyph />
      <p>{children}</p>
    </div>
  );
}
