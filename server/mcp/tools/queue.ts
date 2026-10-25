// tools/queue.ts — the queue toolset, P1: what is queued for a session, what its queue has sent, and every queue
// in scope. All three only read. (Changing a queue is P2; clearing one, `queue_clear`, is P5 and in queueClear.ts.)
//
// The server keeps each queue as JSON it never looks inside (`session_queues`): clients write it, so every field
// is read as if it might be missing or wrong. A queue is text a person, another device or a central wrote, so its
// bodies (an item's text, a chain step's text, the resume prompt, a sent prompt) are fenced as untrusted in `data`
// and the rows in the text sit in one block. Ids, positions, types, times and flags stay plain. An image is
// never sent, only how many there are.
//
// Scope: a tool that names a session goes through `resolveTarget`; `queue_list_all` keeps only the queues of
// sessions in `ctx.scopedSessions()`.

import type { ToolDef } from '../registry.js';
import { shortIdOf, toSessionCard } from '../scope.js';
import {
  defineTool,
  fence,
  isRecord,
  oneLine,
  plural,
  refOf,
  resolveTarget,
  seg,
  SESSION_REF,
  sessionSource,
  unwrap,
  visibleRooms,
} from './define.js';
import { fenced, isoTime, limitInput, list, num, records, str, whole } from './shape.js';
import { queueClearTool } from './queueClear.js';
import { span } from './views.js';

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

export interface Caps {
  /** Items listed for one queue. */
  items: number;
  /** Characters of an item's text kept. */
  text: number;
  /** Characters of a chain step's text kept. */
  stepText: number;
  /** Chain steps listed for one item (the counts say how many there are). */
  steps: number;
}

/** One session's queue (`queue_get`). */
export const FULL: Caps = { items: 100, text: 4_000, stepText: 1_000, steps: 25 };
/** Every queue at once (`queue_list_all`): enough to tell what each holds; `queue_get` has the rest. */
const OVERVIEW: Caps = { items: 10, text: 300, stepText: 200, steps: 5 };

const ROW_TEXT = 160;
const STEP_ROW_TEXT = 120;
const RESUME_PROMPT_MAX = 1_000;
const SENT_DEFAULT = 50;
const SENT_MAX = 300;
const SENT_TEXT_MAX = 200;
/** What the dashboard uses when a stored automation has no `resumeMaxRetries` (src/lib/resumeWatchdog.ts). */
const DEFAULT_RESUME_RETRIES = 3;

/** Sorts an item with no id after those with one. */
const LAST = Number.MAX_SAFE_INTEGER;

const ITEM_TYPES: ReadonlySet<string> = new Set(['once', 'loop', 'schedule']);
const EXEC_STATES: ReadonlySet<string> = new Set(['idle', 'before', 'main', 'after']);
/** `HH:MM`, 24-hour: how the queue writes a time of day. */
const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

// ---------------------------------------------------------------------------
// What a queue looks like to a central
// ---------------------------------------------------------------------------

export interface StepView {
  id: number | null;
  /** Fenced as untrusted. */
  text: string;
  textTruncated: boolean;
  images: number;
}

export interface WindowView {
  start: string;
  end: string;
}

export interface ItemView {
  id: number | null;
  position: number;
  type: string;
  disabled: boolean;
  /** Fenced as untrusted. */
  text: string;
  textTruncated: boolean;
  images: number;
  createdAt: number | null;
  intervalMs: number | null;
  runAt: number | null;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  totalFires: number | null;
  firstFireOfDay: string | null;
  excludeWindows: WindowView[];
  execState: string | null;
  execStepIdx: number | null;
  /** How many steps the chain has, whether or not they are all listed. */
  beforeCount: number;
  afterCount: number;
  beforeSteps: StepView[];
  afterSteps: StepView[];
}

export interface AutomationView {
  paused: boolean;
  autoSend: boolean;
  autoEnter: boolean;
  idleGuard: boolean;
  skipWhenPrompting: boolean;
  autoResume: boolean;
  resumeMaxRetries: number;
  /** Fenced as untrusted; null when none is set. */
  resumePrompt: string | null;
  loopExcludeWindows: WindowView[];
}

interface QueueView {
  /** False when the server holds no queue for the session yet (not the same as an empty queue). */
  known: boolean;
  updatedAt: number;
  count: number;
  enabled: number;
  shown: number;
  omitted: number;
  automation: AutomationView | null;
  items: ItemView[];
}

