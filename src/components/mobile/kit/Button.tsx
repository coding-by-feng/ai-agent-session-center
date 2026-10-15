/**
 * Button — the phone kit's button (AASC-38), 48px (44px `small`).
 *
 * Five states, all required on the phone: default, pressed (`:active`),
 * `:focus-visible`, disabled WITH A REASON, and loading. A disabled button stays
 * focusable (`aria-disabled`, not `disabled`) and says why under itself, linked by
 * `aria-describedby`, so a screen reader hears the reason too. Loading keeps the
 * label, adds a spinner and `aria-busy`, and ignores taps.
 */
import { useId, type MouseEvent, type ReactNode } from 'react';
import styles from '@/styles/modules/mobile/Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'plain' | 'destructive';

export interface ButtonProps {
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  variant?: ButtonVariant;
  /** 44px instead of 48px, for inline actions (a banner, a row). */
  small?: boolean;
  /** Stretch to the container's width. */
  block?: boolean;
  icon?: ReactNode;
  /** Disabled, and why — shown under the button. */
  disabledReason?: string;
  loading?: boolean;
  /** What a screen reader says while loading (the label stays visible). */
  loadingLabel?: string;
  type?: 'button' | 'submit';
  className?: string;
  'aria-label'?: string;
}

export default function Button({
  children,
  onClick,
  variant = 'secondary',
  small,
  block,
  icon,
  disabledReason,
  loading,
  loadingLabel,
  type = 'button',
  className,
  'aria-label': ariaLabel,
}: ButtonProps) {
  const reasonId = useId();
  const inert = !!disabledReason || !!loading;
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (inert) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };

  const button = (
    <button
      type={type}
      className={[
        styles.button,
        styles[variant],
        small ? styles.small : '',
        block && !disabledReason ? styles.block : '',
        !disabledReason ? className ?? '' : '',
      ].filter(Boolean).join(' ')}
      onClick={handleClick}
      aria-disabled={disabledReason ? true : undefined}
      aria-busy={loading ? true : undefined}
      aria-describedby={disabledReason ? reasonId : undefined}
      aria-label={loading && loadingLabel ? loadingLabel : ariaLabel}
      data-loading={loading ? '' : undefined}
    >
      {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
      <span className={styles.label}>{children}</span>
    </button>
  );

  if (!disabledReason) return button;
  return (
    <span className={[styles.withReason, block ? styles.block : '', className ?? ''].filter(Boolean).join(' ')}>
      {button}
      <span id={reasonId} className={styles.reason}>{disabledReason}</span>
    </span>
  );
}
