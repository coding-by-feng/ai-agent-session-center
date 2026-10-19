/**
 * InboxItemRow — one thing waiting in the Inbox (AASC-43), answerable in place.
 *
 *   ● ⚠ agent-manager-2 · 2m                       ›   tap: open the session
 *     Wants to run
 *     ┌ npm run build ┐                                the whole command, wrapped, never clipped
 *     [ Deny ]  [ Allow once ]                         the CLI's choices ("Always" only in the session)
 *
 * Approvals and questions answer through the same checked route and the same
 * take-control confirm as the session's card (useRequestAnswer). An interrupted
 * turn offers Continue; "continue all" continues each of its sessions; a
 * finished turn just opens. The dot says this phone hasn't seen it yet.
 */
import type { Session } from '@/types';
import { Button, ConfirmSheet } from '../kit';
import { ChevronRightIcon } from '../kit/kitIcons';
import { inboxAge, type InboxItem } from '@/lib/chat/inboxItems';
import { offeredChoices, waitingCardModel } from '@/lib/chat/waitingCardModel';
import { choiceKey, useRequestAnswer } from './useRequestAnswer';
import { ContinueIcon, DoneIcon, QuestionIcon, TerminalIcon, WarningIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/Inbox.module.css';

export interface InboxItemRowProps {
  item: InboxItem;
  /** The item's session (none for continue-all). */
  session: Session | undefined;
  now: number;
  unread: boolean;
  onOpen: (sessionId: string, segment?: 'chat' | 'terminal') => void;
  onRead: (itemId: string) => void;
  onContinue: (item: InboxItem) => void;
  continuing: boolean;
}

const KIND_ICON = {
  approval: <WarningIcon />,
  question: <QuestionIcon />,
  interrupted: <ContinueIcon />,
  'continue-all': <ContinueIcon />,
  finished: <DoneIcon />,
} as const;

function Answers({ item, session, onOpen, onRead }: { item: InboxItem; session: Session; onOpen: InboxItemRowProps['onOpen']; onRead: (id: string) => void }) {
  const card = waitingCardModel(session, { inbox: true });
  const { busy, outcome, confirm, cancelConfirm, answer, spectator, driver } = useRequestAnswer(session.sessionId, card?.requestId ?? null, card?.cliName);
  if (!card) return null;
  const terminalOnly = card.terminalOnly || outcome?.kind === 'terminal-only';
  const { offered, reasons } = offeredChoices(card.choices);
  const isQuestion = card.kind === 'question';
  return (
    <>
      {outcome?.kind === 'stale' && <p className={styles.state} role="status">Already answered on your Mac</p>}
      {outcome?.kind === 'sent' && <p className={styles.state} role="status">Answered</p>}
      {outcome?.kind === 'error' && <p className={styles.error} role="alert">{outcome.message}</p>}
      {terminalOnly && outcome?.kind !== 'stale' && outcome?.kind !== 'sent' && (
        <div className={styles.actions}>
          <Button small variant="secondary" icon={<TerminalIcon />} onClick={() => { onRead(item.id); onOpen(session.sessionId, 'terminal'); }}>
            Open terminal
          </Button>
        </div>
      )}
      {!terminalOnly && !outcome && (
        <>
          {reasons.map((reason) => <p key={reason} className={styles.note}>{reason}</p>)}
          {spectator && <p className={styles.note}>{driver} is driving. Answering takes control.</p>}
          <div className={isQuestion ? styles.options : styles.actions} role="group" aria-label={`Answers for ${item.title}`}>
            {offered.map((choice) => (
              <Button
                key={choiceKey(choice.answer)}
                small
                variant={choice.tone === 'primary' ? 'primary' : 'secondary'}
                className={choice.tone === 'destructive' ? styles.deny : undefined}
                onClick={() => { onRead(item.id); answer(choice); }}
                loading={busy === choiceKey(choice.answer)}
              >
                {spectator && choice.tone === 'primary' ? `Take control and ${choice.label.toLowerCase()}` : choice.label}
              </Button>
            ))}
            {isQuestion && card.tell && (
              <Button small variant="plain" onClick={() => { onRead(item.id); onOpen(session.sessionId); }}>{card.tell.label}</Button>
            )}
          </div>
        </>
      )}
      <ConfirmSheet
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={() => confirm?.run()}
        onCancel={cancelConfirm}
      />
    </>
  );
}

export default function InboxItemRow({ item, session, now, unread, onOpen, onRead, onContinue, continuing }: InboxItemRowProps) {
  const open = () => {
    onRead(item.id);
    if (item.sessionId) onOpen(item.sessionId);
  };
  const head = (
    <>
      <span className={styles.kind} data-kind={item.kind}>{KIND_ICON[item.kind]}</span>
      <span className={styles.text}>
        <span className={styles.head}>
          <span className={styles.title}>{item.title}</span>
          <span className={styles.age}>· {inboxAge(item.at, now)}</span>
          {unread && <span className={styles.unread} role="img" aria-label="Unread" />}
        </span>
        <span className={styles.line}>{item.command ? 'Wants to run' : item.line}</span>
      </span>
    </>
  );

  return (
    <li className={styles.item} data-kind={item.kind} data-testid="inbox-item">
      {item.sessionId ? (
        <button type="button" className={styles.main} onClick={open} aria-label={`${item.title}: ${item.line}. Open the session`}>
          {head}
          <span className={styles.chevron}><ChevronRightIcon /></span>
        </button>
      ) : (
        <div className={styles.main}>{head}</div>
      )}
      {/* One tap allows it, so what it runs is shown whole, not cut at two lines. */}
      {item.command && <pre className={styles.command} tabIndex={0} aria-label="The command" data-testid="inbox-command">{item.command}</pre>}
      {(item.kind === 'approval' || item.kind === 'question') && session && (
        <Answers item={item} session={session} onOpen={onOpen} onRead={onRead} />
      )}
      {(item.kind === 'interrupted' || item.kind === 'continue-all') && (
        <div className={styles.actions}>
          <Button
            small
            variant="primary"
            icon={<ContinueIcon />}
            loading={continuing}
            onClick={() => { onRead(item.id); onContinue(item); }}
          >
            {item.kind === 'continue-all' ? 'Continue all' : 'Continue'}
          </Button>
        </div>
      )}
    </li>
  );
}