function windowsOf(raw: unknown): WindowView[] {
  return records(raw).flatMap((w) => {
    const start = str(w.startHHMM);
    const end = str(w.endHHMM);
    return start !== null && end !== null && CLOCK.test(start) && CLOCK.test(end) ? [{ start, end }] : [];
  });
}

function chainOf(sessionId: string, label: 'before' | 'after', raw: unknown, caps: Caps): { count: number; steps: StepView[]; rows: string[] } {
  const found = records(raw);
  const shown = found.slice(0, caps.steps);
  const steps = shown.map((step): StepView => {
    const body = fenced(sessionSource(sessionId), 'queue-step', str(step.text) ?? '', caps.stepText);
    return { id: num(step.id), text: body.value, textTruncated: body.truncated, images: list(step.images).length };
  });
  const rows = shown.map((step, i) => `   ${label} ${i + 1}: ${JSON.stringify(oneLine(str(step.text) ?? '', STEP_ROW_TEXT))}`);
  return { count: found.length, steps, rows };
}

function timingOf(item: Pick<ItemView, 'type' | 'intervalMs' | 'runAt'>): string {
  if (item.type === 'loop' && item.intervalMs !== null) return ` every ${span(item.intervalMs)}`;
  if (item.type === 'schedule' && item.runAt !== null) return ` at ${isoTime(item.runAt)}`;
  return '';
}

/** One stored item as a central sees it, and the rows that describe it in the text (the item, then its steps). */
export function itemOf(sessionId: string, raw: Record<string, unknown>, caps: Caps): { view: ItemView; rows: string[] } {
  const body = str(raw.text) ?? '';
  const type = str(raw.type) ?? '';
  const execState = str(raw.execState) ?? '';
  const firstFire = str(raw.firstFireOfDay) ?? '';
  const before = chainOf(sessionId, 'before', raw.beforeChain, caps);
  const after = chainOf(sessionId, 'after', raw.afterChain, caps);
  const text = fenced(sessionSource(sessionId), 'queue-item', body, caps.text);
  const view: ItemView = {
    id: num(raw.id),
    position: num(raw.position) ?? 0,
    type: ITEM_TYPES.has(type) ? type : 'once',
    disabled: raw.disabled === true,
    text: text.value,
    textTruncated: text.truncated,
    images: list(raw.images).length,
    createdAt: num(raw.createdAt),
    intervalMs: num(raw.intervalMs),
    runAt: num(raw.runAt),
    nextFireAt: num(raw.nextFireAt),
    lastFiredAt: num(raw.lastFiredAt),
    totalFires: num(raw.totalFires),
    firstFireOfDay: CLOCK.test(firstFire) ? firstFire : null,
    excludeWindows: windowsOf(raw.excludeWindows),
    execState: EXEC_STATES.has(execState) ? execState : null,
    execStepIdx: num(raw.execStepIdx),
    beforeCount: before.count,
    afterCount: after.count,
    beforeSteps: before.steps,
    afterSteps: after.steps,
  };
  const lead = `${view.position}. ${view.type}${view.disabled ? ' (paused)' : ''}${timingOf(view)}`;
  const notes = [
    before.count + after.count > 0 ? `steps: ${before.count} before, ${after.count} after` : null,
    view.images > 0 ? plural(view.images, 'image') : null,
  ].filter((n): n is string => n !== null);
  const named = view.id === null ? [] : [`id ${view.id}`];
  return { view, rows: [[lead, ...named, JSON.stringify(oneLine(body, ROW_TEXT)), ...notes].join(' · '), ...before.rows, ...after.rows] };
}

/** The stored automation as the window reads it: a switch is on only when it is stored as true (Ruling 52). */
export function automationOf(sessionId: string, raw: unknown): AutomationView | null {
  if (!isRecord(raw)) return null;
  const prompt = str(raw.resumePrompt) ?? '';
  return {
    paused: raw.paused === true,
    autoSend: raw.autoSend === true,
    autoEnter: raw.autoEnter === true,
    idleGuard: raw.idleGuard === true,
    skipWhenPrompting: raw.skipWhenPrompting === true,
    autoResume: raw.autoResume === true,
    resumeMaxRetries: num(raw.resumeMaxRetries) ?? DEFAULT_RESUME_RETRIES,
    resumePrompt: prompt === '' ? null : fenced(sessionSource(sessionId), 'queue-resume-prompt', prompt, RESUME_PROMPT_MAX).value,
    loopExcludeWindows: windowsOf(raw.loopExcludeWindows),
  };
}

