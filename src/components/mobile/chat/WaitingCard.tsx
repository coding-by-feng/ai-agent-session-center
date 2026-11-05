/**
 * WaitingCard — what a waiting session asks, pinned above the composer (AASC-43).
 *
 *   ⚠ Claude wants to run a command
 *   $ rm -rf dist && npm run build          the exact input, monospace, scrollable
 *   in agent-manager
 *   [ Deny ] [ Always allow ] [ Allow once ] the CLI's own choices, in its words
 *   Tell Claude what to do instead…      ›  = deny with a message (the composer)
 *   Open terminal                        ›  always there, the fallback
 *
 * The model (lib/chat/waitingCardModel) decides what shows and which choices;
 * useRequestAnswer answers through the Mac's checked route. Answered elsewhere →
 * "Already answered on your Mac"; the Mac can't tell the choices → only "Open
 * terminal". The card is server state, so it comes back after a reconnect.
 * While the chat shows the question as its own card (items/QuestionCard, Nov 2 2026), the
 * choices are there and this card says so instead of repeating them. Since Nov 5 2026 it also
 * drops what is asked (the chat card shows it whole): repeating it made this card a third of the
 * screen and covered the chat's answers. Its header then points up: "Answer above"
 * scrolls the chat to the open question.
 */
import { useId } from 'react';
import type { Session } from '@/types';
import { Button, ConfirmSheet } from '../kit';
import { ChevronRightIcon } from '../kit/kitIcons';
import { offeredChoices, type CardDetail, type WaitingCard as WaitingCardData } from '@/lib/chat/waitingCardModel';
import { choiceKey, useRequestAnswer } from './useRequestAnswer';
import { useAnsweredInChat } from './chatQuestions';
import { QuestionIcon, TerminalIcon, WarningIcon } from './chatIcons';
import styles from '@/styles/modules/mobile/WaitingCard.module.css';

export interface WaitingCardProps {
  session: Session;
  card: WaitingCardData;
  onTerminal: () => void;
  /** "Tell Claude what to do instead…" / "Other…": the composer takes it from here. */
  onTell: () => void;
}

