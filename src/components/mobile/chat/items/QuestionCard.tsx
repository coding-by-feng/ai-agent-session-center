/**
 * QuestionCard — an agent's multiple-choice question in the phone chat (Nov 2 2026), for Claude's
 * AskUserQuestion and Codex's request_user_input alike.
 *
 *   ? Claude asks                  Layout
 *   Which layout should I build?
 *   [ Cards (Recommended)       ]   live: a tap answers
 *     One per project
 *   [ List                      ]
 *
 *   ? Claude asked                 Layout
 *   ✓ Cards (Recommended)  ○ List   answered: the pick is marked
 *
 * - Claude: live while this call is the session's open, answerable request (one single-select
 *   question, at most nine options): the answer goes through the Mac's checked route, as the
 *   waiting card's does (useRequestAnswer), and the waiting card then stops repeating the choices.
 *   Several single-select questions (Nov 6 2026): pick one each, then Send answers; the Mac types
 *   a digit per question and Claude's Submit. A question only the terminal can answer (multi-select,
 *   more than nine choices) says so.
 * - Codex asks without waiting and reads your next message as the answer, so a tap sends the
 *   option as that message (with several questions: pick one each, then Send answers). It closes
 *   once you send anything.
 */
import { useId, useState, type ReactNode } from 'react';
import type { PendingRequest } from '@/types';
import type { QuestionItem } from '@/lib/chat/buildChatItems';
import type { ChatQuestion } from '@/lib/chat/questionItem';
import { answerableRequest, codexReply } from '@/lib/chat/questionItem';
import type { CardChoice } from '@/lib/chat/waitingCardModel';
import { composerAction, macWindowOpen } from '@/lib/chat/composerAction';
import { getClientId } from '@/lib/deviceIdentity';
import { useSessionStore } from '@/stores/sessionStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useControlBaton } from '@/hooks/useControlBaton';
import { Button, ConfirmSheet } from '../../kit';
import { ChevronRightIcon } from '../../kit/kitIcons';
import { QuestionIcon, TerminalIcon } from '../chatIcons';
import { CheckIcon } from '../chatViewIcons';
import { choiceKey, useRequestAnswer } from '../useRequestAnswer';
import { sendStatusLine, usePromptSender } from '../usePromptSender';
import { useDriverName } from '../useDriverName';
import { useAnswerInChat, useChatTerminal } from '../chatQuestions';
import MultiQuestionPicker from '../MultiQuestionPicker';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface QuestionCardProps {
  item: QuestionItem;
  sessionId: string;
}

function Shell({ item, children }: { item: QuestionItem; children: ReactNode }) {
  const titleId = useId();
  const cliName = item.cli === 'codex' ? 'Codex' : 'Claude';
  const header = item.questions.length === 1 ? item.questions[0].header : undefined;
  return (
    <section className={styles.question} aria-labelledby={titleId} data-open={item.open ? '' : undefined} data-chat-question="" data-testid="chat-question">
      <header className={styles.questionHead}>
        <span className={styles.questionIcon}><QuestionIcon /></span>
        <h3 id={titleId} className={styles.questionTitle}>{item.open ? `${cliName} asks` : `${cliName} asked`}</h3>
        {header && <span className={styles.questionTag}>{header}</span>}
      </header>
      {children}
    </section>
  );
}

function QuestionText({ question, several }: { question: ChatQuestion; several: boolean }) {
  return (
    <p className={styles.questionText}>
      {several && question.header && <span className={styles.questionTextTag}>{question.header} · </span>}
      {question.question}
    </p>
  );
}

