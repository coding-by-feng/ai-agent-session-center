/**
 * Button — the shared text button: one look in every theme, 32px (md) or 24px
 * (sm), all five states, 44px targets on coarse pointers.
 *
 *   <Button onClick={refresh}>Refresh</Button>
 *   <Button variant="primary" type="submit" icon={<PlusIcon />}>Add task</Button>
 *   <Button pressed={favoritesOnly} onClick={toggle}>★ Favorites</Button>
 *
 * `pressed` turns it into a toggle: it renders `aria-pressed` and the "on" fill,
 * so a filter pill is the same component as an action. Leave it undefined for a
 * plain action — `aria-pressed="false"` on a non-toggle tells a screen reader
 * there is a state that does not exist.
 *
 * `type` defaults to "button": a bare <button> inside a form submits it.
 * An anchor that must look like a button (a router <Link>) uses `buttonClass()`
 * from ./buttonClass instead.
 */
import type { ComponentPropsWithRef, ReactNode } from 'react';
import { buttonClass, type ButtonSize, type ButtonVariant } from '@/components/ui/buttonClass';
import styles from '@/styles/modules/Button.module.css';

export type { ButtonSize, ButtonVariant } from '@/components/ui/buttonClass';

// `aria-pressed` is owned by `pressed`; a caller's attribute would be silently
// overwritten, so it is not a prop at all.
export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'aria-pressed'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Toggle state; undefined = a plain action. */
  pressed?: boolean;
  /** Leading glyph, decorative (the label names the action). */
  icon?: ReactNode;
}

export default function Button({
  variant = 'default',
  size = 'md',
  pressed,
  icon,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={buttonClass({ variant, size, pressed, className })}
      aria-pressed={pressed}
    >
      {icon && <span className={styles.buttonIcon} aria-hidden="true">{icon}</span>}
      {children}
    </button>
  );
}
