/**
 * waitingCardModel.ts — what a waiting card shows, and which choices it offers
 * (AASC-43). Pure: built from the session the phone already receives.
 *
 * The card shows exactly what is asked, from the request the CLI raised
 * (`session.pendingRequest`, server/pendingRequests.ts): the command, the file
 * and its diff for an edit, the URL for a fetch, the question and its options.
 * Its choices are the CLI's own, in its own words (Claude: Allow once, Always
 * allow, Deny; Codex: Approve, Always approve, Deny), and a question's options
 * plus "Other…". Whenever the Mac can't be sure which keys answer it (a guess
 * from the approval timer, a request raised while another was open, a plan, a
 * question taking several picks), the card keeps only "Open terminal" and says
 * why, rather than guess.
 */
import type { PendingRequest, Session } from '@/types';
import type { Answer } from './answerApi';

export interface DiffLine {
  /** ' ' context, '-' removed, '+' added, '@' a note between parts ("Change 2 of 3", "12 unchanged lines"). */
  op: ' ' | '-' | '+' | '@';
  text: string;
}

export type CardDetail =
  | { type: 'command'; command: string; description?: string }
  | { type: 'diff'; file: string; lines: DiffLine[]; added: number; removed: number; truncated: boolean }
  | { type: 'url'; url: string; prompt?: string }
  | { type: 'question'; question: string; header?: string }
  | { type: 'plan'; text: string }
  | { type: 'text'; text: string }
  | { type: 'none' };

export interface CardChoice {
  answer: Answer;
  label: string;
  /** A question option's own description. */
  description?: string;
  tone: 'primary' | 'secondary' | 'destructive';
  /** Asks before answering (Always allow: Face ID / a confirm sheet). */
  confirm?: boolean;
  /** What answering it leaves behind, for the confirm sheet (how long "always" lasts). */
  confirmNote?: string;
  /** Offered but not possible, and why. */
  disabledReason?: string;
}

export interface WaitingCard {
  /** The request an answer names; null for a guess (nothing to answer through the Mac). */
  requestId: string | null;
  kind: 'permission' | 'question' | 'plan' | 'guess';
  cliName: 'Claude' | 'Codex';
  tool: string;
  title: string;
  detail: CardDetail;
  /** "in agent-manager" */
  where?: string;
  /** Empty when only the terminal can answer. */
  choices: CardChoice[];
  /** Deny with a message (a permission), or answer in your own words (a question). */
  tell: { label: string } | null;
  terminalOnly: boolean;
  terminalOnlyReason?: string;
}

type CardSession = Pick<
  Session,
  'status' | 'pendingRequest' | 'pendingTool' | 'pendingToolDetail' | 'waitingDetail' | 'projectName' | 'projectPath' | 'cliSource'
>;

export interface CardOptions {
  /** In the Inbox: no "Always allow", which is decided in the session (§5.6). */
  inbox?: boolean;
}

/** Diff lines a card shows at most; past it, a note says how many more. */
export const MAX_CARD_DIFF_LINES = 400;
/** Unchanged lines kept around each change. */
const CONTEXT_LINES = 3;
/** Past this many cells the comparison isn't worth it: removed, then added. */
const MAX_DIFF_CELLS = 250_000;
const MAX_TEXT_CHARS = 2_000;

const COMMAND_TOOLS = new Set(['Bash', 'shell', 'exec_command', 'local_shell', 'container.exec', 'unified_exec']);
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);

const GUESS_REASON = 'Your Mac can’t see exactly what the agent is asking. Answer it in the terminal.';
const AMBIGUOUS_REASON = 'More than one request is waiting at once. Answer them in the terminal.';
const PLAN_REASON = 'Plan approval changes between versions, so answer it in the terminal.';
const MULTI_PICK_REASON = 'This question takes more than one pick. Answer it in the terminal.';
const TRUNCATED_REASON = 'Too long to show in full: allow it in the terminal.';

// ---------------------------------------------------------------------------
// Line diff
// ---------------------------------------------------------------------------

const splitLines = (text: string): string[] => (text === '' ? [] : text.split('\n'));

