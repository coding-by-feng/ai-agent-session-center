/**
 * questionItem.ts — an agent's multiple-choice question as the phone chat draws it (Nov 2 2026):
 * Claude's AskUserQuestion and Codex's request_user_input(_async), parsed into one shape, and
 * what was answered. Pure.
 *
 *   Claude  {questions:[{question, header, multiSelect, options:[{label, description}]}]}
 *           (or the older single {question, options}); the result says what you picked:
 *           `…answered your questions: "Which layout?"="Cards". You can now continue…`
 *   Codex   {questions:[{title, options: ["A (Recommended)", "B"] | null}]}; its result is
 *           only `{"accepted":true}` and it carries on, so the answer is your next message.
 */
import type { PendingRequest } from '@/types';
import type { QuestionItem } from './buildChatItems';

export interface ChatQuestionOption {
  label: string;
  description?: string;
}

export interface ChatQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  /** Empty when the agent asked for words, not a pick (Codex sends `options: null`). */
  options: ChatQuestionOption[];
}

export const QUESTION_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'request_user_input', 'request_user_input_async']);

export const isQuestionTool = (name: string): boolean => QUESTION_TOOLS.has(name);

/** Codex asks without waiting: its answer is the next message you send. */
export const isCodexQuestionTool = (name: string): boolean => name !== 'AskUserQuestion' && QUESTION_TOOLS.has(name);

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function optionOf(raw: unknown): ChatQuestionOption | null {
  if (typeof raw === 'string') return raw.trim() ? { label: raw.trim() } : null;
  const o = asRecord(raw);
  const label = asText(o.label) || asText(o.title) || asText(o.value);
  if (!label) return null;
  const description = asText(o.description);
  return description ? { label, description } : { label };
}

function questionOf(raw: unknown): ChatQuestion | null {
  const q = asRecord(raw);
  const question = asText(q.question) || asText(q.title) || asText(q.prompt);
  if (!question) return null;
  const header = asText(q.header);
  const options = Array.isArray(q.options) ? q.options.map(optionOf).filter((o): o is ChatQuestionOption => !!o) : [];
  return { question, ...(header ? { header } : {}), multiSelect: q.multiSelect === true, options };
}

/** The questions a call asks, or null when its input isn't one this reads (the tool row shows it then). */
export function parseQuestions(input: unknown): ChatQuestion[] | null {
  const record = asRecord(input);
  const raw = Array.isArray(record.questions) ? record.questions : [record];
  const questions = raw.map(questionOf).filter((q): q is ChatQuestion => !!q);
  return questions.length > 0 ? questions : null;
}

/** Where `"<question>"="` starts the answer in Claude's result, and the answer's closing quote. */
function claudeAnswerText(output: string, question: string): string | null {
  const open = `"${question}"="`;
  const at = output.indexOf(open);
  if (at < 0) return null;
  const from = at + open.length;
  // The answer ends at the quote followed by the next pair, the closing sentence, or the end.
  for (let i = output.indexOf('"', from); i >= 0; i = output.indexOf('"', i + 1)) {
    const rest = output.slice(i + 1);
    if (rest.startsWith(', "') || /^\.(\s|$)/.test(rest) || rest.trim() === '') return output.slice(from, i);
  }
  return null;
}

/**
 * What Claude says you picked, per question: its labels (a multi-select's, split on ", " when they
 * are options), or null when the result doesn't say (cut off at 4 KB, or declined).
 */
export function claudeAnswers(output: string, questions: readonly ChatQuestion[]): Array<string[] | null> {
  return questions.map((q) => {
    const text = claudeAnswerText(output, q.question);
    if (text === null) return null;
    if (!q.multiSelect) return [text];
    const labels = new Set(q.options.map((o) => o.label));
    const parts = text.split(', ');
    return parts.every((p) => labels.has(p)) ? parts : [text];
  });
}

/**
 * Codex's answer: your next message, as a pick only when it is exactly an option (one question)
 * or the card's own "<question>: <option>" line (several). A reply in your own words picks nothing.
 */
export function codexAnswers(reply: string | null, questions: readonly ChatQuestion[]): Array<string[] | null> {
  const text = reply?.trim() ?? '';
  const lines = text.split('\n');
  return questions.map((q) => {
    const said = questions.length === 1
      ? text
      : lines.find((l) => l.startsWith(`${q.header || q.question}: `))?.slice((q.header || q.question).length + 2);
    const hit = said ? q.options.find((o) => o.label === said) : undefined;
    return hit ? [hit.label] : null;
  });
}

/** The message a Codex question's picks send: the label alone for one question, one line each for several. */
export function codexReply(questions: readonly ChatQuestion[], picks: ReadonlyArray<string | null>): string {
  if (questions.length === 1) return picks[0] ?? '';
  return questions
    .map((q, i) => (picks[i] ? `${q.header || q.question}: ${picks[i]}` : ''))
    .filter(Boolean)
    .join('\n');
}

/** The session's open request this card can answer, or null (another call's, a guess, ambiguous, several questions). */
export function answerableRequest(item: QuestionItem, request: PendingRequest | null | undefined): PendingRequest | null {
  if (item.cli !== 'claude' || !item.open || !request || request.kind !== 'question') return null;
  if (request.toolUseId !== item.id && request.id !== item.id) return null;
  if (request.source === 'timer' || request.source === 'notification' || request.ambiguous) return null;
  if (!request.options?.length || item.questions.length !== 1) return null;
  return request;
}
