/**
 * CloudScreen — More → Cloud (AASC-51): what is in the user's AASC Cloud, read
 * through the Mac's own connection (lib/chat/cloudBrowseApi.ts). Read-only:
 * publishing, installing, restoring, project changes and the connection itself
 * stay on the Mac's desktop (RESOURCES → Cloud).
 *
 *   ‹  Cloud                                   ⟳
 *   AASC CLOUD
 *   Status                              Connected
 *   Last synced 2 min ago
 *   [ Resources 12 |  Projects 3 ]
 *   retouch                                     ›   a resource opens its versions
 *   Skill · Claude Code · v3
 *   Updated 2 days ago
 *
 * Pull down, or Refresh, reads again (the Mac reads the cloud at most every
 * 10 s for that; otherwise its answer is a minute old at most).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Banner, Button, EmptyState, ListRow, ListSection, Screen, SegmentedControl } from '../kit';
import { RefreshIcon } from '../phoneIcons';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePullToRefresh, type PullPhase } from '@/hooks/usePullToRefresh';
import { useClock } from '@/lib/chat/clock';
import { fetchCloudBrowse, type CloudBrowse, type CloudStatus } from '@/lib/chat/cloudBrowseApi';
import {
  CLOUD_CONNECT_HINT, CLOUD_READ_ONLY_NOTE, CLOUD_RECONNECT_HINT, agoWords, cloudStateWords, projectDetail, repoWords, resourceLine, syncWords,
} from '@/lib/chat/cloudBrowseModel';
import { cloudResourcePath } from '@/lib/chat/phoneRoutes';
import { useCloudRead } from './useCloudRead';
import styles from '@/styles/modules/mobile/Cloud.module.css';

type View = 'resources' | 'projects';

const PULL_WORDS: Record<Exclude<PullPhase, 'idle'>, string> = {
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  refreshing: 'Refreshing…',
};

/** Module-level, so it is the same function every render (useCloudRead re-reads when it changes). */
const readBrowse = ({ refresh, signal }: { refresh: boolean; signal: AbortSignal }) => fetchCloudBrowse({ refresh, signal });

/** The connection: its state in a word, and the last sync (or why there is none). */
export function CloudStatusSection({ status, now }: { status: CloudStatus; now: number }) {
  return (
    <ListSection header="AASC Cloud">
      <ListRow
        title="Status"
        value={cloudStateWords(status.state)}
        // Not connected: the empty state under it says how to connect.
        subtitle={status.state === 'not-connected' ? undefined : syncWords(status, now)}
        tall={status.state !== 'not-connected'}
        testId="cloud-status"
      />
    </ListSection>
  );
}

function ResourceList({ data, now }: { data: CloudBrowse; now: number }) {
  const push = usePhoneNavStore((s) => s.push);
  if (data.resources.length === 0) {
    return data.problem
      ? <EmptyState title="Nothing read yet" message="Pull down, or tap Refresh, to try again." />
      : <EmptyState title="No resources in AASC Cloud yet" message="Publish skills, commands and rules from your Mac: RESOURCES → Cloud." />;
  }
  return (
    <ListSection label="Resources" footer={data.truncated ? 'Showing the first 1,000. Your Mac lists them all: RESOURCES → Cloud.' : undefined}>
      {data.resources.map((r) => (
        <ListRow
          key={r.id}
          tall
          title={r.name}
          subtitle={<><span className={styles.line}>{resourceLine(r)}</span><span className={styles.line}>Updated {agoWords(r.updatedAt, now)}</span></>}
          chevron
          onClick={() => push(cloudResourcePath(r.id))}
          testId="cloud-resource-row"
        />
      ))}
    </ListSection>
  );
}

function ProjectList({ data }: { data: CloudBrowse }) {
  if (data.projects.length === 0) {
    return data.problem
      ? <EmptyState title="Nothing read yet" message="Pull down, or tap Refresh, to try again." />
      : <EmptyState title="No projects in AASC Cloud yet" message="Save a project from your Mac: RESOURCES → Cloud → Projects." />;
  }
  return (
    <ListSection label="Projects" footer={data.truncated ? 'Showing the first 1,000. Your Mac lists them all: RESOURCES → Cloud.' : undefined}>
      {data.projects.map((p) => (
        <ListRow
          key={p.id}
          tall
          title={p.name}
          subtitle={<><span className={styles.line}>{repoWords(p)}</span><span className={styles.line}>{projectDetail(p)}</span></>}
          testId="cloud-project-row"
        />
      ))}
    </ListSection>
  );
}

