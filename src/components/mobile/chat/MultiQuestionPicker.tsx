/**
 * MultiQuestionPicker — the questions Claude shows as tabs, answered together (Nov 6 2026):
 * several questions in one call, and since Nov 18 2026 a multi-select one and typed answers,
 * as Claude Code's own dialog offers them ("N. [ ] Label", "Type something.").
 *
 *   THEME · Which visual theme…?
 *   [ Warm Sketchnote ] [● Clean Technical ]   pick one: a tap marks it, nothing is sent yet
 *   [ Type your own answer…          ]         typing replaces the pick
 *   TOPPINGS · Which toppings?   Pick any
 *   [☑ Cheese ] [☐ Ham ] [☑ Olives ]           a multi-select: taps tick and untick
 *   [ Something else…                ]         typed text is one more tick
 *   [ Send answers ]                           off until every question has an answer
 *
 * Send answers hands back one `QuestionAnswer` per question; the Mac presses Claude's own keys
 * for each, then "Submit answers" (server/answerKeys/claude.ts). Used by the chat's question
 * card and by the waiting card when the chat isn't showing the question.
 */
import { useId, useState } from 'react';
import type { PendingRequestQuestion } from '@/types';
import type { QuestionAnswer } from '@/lib/chat/answerApi';
import { TYPED_ANSWER_MAX, canTypeAnswer } from '@/lib/chat/typedAnswer';
import { Button } from '../kit';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface MultiQuestionPickerProps {
  questions: readonly PendingRequestQuestion[];
  onSend: (answers: QuestionAnswer[]) => void;
  /** The dialog has a "Type something" line: each question also takes a typed answer. */
  canType?: boolean;
  loading?: boolean;
  /** Why Send answers can't go now (another device drives and no take-over is offered, …). */
  blockedReason?: string;
}

interface Draft {
  picks: number[];
  text: string;
}

const answered = (draft: Draft): boolean => draft.picks.length > 0 || draft.text.trim() !== '';

export default function MultiQuestionPicker({ questions, onSend, canType = false, loading, blockedReason }: MultiQuestionPickerProps) {
  const fieldId = useId();
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ picks: [], text: '' })));
  const complete = drafts.every(answered);
  const update = (qi: number, change: (draft: Draft) => Draft) => setDrafts((all) => all.map((d, i) => (i === qi ? change(d) : d)));
  const send = () => {
    if (!complete) return;
    onSend(drafts.map((d) => {
      const other = d.text.trim();
      return other ? { picks: d.picks, other } : { picks: d.picks };
    }));
  };
  return (
    <div className={styles.questionPicker} data-testid="multi-question-picker">
      {questions.map((q, qi) => {
        const draft = drafts[qi];
        const multi = !!q.multiSelect;
        const typed = canType && canTypeAnswer(q);
        const name = q.header || q.question;
        return (
          <div key={qi} className={styles.questionBlock}>
            <p className={styles.questionText}>
              {q.header && <span className={styles.questionTextTag}>{q.header} · </span>}
              {q.question}
              {multi && <span className={styles.questionHint}> Pick any that apply.</span>}
            </p>
            <div className={styles.questionOptions} role="group" aria-label={`Answers to ${name}`}>
              {q.options.map((o, oi) => {
                const chosen = draft.picks.includes(oi);
                return (
                  <Button
                    key={o.label}
                    small
                    variant={chosen ? 'primary' : 'secondary'}
                    className={styles.questionOption}
                    pressed={multi ? chosen : undefined}
                    onClick={() => update(qi, (d) => (multi
                      ? { ...d, picks: chosen ? d.picks.filter((p) => p !== oi) : [...d.picks, oi] }
                      // Pick one: a pick replaces the typed answer, as in Claude's dialog.
                      : { picks: [oi], text: '' }))}
                  >
                    <span className={styles.questionOptionText}>
                      <span>{multi && <span aria-hidden="true">{chosen ? '☑ ' : '☐ '}</span>}{o.label}{!multi && chosen && <span className={styles.srOnly}> (chosen)</span>}</span>
                      {o.description && <span className={styles.questionOptionNote}>{o.description}</span>}
                    </span>
                  </Button>
                );
              })}
            </div>
            {typed && (
              <input
                id={`${fieldId}-${qi}`}
                type="text"
                className={styles.questionTyped}
                value={draft.text}
                maxLength={TYPED_ANSWER_MAX}
                placeholder={multi ? 'Something else…' : 'Type your own answer…'}
                aria-label={multi ? `Something else for ${name}` : `Your own answer to ${name}`}
                enterKeyHint="done"
                autoCapitalize="sentences"
                // Pick one: typing replaces the pick. Pick any: the text is one more tick.
                onChange={(e) => update(qi, (d) => ({ picks: multi || e.target.value.trim() === '' ? d.picks : [], text: e.target.value }))}
              />
            )}
          </div>
        );
      })}
      <Button
        small
        variant="primary"
        block
        loading={loading}
        disabledReason={complete ? blockedReason : questions.length > 1 ? 'Answer each question' : 'Pick or type an answer'}
        onClick={send}
      >
        {questions.length > 1 ? 'Send answers' : 'Send answer'}
      </Button>
    </div>
  );
}