/** A question's options as they were offered, the picks marked. */
function StaticOptions({ question, picked }: { question: ChatQuestion; picked: readonly string[] | null }) {
  if (question.options.length === 0) return null;
  return (
    <ul className={styles.questionPicks}>
      {question.options.map((o) => {
        const chosen = !!picked?.includes(o.label);
        return (
          <li key={o.label} className={styles.questionPick} data-chosen={chosen ? '' : undefined}>
            <span className={styles.questionMark} aria-hidden="true">{chosen ? <CheckIcon size={16} /> : <span className={styles.questionDot} />}</span>
            <span className={styles.questionPickText}>
              <span>{o.label}{chosen && <span className={styles.srOnly}> (chosen)</span>}</span>
              {o.description && <span className={styles.questionNote}>{o.description}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function TerminalLink({ label }: { label: string }) {
  const openTerminal = useChatTerminal();
  if (!openTerminal) return <p className={styles.questionState}>{label} on your Mac.</p>;
  return (
    <button type="button" className={styles.questionLink} onClick={openTerminal} data-testid="chat-question-terminal">
      <span className={styles.questionLinkLead}><TerminalIcon /> {label}</span>
      <ChevronRightIcon />
    </button>
  );
}

/** What a closed (or not answerable here) question says under its choices. */
function staticState(item: QuestionItem): ReactNode {
  if (item.failed) return <p className={styles.questionState}>Not answered</p>;
  if (item.open) {
    if (item.cli === 'codex') return <p className={styles.questionState}>Reply in the box below.</p>;
    return <TerminalLink label="Answer in Terminal" />;
  }
  const known = item.answers.some((a) => a !== null);
  if (known) return null;
  return <p className={styles.questionState}>{item.cli === 'codex' ? 'Answered in your next message' : 'Answered'}</p>;
}

function StaticQuestion({ item }: { item: QuestionItem }) {
  const several = item.questions.length > 1;
  return (
    <Shell item={item}>
      {item.questions.map((q, i) => (
        <div key={i} className={styles.questionBlock}>
          <QuestionText question={q} several={several} />
          <StaticOptions question={q} picked={item.answers[i]} />
        </div>
      ))}
      {staticState(item)}
    </Shell>
  );
}

function OptionButton({ label, description, onClick, loading, chosen }: {
  label: string; description?: string; onClick: () => void; loading?: boolean; chosen?: boolean;
}) {
  return (
    <Button small variant={chosen ? 'primary' : 'secondary'} className={styles.questionOption} onClick={onClick} loading={loading}>
      <span className={styles.questionOptionText}>
        <span>{label}</span>
        {description && <span className={styles.questionOptionNote}>{description}</span>}
      </span>
    </Button>
  );
}

/** Claude's open request: a tap answers it through the Mac (useRequestAnswer). */
function ClaudeQuestion({ item, sessionId, request }: QuestionCardProps & { request: PendingRequest }) {
  useAnswerInChat(sessionId, request.id);
  const { busy, outcome, confirm, cancelConfirm, answer, spectator, driver } = useRequestAnswer(sessionId, request.id, 'Claude');
  const [picked, setPicked] = useState<string[] | null>(null);
  const several = !!request.questions?.length;
  const settled = outcome?.kind === 'sent' || outcome?.kind === 'stale';
  const choices: CardChoice[] = (request.options ?? []).map((option, optionIndex) => ({
    answer: { choice: 'option', optionIndex },
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
    tone: 'secondary',
  }));
  const question = item.questions[0];

  if (settled || outcome?.kind === 'terminal-only') {
    return (
      <Shell item={item}>
        {item.questions.map((q, i) => (
          <div key={i} className={styles.questionBlock}>
            <QuestionText question={q} several={several} />
            <StaticOptions question={q} picked={outcome?.kind === 'sent' && picked?.[i] ? [picked[i]] : null} />
          </div>
        ))}
        {outcome?.kind === 'sent' && <p className={styles.questionState} role="status">Answered. Waiting for Claude to go on…</p>}
        {outcome?.kind === 'stale' && <p className={styles.questionState} role="status">Already answered on your Mac</p>}
        {outcome?.kind === 'terminal-only' && (
          <>
            <p className={styles.questionState} role="status">{outcome.message}</p>
            <TerminalLink label="Answer in Terminal" />
          </>
        )}
      </Shell>
    );
  }

  const sendAll = (optionIndexes: number[]) => {
    const questions = request.questions ?? [];
    setPicked(optionIndexes.map((pick, i) => questions[i]?.options[pick]?.label ?? ''));
    answer({ answer: { choice: 'options', optionIndexes }, label: 'Send answers', tone: 'primary' });
  };

  return (
    <Shell item={item}>
      {several ? (
        <MultiQuestionPicker questions={request.questions ?? []} onSend={sendAll} loading={busy?.startsWith('options:')} />
      ) : (
      <div className={styles.questionBlock}>
        <QuestionText question={question} several={false} />
        <div className={styles.questionOptions} role="group" aria-label="Answers">
          {choices.map((choice) => (
            <OptionButton
              key={choiceKey(choice.answer)}
              label={choice.label}
              description={choice.description}
              loading={busy === choiceKey(choice.answer)}
              onClick={() => {
                setPicked([choice.label]);
                answer(choice);
              }}
            />
          ))}
        </div>
      </div>
      )}
      {spectator && <p className={styles.questionState}>{driver} is driving. Answering takes control.</p>}
      {outcome?.kind === 'error' && <p className={styles.questionError} role="alert">{outcome.message}</p>}
      <ConfirmSheet
        open={!!confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        onConfirm={() => confirm?.run()}
        onCancel={cancelConfirm}
      />
    </Shell>
  );
}

/** Codex's open question: a pick is sent as your next message, the way the composer sends one. */
function CodexQuestion({ item, sessionId }: QuestionCardProps) {
  const status = useSessionStore((s) => s.sessions.get(sessionId)?.status ?? 'ended');
  const terminalId = useSessionStore((s) => s.sessions.get(sessionId)?.terminalId ?? null);
  const startHeard = useSessionStore((s) => s.sessions.get(sessionId)?.startHeard);
  const dialogOpen = useSessionStore((s) => !!s.sessions.get(sessionId)?.pendingRequest);
  const baton = useControlBaton(sessionId);
  const driver = useDriverName(baton.holder?.clientId, baton.holder?.label);
  const received = usePresenceStore((s) => s.received);
  const workspaceWriter = usePresenceStore((s) => s.workspaceWriter);
  const devices = usePresenceStore((s) => s.devices);
  const windowOpen = macWindowOpen({ received, workspaceWriter, devices }, getClientId());
  const sender = usePromptSender(sessionId);
  const [picks, setPicks] = useState<Array<string | null>>(() => item.questions.map(() => null));
  const [sent, setSent] = useState(false);

  const decision = composerAction({
    terminalId, startHeard,
    status, cli: 'codex', spectator: baton.mode === 'spectator', driverLabel: driver, card: null, macWindowOpen: windowOpen, hasContent: true,
  });
  // A dialog is up (an approval): typing now would answer it. The waiting card goes first.
  const blocked = dialogOpen ? 'Answer the card below first' : decision.fieldDisabledReason ?? (decision.canSend ? null : decision.blockedReason ?? 'Not now');
  const busy = sender.state.phase === 'sending';
  const several = item.questions.length > 1;
  const asked = item.questions.filter((q) => q.options.length > 0);
  const complete = item.questions.every((q, i) => q.options.length === 0 || picks[i] !== null);

  const deliver = async (next: Array<string | null>) => {
    if (blocked || busy) return;
    const text = codexReply(item.questions, next);
    if (!text) return;
    setSent(true);
    if (decision.action === 'queue') {
      sender.queue({ text });
      return;
    }
    const result = await sender.send({ text }, 'now');
    if (!result.ok) setSent(false);
  };

  const pick = (index: number, label: string) => {
    const next = picks.map((p, i) => (i === index ? label : p));
    setPicks(next);
    if (!several) void deliver(next);
  };

  const line = sendStatusLine(sender.state, 'Codex', windowOpen);
  return (
    <Shell item={item}>
      {item.questions.map((q, i) => (
        <div key={i} className={styles.questionBlock}>
          <QuestionText question={q} several={several} />
          {q.options.length > 0 && (sent ? (
            <StaticOptions question={q} picked={picks[i] ? [picks[i] as string] : null} />
          ) : (
            <div className={styles.questionOptions} role="group" aria-label={several ? `Answers to ${q.header || q.question}` : 'Answers'}>
              {q.options.map((o) => (
                <OptionButton
                  key={o.label}
                  label={o.label}
                  description={o.description}
                  chosen={several && picks[i] === o.label}
                  loading={!several && busy && picks[i] === o.label}
                  onClick={() => pick(i, o.label)}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
      {several && asked.length > 0 && !sent && (
        <Button small variant="primary" block onClick={() => void deliver(picks)} loading={busy} disabledReason={complete ? blocked ?? undefined : 'Pick an answer to each question'}>
          Send answers
        </Button>
      )}
      {!several && blocked && !sent && <p className={styles.questionState}>{blocked}</p>}
      {asked.length === 0 && <p className={styles.questionState}>Reply in the box below.</p>}
      {line && <p className={sender.state.phase === 'failed' ? styles.questionError : styles.questionState} role="status">{line}</p>}
    </Shell>
  );
}

export default function QuestionCard({ item, sessionId }: QuestionCardProps) {
  const request = useSessionStore((s) => s.sessions.get(sessionId)?.pendingRequest ?? null);
  const live = answerableRequest(item, request);
  if (live) return <ClaudeQuestion item={item} sessionId={sessionId} request={live} />;
  if (item.cli === 'codex' && item.open && item.questions.some((q) => q.options.length > 0)) {
    return <CodexQuestion item={item} sessionId={sessionId} />;
  }
  return <StaticQuestion item={item} />;
}
