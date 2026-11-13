/**
 * CloudStatusBar — "Cloud · connected · kason-mac · account" with Refresh connection. Shown above
 * Projects (only when the connection needs you) and at the top of the cloud account dialog. A
 * revoked Mac gets no Reconnect here: the header's cloud account button already says Reconnect and
 * opens the same dialog. A status failure is an alert with Retry; it never invents a connection.
 */
import Button from '@/components/ui/Button';
import { useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';

export default function CloudStatusBar({
  quiet = false,
}: {
  /** Hide the line itself (the alert for a failed read still shows). */
  quiet?: boolean;
}) {
  const session = useCloudSession();
  const { status, loaded, error, changed } = session;
  return (
    <>
      {!quiet && (
        <div className={`${styles.banner} ${styles.statusBar}`} role="status">
          <span>
            Cloud · {loaded ? status.state : 'checking connection'}
            {status.connection
              ? ` · ${status.connection.deviceName} · ${status.connection.accountEmail ?? status.connection.accountId}`
              : ''}
          </span>
          <Button onClick={() => session.refresh(true)}>Refresh connection</Button>
          {changed && (
            <p>
              Connection changed. Existing reviews are no longer valid; refresh and review again.
              Drafts are preserved.
            </p>
          )}
        </div>
      )}
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          <Button size="sm" onClick={() => session.refresh(true)}>
            Retry connection status
          </Button>
        </div>
      )}
    </>
  );
}
