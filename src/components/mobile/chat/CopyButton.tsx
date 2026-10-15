/**
 * CopyButton — copy a code block or an answer from the phone chat (AASC-41).
 * The word changes with the outcome ("Copied", "Couldn’t copy"), so it never
 * rests on colour, and a screen reader hears it (`aria-live`).
 */
import { useEffect, useRef, useState } from 'react';
import { copyText } from '@/lib/chat/clipboard';
import { CheckIcon, CopyIcon } from './chatIcons';

type Outcome = 'idle' | 'copied' | 'failed';

const RESET_MS = 1600;

export interface CopyButtonProps {
  text: string | (() => string);
  className: string;
  /** What is copied, for a screen reader ("Copy code"). */
  label?: string;
  children?: string;
}

export default function CopyButton({ text, className, label, children = 'Copy' }: CopyButtonProps) {
  const [outcome, setOutcome] = useState<Outcome>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const copy = async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    setOutcome(ok ? 'copied' : 'failed');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome('idle'), RESET_MS);
  };

  const word = outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Couldn’t copy' : children;
  return (
    <button type="button" className={className} onClick={() => void copy()} aria-label={outcome === 'idle' ? label : undefined}>
      {outcome === 'copied' ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
      <span aria-live="polite">{word}</span>
    </button>
  );
}
