/**
 * useRequestAnswer — answering one waiting request from a card (AASC-43), for
 * the session's card and for the Inbox alike.
 *
 * - Answers go through the Mac's checked route (answerApi); a stale card turns
 *   into "Already answered on your Mac", one the Mac can't answer into "Open
 *   terminal" only.
 * - While another device drives, answering takes control first, after a
 *   confirm: the baton is claimed with the presence claim the "Take control"
 *   button uses, then the answer goes.
 * - "Always allow" asks first. The phone app's Face ID / fingerprint lock lives
 *   in the shell, and a page served by the Mac has no bridge to it (AASC-17's
 *   emulator check), so the gate here is a confirm sheet.
 *
 * State belongs to one request: a new request starts clean.
 */
import { useCallback, useState } from 'react';
import { useControlBaton } from '@/hooks/useControlBaton';
import { claimControl } from '@/lib/presenceClient';
import { showToast } from '@/components/ui/ToastContainer';
import { answerRequest, type Answer, type AnswerChoice } from '@/lib/chat/answerApi';
import type { CardChoice } from '@/lib/chat/waitingCardModel';
import { useDriverName } from './useDriverName';

export type AnswerOutcome =
  | { kind: 'sent'; choice: AnswerChoice }
  | { kind: 'stale' }
  | { kind: 'terminal-only'; message: string }
  | { kind: 'error'; message: string };

/** One answer's key, to tell which button is busy (a question's options share a choice). */
export function choiceKey(answer: Answer): string {
  return `${answer.choice}:${answer.optionIndex ?? ''}`;
}

export interface AnswerConfirm {
  title: string;
  message: string;
  confirmLabel: string;
  run: () => void;
}

export interface RequestAnswer {
  /** The answer being sent, by choiceKey (its button shows a spinner). */
  busy: string | null;
  outcome: AnswerOutcome | null;
  /** A confirm sheet waiting for a yes. */
  confirm: AnswerConfirm | null;
  cancelConfirm: () => void;
  answer: (choice: CardChoice) => void;
  /** Another device drives: an answer takes control first. */
  spectator: boolean;
  driver: string;
}

interface State {
  requestId: string | null;
  busy: string | null;
  outcome: AnswerOutcome | null;
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

export function useRequestAnswer(sessionId: string, requestId: string | null, cliName = 'Claude'): RequestAnswer {
  const baton = useControlBaton(sessionId);
  const spectator = baton.mode === 'spectator';
  const driver = useDriverName(baton.holder?.clientId, baton.holder?.label);
  const [state, setState] = useState<State>({ requestId, busy: null, outcome: null });
  const [confirm, setConfirm] = useState<AnswerConfirm | null>(null);
  const current = state.requestId === requestId ? state : { requestId, busy: null, outcome: null };

  const submit = useCallback(async (choice: CardChoice, takeControl: boolean) => {
    if (!requestId) return;
    const settle = (outcome: AnswerOutcome | null) => setState({ requestId, busy: null, outcome });
    setState({ requestId, busy: choiceKey(choice.answer), outcome: null });
    if (takeControl) {
      const claim = await claimControl(sessionId, true);
      if (!claim.ok) {
        const wait = claim.retryInMs ? ` Try again in ${Math.ceil(claim.retryInMs / 1000)} s.` : '';
        const message = `${claim.controller?.label ?? driver} is still driving.${wait}`;
        showToast(message, 'error', 4000);
        settle({ kind: 'error', message });
        return;
      }
    }
    const result = await answerRequest(sessionId, requestId, choice.answer);
    if (result.ok) {
      navigator.vibrate?.(10);
      settle({ kind: 'sent', choice: choice.answer.choice });
      return;
    }
    if (result.code === 'stale') {
      settle({ kind: 'stale' });
      return;
    }
    if (result.terminalOnly) {
      settle({ kind: 'terminal-only', message: result.message });
      return;
    }
    showToast(result.message, 'error', 4000);
    settle({ kind: 'error', message: result.message });
  }, [sessionId, requestId, driver]);

  const answer = useCallback((choice: CardChoice) => {
    if (choice.disabledReason || current.busy) return;
    const always = !!choice.confirm;
    if (!spectator && !always) {
      void submit(choice, false);
      return;
    }
    const takeLine = spectator ? `${driver} is driving this session. Answering takes control: it stops typing here until it takes control back.` : '';
    const alwaysLine = always ? choice.confirmNote ?? `${cliName} won’t ask again for calls like this one.` : '';
    setConfirm({
      title: spectator ? `Take control and ${lower(choice.label)}?` : `${choice.label}?`,
      message: [takeLine, alwaysLine].filter(Boolean).join(' '),
      confirmLabel: spectator ? `Take control and ${lower(choice.label)}` : choice.label,
      run: () => {
        setConfirm(null);
        void submit(choice, spectator);
      },
    });
  }, [current.busy, spectator, driver, cliName, submit]);

  const cancelConfirm = useCallback(() => setConfirm(null), []);

  return { busy: current.busy, outcome: current.outcome, confirm, cancelConfirm, answer, spectator, driver };
}
