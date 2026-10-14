/**
 * SheetAction — one row of a phone actions sheet (AASC-18): a 48px button with a
 * glyph and words. A toggle (`pressed` set) says its state in words at the end
 * of the row, so "on" never rests on colour alone.
 */
import type { ReactNode } from 'react';
import styles from '@/styles/modules/PhoneSession.module.css';

export interface SheetActionProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  /** A toggle's state; undefined for a plain action. */
  pressed?: boolean;
  /** Destructive (kill, clear): the glyph turns red; a confirm sheet follows. */
  danger?: boolean;
  disabled?: boolean;
}

export default function SheetAction({ icon, label, onClick, pressed, danger, disabled }: SheetActionProps) {
  return (
    <li>
      <button
        type="button"
        className={`${styles.sheetItem}${danger ? ` ${styles.sheetDanger}` : ''}`}
        onClick={onClick}
        aria-pressed={pressed}
        disabled={disabled}
      >
        <span className={styles.sheetIcon}>{icon}</span>
        <span className={styles.sheetLabel}>{label}</span>
        {pressed !== undefined && <span className={styles.sheetState}>{pressed ? 'On' : 'Off'}</span>}
      </button>
    </li>
  );
}

/** A titled group of rows. */
export function SheetSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.sheetSection} aria-label={title}>
      <h3 className={styles.sheetHeading}>{title}</h3>
      <ul className={styles.sheetList}>{children}</ul>
    </section>
  );
}
