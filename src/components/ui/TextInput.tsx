/**
 * TextInput — a styled native <input> (text, date, search, number): the same
 * height, border and focus ring as NativeSelect, so a toolbar reads as one row.
 * Every prop goes straight to the input; wrap it in `Field` for a caption.
 */
import type { ComponentPropsWithRef } from 'react';
import styles from '@/styles/modules/FormControl.module.css';

export type TextInputProps = ComponentPropsWithRef<'input'>;

export default function TextInput({ className, type = 'text', ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      type={type}
      className={className ? `${styles.control} ${className}` : styles.control}
    />
  );
}