export default function CloudScreen() {
  const pop = usePhoneNavStore((s) => s.pop);
  const now = useClock();
  const [view, setView] = useState<View>('resources');
  const browse = useCloudRead<CloudBrowse>(readBrowse);
  const pull = usePullToRefresh<HTMLDivElement>(browse.refresh);
  const { scrollerRef } = pull;
  const pullHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The Screen's own scroller is the one the pull reads and writes (--pull).
    scrollerRef.current = pullHost.current?.parentElement as HTMLDivElement | null;
  });
  const refreshing = pull.phase === 'refreshing';
  const refresh = () => void pull.refresh();
  const data = browse.data;

  const actions = (
    <button
      type="button"
      className={styles.navAction}
      onClick={refresh}
      aria-label={refreshing ? 'Refreshing' : 'Refresh'}
      aria-disabled={refreshing || undefined}
      data-busy={refreshing ? '' : undefined}
    >
      <RefreshIcon />
    </button>
  );

  // A failed refresh keeps the last answer on screen and says so; a cloud problem the Mac met, likewise.
  const banner = data && browse.error
    ? <div className={styles.banner}><Banner tone="error" title="Couldn’t refresh">{browse.error.message}</Banner></div>
    : data?.connected && data.problem
      ? <div className={styles.banner}><Banner tone="warning" title="Couldn’t sync just now">{data.problem}</Banner></div>
      : undefined;

  let body: ReactNode;
  if (!browse.loaded) {
    body = <EmptyState live title="Loading AASC Cloud…" message="Your Mac is reading it for this phone." />;
  } else if (!data) {
    body = (
      <EmptyState
        title="Couldn’t load AASC Cloud"
        message={browse.error?.message}
        action={<Button variant="primary" onClick={refresh} loading={refreshing} loadingLabel="Trying again">Try again</Button>}
      />
    );
  } else if (!data.connected) {
    body = (
      <>
        <CloudStatusSection status={data} now={now} />
        <EmptyState
          title={data.state === 'revoked' ? 'This Mac’s cloud device was revoked' : 'This Mac isn’t connected to AASC Cloud'}
          message={data.state === 'revoked' ? CLOUD_RECONNECT_HINT : CLOUD_CONNECT_HINT}
          action={<Button variant="secondary" onClick={refresh} loading={refreshing} loadingLabel="Checking">Check again</Button>}
        />
      </>
    );
  } else {
    body = (
      <>
        <CloudStatusSection status={data} now={now} />
        <div className={styles.segments}>
          <SegmentedControl
            label="Show"
            value={view}
            onChange={setView}
            idPrefix="cloud-view"
            panelId="cloud-panel"
            segments={[
              { value: 'resources', label: 'Resources', badge: data.resources.length },
              { value: 'projects', label: 'Projects', badge: data.projects.length },
            ]}
          />
        </div>
        <div id="cloud-panel" role="tabpanel" aria-labelledby={`cloud-view-${view}`}>
          {view === 'resources' ? <ResourceList data={data} now={now} /> : <ProjectList data={data} />}
        </div>
        <p className={styles.note}>{CLOUD_READ_ONLY_NOTE}</p>
      </>
    );
  }

  return (
    <Screen title="Cloud" onBack={pop} backLabel="Back to More" actions={actions} banner={banner} testId="phone-more-cloud">
      <div ref={pullHost} className={styles.pullHost} data-pull={pull.phase} {...pull.handlers}>
        <div className={styles.pull} aria-hidden={pull.phase === 'idle' ? true : undefined}>
          {pull.phase !== 'idle' && (
            <span className={styles.pullInner} role="status">
              <span className={styles.pullSpinner} aria-hidden="true" />
              {PULL_WORDS[pull.phase]}
            </span>
          )}
        </div>
        {body}
      </div>
    </Screen>
  );
}
