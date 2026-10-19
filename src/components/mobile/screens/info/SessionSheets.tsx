/**
 * SessionSheets — one session's sheets on the phone (AASC-40 / AASC-46): its
 * actions, rename, remark, room, and the restart and kill confirms. Model and
 * effort are the composer's sheet (Oct 20 2026), and labels stay on the device
 * that set them (labelStore never syncs), so the phone offers neither here. The Sessions list (long press, swipe "More"), Info and the
 * session's ⋯ sheet all open them, so an action works the same wherever it was
 * asked for.
 *
 * Kill and Restart confirm in a ConfirmSheet (a misfired tap must not stop an
 * agent); everything else changes something that can be changed back. Only what
 * a paired phone may do is offered: no Pin (AASC-50), no Share.
 */
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@/types';
import { Button, ConfirmSheet, ListRow, ListSection, Sheet } from '../../kit';
import { ManageRoomsSheet, MoveToRoomSheet } from '../../RoomSheets';
import { useSessionStore } from '@/stores/sessionStore';
import { showToast } from '@/components/ui/ToastContainer';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { requestSessionRestart, restartNeedsConfirm } from '@/lib/restartSession';
import { requestSessionKill } from '@/lib/sessionActions';
import { killMessage, restartBlocker, restartMessage } from '@/lib/chat/sessionInfoModel';
import { forkBlocker, useSessionActions } from './useSessionActions';
import styles from '@/styles/modules/mobile/SessionSheets.module.css';

export type SessionSheetKind =
  | 'actions'
  | 'rename'
  | 'remark'
  | 'move-room'
  | 'manage-rooms'
  | 'restart'
  | 'kill';

/** The longest title and remark the desktop's own editors accept. */
export const TITLE_MAX = 200;
export const REMARK_MAX = 200;
const FIT = ['fit'] as const;
const FIT_LARGE = ['fit', 'large'] as const;

export interface SessionSheetsProps {
  /** The session the sheet is for; null renders nothing. */
  sessionId: string | null;
  sheet: SessionSheetKind | null;
  /** Keep it stable (a state setter): every sheet's close calls it with null. */
  onSheet: (next: SessionSheetKind | null) => void;
  /** The actions sheet offers "Info" when given. */
  onOpenInfo?: () => void;
  /** The actions sheet offers "Terminal" when given (AASC-56: the terminal left the tabs). */
  onOpenTerminal?: () => void;
}

