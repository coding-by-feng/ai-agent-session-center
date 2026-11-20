/**
 * PanelNetworkAddress — "Connect a phone at <this computer's LAN address>" in the devices panel, with its copy
 * button. It was inline in DevicePresenceChip until the panel learned its keyboard (Nov 20 2026) and draws exactly
 * what it drew there.
 */
import { useCallback, useState } from 'react';
import styles from '@/styles/modules/DevicePresence.module.css';

export default function PanelNetworkAddress({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied or unavailable — the URL is still
      // selectable text, so this isn't the only way to copy it.
    }
  }, [url]);

  return (
    <div className={styles.networkInfo}>
      <span className={styles.networkLabel}>Connect a phone at</span>
      <span className={styles.networkRow}>
        <span className={styles.networkUrl}>{url}</span>
        <button
          type="button"
          className={styles.copyBtn}
          onClick={handleCopy}
          title="Copy address"
          aria-label="Copy address"
        >
          {copied ? '✓' : '⧉'}
        </button>
      </span>
    </div>
  );
}
