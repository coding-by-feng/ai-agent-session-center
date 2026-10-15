// answerKeys/types.ts — what a card asks the Mac to answer (AASC-43).

/** The choices a waiting-request card offers. `option` picks one of a question's choices. */
export type AnswerChoice = 'allow_once' | 'allow_always' | 'deny' | 'option';

export interface Answer {
  choice: AnswerChoice;
  /** 0-based, for `option`. */
  optionIndex?: number;
}
