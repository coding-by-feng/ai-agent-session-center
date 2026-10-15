/**
 * ListSection / ListRow — grouped inset lists, the phone's main surface (AASC-38).
 *
 *   SECTION HEADER
 *   ┌─────────────────────────────────┐
 *   │ ◉  Title                value ›│   56px (72px `tall`, two-line rows)
 *   │    subtitle                     │
 *   ├─────────────────────────────────┤   separators inset past the leading slot
 *   │    New design              (●) │   `toggle`: the whole row is the switch
 *   └─────────────────────────────────┘
 *   footer note
 *
 * A row is a button when it does something (`onClick`), a switch when it toggles
 * (`toggle`), and plain text otherwise. A disabled row stays focusable and shows
 * its reason in place of the subtitle.
 */
import { useId, type ReactNode } from 'react';
import { ChevronRightIcon } from './kitIcons';
import styles from '@/styles/modules/mobile/List.module.css';

export interface ListSectionProps {
  header?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  /** Accessible name when there is no visible header. */
  label?: string;
  className?: string;
}

export function ListSection({ header, footer, children, label, className }: ListSectionProps) {
  const headerId = useId();
  return (
    <section
      className={`${styles.section}${className ? ` ${className}` : ''}`}
      aria-labelledby={header ? headerId : undefined}
      aria-label={header ? undefined : label}
    >
      {header && <h2 id={headerId} className={styles.header}>{header}</h2>}
      <ul className={styles.group} role="list">{children}</ul>
      {footer && <p className={styles.footer}>{footer}</p>}
    </section>
  );
}

export interface ListRowToggle {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** A value on the right ("On", "Opus 5.5 · high"). */
  value?: ReactNode;
  /** A glyph or status ring on the left. */
  leading?: ReactNode;
  /** Anything else on the right (a badge, a time). */
  trailing?: ReactNode;
  /** Draw a › (the row pushes a screen). */
  chevron?: boolean;
  onClick?: () => void;
  toggle?: ListRowToggle;
  destructive?: boolean;
  /** Disabled, and why (shown as the subtitle). */
  disabledReason?: string;
  /** Two-line rows: 72px. */
  tall?: boolean;
  /** Spoken instead of the visible text, when that needs context (button and switch rows). */
  ariaLabel?: string;
  testId?: string;
}

export function ListRow({
  title,
  subtitle,
  value,
  leading,
  trailing,
  chevron,
  onClick,
  toggle,
  destructive,
  disabledReason,
  tall,
  ariaLabel,
  testId,
}: ListRowProps) {
  const reasonId = useId();
  const disabled = !!disabledReason;
  const body = (
    <>
      {leading && <span className={styles.leading}>{leading}</span>}
      <span className={styles.text}>
        <span className={`${styles.title}${destructive ? ` ${styles.destructive}` : ''}`}>{title}</span>
        {disabled ? (
          <span id={reasonId} className={styles.subtitle}>{disabledReason}</span>
        ) : subtitle ? (
          <span className={styles.subtitle}>{subtitle}</span>
        ) : null}
      </span>
      {value !== undefined && <span className={styles.value}>{value}</span>}
      {trailing}
      {toggle && <span className={styles.switch} data-on={toggle.checked ? '' : undefined} aria-hidden="true" />}
      {chevron && <span className={styles.chevron}><ChevronRightIcon /></span>}
    </>
  );
  const rowClass = `${styles.row}${tall ? ` ${styles.tall}` : ''}`;

  let control: ReactNode;
  if (toggle) {
    control = (
      <button
        type="button"
        role="switch"
        aria-checked={toggle.checked}
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        aria-label={ariaLabel}
        className={`${rowClass} ${styles.pressable}`}
        onClick={() => { if (!disabled) toggle.onChange(!toggle.checked); }}
      >
        {body}
      </button>
    );
  } else if (onClick) {
    control = (
      <button
        type="button"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled ? reasonId : undefined}
        aria-label={ariaLabel}
        className={`${rowClass} ${styles.pressable}`}
        onClick={() => { if (!disabled) onClick(); }}
      >
        {body}
      </button>
    );
  } else {
    control = <div className={rowClass}>{body}</div>;
  }

  return (
    <li className={styles.item} data-has-leading={leading ? '' : undefined} data-testid={testId}>
      {control}
    </li>
  );
}
