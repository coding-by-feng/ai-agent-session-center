/**
 * InfoScreen — a session's Info (AASC-46, design §5.5): tap the session's title.
 *
 *   ‹      agent-manager-2
 *       Claude Code · Working · 1h 12m
 *   SESSION   status · model/effort › · context · plan usage · project › · room ›
 *             label › · remark › · notifications (●) · loud alerts (●) · driving
 *   OPEN      Files › Notes › Queue › Agents › AI popups ›
 *   ACTIONS   Rename · Restart | Resume · Fork · Clone · Move to room · Manage rooms
 *             Kill session (red, confirms)
 *
 * It replaced the classic phone layout's header chips and ⋯ sheets (removed in
 * AASC-48), so everything those offered is here, and only what a paired phone
 * may do: no Pin inside the app (AASC-50), no Share.
 * Who is driving is said in plain words, with Ask / Take / Release control.
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
import { useLabelStore } from '@/stores/labelStore';
import { useQueueStore } from '@/stores/queueStore';
import { useNotesStore } from '@/stores/notesStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useControlBaton } from '@/hooks/useControlBaton';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { phoneStatus } from '@/lib/chat/phoneStatus';
import { infoPath, type InfoPage } from '@/lib/chat/phoneRoutes';
import { faultLabel } from '@/lib/resumeWatchdog';
import {
  contextWords,
  drivingWords,
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
  const driving = drivingWords(baton.mode, baton.holder?.label ?? null);
  return (
    <>
      <ListRow title="Driving" value={driving} />
      {baton.mode === 'spectator' && baton.holder && (
        <>
          <ListRow title="Ask for control" subtitle={`${baton.holder.label} is asked to hand it over`} onClick={() => void baton.ask()} />
          <ListRow
            title="Take control"
            disabledReason={baton.canTake ? undefined : `Opens after ${baton.waitSecs}s of quiet on ${baton.holder.label}.`}
            onClick={() => void baton.take()}
          />
        </>
      )}
      {(baton.mode === 'driver' || baton.mode === 'asked') && (
        <ListRow title="Release control" subtitle="Another device may then drive it" onClick={() => void baton.release()} />
      )}
    </>
  );
}

function InfoBody({ session }: { session: Session }) {
  const { sessionId } = session;
  const push = usePhoneNavStore((s) => s.push);
  const room = useRoomStore((s) => s.rooms.find((r) => r.sessionIds.includes(sessionId)));
  const label = useLabelStore((s) => s.labels[sessionId]);
  const queued = useQueueStore((s) => s.queues.get(sessionId)?.length ?? 0);
  const notes = useNotesStore((s) => s.notes.get(sessionId) ?? EMPTY).length;
  const popups = useFloatingSessionsStore((s) => s.floats.filter((f) => f.originSessionId === sessionId).length);
  const { busy, copy, resume, setNotifications, setLoudAlerts } = useSessionActions();
  const now = useClock();
  const [sheet, setSheet] = useState<SessionSheetKind | null>(null);
  const to = useCallback((kind: SessionSheetKind) => () => setSheet(kind), []);
  const openPage = (page: InfoPage) => () => push(infoPath(sessionId, page));

  const ended = session.status === 'ended';
  const model = modelWords(session);
  const context = contextWords(session);
  const plan = planWords(session);
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
          title={phoneStatus(session.status, !!session.interruption).label}
          value={formatRunTime(session, now)}
        />
        <ListRow
          title="Model"
          value={model ?? 'Not reported yet'}
          chevron={!modelWhyNot}
          disabledReason={modelWhyNot ?? undefined}
          onClick={to('model')}
        />
        <ListRow title="Context" value={context ?? 'Not reported yet'} />
        <ListRow title="Plan usage" subtitle={plan ?? 'Not reported yet'} />
        <ListRow title="Project" value={session.projectName || '—'} chevron onClick={openPage('files')} ariaLabel={`Project ${session.projectName}: open its files`} />
        <ListRow title="Room" value={room?.name ?? 'None'} chevron onClick={to('move-room')} />
        <ListRow title="Label" value={label ?? 'None'} chevron onClick={to('label')} />
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
        <ControlRows sessionId={sessionId} />
      </ListSection>

      <ListSection header="Open">
        <ListRow title="Files" subtitle="The project, read-only" chevron onClick={openPage('files')} />
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
