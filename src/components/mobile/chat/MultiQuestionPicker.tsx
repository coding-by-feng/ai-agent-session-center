/**
 * MultiQuestionPicker — several single-select questions Claude asks in one call (Nov 6 2026).
 *
 *   THEME · Which visual theme…?
 *   [ Warm Sketchnote ] [● Clean Technical ]   a tap marks the pick, nothing is sent yet
 *   SCOPE · What should it explain?
 *   [● AASC phone installs ] [ General concept ]
 *   [ Send answers ]                           off until every question has a pick
 *
 * Send answers hands back one 0-based index per question; the Mac types a digit for each,
 * then Claude's "1. Submit answers" (server/answerKeys/claude.ts). Used by the chat's
 * question card and by the waiting card when the chat isn't showing the question.
 */
import { useState } from 'react';
import type { PendingRequestQuestion } from '@/types';
import { Button } from '../kit';
import styles from '@/styles/modules/mobile/ChatItems.module.css';

export interface MultiQuestionPickerProps {
  questions: readonly PendingRequestQuestion[];
  onSend: (optionIndexes: number[]) => void;
  loading?: boolean;
  /** Why Send answers can't go now (another device drives and no take-over is offered, …). */
  blockedReason?: string;
}

export default function MultiQuestionPicker({ questions, onSend, loading, blockedReason }: MultiQuestionPickerProps) {
  const [picks, setPicks] = useState<Array<number | null>>(() => questions.map(() => null));
  const complete = picks.every((p) => p !== null);
  return (
    <div data-testid="multi-question-picker">
      {questions.map((q, qi) => (
        <div key={qi} className={styles.questionBlock}>
          <p className={styles.questionText}>
            {q.header && <span className={styles.questionTextTag}>{q.header} · </span>}
            {q.question}
          </p>
          <div className={styles.questionOptions} role="group" aria-label={`Answers to ${q.header || q.question}`}>
            {q.options.map((o, oi) => {
              const chosen = picks[qi] === oi;
              return (
                <Button
                  key={o.label}
                  small
                  variant={chosen ? 'primary' : 'secondary'}
                  className={styles.questionOption}
                  onClick={() => setPicks((p) => p.map((v, i) => (i === qi ? oi : v)))}
                >
                  <span className={styles.questionOptionText}>
                    <span>{o.label}{chosen && <span className={styles.srOnly}> (chosen)</span>}</span>
                    {o.description && <span className={styles.questionOptionNote}>{o.description}</span>}
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      <Button
        small
        variant="primary"
        block
        loading={loading}
        disabledReason={complete ? blockedReason : 'Pick an answer to each question'}
        onClick={() => { if (complete) onSend(picks as number[]); }}
      >
        Send answers
      </Button>
    </div>
  );
}
