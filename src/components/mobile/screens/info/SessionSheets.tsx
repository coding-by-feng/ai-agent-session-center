/**
 * SessionSheets — one session's sheets on the phone (AASC-40 / AASC-46): its
 * actions, rename, label, remark, room, model and effort, and the restart and
 * kill confirms. The Sessions list (long press, swipe "More"), Info and the
 * session's ⋯ sheet all open them, so an action works the same wherever it was
 * asked for.
 *
 * Kill and Restart confirm in a ConfirmSheet (a misfired tap must not stop an
 * agent); everything else changes something that can be changed back. Only what
 * a paired phone may do is offered: no Pin (AASC-50), no Share.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@/types';
import type { CodexModelOption, ListCodexModelsResponse } from '@/types/api';
import { Button, ConfirmSheet, ListRow, ListSection, Sheet, Chip } from '../../kit';
import { ManageRoomsSheet, MoveToRoomSheet } from '../../RoomSheets';
import { useSessionStore } from '@/stores/sessionStore';
import { BUILTIN_LABELS, useLabelStore } from '@/stores/labelStore';
import { showToast } from '@/components/ui/ToastContainer';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { requestSessionRestart, restartNeedsConfirm } from '@/lib/restartSession';
import { requestSessionKill } from '@/lib/sessionActions';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';
import { detectCli } from '@/lib/cliDetect';
import { MODEL_STEP_OPTIONS, isModelAlias, modelStepText } from '@/lib/queueModel';
import { EFFORT_STEP_LEVELS, effortStepText } from '@/lib/queueEffort';
import { formatModelLabel } from '@/lib/modelLabel';
import { killMessage, restartBlocker, restartMessage, sendSessionCommand } from '@/lib/chat/sessionInfoModel';
import { forkBlocker, useSessionActions } from './useSessionActions';
import styles from '@/styles/modules/mobile/SessionSheets.module.css';

export type SessionSheetKind =
  | 'actions'
  | 'rename'
  | 'label'
  | 'remark'
  | 'move-room'
  | 'manage-rooms'
  | 'model'
  | 'restart'
  | 'kill';

/** The longest title and remark the desktop's own editors accept. */
export const TITLE_MAX = 200;
export const REMARK_MAX = 200;
const LABEL_MAX = 24;
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
      {sheet === 'label' && <LabelSheet key={`label-${key}`} session={session} onClose={close} />}
      {sheet === 'remark' && <RemarkSheet key={`remark-${key}`} session={session} onClose={close} />}
      {sheet === 'model' && <ModelSheet key={`model-${key}`} session={session} onClose={close} />}
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
  const label = useLabelStore((s) => s.labels[session.sessionId]);
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
        <ListRow title="Label" value={label} chevron onClick={to('label')} />
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

export function LabelSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const active = useLabelStore((s) => s.labels[session.sessionId]);
  const custom = useLabelStore((s) => s.custom);
  const [name, setName] = useState('');
  const all = [...BUILTIN_LABELS, ...custom];
  const set = (label: string | null) => useLabelStore.getState().setLabel(session.sessionId, label);
  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = all.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      set(existing.name);
    } else {
      useLabelStore.getState().addCustom(trimmed, ROOM_COLOR_PALETTE[custom.length % ROOM_COLOR_PALETTE.length]);
      set(trimmed);
    }
    setName('');
  };
  return (
    <Sheet open onClose={onClose} title="Label" detents={FIT_LARGE} testId="label-sheet">
      <div className={styles.chips} role="group" aria-label="Labels">
        {all.map((l) => (
          <Chip key={l.name} label={l.name} selected={active === l.name} onClick={() => set(active === l.name ? null : l.name)} />
        ))}
      </div>
      <SheetForm onSubmit={add}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>New label</span>
          <input
            className={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={LABEL_MAX}
            enterKeyHint="done"
            autoComplete="off"
          />
        </label>
        <div className={styles.actions}>
          {active ? <Button onClick={() => set(null)}>Remove label</Button> : <span />}
          <Button type="submit" variant="primary" disabledReason={name.trim() ? undefined : 'Type a label first.'}>Add</Button>
        </div>
      </SheetForm>
      <div className={styles.done}>
        <Button block onClick={onClose}>Done</Button>
      </div>
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
// Model and effort
// ---------------------------------------------------------------------------

function useCodexModels(enabled: boolean): CodexModelOption[] | null {
  const [models, setModels] = useState<CodexModelOption[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetch('/api/codex/models', { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json() as Promise<ListCodexModelsResponse>;
      })
      .then((data) => setModels(Array.isArray(data.models) ? data.models : []))
      .catch(() => {
        if (!controller.signal.aborted) setModels([]);
      });
    return () => controller.abort();
  }, [enabled]);
  return models;
}

export function ModelSheet({ session, onClose }: { session: Session; onClose: () => void }) {
  const cli = detectCli(session);
  const codexModels = useCodexModels(cli === 'codex');
  const [sending, setSending] = useState<string | null>(null);
  const current = (session.runtime?.model || session.model || '').toLowerCase();
  const effort = session.runtime?.effort || session.effortLevel || '';

  const send = useCallback(async (text: string, words: string) => {
    if (sending) return;
    setSending(text);
    const result = await sendSessionCommand(session.sessionId, text);
    setSending(null);
    if (result.ok) {
      showToast(`Asked your Mac to switch to ${words}`, 'success');
      onClose();
    } else {
      showToast(result.error, 'error');
    }
  }, [sending, session.sessionId, onClose]);

  const busyReason = sending ? 'Sending…' : undefined;
  const claudeModels = MODEL_STEP_OPTIONS;
  return (
    <Sheet open onClose={onClose} title="Model and effort" detents={['medium', 'large']} testId="model-sheet">
      <p className={styles.lead}>The change is typed into the session as a command, as on your Mac.</p>
      {cli === 'claude' && (
        <>
          <ListSection header="Model" footer="A tier name follows the newest model in its tier.">
            {claudeModels.filter(isModelAlias).map((m) => (
              <ListRow
                key={m}
                title={formatModelLabel(m)}
                value={current.includes(m) ? 'Current' : undefined}
                disabledReason={busyReason}
                onClick={() => void send(modelStepText(m), formatModelLabel(m))}
              />
            ))}
          </ListSection>
          <ListSection header="A pinned model">
            {claudeModels.filter((m) => !isModelAlias(m)).map((m) => (
              <ListRow key={m} title={formatModelLabel(m)} subtitle={m} disabledReason={busyReason} onClick={() => void send(modelStepText(m), formatModelLabel(m))} />
            ))}
          </ListSection>
          <ListSection header="Effort">
            {EFFORT_STEP_LEVELS.map((level) => (
              <ListRow
                key={level}
                title={level}
                value={effort === level ? 'Current' : undefined}
                disabledReason={busyReason}
                onClick={() => void send(effortStepText(level), `${level} effort`)}
              />
            ))}
          </ListSection>
        </>
      )}
      {cli === 'codex' && (
        <ListSection header="Model" footer={codexModels === null ? 'Asking your Mac for Codex’s models…' : codexModels.length === 0 ? 'Your Mac couldn’t list Codex’s models.' : undefined}>
          {(codexModels ?? []).map((m) => (
            <ListRow
              key={m.id}
              title={m.displayName}
              subtitle={m.description || undefined}
              value={current === m.id.toLowerCase() ? 'Current' : m.isDefault ? 'Default' : undefined}
              disabledReason={busyReason}
              onClick={() => void send(`/model ${m.id}`, m.displayName)}
            />
          ))}
        </ListSection>
      )}
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
