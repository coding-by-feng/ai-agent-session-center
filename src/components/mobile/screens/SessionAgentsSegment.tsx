/**
 * SessionAgentsSegment — a session's Agents tab on the phone (Oct 22 2026): the
 * desktop AGENTS tab (who works for this session, what each did, a subagent's
 * own conversation) in the phone's dress, as Info → Agents showed it before this
 * tab replaced that page; loaded on first use so none of it is in the
 * frame's chunk. A teammate opens its own session screen over this one, so Back
 * returns here; an open subagent is a back layer, so Back closes it first.
 * Above it, Claude Code's Background list (BackgroundTasksSection, Oct 25 2026).
 */
import { lazy, Suspense, useCallback } from 'react';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { sessionPath } from '@/lib/chat/phoneRoutes';
import { openBackLayer } from '@/lib/backLayers';
import { EmptyState, useScreenSlot } from '../kit';
import BackgroundTasksSection from './BackgroundTasksSection';
import styles from '@/styles/modules/mobile/Screens.module.css';
import infoStyles from '@/styles/modules/mobile/SessionInfo.module.css';
import dress from '@/styles/modules/PhoneDress.module.css';

const AgentsTab = lazy(() => import('@/components/session/AgentsTab'));

export default function SessionAgentsSegment({ sessionId }: { sessionId: string }) {
  const { isTop } = useScreenSlot();
  const openTeammate = useCallback((teammateId: string) => {
    usePhoneNavStore.getState().push(sessionPath(teammateId, 'chat'));
  }, []);
  // Only while this screen is on top: one under a pushed screen must not take that screen's Back.
  const backLayer = isTop ? openBackLayer : undefined;
  return (
    <div className={styles.agentsScroll} data-testid="phone-session-agents">
      {/* Claude Code's Background list (shells, teammates) as of the last Stop, Oct 25 2026. */}
      <BackgroundTasksSection sessionId={sessionId} />
      {/* The phone's dress for a desktop component (phone font, no forced capitals), as Info's pages wear it. */}
      <div className={`${infoStyles.tab} ${dress.dress}`}>
        <Suspense fallback={<EmptyState live title="Loading…" />}>
          <AgentsTab sessionId={sessionId} onOpenTeammate={openTeammate} backLayer={backLayer} />
        </Suspense>
      </div>
    </div>
  );
}
