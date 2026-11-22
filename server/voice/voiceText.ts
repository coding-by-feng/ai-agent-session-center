// voiceText.ts — the words of a voice call: the GPT-Live voice's instructions, the line typed into the Voice central,
// and a central's markdown answer turned into something the voice can say.
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
    'Keep replies short: one to three sentences. Speak plainly. Never spell out code, file paths or IDs.',
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
}

/** The header every line typed into the Voice central starts with; `tag` makes each question findable. */
export const voiceHeader = (tag?: string): string => (tag ? `[AASC · voice ${tag}]` : '[AASC · voice]');

/** The single line typed into the Voice central for one delegation. */
export function brainPrompt(input: BrainPromptInput): string {
  const request = clip(oneLine(input.request), BRAIN_REQUEST_MAX);
  const context = clip(oneLine(input.context), BRAIN_CONTEXT_MAX);
  const parts = [
    `${voiceHeader(input.tag)} The person is on a voice call and said (transcribed, may contain mistakes): "${request}".`,
    context ? `Recent call context: ${context}.` : '',
    input.briefing ? oneLine(input.briefing) : '',
    'Do what they ask with your AASC tools. Do not wait for long work: start it and reply; AASC tells the person when a session finishes.',
    'Reply for speech: at most three short sentences, plain words, no markdown, no code, no paths or IDs.',
    'If you cannot tell what they meant, ask one short question instead of acting.',
  ];
  return parts.filter(Boolean).join(' ');
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
