/**
 * DownloadButton — the phone file view's ⬇ (Nov 7 2026): saves the open file onto the phone.
 * How each place saves is phoneDownload.ts; in the iOS app it stays busy until the share sheet opens.
 */
import { useEffect, useRef, useState } from 'react';
import { showToast } from '@/components/ui/ToastContainer';
import { nativeAppPlatform } from '@/lib/platform';
import { SAVE_FILE_EVENT, downloadUrl, readSaveFileOutcome, startDownload } from '@/lib/phoneDownload';
import { DownloadIcon } from '../projectIcons';
import styles from '@/styles/modules/PhoneProject.module.css';

/** Long enough for a few hundred MB over the LAN; past it the button frees itself (the app may still answer). */
const NATIVE_BUSY_MS = 10 * 60_000;

export interface DownloadButtonProps {
  projectPath: string;
  path: string;
  name: string;
}

export default function DownloadButton({ projectPath, path, name }: DownloadButtonProps) {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const counter = useRef(0);

  useEffect(() => {
    if (!pendingId) return;
    const onOutcome = (event: Event) => {
      const outcome = readSaveFileOutcome((event as CustomEvent).detail);
      if (!outcome || outcome.id !== pendingId) return;
      setPendingId(null);
      if (outcome.state === 'failed') showToast(outcome.message ?? `Couldn't save ${name}.`, 'error');
    };
    const timer = window.setTimeout(() => setPendingId(null), NATIVE_BUSY_MS);
    window.addEventListener(SAVE_FILE_EVENT, onOutcome);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(SAVE_FILE_EVENT, onOutcome);
    };
  }, [pendingId, name]);

  const onClick = () => {
    counter.current += 1;
    const id = `${Date.now().toString(36)}-${counter.current}`;
    const started = startDownload(downloadUrl(projectPath, path), name, id);
    if (started === 'native') setPendingId(id);
    else if (started === 'unsupported') showToast('Update the AASC app to save files to this phone.', 'warning');
    else if (nativeAppPlatform() === 'android') showToast(`Saving ${name} to Downloads…`, 'info');
  };

  const busy = pendingId !== null;
  return (
    <button
      type="button"
      className={styles.iconBtn}
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      aria-label={busy ? `Saving ${name}…` : `Download ${name}`}
      title="Download"
    >
      <DownloadIcon />
    </button>
  );
}
