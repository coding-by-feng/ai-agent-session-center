/**
 * SectionHeader — the header over a group of rows: caption, count beside it,
 * a hairline to the edge, an optional aside.
 *
 *   <SectionHeader label="Wed, Oct 7" count={12} aside="12 shown" sticky />
 *   <SectionHeader label="Urgent" count={10} collapsed={c} onToggle={toggle} controls="grp-urgent" />
 *
 * With `onToggle` it collapses: the heading wraps a real <button
 * aria-expanded> (the WAI-ARIA accordion shape), so the keyboard can fold a
 * group and a screen reader hears its state. Without it, it is a plain heading.
 */
import type { ReactNode } from 'react';
import CountBadge from '@/components/ui/CountBadge';
import styles from '@/styles/modules/SectionHeader.module.css';

interface SectionHeaderProps {
  label: ReactNode;
  count?: number;
  /** Screen-reader wording for the count ("10 tasks"). */
  countLabel?: string;
  /** Collapse state; only meaningful with `onToggle`. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** id of the region this header folds. */
  controls?: string;
  /** Right-aligned extra, after the rule ("12 shown"). */
  aside?: ReactNode;
  /** Pin to the top of the scrolling list it heads. */
  sticky?: boolean;
  level?: 2 | 3 | 4;
  className?: string;
}

function Chevron() {
  return (
    <svg className={styles.chevron} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export default function SectionHeader({
  label,
  count,
  countLabel,
  collapsed = false,
  onToggle,
  controls,
  aside,
  sticky,
  level = 3,
  className,
}: SectionHeaderProps) {
  const Heading = `h${level}` as 'h2' | 'h3' | 'h4';
  const collapsible = onToggle !== undefined;
  const cls = [
    styles.header,
    sticky ? styles.sticky : undefined,
    collapsible && collapsed ? styles.collapsed : undefined,
    className,
  ].filter(Boolean).join(' ');

  const caption = (
    <>
      {collapsible && <Chevron />}
      <span className={styles.label}>{label}</span>
      {count !== undefined && <CountBadge count={count} label={countLabel} />}
    </>
  );

  return (
    <Heading className={cls}>
      {collapsible ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls={controls}
          onClick={onToggle}
        >
          {caption}
          <span className={styles.rule} aria-hidden="true" />
        </button>
      ) : (
        <span className={styles.title}>
          {caption}
          <span className={styles.rule} aria-hidden="true" />
        </span>
      )}
      {aside !== undefined && aside !== null && <span className={styles.aside}>{aside}</span>}
    </Heading>
  );
}