/**
 * A line diff of `before` → `after`: shared lines at either end are trimmed
 * first, the middle compared by longest common subsequence (or, when it is
 * very long, shown as removed then added).
 */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const head = a.slice(0, start).map((text): DiffLine => ({ op: ' ', text }));
  const tail = a.slice(endA).map((text): DiffLine => ({ op: ' ', text }));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  return [...head, ...diffMiddle(midA, midB), ...tail];
}

function diffMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > MAX_DIFF_CELLS || a.length === 0 || b.length === 0) {
    return [...a.map((text): DiffLine => ({ op: '-', text })), ...b.map((text): DiffLine => ({ op: '+', text }))];
  }
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: '-', text: a[i] });
      i += 1;
    } else {
      out.push({ op: '+', text: b[j] });
      j += 1;
    }
  }
  for (; i < a.length; i += 1) out.push({ op: '-', text: a[i] });
  for (; j < b.length; j += 1) out.push({ op: '+', text: b[j] });
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Runs of unchanged lines longer than the context around them fold into one note. */
function foldContext(lines: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].op !== ' ') {
      out.push(lines[i]);
      i += 1;
      continue;
    }
    let end = i;
    while (end < lines.length && lines[end].op === ' ') end += 1;
    const run = lines.slice(i, end);
    const keepBefore = i === 0 ? 0 : CONTEXT_LINES; // after a change
    const keepAfter = end === lines.length ? 0 : CONTEXT_LINES; // before a change
    if (run.length > keepBefore + keepAfter) {
      out.push(...run.slice(0, keepBefore));
      out.push({ op: '@', text: plural(run.length - keepBefore - keepAfter, 'unchanged line') });
      out.push(...run.slice(run.length - keepAfter));
    } else {
      out.push(...run);
    }
    i = end;
  }
  return out;
}

function diffDetail(file: string, parts: DiffLine[][]): CardDetail {
  const all: DiffLine[] = [];
  parts.forEach((part, index) => {
    if (parts.length > 1) all.push({ op: '@', text: `Change ${index + 1} of ${parts.length}` });
    all.push(...foldContext(part));
  });
  const added = parts.reduce((n, p) => n + p.filter((l) => l.op === '+').length, 0);
  const removed = parts.reduce((n, p) => n + p.filter((l) => l.op === '-').length, 0);
  const truncated = all.length > MAX_CARD_DIFF_LINES;
  const lines = truncated
    ? [...all.slice(0, MAX_CARD_DIFF_LINES), { op: '@' as const, text: `${plural(all.length - MAX_CARD_DIFF_LINES, 'more line')} in the terminal` }]
    : all;
  return { type: 'diff', file, lines, added, removed, truncated };
}

// ---------------------------------------------------------------------------
// What is asked
// ---------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

function relativeTo(projectPath: string | undefined, file: string): string {
  if (projectPath && file.startsWith(`${projectPath.replace(/\/$/, '')}/`)) return file.slice(projectPath.replace(/\/$/, '').length + 1);
  return file;
}

/** A Codex argument list as the command it runs (`bash -lc "npm test"` → `npm test`). */
function commandText(command: unknown): string {
  if (Array.isArray(command)) {
    const args = command.map(String);
    if (args.length === 3 && /^(?:ba|z)?sh$/.test(args[0].split('/').pop() ?? '') && /^-l?c$/.test(args[1])) return args[2];
    return args.join(' ');
  }
  return asString(command);
}

