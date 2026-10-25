/**
 * ResourcesScreen — More → Resources (plan 16): the desktop RESOURCES tab's Library, Cloud sync
 * and Projects on the phone, read through the Mac (lib/chat/phoneResourcesApi.ts).
 *
 *   ‹  Resources                                ⟳
 *   [ Library | Cloud sync | Projects ]
 *   (the tab's own list)
 *
 * Each tab is its own path (`/more/resources[/cloud|/projects]`), so Back from a resource returns
 * to the tab it was opened from and a link lands on the right one. Pull down, or Refresh, reads
 * the open tab again; the Mac reads AASC Cloud and git for it at most every 10 s.
 */
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { EmptyState, Screen, SegmentedControl } from '../kit';
import { RefreshIcon } from '../phoneIcons';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { usePullToRefresh, type PullPhase } from '@/hooks/usePullToRefresh';
import { RESOURCES_TABS, resourcesPath, type ResourcesTab } from '@/lib/chat/phoneRoutes';
import { RESOURCES_TAB_LABELS } from '@/lib/chat/phoneResourcesModel';
import styles from '@/styles/modules/mobile/Cloud.module.css';
import resourceStyles from '@/styles/modules/mobile/Resources.module.css';

const LibraryPanel = lazy(() => import('./resources/LibraryPanel'));
const CloudSyncPanel = lazy(() => import('./resources/CloudSyncPanel'));
const ProjectsPanel = lazy(() => import('./resources/ProjectsPanel'));

const PULL_WORDS: Record<Exclude<PullPhase, 'idle'>, string> = {
  pulling: 'Pull to refresh',
  armed: 'Release to refresh',
  refreshing: 'Refreshing…',
};

/** A panel hands the screen its refresh, for the ⟳ button and the pull. */
export type RegisterRefresh = (refresh: (() => Promise<void>) | null) => void;

export default function ResourcesScreen({ tab }: { tab: ResourcesTab }) {
  const pop = usePhoneNavStore((s) => s.pop);
  const replace = usePhoneNavStore((s) => s.replace);
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const register = useCallback<RegisterRefresh>((refresh) => {
    refreshRef.current = refresh;
  }, []);
  const pull = usePullToRefresh<HTMLDivElement>(useCallback(async () => {
    await refreshRef.current?.();
  }, []));
  const { scrollerRef } = pull;
  const pullHost = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The Screen's own scroller is the one the pull reads and writes (--pull).
    scrollerRef.current = pullHost.current?.parentElement as HTMLDivElement | null;
  });
  const refreshing = pull.phase === 'refreshing';

  const actions = (
    <button
      type="button"
      className={styles.navAction}
      onClick={() => void pull.refresh()}
      aria-label={refreshing ? 'Refreshing' : 'Refresh'}
      aria-disabled={refreshing || undefined}
      data-busy={refreshing ? '' : undefined}
    >
      <RefreshIcon />
    </button>
  );

  return (
    <Screen title="Resources" onBack={pop} backLabel="Back to More" actions={actions} testId="phone-more-resources">
      <div ref={pullHost} className={styles.pullHost} data-pull={pull.phase} {...pull.handlers}>
        <div className={styles.pull} aria-hidden={pull.phase === 'idle' ? true : undefined}>
          {pull.phase !== 'idle' && (
            <span className={styles.pullInner} role="status">
              <span className={styles.pullSpinner} aria-hidden="true" />
              {PULL_WORDS[pull.phase]}
            </span>
          )}
        </div>
        <div className={resourceStyles.tabs}>
          <SegmentedControl
            label="Show"
            value={tab}
            onChange={(next: ResourcesTab) => replace(resourcesPath(next))}
            idPrefix="resources-tab"
            panelId="resources-panel"
            segments={RESOURCES_TABS.map((t) => ({ value: t, label: RESOURCES_TAB_LABELS[t] }))}
          />
        </div>
        <div id="resources-panel" role="tabpanel" aria-labelledby={`resources-tab-${tab}`}>
          <Suspense fallback={<EmptyState live title="Loading…" />}>
            {tab === 'library' && <LibraryPanel register={register} />}
            {tab === 'cloud' && <CloudSyncPanel register={register} />}
            {tab === 'projects' && <ProjectsPanel register={register} />}
          </Suspense>
        </div>
      </div>
    </Screen>
  );
}
