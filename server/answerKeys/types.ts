// answerKeys/types.ts — what a card asks the Mac to answer (AASC-43).

/** The choices a waiting-request card offers. `option` picks one of a question's choices. */
export type AnswerChoice = 'allow_once' | 'allow_always' | 'deny' | 'option' | 'options' | 'answers';

/** One question's answer (Nov 18 2026): the choices picked, and/or a typed one ("Type something"). */
export interface QuestionAnswer {
  /** 0-based. One for a single-select question (or none, with `other`); any number for a multi-select. */
  picks: number[];
  /** A typed answer. The Mac types it as one cleaned line; it is the only client text the route types. */
  other?: string;
}

export interface Answer {
  choice: AnswerChoice;
  /** 0-based, for `option`. */
  optionIndex?: number;
  /** 0-based, one per question, for `options` (several questions in one call). */
  optionIndexes?: number[];
  /** One per question, for `answers`: picks, multi-select ticks and typed answers. */
  answers?: QuestionAnswer[];
}
