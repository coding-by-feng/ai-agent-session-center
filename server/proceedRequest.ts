/**
 * @module proceedRequest
 * Does a finished answer end by asking the user to reply "proceed" (Oct 23 2026)? A review-first
 * turn ends that way ("Reply **proceed** to build…") and the session then just looks idle, so the
 * store marks it (`Session.pendingProceedAt`) and the rail, the LIVE board and the phone show a P
 * until someone replies.
 *
 * Only the end of the answer counts, outside code blocks: an ask is the answer's last word, and a
 * plan that quotes "reply proceed" earlier, in a code block or as multi-word inline code asks
 * nothing, and neither does a negated one ("no need to reply proceed"). Pure: the store reads the
 * transcript a resumed session needs and hands `lastAnswerAsksForProceed` its lines.
 */

/** How much of the answer's end is read: the closing paragraph or two. */
export const PROCEED_TAIL_CHARS = 600;

const CODE_BLOCK_RE = /```[\s\S]*?(```|$)/g;
/** Inline code of more than one word (`reply proceed`) quotes something; one word (`proceed`) is just the word. */
const QUOTED_CODE_RE = /`[^`\n]*\s[^`\n]*`/g;
/** Markdown emphasis and quotes around the word: **proceed**, `proceed`, "proceed", “proceed”, 「proceed」. */
const DECORATION_RE = /[*_`"'“”‘’「」『』＂＇《》]/g;
/** Just before an ask, these turn it around: "No need to reply proceed", "you don't have to type proceed". */
const NEGATED_RE = /(?:\bno need to|\bdont|\bdo not|\bnever|\bnot)\s+(?:\w+\s+){0,3}$/i;

const ASK_PATTERNS: readonly RegExp[] = [
  // Reply proceed · Reply: proceed · Say "proceed" · Type `proceed` · Reply with proceed
  /\b(?:reply|say|type|send|answer|respond)(?:\s+with)?\s*[:：]?\s*proceed\b/gi,
  // Reply "go" or "proceed"
  /\b(?:reply|say|type|send)\s+\S+\s+or\s+proceed\b/gi,
  // … wait for your proceed (confirmation)
  /\bwait(?:ing)?\s+for\s+(?:your|my|a|an)?\s*(?:explicit\s+)?proceed\b/gi,
  // Shall I proceed? · Should I proceed with X (i.e. Y)? · Want me to proceed? · Ready to proceed?
  // ("Can I proceed …?" is left out: an answer often repeats the user's own question.)
  /\b(?:shall|should)\s+i\s+proceed\b[^?\n]{0,160}\?/gi,
  /\b(?:want|like)\s+me\s+to\s+proceed\b[^?\n]{0,160}\?/gi,
  /\bready\s+to\s+proceed\b[^?\n]{0,160}\?/gi,
  // 回复 proceed · 输入 proceed · 发送 proceed
  /(?:回复|回覆|输入|輸入|发送|發送|键入)\s*proceed\b/gi,
];

/** True when the end of `text` asks the user to reply "proceed". */
export function asksForProceed(text: string): boolean {
  if (!text) return false;
  const prose = text
    .replace(CODE_BLOCK_RE, ' ')
    .replace(QUOTED_CODE_RE, ' ')
    .replace(DECORATION_RE, '');
  const tail = prose.slice(-PROCEED_TAIL_CHARS);
  return ASK_PATTERNS.some((re) =>
    [...tail.matchAll(re)].some(
      (m) => !NEGATED_RE.test(tail.slice(Math.max(0, m.index - 40), m.index)),
    ),
  );
}

interface TranscriptEntry {
  type?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  message?: { content?: unknown } | null;
}

interface Block {
  type?: unknown;
  text?: unknown;
}

/** What Claude Code writes as a user entry without the user replying: a local command, its output, a notice. */
const HARNESS_LINE_RE =
  /^<(?:command-(?:name|message|args)|local-command-|system-reminder|task-notification|bash-(?:input|stdout|stderr))/;

function parse(raw: string): TranscriptEntry | null {
  const line = raw.trim();
  if (!line) return null;
  try {
    const e = JSON.parse(line) as unknown;
    return e && typeof e === 'object' ? (e as TranscriptEntry) : null;
  } catch {
    return null; // junk, or the line Claude Code is still writing
  }
}

function blocks(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content)
    ? (content.filter((b) => b && typeof b === 'object') as Block[])
    : [];
}

/**
 * Pure. A Claude Code transcript's lines, oldest → newest: does its last answer ask for proceed,
 * with nothing typed since? Walking back, the first thing the user typed (or a pasted image)
 * means answered; a harness line (`HARNESS_LINE_RE`: `<local-command-stdout>`, `<command-name>`…),
 * a meta or side-chain entry and any system entry are skipped; the first assistant text decides,
 * and a tool call means the turn did not end on an answer.
 */
export function lastAnswerAsksForProceed(lines: readonly string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parse(lines[i]);
    if (!e || e.isMeta === true || e.isSidechain === true) continue;
    const content = blocks(e.message?.content);
    if (e.type === 'user') {
      if (content.some((b) => b.type === 'tool_result' || b.type === 'image')) return false; // a pasted image is a reply
      const typed = content
        .map((b) => (typeof b.text === 'string' ? b.text : ''))
        .join('')
        .trim();
      if (!typed || HARNESS_LINE_RE.test(typed)) continue;
      return false; // a reply, or "[Request interrupted by user]"
    }
    if (e.type === 'assistant') {
      if (content.some((b) => b.type === 'tool_use')) return false;
      const said = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string);
      if (said.length > 0) return asksForProceed(said.join('\n'));
    }
  }
  return false;
}