export function CardDetailView({ detail }: { detail: CardDetail }) {
  switch (detail.type) {
    case 'command':
      return (
        <div className={styles.detail}>
          {detail.description && <p className={styles.caption}>{detail.description}</p>}
          <pre className={styles.code} tabIndex={0} aria-label="Command"><span aria-hidden="true">$ </span>{detail.command}</pre>
        </div>
      );
    case 'diff':
      return (
        <div className={styles.detail}>
          <p className={styles.file}>
            <span className={styles.fileName}>{detail.file || 'A file'}</span>
            <span className={styles.counts}>
              <span className={styles.added}>+{detail.added}</span> <span className={styles.removed}>−{detail.removed}</span>
            </span>
          </p>
          <div className={styles.diff} tabIndex={0} role="group" aria-label={`Changes to ${detail.file || 'the file'}`}>
            {detail.lines.map((line, i) => (
              <div key={i} className={styles.diffLine} data-op={line.op}>
                <span className={styles.gutter} aria-hidden="true">{line.op === '@' ? '⋯' : line.op === ' ' ? '' : line.op === '-' ? '−' : '+'}</span>
                <span className={styles.lineText}>
                  {line.op === '-' && <span className={styles.srOnly}>Removed: </span>}
                  {line.op === '+' && <span className={styles.srOnly}>Added: </span>}
                  {line.text || ' '}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    case 'url':
      return (
        <div className={styles.detail}>
          <p className={styles.url}>{detail.url}</p>
          {detail.prompt && <p className={styles.caption}>{detail.prompt}</p>}
        </div>
      );
    case 'question':
      return (
        <div className={styles.detail}>
          {detail.header && <p className={styles.caption}>{detail.header}</p>}
          <p className={styles.question}>{detail.question}</p>
        </div>
      );
    case 'plan':
    case 'text':
      return (
        <div className={styles.detail}>
          <pre className={`${styles.code} ${detail.type === 'plan' ? styles.prose : ''}`} tabIndex={0}>{detail.text}</pre>
        </div>
      );
    default:
      return null;
  }
}

/** Scroll the chat to its open question card (the newest when several are open). */
function scrollToChatQuestion(): void {
  const open = document.querySelectorAll('[data-chat-question][data-open]');
  const target = open[open.length - 1] ?? null;
  if (!target) return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

export default function WaitingCard({ session, card, onTerminal, onTell }: WaitingCardProps) {
  const titleId = useId();
  const { busy, outcome, confirm, cancelConfirm, answer, spectator, driver } = useRequestAnswer(session.sessionId, card.requestId, card.cliName);
  const tone = card.kind === 'question' ? 'question' : 'approval';
  const terminalOnly = card.terminalOnly || outcome?.kind === 'terminal-only';
  const settled = outcome?.kind === 'sent' || outcome?.kind === 'stale';
  const isQuestion = card.kind === 'question';
  // A question card in the chat offers the same choices (items/QuestionCard): the card here keeps
  // what is asked, "Other…" and the terminal, not a second set of buttons.
  const inChat = useAnsweredInChat(session.sessionId, isQuestion ? card.requestId : null);
  const answerable = !terminalOnly && !settled && card.choices.length > 0;
  const showChoices = answerable && !inChat;
  /** The chat shows this question whole: keep the title, Other… and the terminal, nothing it repeats. */
  const compact = answerable && inChat;
  const { offered, reasons } = offeredChoices(card.choices);

  const choices = showChoices && offered.length > 0 && (
    <div className={isQuestion ? styles.options : styles.choices} role="group" aria-label="Answers">
      {offered.map((choice) => {
        const primary = choice.tone === 'primary';
        const label = spectator && primary ? `Take control and ${choice.label.toLowerCase()}` : choice.label;
        return (
          <Button
            key={choiceKey(choice.answer)}
            small
            variant={primary ? 'primary' : 'secondary'}
            className={`${choice.tone === 'destructive' ? styles.deny : ''} ${isQuestion ? styles.option : styles.choice}`}
            onClick={() => answer(choice)}
            loading={busy === choiceKey(choice.answer)}
          >
            {isQuestion ? (
              <span className={styles.optionText}>
                <span>{label}</span>
                {choice.description && <span className={styles.optionNote}>{choice.description}</span>}
              </span>
            ) : label}
          </Button>
        );
      })}
    </div>
  );

  // The header and the answers stay put; what is asked scrolls between them, so a
  // long command or diff never pushes an answer out of reach (the card is capped
  // by ChatFooter). A question's options are part of what scrolls: there may be nine.
  return (
    <section className={styles.card} data-tone={tone} aria-labelledby={titleId} data-testid="waiting-card">
      <header className={styles.header} data-compact={compact ? '' : undefined}>
        <span className={styles.icon}>{isQuestion ? <QuestionIcon /> : <WarningIcon />}</span>
        <h3 id={titleId} className={styles.title}>{card.title}</h3>
        {compact && (
          <button type="button" className={styles.jump} onClick={scrollToChatQuestion} data-testid="waiting-card-in-chat">
            Answer above
            <ChevronRightIcon className={styles.jumpIcon} aria-hidden="true" />
          </button>
        )}
      </header>
      {!compact && (
        <div className={styles.scroll} data-testid="waiting-card-body">
          <div className={styles.body}>
            <CardDetailView detail={card.detail} />
            {card.where && <p className={styles.where}>{card.where}</p>}
          </div>
          {isQuestion && choices}
        </div>
      )}

      <div className={styles.fixed}>
        {outcome?.kind === 'stale' && <p className={styles.state} role="status">Already answered on your Mac</p>}
        {outcome?.kind === 'sent' && <p className={styles.state} role="status">Answered. Waiting for {card.cliName} to go on…</p>}
        {terminalOnly && (
          <p className={styles.reason} role="status">
            {outcome?.kind === 'terminal-only' ? outcome.message : card.terminalOnlyReason}
          </p>
        )}
        {outcome?.kind === 'error' && <p className={styles.error} role="alert">{outcome.message}</p>}
        {showChoices && reasons.map((reason) => <p key={reason} className={styles.reason}>{reason}</p>)}
        {showChoices && spectator && <p className={styles.note}>{driver} is driving. Answering takes control.</p>}
        {!isQuestion && choices}

        <div className={styles.links}>
          {/* The box is off while another device drives: nothing to tell it in. */}
          {answerable && card.tell && !spectator && (
            <button type="button" className={styles.link} onClick={onTell}>
              <span>{card.tell.label}</span>
              <ChevronRightIcon />
            </button>
          )}
          <button type="button" className={styles.link} onClick={onTerminal} data-testid="waiting-card-terminal">
            <span className={styles.linkLead}><TerminalIcon /> Open terminal</span>
            <ChevronRightIcon />
          </button>
        </div>
      </div>

      <ConfirmSheet
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={() => confirm?.run()}
        onCancel={cancelConfirm}
      />
    </section>
  );
}
