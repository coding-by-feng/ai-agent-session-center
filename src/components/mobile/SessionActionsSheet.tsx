/**
 * SessionActionsSheet — one session's touch actions on a phone (AASC-18), from
 * its row in the session drawer: its label, its remark, its room (AASC-20:
 * move it, manage rooms), and fork / clone.
 *
 * The desktop does these from the header's tag and note icons (a cursor-placed
 * label popover, an inline one-line editor) and the terminal toolbar; on a
 * phone each is a full-width control in a sheet within thumb reach, and works
 * for any session in the list, not only the open one.
 *
 * Nothing here destroys anything: a label or remark can be set again, and fork
 * and clone create a session. So nothing asks for confirmation.
 */
import { useCallback, useId, useState, type CSSProperties } from 'react';
import BottomSheet from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import { BUILTIN_LABELS, useLabelStore } from '@/stores/labelStore';
import { useSessionStore } from '@/stores/sessionStore';
import { copySession, type CopyKind } from '@/lib/sessionCopy';
import { detectCli } from '@/lib/cliDetect';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';
import { RoomSection } from './RoomSheets';
import styles from '@/styles/modules/SessionDrawer.module.css';

/** The longest remark the header's own editor accepts. */
const REMARK_MAX = 200;
const LABEL_MAX = 24;

interface SessionActionsSheetProps {
  /** The session to act on; null = closed. */
  sessionId: string | null;
  onClose: () => void;
  /** A fork or clone opened its new session: the caller may close the drawer too. */
  onOpened?: () => void;
}

function LabelSection({ sessionId }: { sessionId: string }) {
  const headingId = useId();
  const active = useLabelStore((s) => s.labels[sessionId]);
  const custom = useLabelStore((s) => s.custom);
  const setLabel = useLabelStore((s) => s.setLabel);
  const addCustom = useLabelStore((s) => s.addCustom);
  const [name, setName] = useState('');
  const all = [...BUILTIN_LABELS, ...custom];

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const existing = all.find((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) {
      setLabel(sessionId, existing.name);
    } else {
      addCustom(trimmed, ROOM_COLOR_PALETTE[custom.length % ROOM_COLOR_PALETTE.length]);
      setLabel(sessionId, trimmed);
    }
    setName('');
  };

  return (
    <section className={styles.actionSection} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.actionHeading}>Label</h3>
      <div className={styles.labelChips} role="group" aria-label="Labels">
        {all.map((l) => (
          <button
            key={l.name}
            type="button"
            className={styles.labelChip}
            style={{ '--label-color': l.color } as CSSProperties}
            aria-pressed={active === l.name}
            onClick={() => setLabel(sessionId, active === l.name ? null : l.name)}
          >
            {l.name}
          </button>
        ))}
      </div>
      <form
        className={styles.inlineForm}
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <TextInput
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New label"
          aria-label="New label name"
          maxLength={LABEL_MAX}
          className={styles.grow}
        />
        <Button type="submit" disabled={!name.trim()}>Add</Button>
      </form>
      {active && (
        <Button variant="quiet" className={styles.alignStart} onClick={() => setLabel(sessionId, null)}>
          Remove label
        </Button>
      )}
    </section>
  );
}

function RemarkSection({ sessionId, remark }: { sessionId: string; remark: string }) {
  const headingId = useId();
  const [draft, setDraft] = useState(remark);
  const save = () => useSessionStore.getState().setSessionRemark(sessionId, draft.trim());
  const unchanged = draft.trim() === remark.trim();
  return (
    <section className={styles.actionSection} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.actionHeading}>Remark</h3>
      <form
        className={styles.inlineForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (!unchanged) save();
        }}
      >
        <TextInput
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="What's happening in this session?"
          aria-label="Session remark"
          maxLength={REMARK_MAX}
          className={styles.grow}
        />
        <Button type="submit" variant="primary" disabled={unchanged}>Save</Button>
      </form>
    </section>
  );
}

function CopySection({ sessionId, forkable, onOpened }: { sessionId: string; forkable: boolean; onOpened: () => void }) {
  const headingId = useId();
  const [pending, setPending] = useState<CopyKind | null>(null);
  const run = useCallback(async (kind: CopyKind) => {
    if (pending) return;
    setPending(kind);
    const created = await copySession(sessionId, kind);
    setPending(null);
    if (created) onOpened();
  }, [pending, sessionId, onOpened]);

  return (
    <section className={styles.actionSection} aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.actionHeading}>New session from this one</h3>
      <div className={styles.copyButtons}>
        {forkable && (
          <Button onClick={() => void run('fork')} disabled={pending !== null} aria-busy={pending === 'fork' || undefined}>
            {pending === 'fork' ? 'Forking…' : 'Fork'}
          </Button>
        )}
        <Button onClick={() => void run('clone')} disabled={pending !== null} aria-busy={pending === 'clone' || undefined}>
          {pending === 'clone' ? 'Cloning…' : 'Clone'}
        </Button>
      </div>
      <p className={styles.actionHint}>
        {forkable && 'Fork continues this conversation in a new session. '}
        Clone starts a new session with the same command and folder.
      </p>
    </section>
  );
}

export default function SessionActionsSheet({ sessionId, onClose, onOpened }: SessionActionsSheetProps) {
  const session = useSessionStore((s) => (sessionId ? s.sessions.get(sessionId) : undefined));
  const opened = useCallback(() => {
    onClose();
    onOpened?.();
  }, [onClose, onOpened]);

  const open = !!sessionId && !!session;
  const cli = session ? detectCli(session) : null;
  return (
    <BottomSheet open={open} onClose={onClose} title={session ? sessionDisplayTitle(session) : 'Session'}>
      {session && (
        // Keyed by session: a draft typed for one session never shows on another's sheet.
        <div key={session.sessionId} className={styles.actions}>
          <LabelSection sessionId={session.sessionId} />
          <RemarkSection sessionId={session.sessionId} remark={session.remark ?? ''} />
          <RoomSection sessionId={session.sessionId} />
          <CopySection
            sessionId={session.sessionId}
            forkable={cli === 'claude' || cli === 'codex'}
            onOpened={opened}
          />
        </div>
      )}
    </BottomSheet>
  );
}
