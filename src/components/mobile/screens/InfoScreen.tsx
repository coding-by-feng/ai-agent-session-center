/**
 * InfoScreen — a session's Info (AASC-46, design §5.5): tap the session's title.
 *
 *   ‹      agent-manager-2
 *       Claude Code · Working · 1h 12m
 *   SESSION   status · model/effort › · context · plan usage · project › · room ›
 *             remark › · notifications (●) · loud alerts (●) · AI popups (●) · driving
 *   OPEN      Files › (the session's Project tab, AASC-56) Notes › Queue › Agents › AI popups ›
 *   ACTIONS   Rename · Restart | Resume · Fork · Clone · Move to room · Manage rooms
 *             Kill session (red, confirms)
 *
 * It replaced the classic phone layout's header chips and ⋯ sheets (removed in
 * AASC-48), so everything those offered is here, and only what a paired phone
 * may do: no Pin inside the app (AASC-50), no Share.
 * Which device typed into the session last is said in plain words (any device drives it).
 */
import { useCallback, useState } from 'react';
import type { Session } from '@/types';
import { Banner, Button, EmptyState, ListRow, ListSection, Screen, StatusRing } from '../kit';
import ConnectionBanner from './ConnectionBanner';
import SessionSheets, { type SessionSheetKind } from './info/SessionSheets';
import { forkBlocker, useSessionActions } from './info/useSessionActions';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { usePhoneNavStore } from '@/stores/phoneNavStore';
import { useRoomStore } from '@/stores/roomStore';
import { useComposerDraftStore } from '@/stores/composerDraftStore';
import { useQueueStore } from '@/stores/queueStore';
import { useNotesStore } from '@/stores/notesStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useControlBaton } from '@/hooks/useControlBaton';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { isCompacting, phoneStatus } from '@/lib/chat/phoneStatus';
import { infoPath, sessionHasChat, type InfoPage } from '@/lib/chat/phoneRoutes';
import { detectCli } from '@/lib/cliDetect';
import { faultLabel } from '@/lib/resumeWatchdog';
import { isAiPopupEnabled } from '@/lib/aiPopup';
import {
  contextWords,
  formatRunTime,
  infoSubtitle,
  modelBlocker,
  modelWords,
  planWords,
  restartBlocker,
} from '@/lib/chat/sessionInfoModel';
import { useClock } from '@/lib/chat/clock';
import styles from '@/styles/modules/mobile/SessionInfo.module.css';

const EMPTY: readonly unknown[] = [];

function ControlRows({ sessionId }: { sessionId: string }) {
  const baton = useControlBaton(sessionId);
  // Every device drives directly (Oct 2026: no Ask / Take / Release), so this only says who typed last.
  const last = baton.mode === 'driver' ? 'This phone' : baton.holder?.label ?? null;
  return last ? <ListRow title="Last typed from" value={last} /> : null;
}

