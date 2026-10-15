/**
 * CopyTextButton — copies a fixed text: says "Copied" for a moment, and a
 * toast says so when the clipboard refuses. Used by the AGENTS tab (log
 * detail, subagent task / result / tool output).
 */
import { useEffect, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import { showToast } from '@/components/ui/ToastContainer';

/** How long the button says "Copied" before it reverts. */
const COPIED_MS = 1500;

interface CopyTextButtonProps {
  text: string;
  /** What it copies, for a screen reader when there are several on screen ("Copy the task"). */
  ariaLabel?: string;
}

export default function CopyTextButton({ text, ariaLabel }: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast('Could not copy to the clipboard', 'error');
      return;
    }
    setCopied(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <Button size="sm" onClick={copy} aria-label={ariaLabel && !copied ? ariaLabel : undefined}>
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}
