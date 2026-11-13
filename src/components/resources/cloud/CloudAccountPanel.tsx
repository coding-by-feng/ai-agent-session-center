/**
 * CloudAccountPanel — what the cloud account dialog shows (the Connection tab until Nov 13 2026):
 * the connection's status line, then the device connection card (sign in with Google or pair,
 * disconnect, skill-notes sync, cloud aliases). Lazy, so the Library's first load never pays for it.
 */
import CloudConnection from './CloudConnection';
import CloudStatusBar from './CloudStatusBar';
import { useCloudSession } from './cloudSession';
import lib from '@/styles/modules/ResourceLibrary.module.css';

export default function CloudAccountPanel() {
  const session = useCloudSession();
  return (
    <div className={lib.connection}>
      {/* The pairing form is right below, so the bar needs no Reconnect of its own. */}
      <CloudStatusBar />
      {session.loaded && <CloudConnection onStatus={session.apply} />}
    </div>
  );
}