function InfoBody({ session }: { session: Session }) {
  const { sessionId } = session;
  const push = usePhoneNavStore((s) => s.push);
  const showSegment = usePhoneNavStore((s) => s.showSegment);
  const room = useRoomStore((s) => s.rooms.find((r) => r.sessionIds.includes(sessionId)));
  const queued = useQueueStore((s) => s.queues.get(sessionId)?.length ?? 0);
  const notes = useNotesStore((s) => s.notes.get(sessionId) ?? EMPTY).length;
  const popups = useFloatingSessionsStore((s) => s.floats.filter((f) => f.originSessionId === sessionId).length);
  const { busy, copy, resume, setNotifications, setLoudAlerts, setAiPopups } = useSessionActions();
  const now = useClock();
  const [sheet, setSheet] = useState<SessionSheetKind | null>(null);
  const to = useCallback((kind: SessionSheetKind) => () => setSheet(kind), []);
  const openPage = (page: InfoPage) => () => push(infoPath(sessionId, page));
  // Files is the session's own Project tab (AASC-56), not a second browser: back to it.
  const openProject = () => showSegment(sessionId, 'project', sessionHasChat(detectCli(session)));
  // Model is the composer's model sheet (Oct 20 2026): one sheet, and the change goes out as
  // the composer sends it (queued behind a turn, /model before /effort). Only Claude Code and
  // Codex have a model (modelBlocker), and both have a Chat.
  const openModel = () => {
    useComposerDraftStore.getState().requestSheet(sessionId, 'model');
    showSegment(sessionId, 'chat', true);
  };

  const ended = session.status === 'ended';
  const model = modelWords(session);
  const context = contextWords(session);
  const plan = planWords(session, now);
  const subagents = session.subagents?.filter((a) => a.status === 'working').length ?? 0;
  const modelWhyNot = modelBlocker(session);
  const restartWhyNot = restartBlocker(session);
  const forkWhyNot = forkBlocker(session);
  const busyReason = busy ? 'Working on it…' : undefined;

  return (
    <>
      {session.interruption && !ended && (
        <div className={styles.banner}>
          <Banner tone="error" title={`Stopped by ${faultLabel(session.interruption.kind)}`}>
            {session.interruption.line}
          </Banner>
        </div>
      )}
      <ListSection header="Session">
        <ListRow
          leading={<StatusRing status={session.status} interrupted={!!session.interruption} />}
          title={phoneStatus(session.status, !!session.interruption, isCompacting(session)).label}
          value={formatRunTime(session, now)}
        />
        <ListRow
          title="Model"
          value={model ?? 'Not reported yet'}
          chevron={!modelWhyNot}
          disabledReason={modelWhyNot ?? undefined}
          onClick={openModel}
        />
        <ListRow title="Context" value={context ?? 'Not reported yet'} />
        <ListRow title="Plan usage" subtitle={plan ?? 'Not reported yet'} />
        <ListRow title="Project" value={session.projectName || '—'} chevron onClick={openProject} ariaLabel={`Project ${session.projectName}: open its files`} />
        <ListRow title="Room" value={room?.name ?? 'None'} chevron onClick={to('move-room')} />
        <ListRow title="Remark" subtitle={session.remark || 'None'} chevron onClick={to('remark')} />
        <ListRow
          title="Notifications"
          subtitle="Off mutes its pushes and sounds"
          toggle={{ checked: !session.muted, onChange: (on) => setNotifications(session, on) }}
        />
        <ListRow
          title="Loud alerts"
          subtitle="Ring out for approvals and finished turns"
          toggle={{ checked: !!session.alerted, onChange: (on) => setLoudAlerts(session, on) }}
        />
        <ListRow
          title="AI popups"
          subtitle="Select text to explain, translate or ask about it"
          toggle={{ checked: isAiPopupEnabled(session), onChange: (on) => void setAiPopups(session, on) }}
        />
        <ControlRows sessionId={sessionId} />
      </ListSection>

      <ListSection header="Open">
        <ListRow title="Files" subtitle="The project, read-only: its Project tab" chevron onClick={openProject} />
        <ListRow title="Notes" value={notes > 0 ? String(notes) : undefined} chevron onClick={openPage('notes')} />
        <ListRow title="Queue" value={queued > 0 ? String(queued) : undefined} chevron onClick={openPage('queue')} />
        <ListRow title="Agents" value={subagents > 0 ? `${subagents} running` : undefined} chevron onClick={openPage('agents')} />
        <ListRow title="AI popups" value={popups > 0 ? `${popups} open` : undefined} chevron onClick={openPage('popups')} />
      </ListSection>

      <ListSection header="Actions">
        <ListRow title="Rename" chevron onClick={to('rename')} />
        {ended ? (
          <ListRow
            title={busy === 'resume' ? 'Resuming…' : 'Resume'}
            subtitle="Start it again where it left off"
            disabledReason={busyReason}
            onClick={() => void resume(sessionId)}
          />
        ) : (
          <ListRow title="Restart" subtitle="A fresh terminal, same session" disabledReason={restartWhyNot ?? undefined} onClick={to('restart')} />
        )}
        <ListRow
          title={busy === 'fork' ? 'Forking…' : 'Fork'}
          subtitle="Continue this conversation in a new session"
          disabledReason={forkWhyNot ?? busyReason}
          onClick={() => void copy(sessionId, 'fork')}
        />
        <ListRow
          title={busy === 'clone' ? 'Cloning…' : 'Clone'}
          subtitle="A new session with the same command and folder"
          disabledReason={busyReason}
          onClick={() => void copy(sessionId, 'clone')}
        />
        <ListRow title="Move to room" chevron onClick={to('move-room')} />
        <ListRow title="Manage rooms" chevron onClick={to('manage-rooms')} />
        <ListRow title="Kill session" destructive disabledReason={ended ? 'It has already ended.' : undefined} onClick={to('kill')} />
      </ListSection>

      <SessionSheets sessionId={sessionId} sheet={sheet} onSheet={setSheet} />
    </>
  );
}

export default function InfoScreen({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  const snapshotReceived = useWsStore((s) => s.snapshotReceived);
  const pop = usePhoneNavStore((s) => s.pop);
  const now = useClock();

  if (!session) {
    return (
      <Screen title="Info" onBack={pop} backLabel="Back to the session" testId="phone-info-missing">
        <EmptyState
          live={!snapshotReceived}
          title={snapshotReceived ? 'This session isn’t here' : 'Loading…'}
          message={snapshotReceived ? 'It ended, or it isn’t shared with this phone.' : undefined}
          action={snapshotReceived ? <Button onClick={pop}>Back</Button> : undefined}
        />
      </Screen>
    );
  }
  return (
    <Screen
      title={sessionDisplayTitle(session)}
      subtitle={infoSubtitle(session, now)}
      onBack={pop}
      backLabel="Back to the session"
      banner={<ConnectionBanner />}
      testId="phone-info"
    >
      <InfoBody session={session} />
    </Screen>
  );
}
