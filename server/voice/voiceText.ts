// voiceText.ts — the words of a voice call: the GPT-Live voice's instructions, the line typed into the Voice central,
// and a central's markdown answer turned into something the voice can say.

import type { CallAttachment } from './callAttach.js';
import { formatModelLabel } from '../../src/lib/modelLabel.js';
//
// The voice (gpt-live-1, client delegation) never acts: it hands every AASC request to the Voice central through a
// delegation, using the `<|SpawnThinking|>` token and the three policy labels OpenAI's GPT-Live prompting guide asks
// for (developers.openai.com/api/docs/guides/live-prompting). An append to the voice holds at most 500 tokens, so a
// spoken answer is capped at SPEAKABLE_MAX characters (~400 tokens).

/** The longest answer handed to the voice to say (a `session.commentary.append` holds at most 500 tokens). */
export const SPEAKABLE_MAX = 1_600;

/** The longest transcribed request typed into the central. */
export const BRAIN_REQUEST_MAX = 1_500;

/** The longest slice of the call's recent transcript typed with it. */
export const BRAIN_CONTEXT_MAX = 1_200;

export function frontInstructions(): string {
  return [
    'You are AASC Voice, a calm, concise voice assistant for a developer who runs AI coding agents (Claude Code and Codex) through AASC on their computer.',
    'Keep your own remarks short: one to three sentences. Speak plainly. Never spell out code, file paths or IDs.',
    'When an answer or update from AASC arrives, say all of it in your own voice: do not cut it down, and do not add anything it does not say.',
    '',
    'Backchannel policy: Use few backchannels.',
    '',
    'Interruption policy: Stop speaking when the user interrupts. Listen to what they say.',
    '',
    'Delegation policy:',
    'Backend tools:',
    '- AASC: list sessions, rooms and projects; read what a session said; start Claude Code or Codex sessions; send or queue prompts; interrupt a session; agenda and notes; research and web search through an agent.',
    '',
    'Generate <|SpawnThinking|> when:',
    '- The user asks about their sessions, agents, projects, queue, agenda or files.',
    '- The user asks to start, prompt, check or stop an agent, or asks for research or a web search.',
    '- A correction changes work already requested.',
    '',
    'Do not generate <|SpawnThinking|> when:',
    '- You can answer from the conversation, or from the AASC status you were given and it is still current.',
    '- You need a brief clarification to understand the request.',
    '',
    'Generate <|SpawnThinking|> before giving an answer that depends on backend work.',
    'Do not guess the result while waiting. Never say an action is done until the backend says so.',
    'Work keeps running in the background while you talk, and the user can keep talking.',
    'Anything destructive (stopping, killing, deleting, pushing) is confirmed on the screen, never by voice. When the backend says something waits for a confirmation, tell the user to check their screen.',
  ].join('\n');
}

/** Control characters (C0, DEL, C1) and runs of whitespace become one space: the line is typed into a terminal. */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface BrainPromptInput {
  /** What the person said since the last request, as transcribed. */
  request: string;
  /** The call's recent transcript, for short replies like "yes" or "the second one". */
  context: string;
  /** This question's id (brain.ts): the central's reply is the one that follows the prompt carrying it. */
  tag?: string;
  /** voiceContext.ts `briefing`: AASC's vocabulary, the visible sessions, the skills that fit, how to act. */
  briefing?: string;
  /** What the person added on the call screen since their last question (callAttach.ts, Nov 24 2026). */
  added?: readonly CallAttachment[];
}

const ADDED_NAME_MAX = 80;

/** "They added on the call screen: photo a.jpg at /…; file b.pdf at /…. Use /skill." ('' for nothing). */
function addedLine(added: readonly CallAttachment[] = []): string {
  const files = added.filter((a) => a.kind !== 'skill' && a.path);
  const picks = added.filter((a) => a.kind === 'skill');
  const parts: string[] = [];
  if (files.length > 0) {
    const list = files.map((a) => `${a.kind} ${clip(oneLine(a.name), ADDED_NAME_MAX)} at ${oneLine(a.path ?? '')}`).join('; ');
    parts.push(`They added on the call screen: ${list}. Open what you need before answering.`);
  }
  for (const p of picks) parts.push(`Use ${oneLine(p.name)}.`);
  return parts.join(' ');
}

/**
 * How the Voice central shapes a spoken reply (Nov 23 2026): what it did, the state of the work in plain words, the
 * result, then a limit or next step; as long as the work needs, no longer. It used to be held to "three short
 * sentences", which left the person with "Done." and no result.
 */
/** A line that is exactly this starts the part of an answer shown on the call screen, never spoken (Nov 23 2026). */
export const SCREEN_MARKER = '[[screen]]';

/** How the Voice central may add that part: only when it helps someone reading the call screen. */
const SCREEN_RULE =
  `If a table, list, commands or code would help someone reading the call screen, add them after your spoken reply ` +
  `under a line that is exactly ${SCREEN_MARKER}, in Markdown (at most 60 lines): shown, never spoken, so the spoken ` +
  'reply must stand alone. Skip it for a simple status.';