export default function SessionSheets({ sessionId, sheet, onSheet, onOpenInfo, onOpenTerminal }: SessionSheetsProps) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const close = useCallback(() => onSheet(null), [onSheet]);
  const manageRooms = useCallback(() => onSheet('manage-rooms'), [onSheet]);
  if (!session) return null;
  // Keyed by session: a draft typed for one session never shows on another's sheet.
  const key = session.sessionId;
  return (
    <>
      <ActionsSheet
        key={`actions-${key}`}
        session={session}
        open={sheet === 'actions'}
        onSheet={onSheet}
        onClose={close}
        onOpenInfo={onOpenInfo}
        onOpenTerminal={onOpenTerminal}
      />
      {sheet === 'rename' && <RenameSheet key={`rename-${key}`} session={session} onClose={close} />}
      {sheet === 'remark' && <RemarkSheet key={`remark-${key}`} session={session} onClose={close} />}
      <MoveToRoomSheet sessionId={sheet === 'move-room' ? key : null} onClose={close} onManage={manageRooms} />
      <ManageRoomsSheet open={sheet === 'manage-rooms'} onClose={close} />
      <RestartConfirm session={session} open={sheet === 'restart'} onClose={close} />
      <KillConfirm session={session} open={sheet === 'kill'} onClose={close} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Actions (the long-press menu's list, as a sheet: swipe "More")
// ---------------------------------------------------------------------------

function ActionsSheet({
  session,
  open,
  onSheet,
  onClose,
  onOpenInfo,
  onOpenTerminal,
}: {
  session: Session;
  open: boolean;
  onSheet: (next: SessionSheetKind | null) => void;
  onClose: () => void;
  onOpenInfo?: () => void;
  onOpenTerminal?: () => void;
}) {
  const { busy, copy, resume } = useSessionActions();
  const ended = session.status === 'ended';
  const restartWhyNot = restartBlocker(session);
  const forkWhyNot = forkBlocker(session);
  const to = (next: SessionSheetKind) => () => onSheet(next);
  const thenClose = (action: () => void) => () => {
    onClose();
    action();
  };
  return (
    <Sheet open={open} onClose={onClose} title={sessionDisplayTitle(session)} detents={FIT_LARGE} testId="session-actions-sheet">
      {(onOpenInfo || onOpenTerminal) && (
        <ListSection label="Open">
          {onOpenInfo && <ListRow title="Info" subtitle="Status, model, notes, queue, agents" chevron onClick={thenClose(onOpenInfo)} />}
          {onOpenTerminal && <ListRow title="Terminal" subtitle="Full screen, with keys to type" chevron onClick={thenClose(onOpenTerminal)} />}
        </ListSection>
      )}
      <ListSection header="Edit">
        <ListRow title="Rename" chevron onClick={to('rename')} />
        <ListRow title="Remark" chevron onClick={to('remark')} />
        <ListRow title="Move to room" chevron onClick={to('move-room')} />
      </ListSection>
      <ListSection header="New session from this one">
        <ListRow
          title={busy === 'fork' ? 'Forking…' : 'Fork'}
          subtitle="Continue this conversation in a new session"
          disabledReason={forkWhyNot ?? (busy ? 'Working on it…' : undefined)}
          onClick={thenClose(() => void copy(session.sessionId, 'fork'))}
        />
        <ListRow
          title={busy === 'clone' ? 'Cloning…' : 'Clone'}
          subtitle="A new session with the same command and folder"
          disabledReason={busy ? 'Working on it…' : undefined}
          onClick={thenClose(() => void copy(session.sessionId, 'clone'))}
        />
      </ListSection>
      <ListSection header="Session">
        {ended ? (
          <ListRow
            title={busy === 'resume' ? 'Resuming…' : 'Resume'}
            subtitle="Start it again where it left off"
            disabledReason={busy ? 'Working on it…' : undefined}
            onClick={thenClose(() => void resume(session.sessionId))}
          />
        ) : (
          <ListRow title="Restart" subtitle="A fresh terminal, same session" disabledReason={restartWhyNot ?? undefined} onClick={to('restart')} />
        )}
        <ListRow title="Kill session" destructive disabledReason={ended ? 'It has already ended.' : undefined} onClick={to('kill')} />
      </ListSection>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Rename, label, remark
// ---------------------------------------------------------------------------

function SheetForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className={styles.form}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

export function RenameSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  // Pre-filled with what the title shows; saving that untouched would count as a
  // manual rename and suppress the automatic title from the first prompt.
  const [initial] = useState(() => (session.title || session.projectName || '').trim());
  const [draft, setDraft] = useState(initial);
  const trimmed = draft.trim();
  const unchanged = !trimmed || trimmed === initial || trimmed === session.title;
  const save = () => {
    if (unchanged) return;
    useSessionStore.getState().setSessionTitle(session.sessionId, trimmed);
    showToast(`Renamed to "${trimmed}"`, 'success');
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title="Rename" detents={FIT} testId="rename-sheet">
      <SheetForm onSubmit={save}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Session name</span>
          <input
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={TITLE_MAX}
            enterKeyHint="done"
            autoComplete="off"
          />
        </label>
        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabledReason={unchanged ? (trimmed ? 'Type a new name first.' : 'A name can’t be empty.') : undefined}>
            Save
          </Button>
        </div>
      </SheetForm>
    </Sheet>
  );
}

export function RemarkSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const remark = session.remark ?? '';
  const [draft, setDraft] = useState(remark);
  const unchanged = draft.trim() === remark.trim();
  const save = () => {
    if (unchanged) return;
    useSessionStore.getState().setSessionRemark(session.sessionId, draft.trim());
    showToast(draft.trim() ? 'Remark saved' : 'Remark cleared', 'success');
    onClose();
  };
  return (
    <Sheet open onClose={onClose} title="Remark" detents={FIT} testId="remark-sheet">
      <SheetForm onSubmit={save}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>What’s happening in this session?</span>
          <textarea
            className={`${styles.input} ${styles.textarea}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={REMARK_MAX}
            rows={3}
          />
        </label>
        <div className={styles.actions}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabledReason={unchanged ? 'Nothing changed yet.' : undefined}>Save</Button>
        </div>
      </SheetForm>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Confirms
// ---------------------------------------------------------------------------

function RestartConfirm({ session, open, onClose }: { session: Session; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const name = sessionDisplayTitle(session);
  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestSessionRestart(session.sessionId);
      showToast(result.ok ? `Restarting ${name}` : `${name}: ${result.error}`, result.ok ? 'info' : 'error');
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, session.sessionId, name, onClose]);
  return (
    <ConfirmSheet
      open={open}
      title="Restart this session?"
      message={restartMessage(name, session.status)}
      confirmLabel="Restart"
      danger={restartNeedsConfirm(session.status)}
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}

function KillConfirm({ session, open, onClose }: { session: Session; open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const name = sessionDisplayTitle(session);
  const confirm = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await requestSessionKill(session.sessionId, session.terminalId);
      if (result.warning) showToast(result.warning, 'error');
      showToast(result.message, result.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, session.sessionId, session.terminalId, onClose]);
  return (
    <ConfirmSheet
      open={open}
      title="Kill this session?"
      message={killMessage(name)}
      confirmLabel="Kill session"
      danger
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
