/**
 * CloudResourceScreen — More → Cloud → a resource (AASC-51): what it is and its
 * latest versions, newest first, read through the Mac. Read-only: installing a
 * version, restoring one or publishing a new one stays on the Mac.
 *
 *   ‹  retouch
 *   DETAILS     Kind Skill · For Claude Code · Scope Everywhere · Current v3 …
 *   VERSIONS    Version 3  [Current]
 *               Oct 14, 2026, 08:00 · 2.4 KB · 2 files
 *   Showing the latest 10 versions.
 *
 * The backend has no version list, so the Mac reads each version exactly and
 * stops at ten (server/mobile/phoneCloud.ts); deleted versions are skipped.
 */
import { useCallback, type ReactNode } from 'react';
import { Button, EmptyState, ListRow, ListSection, Screen } from '../kit';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useClock } from '@/lib/chat/clock';
import { fetchCloudVersions, type CloudVersions } from '@/lib/chat/cloudBrowseApi';
import {
  CLOUD_CONNECT_HINT, CLOUD_RECONNECT_HINT, agentWords, agoWords, filesWords, kindWords, sizeWords, versionDate,
} from '@/lib/chat/cloudBrowseModel';
import { useCloudRead } from './useCloudRead';
import styles from '@/styles/modules/mobile/Cloud.module.css';

export default function CloudResourceScreen({ resourceId }: { resourceId: string }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const now = useClock();
  const read = useCallback(({ signal }: { refresh: boolean; signal: AbortSignal }) => fetchCloudVersions(resourceId, signal), [resourceId]);
  const answer = useCloudRead<CloudVersions>(read);
  const data = answer.data;
  const resource = data?.resource ?? null;
  const tryAgain = <Button variant="primary" onClick={() => void answer.refresh()}>Try again</Button>;

  let body: ReactNode;
  if (!answer.loaded) {
    body = <EmptyState live title="Loading versions…" message="Your Mac is reading them from AASC Cloud." />;
  } else if (!data) {
    body = <EmptyState title="Couldn’t load this resource" message={answer.error?.message} action={tryAgain} />;
  } else if (!data.connected) {
    body = (
      <EmptyState
        title={data.state === 'revoked' ? 'This Mac’s cloud device was revoked' : 'This Mac isn’t connected to AASC Cloud'}
        message={data.state === 'revoked' ? CLOUD_RECONNECT_HINT : CLOUD_CONNECT_HINT}
      />
    );
  } else if (!resource) {
    body = data.problem
      ? <EmptyState title="Couldn’t read this resource" message={data.problem} action={tryAgain} />
      : <EmptyState title="This resource isn’t in AASC Cloud any more" message="It may have been removed from AASC Cloud since this list was read." />;
  } else {
    body = (
      <>
        <ListSection header="Details">
          <ListRow title="Kind" value={kindWords(resource.kind)} />
          <ListRow title="For" value={agentWords(resource.agent)} />
          <ListRow title="Scope" value={resource.scope === 'project' ? 'One project' : 'Everywhere'} />
          <ListRow title="Current version" value={`v${resource.version}`} />
          <ListRow title="Updated" value={agoWords(resource.updatedAt, now)} />
          <ListRow title="Size" value={`${sizeWords(resource.bytes)} · ${filesWords(resource.files)}`} />
        </ListSection>
        {data.versions.length === 0 ? (
          <EmptyState title="No versions to show" message={data.problem ?? 'Its versions couldn’t be read. Try again in a moment.'} action={tryAgain} />
        ) : (
          <ListSection
            header="Versions"
            footer={data.truncated ? `Showing the ${data.versions.length} newest. Older versions are in AASC Cloud too.` : undefined}
          >
            {data.versions.map((v) => (
              <ListRow
                key={v.version}
                tall
                title={<>Version {v.version}{v.version === resource.version && <span className={styles.current}>Current</span>}</>}
                subtitle={`${versionDate(v.createdAt)} · ${sizeWords(v.bytes)} · ${filesWords(v.files)}`}
                testId="cloud-version-row"
              />
            ))}
          </ListSection>
        )}
        <p className={styles.note}>Read-only on this phone. Installing or restoring a version stays on your Mac: RESOURCES → Cloud.</p>
      </>
    );
  }

  return (
    <Screen title={resource?.name ?? 'Resource'} onBack={pop} backLabel="Back to Cloud" testId="phone-more-cloud-resource">
      <div className={styles.pullHost}>{body}</div>
    </Screen>
  );
}