const onOff = (flag: boolean): string => (flag ? 'on' : 'off');

/** AASC's words about the flags: booleans only, so they sit outside any fence. */
export function automationLine(a: AutomationView): string {
  return (
    `Automation: ${a.paused ? 'paused' : 'running'}, auto-send ${onOff(a.autoSend)}, auto-enter ${onOff(a.autoEnter)}, ` +
    `idle guard ${onOff(a.idleGuard)}, skip while prompting ${onOff(a.skipWhenPrompting)}, auto-resume ${onOff(a.autoResume)}.`
  );
}

/** A session's stored queue (`{ sessionId, items, automation, updatedAt }`, items null when nothing is stored). */
function queueOf(sessionId: string, record: unknown, caps: Caps): { view: QueueView; rows: string[] } {
  const body = isRecord(record) ? record : {};
  const built = records(body.items)
    .map((raw) => itemOf(sessionId, raw, caps))
    .sort((a, b) => a.view.position - b.view.position || (a.view.id ?? LAST) - (b.view.id ?? LAST));
  const shown = built.slice(0, caps.items);
  const view: QueueView = {
    known: Array.isArray(body.items),
    updatedAt: whole(body.updatedAt),
    count: built.length,
    enabled: built.filter((b) => !b.view.disabled).length,
    shown: shown.length,
    omitted: built.length - shown.length,
    automation: automationOf(sessionId, body.automation),
    items: shown.map((b) => b.view),
  };
  return { view, rows: shown.flatMap((b) => b.rows) };
}

// ---------------------------------------------------------------------------
// queue_get
// ---------------------------------------------------------------------------

/** The words for a queue with no automation stored: the window keeps settings the server cannot see (Ruling 52). */
const NO_AUTOMATION =
  'No automation settings are stored yet: the AASC window uses its own, and a central can only pause the queue or turn ' +
  'auto-send off until a person changes one queue switch in AASC.';

function queueSummary(ref: string, sessionId: string, view: QueueView, rows: readonly string[], resumePrompt: string): string {
  if (!view.known) return `Session ${ref} has no queue record yet: nothing has been queued for it on this Mac.`;
  const head = `Session ${ref} has ${plural(view.count, 'queued prompt')} (${view.enabled} enabled).`;
  const more = view.omitted > 0 ? ` ${view.omitted} more are not shown.` : '';
  const auto = view.automation === null ? ` ${NO_AUTOMATION}` : ` ${automationLine(view.automation)}`;
  const body = [...rows, ...(resumePrompt === '' ? [] : [`resume prompt: ${JSON.stringify(oneLine(resumePrompt, ROW_TEXT))}`])];
  return body.length === 0 ? `${head}${auto}` : `${head}${more}${auto}\n${fence(sessionSource(sessionId), 'queue', body.join('\n'))}`;
}

const queueGet = defineTool({
  name: 'queue_get',
  toolset: 'queue',
  title: 'A session’s prompt queue',
  description:
    'Shows what is queued for one session: each item by position with its id, type (once, loop or schedule), ' +
    'whether it is paused, its timing, its before and after chain steps and how many images it carries (never the ' +
    'images), plus the queue’s automation flags (paused, auto-send, auto-enter, idle guard, auto-resume). Up to 100 ' +
    'items; every text is fenced as untrusted data.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const record = unwrap<unknown>(await ctx.client.get(`/sessions/${seg(s.sessionId)}/queue`));
    const { view, rows } = queueOf(s.sessionId, record, FULL);
    const resume = isRecord(record) && isRecord(record.automation) ? (str(record.automation.resumePrompt) ?? '') : '';
    return {
      data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), ...view },
      summary: queueSummary(refOf(ctx)(s.sessionId), s.sessionId, view, rows, resume),
    };
  },
});

// ---------------------------------------------------------------------------
// queue_list_all
// ---------------------------------------------------------------------------

