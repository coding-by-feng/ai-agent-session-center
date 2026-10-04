/**
 * Store-reading halves of lib/liveBoard.ts and lib/liveHint.ts, shared by the
 * LIVE page (which draws the board and the tip) and the NavBar (which marks
 * the LIVE tab while the tip is up), so both decide from the same inputs.
 */
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useUiStore } from '@/stores/uiStore';
import { useWsStore } from '@/stores/wsStore';
import { liveFlatState, type FlatState } from '@/lib/liveBoard';
import { shouldShowLiveHint } from '@/lib/liveHint';
import { isListedSession } from '@/lib/sessionSort';
import { useIsMobile } from '@/lib/platform';
import type { Session } from '@/types';

function countListed(sessions: ReadonlyMap<string, Session>): number {
  let n = 0;
  for (const s of sessions.values()) if (isListedSession(s)) n += 1;
  return n;
}

/** What the 3D-off LIVE page shows: 'loading', 'empty' or 'board'. */
export function useLiveFlatState(): FlatState {
  // A number, so a session update that changes no count does not re-render.
  const listedCount = useSessionStore((s) => countListed(s.sessions));
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  // A restore running, or not yet decided (the first snapshot of a fresh server is empty).
  const restoring = useUiStore((s) => s.workspaceLoad.active || s.workspaceRestorePending);
  return liveFlatState({ snapshotReceived, restoring, listedCount });
}

/**
 * Is the one-time tip up? `onLiveRoute` comes from the caller: the NavBar
 * reads it from the router, the LIVE page is the route.
 */
export function useLiveHint(onLiveRoute: boolean): { visible: boolean; dismiss: () => void } {
  const dismissed = useUiStore((s) => s.liveHintDismissed);
  const dismiss = useUiStore((s) => s.dismissLiveHint);
  const minimized = useUiStore((s) => s.detailPanelMinimized);
  const selected = useSessionStore((s) => s.selectedSessionId !== null);
  const scene3dEnabled = useSettingsStore((s) => s.scene3dEnabled);
  const isMobile = useIsMobile();
  const flatState = useLiveFlatState();
  const visible = shouldShowLiveHint({
    dismissed,
    onLiveRoute,
    scene3dEnabled,
    isMobile,
    boardShown: flatState === 'board',
    panelOpen: selected && !minimized,
  });
  return { visible, dismiss };
}
