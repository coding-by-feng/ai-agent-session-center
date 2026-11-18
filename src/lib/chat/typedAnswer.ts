/**
 * typedAnswer.ts — when a question takes an answer in your own words (Nov 18 2026), as Claude
 * Code's dialog offers with "Type something". Pure; shared by the question picker and the card.
 */
import type { PendingRequestQuestion } from '@/types';

/** The longest typed answer the Mac types (server/answerKeys/claude.ts TYPED_ANSWER_MAX). */
export const TYPED_ANSWER_MAX = 500;
/** "Type something" is choice N+1 in a single-select: with nine choices it has no key. */
const MAX_OPTIONS_WITH_TYPED = 8;

/** A multi-select always takes one (its text line is reached with the arrow keys); a single-select with up to eight choices does. */
export const canTypeAnswer = (question: Pick<PendingRequestQuestion, 'options' | 'multiSelect'>): boolean =>
  !!question.multiSelect || question.options.length <= MAX_OPTIONS_WITH_TYPED;