export const SPEECH_SHAPE =
  'Reply for speech, in plain words with no markdown, code, paths or IDs. Say what you did; then say plainly whether ' +
  'the work is queued (and what it waits for), started (which session is on it now) or completed, going only by what ' +
  'your tools returned (a prompt AASC is typing is sent, not done; scheduled is not done); then the actual result or ' +
  'the key findings; then an important limit or next step, if there is one. One or two sentences for a simple status, ' +
  'up to six when there is a result to explain. Never invent details or claim a success your tools did not confirm. ' +
  SCREEN_RULE;

/** The header every line typed into the Voice central starts with; `tag` makes each question findable. */
export const voiceHeader = (tag?: string): string => (tag ? `[AASC · voice ${tag}]` : '[AASC · voice]');

/** The single line typed into the Voice central for one delegation. */
export function brainPrompt(input: BrainPromptInput): string {
  const request = clip(oneLine(input.request), BRAIN_REQUEST_MAX);
  const context = clip(oneLine(input.context), BRAIN_CONTEXT_MAX);
  const parts = [
    `${voiceHeader(input.tag)} The person is on a voice call and said (transcribed, may contain mistakes): "${request}".`,
    addedLine(input.added),
    context ? `Recent call context: ${context}.` : '',
    input.briefing ? oneLine(input.briefing) : '',
    'Do what they ask with your AASC tools. Do not wait for long work: start it and reply; AASC tells the person when a session finishes.',
    SPEECH_SHAPE,
    'If you cannot tell what they meant, ask one short question instead of acting.',
  ];
  return parts.filter(Boolean).join(' ');
}

export interface FinishPromptInput {
  /** The finished session's display title (the person named it; typed as one quoted line). */
  title: string;
  /** Its task from this call (`T12`), when the ledger has one. */
  taskId?: string | null;
  tag?: string;
}

const TITLE_MAX = 120;
const TASK_ID = /^T\d{1,9}$/;

/** The line typed into the Voice central when a session this call gave work to has finished. */
export function finishPrompt(input: FinishPromptInput): string {
  const title = clip(oneLine(input.title).replace(/"/g, "'"), TITLE_MAX) || 'a session';
  const task = input.taskId && TASK_ID.test(input.taskId) ? ` (task ${input.taskId}: task_get has its answer)` : '';
  return [
    `${voiceHeader(input.tag)} The session "${title}"${task} just finished work it was given during this voice call.`,
    'Read what it answered and tell the person what it did, the actual result or key findings, and an important limit or next step if any.',
    'Plain words for speech, no markdown, code, paths or IDs; one to six sentences; only what the session actually said.',
    SCREEN_RULE,
    'Do not start new work.',
  ].join(' ');
}

export interface SettingNoteInput {
  /** The Voice central's own session. */
  own: boolean;
  /** The session's display title, for a worker. */
  title: string;
  kind: 'model' | 'effort';
  value: string;
  applied: boolean;
  /** AASC's words for why it was not applied. */
  reason: string | null;
}

/** What a call says when a model or effort change it asked for is confirmed or not applied (runtimeChange.ts). */
export function settingNote(input: SettingNoteInput): string {
  const who = input.own ? 'your central' : `"${clip(oneLine(input.title).replace(/"/g, "'"), TITLE_MAX) || 'the session'}"`;
  const what = input.kind === 'model' ? `the ${formatModelLabel(input.value)} model` : `${input.value} effort`;
  if (input.applied) return `AASC update: ${who} now runs on ${what}; the CLI confirmed it.`;
  const why = input.reason ? `: ${oneLine(input.reason).slice(0, 160)}` : '';
  return `AASC update: switching ${who} to ${what} did not go through${why}.`;
}

/** The end of the last sentence that fits in `max` characters, or a hard cut with an ellipsis. */
function cutAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end > max / 2) return head.slice(0, end + 1);
  return `${head.slice(0, max - 1).trimEnd()}…`;
}

/** A central's markdown answer as plain sentences for the voice to say. */
/** What the voice says when an answer is only an on-screen part. */
const SCREEN_ONLY_SPEECH = 'I have put the details on the call screen.';
const SCREEN_LINE = /^\s*\[\[screen\]\]\s*$/i;

/**
 * An answer split at its first {@link SCREEN_MARKER} line: the words to say, and the Markdown shown on the call screen
 * only (null when there is none). The marker inside a sentence is speech.
 */
export function splitScreen(answer: string): { speech: string; screen: string | null } {
  const lines = answer.split('\n');
  const at = lines.findIndex((line) => SCREEN_LINE.test(line));
  if (at < 0) return { speech: answer.trim(), screen: null };
  const speech = lines.slice(0, at).join('\n').trim();
  const screen = lines.slice(at + 1).join('\n').replace(/^\s*\n/, '').trimEnd();
  if (screen.trim() === '') return { speech, screen: null };
  return { speech: speech || SCREEN_ONLY_SPEECH, screen };
}

export function toSpeakable(answer: string, max = SPEAKABLE_MAX): string {
  const text = answer
    .replace(/```[\s\S]*?(```|$)/g, ' (code left out) ')
    .split('\n')
    .filter((line) => !/^\s*\|/.test(line))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s*>\s?/, ''))
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'The Voice central gave no answer.';
  return cutAtSentence(text, max);
}