const queueListAll = defineTool({
  name: 'queue_list_all',
  toolset: 'queue',
  title: 'Every prompt queue in scope',
  description:
    'Lists the prompt queues of the sessions in your scope that have something queued: for each, the session, its ' +
    'status, the automation flags and its first 10 items (id, position, type, paused, timing, chain steps; texts ' +
    'cut short and fenced as untrusted data). queue_get shows one queue in full.',
  risk: 'read',
  phase: 1,
  input: {},
  async run(_args, ctx) {
    const body = unwrap<unknown>(await ctx.client.get('/queues'));
    const mine = new Map(ctx.scopedSessions().map((s) => [s.sessionId, s]));
    const rooms = visibleRooms(ctx);
    const ref = refOf(ctx);
    const found = records(isRecord(body) ? body.queues : []).flatMap((q) => {
      const session = typeof q.sessionId === 'string' ? mine.get(q.sessionId) : undefined;
      if (session === undefined) return [];
      const card = toSessionCard(session, rooms);
      return [{ card, ...queueOf(card.id, q, OVERVIEW) }];
    });
    const listed = found
      .filter((q) => q.view.count > 0)
      .sort((a, b) => b.view.updatedAt - a.view.updatedAt || a.card.id.localeCompare(b.card.id));
    const items = listed.reduce((n, q) => n + q.view.count, 0);
    const data = {
      count: listed.length,
      items,
      empty: found.length - listed.length,
      queues: listed.map((q) => ({
        id: q.card.id,
        shortId: q.card.shortId,
        title: fence(sessionSource(q.card.id), 'title', q.card.title),
        status: q.card.status,
        ...q.view,
      })),
    };
    if (listed.length === 0) return { data, summary: 'No prompts are queued in your scope.' };
    const rows = listed.flatMap((q) => [
      `${ref(q.card.id)} · ${JSON.stringify(oneLine(q.card.title, 80))} · ${q.card.status} · ${plural(q.view.count, 'queued prompt')}` +
        (q.view.omitted > 0 ? ` (${q.view.omitted} more not shown)` : ''),
      ...q.rows.map((row) => `  ${row}`),
    ]);
    const lead = `${plural(listed.length, 'session')} ${listed.length === 1 ? 'has' : 'have'} queued prompts (${items} in all).`;
    return { data, summary: `${lead}\n${fence('aasc', 'queues', rows.join('\n'))}` };
  },
});

// ---------------------------------------------------------------------------
// queue_sent
// ---------------------------------------------------------------------------

const queueSent = defineTool({
  name: 'queue_sent',
  toolset: 'queue',
  title: 'What a session’s queue sent',
  description:
    'Lists the prompts the queue sent to one session, newest first, each with when it was sent. The server keeps ' +
    'the first 80 characters of each, for the last 300 sends; the text is fenced as untrusted data. 50 by default.',
  risk: 'read',
  phase: 1,
  input: { id: SESSION_REF, limit: limitInput(SENT_MAX, SENT_DEFAULT) },
  async run(args, ctx) {
    const s = resolveTarget(ctx, args.id);
    const body = unwrap<unknown>(await ctx.client.get(`/sessions/${seg(s.sessionId)}/queue/sent`));
    const all = records(isRecord(body) ? body.sent : [])
      .map((r) => ({ text: str(r.text) ?? '', sentAt: whole(r.sentAt) }))
      .map((r, index) => ({ ...r, index }))
      .sort((a, b) => b.sentAt - a.sentAt || b.index - a.index);
    const shown = all.slice(0, args.limit ?? SENT_DEFAULT);
    const ref = refOf(ctx)(s.sessionId);
    const data = {
      id: s.sessionId,
      shortId: shortIdOf(s.sessionId),
      count: all.length,
      shown: shown.length,
      sent: shown.map((r) => ({ text: fenced(sessionSource(s.sessionId), 'queue-sent', r.text, SENT_TEXT_MAX).value, sentAt: r.sentAt })),
    };
    if (all.length === 0) return { data, summary: `The queue of session ${ref} has not sent a prompt.` };
    const more = all.length > shown.length ? `; the newest ${shown.length} are listed` : '';
    const rows = shown.map((r) => `${isoTime(r.sentAt)} · ${JSON.stringify(oneLine(r.text, SENT_TEXT_MAX))}`);
    return {
      data,
      summary: `The queue of session ${ref} has sent ${plural(all.length, 'prompt')}${more}, newest first.\n${fence(sessionSource(s.sessionId), 'queue-sent', rows.join('\n'))}`,
    };
  },
});

export const queueTools: readonly ToolDef[] = [queueGet, queueListAll, queueSent, queueClearTool];
