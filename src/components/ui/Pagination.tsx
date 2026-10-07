/**
 * Pagination — Previous · 1 … 4 5 [6] 7 8 … 20 · Next.
 *
 *   <Pagination page={page} totalPages={pages} onPageChange={setPage} label="Session pages" />
 *
 * Renders nothing for a single page. The current page is `aria-current="page"`;
 * on a phone the numbered window gives way to "Page x of y".
 */
import Button from '@/components/ui/Button';
import { pageWindow } from '@/lib/pageWindow';
import styles from '@/styles/modules/Pagination.module.css';

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Names the navigation landmark ("Session pages"). */
  label?: string;
  className?: string;
}

export default function Pagination({ page, totalPages, onPageChange, label = 'Pages', className }: PaginationProps) {
  if (totalPages <= 1) return null;
  const items = pageWindow(page, totalPages);

  return (
    <nav className={className ? `${styles.pagination} ${className}` : styles.pagination} aria-label={label}>
      <Button size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
        Previous
      </Button>
      <ol className={styles.pages}>
        {items.map((item, i) =>
          item === 'gap' ? (
            <li key={`gap-${i}`} className={styles.gap} aria-hidden="true">…</li>
          ) : (
            <li key={item}>
              <Button
                size="sm"
                variant={item === page ? 'primary' : 'quiet'}
                className={styles.page}
                aria-current={item === page ? 'page' : undefined}
                aria-label={`Page ${item}`}
                onClick={() => onPageChange(item)}
              >
                {item}
              </Button>
            </li>
          ),
        )}
      </ol>
      <span className={styles.info}>
        Page {page.toLocaleString()} of {totalPages.toLocaleString()}
      </span>
      <Button size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