function jsonText(input: unknown): string {
  const text = JSON.stringify(input, null, 2) ?? '';
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}…` : text;
}

/** Codex's apply_patch envelope as file + diff lines. */
function patchDetail(patch: string, projectPath: string | undefined): CardDetail {
  const files: string[] = [];
  const parts: DiffLine[][] = [];
  let current: DiffLine[] | null = null;
  for (const raw of patch.split('\n')) {
    const header = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(raw);
    if (header) {
      files.push(relativeTo(projectPath, header[1].trim()));
      current = [];
      parts.push(current);
      continue;
    }
    if (!current || raw.startsWith('***') || raw.startsWith('@@')) continue;
    const op = raw[0];
    if (op === '+' || op === '-') current.push({ op, text: raw.slice(1) });
    else if (op === ' ') current.push({ op: ' ', text: raw.slice(1) });
  }
  if (parts.length === 0) return { type: 'text', text: patch.slice(0, MAX_TEXT_CHARS) };
  return diffDetail(files.length === 1 ? files[0] : plural(files.length, 'file'), parts);
}

function describeTool(tool: string, cliName: string): string {
  if (COMMAND_TOOLS.has(tool)) return `${cliName} wants to run a command`;
  if (tool === 'Write') return `${cliName} wants to write a file`;
  if (tool === 'NotebookEdit') return `${cliName} wants to edit a notebook`;
  if (EDIT_TOOLS.has(tool)) return `${cliName} wants to edit a file`;
  if (tool === 'apply_patch') return `${cliName} wants to change files`;
  if (tool === 'WebFetch') return `${cliName} wants to fetch a page`;
  if (tool === 'WebSearch') return `${cliName} wants to search the web`;
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  if (mcp) return `${cliName} wants to use ${mcp[2]} (${mcp[1]})`;
  return `${cliName} wants to use ${tool}`;
}

function detailOf(request: PendingRequest, projectPath: string | undefined): CardDetail {
  const input = asRecord(request.input);
  if (request.input === undefined) return { type: 'none' };
  if (typeof input.preview === 'string' && Object.keys(input).length === 1) return { type: 'text', text: input.preview };
  const { tool } = request;
  if (COMMAND_TOOLS.has(tool)) {
    const command = commandText(input.command ?? input.cmd);
    if (command) {
      const description = asString(input.description);
      return description ? { type: 'command', command, description } : { type: 'command', command };
    }
  }
  if (tool === 'Edit') {
    return diffDetail(relativeTo(projectPath, asString(input.file_path)), [lineDiff(asString(input.old_string), asString(input.new_string))]);
  }
  if (tool === 'MultiEdit' && Array.isArray(input.edits)) {
    const parts = input.edits.map((e) => lineDiff(asString(asRecord(e).old_string), asString(asRecord(e).new_string)));
    return diffDetail(relativeTo(projectPath, asString(input.file_path)), parts);
  }
  if (tool === 'Write') {
    return diffDetail(relativeTo(projectPath, asString(input.file_path)), [lineDiff('', asString(input.content))]);
  }
  if (tool === 'NotebookEdit') {
    return diffDetail(relativeTo(projectPath, asString(input.notebook_path)), [lineDiff('', asString(input.new_source))]);
  }
  if (tool === 'apply_patch') {
    // codex-cli 0.162 sends the patch as `command`; older builds as `input` or `patch`.
    const patch = typeof request.input === 'string' ? request.input : asString(input.input ?? input.patch ?? input.command);
    if (patch) return patchDetail(patch, projectPath);
  }
  if (tool === 'WebFetch' && asString(input.url)) {
    const prompt = asString(input.prompt);
    return prompt ? { type: 'url', url: asString(input.url), prompt } : { type: 'url', url: asString(input.url) };
  }
  if (tool === 'WebSearch' && asString(input.query)) return { type: 'text', text: asString(input.query) };
  return { type: 'text', text: jsonText(request.input) };
}

function questionDetail(request: PendingRequest | null, fallback: string | null | undefined): CardDetail {
  const input = asRecord(request?.input);
  const first = Array.isArray(input.questions) ? asRecord(input.questions[0]) : input;
  const question = asString(first.question) || fallback || 'The agent has a question for you.';
  const header = asString(first.header);
  return header ? { type: 'question', question, header } : { type: 'question', question };
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * What "always" leaves behind, or null when the CLI's dialog has no such line. Claude
 * drops it for a call it can't save as a rule; Codex has it for a command (a prefix rule
 * in its global rules file) and a file edit (this session), and was never probed for more.
 */
function alwaysNote(cliName: string, request: PendingRequest): string | null {
  if (cliName !== 'Codex') return request.canAlwaysAllow === true ? 'Claude won’t ask again for calls like this one.' : null;
  if (request.tool === 'Bash') return 'Codex saves a rule and won’t ask again for commands that start like this one, in any project.';
  if (request.tool === 'apply_patch') return 'Codex won’t ask again for these files for the rest of this session.';
  return null;
}

function permissionChoices(cliName: string, request: PendingRequest, inbox: boolean): CardChoice[] {
  const codex = cliName === 'Codex';
  const truncated = !!request.inputTruncated;
  const note = alwaysNote(cliName, request);
  const blocked = truncated ? { disabledReason: TRUNCATED_REASON } : {};
  const choices: CardChoice[] = [
    { answer: { choice: 'deny' }, label: 'Deny', tone: 'destructive' },
    { answer: { choice: 'allow_always' }, label: codex ? 'Always approve' : 'Always allow', tone: 'secondary', confirm: true, ...(note ? { confirmNote: note } : {}), ...blocked },
    { answer: { choice: 'allow_once' }, label: codex ? 'Approve' : 'Allow once', tone: 'primary', ...blocked },
  ];
  return inbox || !note ? choices.filter((c) => c.answer.choice !== 'allow_always') : choices;
}

function terminalOnly(card: Omit<WaitingCard, 'choices' | 'tell' | 'terminalOnly' | 'terminalOnlyReason'>, reason: string): WaitingCard {
  return { ...card, choices: [], tell: null, terminalOnly: true, terminalOnlyReason: reason };
}

/** The card for a session waiting on the user, or null when nothing waits. */
export function waitingCardModel(session: CardSession, opts: CardOptions = {}): WaitingCard | null {
  if (session.status === 'ended') return null;
  const request = session.pendingRequest ?? null;
  const waiting = session.status === 'approval' || session.status === 'input';
  if (!request && !waiting) return null;
  const cli = request?.cli ?? (session.cliSource === 'codex' ? 'codex' : 'claude');
  const cliName: WaitingCard['cliName'] = cli === 'codex' ? 'Codex' : 'Claude';
  const where = session.projectName ? `in ${session.projectName}` : undefined;

  if (!request) {
    const base = { requestId: null, kind: 'guess' as const, cliName, tool: session.pendingTool ?? '', where };
    if (session.status === 'input') {
      return terminalOnly({ ...base, title: `${cliName} asks`, detail: questionDetail(null, session.waitingDetail) }, GUESS_REASON);
    }
    const what = session.pendingToolDetail || session.pendingTool;
    return terminalOnly({
      ...base,
      title: `${cliName} wants your approval`,
      detail: what ? { type: 'text', text: what } : { type: 'none' },
    }, GUESS_REASON);
  }

  const guess = request.source === 'timer' || request.source === 'notification';
  const base = { requestId: request.id, cliName, tool: request.tool, where };

  if (request.kind === 'question') {
    const card = { ...base, kind: 'question' as const, title: `${cliName} asks`, detail: questionDetail(request, session.waitingDetail) };
    if (guess) return terminalOnly(card, GUESS_REASON);
    if (request.ambiguous) return terminalOnly(card, AMBIGUOUS_REASON);
    if (!request.options || request.options.length === 0) return terminalOnly(card, MULTI_PICK_REASON);
    const choices = request.options.map((option, optionIndex): CardChoice => ({
      answer: { choice: 'option', optionIndex },
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      tone: 'secondary',
    }));
    return { ...card, choices, tell: { label: 'Other…' }, terminalOnly: false };
  }

  if (request.kind === 'plan') {
    const plan = asString(asRecord(request.input).plan);
    return terminalOnly({
      ...base,
      kind: 'plan',
      title: `${cliName} has a plan for you to approve`,
      detail: plan ? { type: 'plan', text: plan } : { type: 'none' },
    }, PLAN_REASON);
  }

  const card = { ...base, kind: 'permission' as const, title: describeTool(request.tool, cliName), detail: detailOf(request, session.projectPath) };
  if (guess) return terminalOnly(card, GUESS_REASON);
  if (request.ambiguous) return terminalOnly(card, AMBIGUOUS_REASON);
  return {
    ...card,
    choices: permissionChoices(cliName, request, !!opts.inbox),
    tell: { label: cli === 'codex' ? 'Tell Codex what to do…' : 'Tell Claude what to do instead…' },
    terminalOnly: false,
  };
}

/**
 * The choices a card shows as buttons, and why the others can't be pressed, each
 * reason once. Two blocked Allow buttons each repeating "Too long to show in full"
 * under itself took the room the card's other answers needed.
 */
export function offeredChoices(choices: readonly CardChoice[]): { offered: CardChoice[]; reasons: string[] } {
  if (choices.every((c) => !c.disabledReason)) return { offered: [...choices], reasons: [] };
  const reasons = [...new Set(choices.flatMap((c) => (c.disabledReason ? [c.disabledReason] : [])))];
  return { offered: choices.filter((c) => !c.disabledReason), reasons };
}
