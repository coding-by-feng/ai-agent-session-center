// queueOps.ts — what a central does to a session's shared prompt queue (`session_queues`): pure operations that take the
// queue as it is and answer a new one, and the one synchronous read-modify-write that applies them.
//
// The queue is shared state that the desktop window also writes, as whole lists. So a central never reads the queue,
// thinks, and PUTs it back: that would lose whatever the window saved in between. `applyQueueOp` reads the stored row,
// applies the op and writes the result in one synchronous call, with nothing that can run between the read and the
// write (the SQLite calls under it are synchronous too). The write is then told to every window as `queue_update`,
// with the origin `mcp:<centralId>`, exactly as `PUT /sessions/:id/queue` does (queueWiring.ts).
//
// An op follows the client's own rules, so what a central writes is what the window would have written:
//   * a new item's id is `max(now, maxId + 1)` and its position the next one after the last (the scheme of
//     `appendPausedItem`, the phone's share path); a step's id is `max(now, the highest step id + 1)`;
//   * a position is clamped into the queue; an item or step that is not there is NOT_FOUND;
//   * the queue's order is the items' `position`, numbered 0..n-1 whenever an op reorders;
//   * timing edits mean what the editor's Save means (QueueItemEditModal `handleSave`); ⚡ NOW means what the Queue
//     tab's button means (`handleTriggerNow`).
// An item is stored as JSON the server never looks inside: every op spreads what it finds, so a field this build has
// never heard of survives, and an entry that is not an item at all is kept where it stands.
//
// Text a central writes is typed into a person's CLI by the scheduler, so it passes the rails of the prompt route:
// control bytes are dropped (an Esc sequence could drive the TUI) and a line that starts with `!` (a shell command in
// the CLI) is refused. Refusals say what is wrong in AASC's own words and never repeat anything a caller sent.
//
// Pure: nothing here reads a clock, a store or the network; `now` and the store are handed in. Nothing it is given is
// changed.

import { assertNotShellLine } from './policy.js';
import { ToolError } from './types.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One stored item. Opaque on purpose: the server keeps whatever the clients write. */
export type QueueItemLike = Readonly<Record<string, unknown>>;
/** The stored automation switches (`QueueAutomationConfig` on the client), as stored. */
export type QueueAutomationLike = Readonly<Record<string, unknown>>;

/** A queue as an op sees it. */
export interface QueueState {
  readonly items: readonly QueueItemLike[];
  readonly automation: QueueAutomationLike | null;
}

/** What an op answers: the new queue, and what the caller needs to say about the change. */
export interface QueueChange<R> {
  items: QueueItemLike[];
  automation: QueueAutomationLike | null;
  result: R;
}

export type QueueOp<R> = (state: QueueState) => QueueChange<R>;

/**
 * Where queues are kept. The server's own is over `db.getSessionQueue` / `db.upsertSessionQueue` and the
 * `queue_update` broadcast (queueWiring.ts); a session with no row reads as an empty queue. Both methods are
 * synchronous: that is what makes `applyQueueOp` one step.
 */
export interface QueueStore {
  read(sessionId: string): { items: QueueItemLike[]; automation: QueueAutomationLike | null };
  write(sessionId: string, items: QueueItemLike[], automation: QueueAutomationLike | null, originClientId: string): void;
}

export type ChainName = 'before' | 'after';
export type ItemType = 'once' | 'loop' | 'schedule';

/** A quiet-hours window as a caller writes it: 24-hour `HH:MM`, local time. */
export interface WindowInput {
  start: string;
  end: string;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The most one queue may carry in `items` (apiRouter.ts MAX_QUEUE_PAYLOAD_BYTES: the PUT refuses more). */
export const QUEUE_PAYLOAD_MAX = 8 * 1024 * 1024;
/** The longest prompt or step (`POST /sessions/:id/queue/items` takes 64 KiB). */
export const TEXT_MAX = 64 * 1024;
/** The longest resume prompt (the dashboard's `setResumePrompt` cuts at this). */
export const RESUME_PROMPT_MAX = 4_000;
/** The shortest loop: the Queue editor's smallest unit is one second. */
export const MIN_LOOP_INTERVAL_MS = 1_000;
/** The longest loop interval a central may set. */
export const MAX_LOOP_INTERVAL_MS = 30 * 24 * 60 * 60_000;
/** The most quiet-hours windows one list carries. */
export const MAX_WINDOWS = 10;
/** Resume attempts per window: the dashboard clamps to this range. */
export const RESUME_RETRIES_RANGE = { min: 1, max: 10 } as const;
/** The most prompts one queue holds: a central adds none past it (B-M4). */
export const MAX_QUEUE_ITEMS = 200;
/** The most chain steps one prompt carries, its before and after chains together. */
export const MAX_ITEM_STEPS = 20;

/** `HH:MM`, 24-hour, zero-padded: how the queue writes a time of day. */
export const CLOCK_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * The resume attempts when none are stored: the dashboard's `DEFAULT_MAX_RETRIES` (src/stores/queueStore.ts). A copy:
 * the client's store cannot be imported on the server.
 */
const DEFAULT_RESUME_RETRIES = 3;

// ---------------------------------------------------------------------------
// Reading what the clients stored
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const numeric = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (entry: unknown): number | null => (isRecord(entry) ? numeric(entry.id) : null);

/** A copy of `record` without these keys. */
function without(record: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop.has(key)));
}

/** `position` as a place in a list of `size` entries (0 is first). Anything that is not a number is the end. */
function clampTo(position: number | undefined, size: number): number {
  if (position === undefined || !Number.isFinite(position)) return size;
  return Math.max(0, Math.min(size, Math.trunc(position)));
}

const notFoundItem = (): ToolError =>
  new ToolError('NOT_FOUND', 'No prompt in that queue has that id.', 'Call queue_get for the ids of its prompts.');
const notFoundStep = (): ToolError =>
  new ToolError('NOT_FOUND', 'No step in that chain has that id.', 'Call queue_get: each prompt lists its steps and their ids.');

/**
 * The items that are items, in the queue's order (their `position`; the window sorts the same way), then what is not an
 * item, in the order found.
 */
export function inOrder(items: readonly QueueItemLike[]): QueueItemLike[] {
  const found = items.map((entry, index) => ({ entry, index, at: isRecord(entry) ? numeric(entry.position) : null }));
  found.sort((a, b) => {
    if (a.at === b.at) return a.index - b.index;
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return a.at - b.at || a.index - b.index;
  });
  const records = found.filter((f) => isRecord(f.entry)).map((f) => f.entry);
  return [...records, ...found.filter((f) => !isRecord(f.entry)).map((f) => f.entry)];
}

const recordCount = (items: readonly unknown[]): number => items.filter(isRecord).length;

/** The items numbered 0..n-1 in the order they stand (what the dashboard's own reorder writes). */
function renumbered(items: readonly QueueItemLike[]): QueueItemLike[] {
  let next = 0;
  return items.map((entry) => {
    if (!isRecord(entry)) return entry;
    const position = next;
    next += 1;
    return entry.position === position ? entry : { ...entry, position };
  });
}

/** The index of the item with this id and the item; NOT_FOUND when none has it. */
function pick(items: readonly QueueItemLike[], itemId: number): { index: number; item: Record<string, unknown> } {
  const index = items.findIndex((entry) => idOf(entry) === itemId);
  if (index < 0) throw notFoundItem();
  return { index, item: items[index] as Record<string, unknown> };
}

const replaceAt = (items: readonly QueueItemLike[], index: number, next: QueueItemLike): QueueItemLike[] =>
  items.map((entry, i) => (i === index ? next : entry));

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** The bytes the prompt route strips before it types (promptRouter.ts `cleanPromptText`): all but \t and \n. */
// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\x00-\x08\x0B-\x1F\x7F-\x9F]/g;

/** Text as the scheduler will type it: line breaks as \n, control bytes gone, both ends trimmed. */
const cleaned = (raw: string): string => raw.replace(/\r\n?/g, '\n').replace(CONTROL_BYTES, '').trim();

/**
 * The scheduler turns the two characters `\n` into a line break before it types (useGlobalQueueScheduler
 * `sendToTerminal`), so a shell line is looked for in what it will type, not in what was stored.
 */
const typed = (text: string): string => text.replace(/\\n/g, '\n');

/** Text as the CLI will receive it: cleaned, and every two-character `\n` a line break, as the scheduler types it. */
export const typedText = (raw: string): string => typed(cleaned(raw));

/** A prompt or step as it is stored: cleaned, not blank, not too long, not a shell line. */
function promptText(raw: string): string {
  const text = cleaned(raw);
  if (text === '') throw new ToolError('INVALID', 'The text is blank.', 'Give the words to type into the session.');
  if (text.length > TEXT_MAX) {
    throw new ToolError('INVALID', 'The text is too long.', `A prompt or step holds at most ${TEXT_MAX / 1024} KiB.`);
  }
  assertNotShellLine(typed(text));
  return text;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export interface AddItemInput {
  /** The session the queue belongs to: stored in the item, as the client does. */
  sessionId: string;
  text: string;
  /** Where it goes (0 is first), clamped to the queue; the end when absent. */
  position?: number;
  /** A central's items are added disabled: a person turns them on (Ruling P2-2). `false` leaves the mark out. */
  disabled: boolean;
}

/** The highest id and position stored: what a new item must go past. */
function extents(items: readonly QueueItemLike[]): { maxId: number; maxPosition: number } {
  let maxId = 0;
  let maxPosition = -1;
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    const id = numeric(entry.id);
    const position = numeric(entry.position);
    if (id !== null) maxId = Math.max(maxId, id);
    if (position !== null) maxPosition = Math.max(maxPosition, position);
  }
  return { maxId, maxPosition };
}

/** Adds a once-only prompt: last, or at `position`. Without a position nothing else in the queue changes. */
export function addItem(state: QueueState, input: AddItemInput, now: number): QueueChange<{ itemId: number }> {
  const text = promptText(input.text);
  if (recordCount(state.items) >= MAX_QUEUE_ITEMS) {
    throw new ToolError(
      'INVALID',
      `This queue already holds ${MAX_QUEUE_ITEMS} prompts, the most one may hold.`,
      'Remove prompts that are no longer needed first.',
    );
  }
  const { maxId, maxPosition } = extents(state.items);
  const added: QueueItemLike = {
    id: Math.max(now, maxId + 1),
    sessionId: input.sessionId,
    text,
    position: Math.max(maxPosition + 1, state.items.length),
    createdAt: now,
    ...(input.disabled ? { disabled: true } : {}),
  };
  const result = { itemId: added.id as number };
  if (input.position === undefined) return { items: [...state.items, added], automation: state.automation, result };
  const ordered = inOrder(state.items);
  const at = clampTo(input.position, recordCount(ordered));
  const items = renumbered([...ordered.slice(0, at), added, ...ordered.slice(at)]);
  return { items, automation: state.automation, result };
}

/** Replaces one item's text; its timing, steps, images and paused mark stay. */
export function editItem(state: QueueState, input: { itemId: number; text: string }): QueueChange<{ itemId: number }> {
  const { index, item } = pick(state.items, input.itemId);
  const text = promptText(input.text);
  return { items: replaceAt(state.items, index, { ...item, text }), automation: state.automation, result: { itemId: input.itemId } };
}

/** Takes one item out. The others keep their positions (the dashboard's own remove does not renumber either). */
export function removeItem(state: QueueState, input: { itemId: number }): QueueChange<{ itemId: number }> {
  const { index } = pick(state.items, input.itemId);
  return { items: state.items.filter((_, i) => i !== index), automation: state.automation, result: { itemId: input.itemId } };
}

/** Moves one item to a place in the queue's order (0 is first, clamped) and numbers the queue 0..n-1. */
export function moveItem(
  state: QueueState,
  input: { itemId: number; position: number },
): QueueChange<{ itemId: number; from: number; to: number }> {
  const ordered = inOrder(state.items);
  const from = ordered.findIndex((entry) => idOf(entry) === input.itemId);
  if (from < 0) throw notFoundItem();
  const to = clampTo(input.position, recordCount(ordered) - 1);
  const rest = ordered.filter((_, i) => i !== from);
  const items = renumbered([...rest.slice(0, to), ordered[from], ...rest.slice(to)]);
  return { items, automation: state.automation, result: { itemId: input.itemId, from, to } };
}

/** Turns one item on or off. On leaves the `disabled` mark out, as the dashboard stores an enabled item. */
export function setItemEnabled(
  state: QueueState,
  input: { itemId: number; enabled: boolean },
): QueueChange<{ itemId: number }> {
  const { index, item } = pick(state.items, input.itemId);
  const next = input.enabled ? without(item, 'disabled') : { ...item, disabled: true };
  return { items: replaceAt(state.items, index, next), automation: state.automation, result: { itemId: input.itemId } };
}

/** The ids of the stored prompts, sorted: what a clear is asked about (Ruling P5-10). An entry with no id is not one. */
export function queueItemIds(items: readonly QueueItemLike[]): number[] {
  return items.map(idOf).filter((id): id is number => id !== null).sort((a, b) => a - b);
}

/**
 * Takes every prompt out, only when they are exactly the ones the person was shown (`expectIds`, in any order): a
 * prompt the window added, or one it sent, since then refuses INVALID and nothing is written. The automation record
 * stays as stored, and an entry that is not an item is kept where it stands.
 */
export function clearItems(state: QueueState, input: { expectIds: readonly number[] }): QueueChange<{ cleared: number }> {
  const stored = queueItemIds(state.items);
  const expected = [...input.expectIds].sort((a, b) => a - b);
  if (stored.length !== expected.length || stored.some((id, i) => id !== expected[i])) {
    throw invalid('The queue changed since the person was asked.', 'Call queue_clear again: the person is asked about the queue as it is now.');
  }
  return { items: state.items.filter((entry) => !isRecord(entry)), automation: state.automation, result: { cleared: recordCount(state.items) } };
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export interface ScheduleInput {
  itemId: number;
  type: ItemType;
  /** A loop's interval; required for a loop, refused otherwise. */
  intervalMs?: number;
  /** A schedule's run time (unix ms, in the future); required for a schedule, refused otherwise. */
  runAt?: number;
  /** A loop's first fire of the day (`HH:MM`); null clears it. Loops only. */
  firstFireOfDay?: string | null;
  /** A loop's own quiet hours; an empty list clears them. Loops only. */
  excludeWindows?: ReadonlyArray<WindowInput>;
}

type ScheduleField = 'intervalMs' | 'runAt' | 'firstFireOfDay' | 'excludeWindows';

/** What each type takes (the rest is refused) and what it needs. */
const SCHEDULE_FIELDS: Readonly<Record<ItemType, { takes: readonly ScheduleField[]; needs: readonly ScheduleField[] }>> = {
  once: { takes: [], needs: [] },
  loop: { takes: ['intervalMs', 'firstFireOfDay', 'excludeWindows'], needs: ['intervalMs'] },
  schedule: { takes: ['runAt'], needs: ['runAt'] },
};

const invalid = (message: string, hint: string): ToolError => new ToolError('INVALID', message, hint);

/** The quiet-hours windows as the queue stores them, ids `now`, `now + 1`, … (a list's ids only need be its own). */
function storedWindows(windows: ReadonlyArray<WindowInput>, now: number): Array<Record<string, unknown>> {
  if (windows.length > MAX_WINDOWS) {
    throw invalid(`A list holds at most ${MAX_WINDOWS} quiet-hours windows.`, 'Merge windows that touch.');
  }
  return windows.map((w, i) => {
    if (!CLOCK_RE.test(w.start) || !CLOCK_RE.test(w.end)) {
      throw invalid('A quiet-hours window needs 24-hour HH:MM times.', 'Write them like 22:00 and 06:30.');
    }
    if (w.start === w.end) {
      throw invalid('A quiet-hours window needs different start and end times.', 'A window that wraps midnight, like 22:00 to 06:00, is fine.');
    }
    return { id: now + i, startHHMM: w.start, endHHMM: w.end };
  });
}

/** Refuses an input that does not fit its type, or that no timing could mean. Words name fields, never values. */
function checkSchedule(input: ScheduleInput, now: number): void {
  if (!Object.hasOwn(SCHEDULE_FIELDS, input.type)) {
    throw invalid('That timing type is not once, loop or schedule.', 'Use once, loop or schedule.');
  }
  const rules = SCHEDULE_FIELDS[input.type];
  const given = (field: ScheduleField): boolean => input[field] !== undefined;
  const all: ScheduleField[] = ['intervalMs', 'runAt', 'firstFireOfDay', 'excludeWindows'];
  for (const field of all) {
    if (given(field) && !rules.takes.includes(field)) {
      throw invalid(`${field} does not apply to that kind of timing.`, 'A loop takes intervalMs, firstFireOfDay and excludeWindows; a schedule takes runAt; once takes none.');
    }
  }
  for (const field of rules.needs) {
    if (!given(field)) throw invalid(`${field} is required for that kind of timing.`, 'A loop needs intervalMs; a schedule needs runAt.');
  }
  const { intervalMs, runAt, firstFireOfDay } = input;
  if (intervalMs !== undefined && !(Number.isInteger(intervalMs) && intervalMs >= MIN_LOOP_INTERVAL_MS && intervalMs <= MAX_LOOP_INTERVAL_MS)) {
    throw invalid('intervalMs is outside what a loop may be.', 'Whole milliseconds, from one second to 30 days.');
  }
  if (runAt !== undefined && !(Number.isInteger(runAt) && runAt > now)) {
    throw invalid('runAt is not a time in the future.', 'Give a time ahead of now; to send something now use queue_fire_now.');
  }
  if (typeof firstFireOfDay === 'string' && !CLOCK_RE.test(firstFireOfDay)) {
    throw invalid('firstFireOfDay is not a 24-hour HH:MM time.', 'Write it like 07:30.');
  }
}

/**
 * Sets one item's timing the way the editor's Save does. A loop's first fire is one interval from now unless it
 * already has a later one; a schedule fires at its run time; a once item sorts first (next fire 0). Each type drops
 * the fields the others own; a loop's quiet hours stay when it becomes something else (the editor keeps them too).
 */
export function setItemSchedule(state: QueueState, input: ScheduleInput, now: number): QueueChange<{ itemId: number }> {
  const { index, item } = pick(state.items, input.itemId);
  checkSchedule(input, now);
  let next: Record<string, unknown>;
  if (input.type === 'loop') {
    const interval = input.intervalMs as number;
    const upcoming = numeric(item.nextFireAt);
    next = { ...without(item, 'runAt'), type: 'loop', intervalMs: interval, nextFireAt: upcoming !== null && upcoming > 0 && upcoming >= now ? upcoming : now + interval };
    if (input.firstFireOfDay === null) next = without(next, 'firstFireOfDay');
    else if (input.firstFireOfDay !== undefined) next = { ...next, firstFireOfDay: input.firstFireOfDay };
    if (input.excludeWindows !== undefined) {
      const windows = storedWindows(input.excludeWindows, now);
      next = windows.length === 0 ? without(next, 'excludeWindows') : { ...next, excludeWindows: windows };
    }
  } else if (input.type === 'schedule') {
    next = { ...without(item, 'intervalMs', 'firstFireOfDay'), type: 'schedule', runAt: input.runAt, nextFireAt: input.runAt };
  } else {
    next = { ...without(item, 'intervalMs', 'runAt', 'firstFireOfDay'), type: 'once', nextFireAt: 0 };
  }
  return { items: replaceAt(state.items, index, next), automation: state.automation, result: { itemId: input.itemId } };
}

/** Is this item partway through its before → main → after chain (the scheduler's `isExecuting`)? */
const isExecuting = (item: Record<string, unknown>): boolean =>
  item.execState === 'before' || item.execState === 'main' || item.execState === 'after';

const isPaused = (automation: QueueAutomationLike | null): boolean => isRecord(automation) && automation.paused === true;

/**
 * ⚡ NOW: flags the item so the window's scheduler starts it (its whole chain) at once, past the idle guard, quiet
 * hours and the auto-send switch. A fresh item starts from the top; one partway through its chain keeps its cursor and
 * the flag releases the step it waits on (`resumed`). Refused for a paused item and a paused queue: the scheduler
 * never fires either, so the flag would stay on and fire the moment a person turned them on.
 */
export function fireNow(state: QueueState, input: { itemId: number }): QueueChange<{ itemId: number; resumed: boolean }> {
  const { index, item } = pick(state.items, input.itemId);
  if (item.disabled === true) {
    throw invalid('That prompt is paused, so it cannot be started now.', 'A paused prompt runs once the person turns it on in AASC.');
  }
  if (isPaused(state.automation)) {
    throw invalid('That queue is paused, so nothing in it can be started now.', 'Resume the queue first (queue_set_paused), if the person wants it to run.');
  }
  const resumed = isExecuting(item);
  const next = resumed ? { ...item, forceStart: true } : { ...without(item, 'execState', 'execStepIdx'), forceStart: true };
  return { items: replaceAt(state.items, index, next), automation: state.automation, result: { itemId: input.itemId, resumed } };
}

// ---------------------------------------------------------------------------
// Chain steps
// ---------------------------------------------------------------------------

const CHAIN_KEY: Readonly<Record<ChainName, 'beforeChain' | 'afterChain'>> = { before: 'beforeChain', after: 'afterChain' };

function chainKey(chain: ChainName): 'beforeChain' | 'afterChain' {
  if (!Object.hasOwn(CHAIN_KEY, chain)) throw invalid('A chain is before or after.', 'Pass chain as "before" or "after".');
  return CHAIN_KEY[chain];
}

const stepsOf = (item: Record<string, unknown>, key: 'beforeChain' | 'afterChain'): unknown[] =>
  Array.isArray(item[key]) ? [...(item[key] as unknown[])] : [];

/** The item with this chain replaced; a chain with no step left has no key (the dashboard stores none either). */
const withSteps = (item: Record<string, unknown>, key: 'beforeChain' | 'afterChain', steps: unknown[]): Record<string, unknown> =>
  steps.length === 0 ? without(item, key) : { ...item, [key]: steps };

function highestStepId(item: Record<string, unknown>): number {
  const ids = [...stepsOf(item, 'beforeChain'), ...stepsOf(item, 'afterChain')].map(idOf);
  return ids.reduce<number>((high, id) => (id === null ? high : Math.max(high, id)), 0);
}

/**
 * A step added, taken out or moved while its item is partway through the chain would shift what `execStepIdx` points
 * at, so the scheduler would skip a step or send one twice. A step's text is safe to change at any time.
 */
function mustBeIdle(item: Record<string, unknown>): void {
  if (isExecuting(item)) {
    throw new ToolError('BUSY', 'That prompt is partway through its chain.', 'Wait until the chain finishes, then change its steps.');
  }
}

/** The item, its chain, and where the step stands in it. */
function pickStep(state: QueueState, itemId: number, chain: ChainName, stepId: number) {
  const { index, item } = pick(state.items, itemId);
  const key = chainKey(chain);
  const steps = stepsOf(item, key);
  const at = steps.findIndex((step) => idOf(step) === stepId);
  if (at < 0) throw notFoundStep();
  return { index, item, key, steps, at };
}

const stepsChange = <R>(
  state: QueueState,
  index: number,
  item: Record<string, unknown>,
  key: 'beforeChain' | 'afterChain',
  steps: unknown[],
  result: R,
): QueueChange<R> => ({ items: replaceAt(state.items, index, withSteps(item, key, steps)), automation: state.automation, result });

export interface AddStepInput {
  itemId: number;
  chain: ChainName;
  text: string;
  /** Where in the chain (0 is first), clamped; the end when absent. */
  position?: number;
}

/** Adds a step to an item's before or after chain, while the two hold fewer than MAX_ITEM_STEPS together. */
export function addStep(state: QueueState, input: AddStepInput, now: number): QueueChange<{ itemId: number; stepId: number }> {
  const { index, item } = pick(state.items, input.itemId);
  const key = chainKey(input.chain);
  mustBeIdle(item);
  const text = promptText(input.text);
  if (stepsOf(item, 'beforeChain').length + stepsOf(item, 'afterChain').length >= MAX_ITEM_STEPS) {
    throw invalid(
      `That prompt already has ${MAX_ITEM_STEPS} chain steps, the most one may have.`,
      'Remove a step it no longer needs first, or queue the rest as another prompt.',
    );
  }
  const steps = stepsOf(item, key);
  const stepId = Math.max(now, highestStepId(item) + 1);
  steps.splice(clampTo(input.position, steps.length), 0, { id: stepId, text });
  return stepsChange(state, index, item, key, steps, { itemId: input.itemId, stepId });
}

/** Replaces one step's text; its id and images stay. */
export function editStep(
  state: QueueState,
  input: { itemId: number; chain: ChainName; stepId: number; text: string },
): QueueChange<{ itemId: number; stepId: number }> {
  const { index, item, key, steps, at } = pickStep(state, input.itemId, input.chain, input.stepId);
  const text = promptText(input.text);
  steps[at] = { ...(steps[at] as Record<string, unknown>), text };
  return stepsChange(state, index, item, key, steps, { itemId: input.itemId, stepId: input.stepId });
}

/** Takes one step out of its chain. */
export function removeStep(
  state: QueueState,
  input: { itemId: number; chain: ChainName; stepId: number },
): QueueChange<{ itemId: number; stepId: number }> {
  const { index, item, key, steps, at } = pickStep(state, input.itemId, input.chain, input.stepId);
  mustBeIdle(item);
  steps.splice(at, 1);
  return stepsChange(state, index, item, key, steps, { itemId: input.itemId, stepId: input.stepId });
}

/** Moves one step within its chain (0 is first, clamped). */
export function moveStep(
  state: QueueState,
  input: { itemId: number; chain: ChainName; stepId: number; position: number },
): QueueChange<{ itemId: number; stepId: number; from: number; to: number }> {
  const { index, item, key, steps, at } = pickStep(state, input.itemId, input.chain, input.stepId);
  mustBeIdle(item);
  const [moved] = steps.splice(at, 1);
  const to = clampTo(input.position, steps.length);
  steps.splice(to, 0, moved);
  return stepsChange(state, index, item, key, steps, { itemId: input.itemId, stepId: input.stepId, from: at, to });
}

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

/** The resume attempts a stored record allows, as the dashboard reads them: whole, within 1 to 10, 3 when none are stored. */
export function storedResumeRetries(stored: QueueAutomationLike | null): number {
  const retries = isRecord(stored) ? numeric(stored.resumeMaxRetries) : null;
  if (retries === null) return DEFAULT_RESUME_RETRIES;
  return Math.min(RESUME_RETRIES_RANGE.max, Math.max(RESUME_RETRIES_RANGE.min, Math.round(retries)));
}

/**
 * The stored automation with every field present, for an op to change one. The window reads a switch that is absent
 * (or anything but true) as off, so that is how it is written back: never as on, which would make the window send
 * where it does not now (Ruling 52). With no record stored the window keeps settings of its own the server cannot see,
 * so there is nothing to write back: refused until a person changes one queue switch in AASC, which stores the record.
 * Fields this build does not know are kept.
 */
function wholeAutomation(stored: QueueAutomationLike | null, fromNothing = false): Record<string, unknown> {
  if (fromNothing && stored === null) return { ...SAFE_AUTOMATION };
  if (!isRecord(stored)) {
    throw invalid('No automation settings are stored for this queue yet.', 'Change one queue switch in AASC first.');
  }
  return {
    ...stored,
    paused: stored.paused === true,
    autoSend: stored.autoSend === true,
    autoEnter: stored.autoEnter === true,
    idleGuard: stored.idleGuard === true,
    skipWhenPrompting: stored.skipWhenPrompting === true,
    autoResume: stored.autoResume === true,
    resumeMaxRetries: storedResumeRetries(stored),
    resumePrompt: typeof stored.resumePrompt === 'string' ? stored.resumePrompt : '',
  };
}

/**
 * The record written when none is stored and the change only stops things (P4-32 M6: pausing, auto-send off): every
 * switch that makes the window send is off, the guards that hold a send back are on, the resume tries and prompt are the
 * dashboard's. Everything else keeps Ruling 52.
 */
const SAFE_AUTOMATION: Readonly<Record<string, unknown>> = Object.freeze({
  paused: false,
  autoSend: false,
  autoEnter: false,
  idleGuard: true,
  skipWhenPrompting: true,
  autoResume: false,
  resumeMaxRetries: DEFAULT_RESUME_RETRIES,
  resumePrompt: '',
});

const automationChange = (state: QueueState, automation: Record<string, unknown>): QueueChange<{ changed: string[] }> => ({
  items: [...state.items],
  automation,
  result: { changed: [] },
});

/**
 * The queue's Pause (`automation.paused`): a hard stop for everything the scheduler sends, ⚡ NOW included. Pausing is
 * allowed with no record stored (it only stops things); resuming is not.
 */
export function setPaused(state: QueueState, paused: boolean): QueueChange<{ changed: string[] }> {
  const base = wholeAutomation(state.automation, paused);
  return { ...automationChange(state, { ...base, paused }), result: { changed: ['paused'] } };
}

/**
 * The session's auto-send switch (the ➤ icon): whether the scheduler sends queued prompts on its own. Switching it off
 * is allowed with no record stored (it only stops things); switching it on is not.
 */
export function setAutoSend(state: QueueState, autoSend: boolean): QueueChange<{ changed: string[] }> {
  const base = wholeAutomation(state.automation, !autoSend);
  return { ...automationChange(state, { ...base, autoSend }), result: { changed: ['autoSend'] } };
}

export interface AutomationPatch {
  autoEnter?: boolean;
  idleGuard?: boolean;
  skipWhenPrompting?: boolean;
  autoResume?: boolean;
  resumeMaxRetries?: number;
  /** The prompt the auto-resume watchdog types; empty brings back the default wording. */
  resumePrompt?: string;
  /** Quiet hours for every loop in the session; an empty list clears them. */
  loopExcludeWindows?: ReadonlyArray<WindowInput>;
}

const FLAG_FIELDS = ['autoEnter', 'idleGuard', 'skipWhenPrompting', 'autoResume'] as const;

/** The resume prompt as it is stored: cleaned, within its limit, not a shell line. Empty is allowed. */
function resumeText(raw: string): string {
  const text = cleaned(raw);
  if (text.length > RESUME_PROMPT_MAX) {
    throw invalid('The resume prompt is too long.', `It holds at most ${RESUME_PROMPT_MAX} characters.`);
  }
  if (text !== '') assertNotShellLine(typed(text));
  return text;
}

/** Sets the other automation fields: only those in `patch`, the rest of the record as it is. */
export function setAutomation(state: QueueState, patch: AutomationPatch, now: number): QueueChange<{ changed: string[] }> {
  const changed = Object.entries(patch).filter(([, value]) => value !== undefined).map(([field]) => field);
  if (changed.length === 0) throw invalid('Nothing to change.', 'Pass at least one automation field.');
  let next = wholeAutomation(state.automation);
  for (const field of FLAG_FIELDS) {
    if (patch[field] !== undefined) next = { ...next, [field]: patch[field] };
  }
  const retries = patch.resumeMaxRetries;
  if (retries !== undefined) {
    if (!(Number.isInteger(retries) && retries >= RESUME_RETRIES_RANGE.min && retries <= RESUME_RETRIES_RANGE.max)) {
      throw invalid('resumeMaxRetries is outside 1 to 10.', 'Pass a whole number from 1 to 10.');
    }
    next = { ...next, resumeMaxRetries: retries };
  }
  if (patch.resumePrompt !== undefined) next = { ...next, resumePrompt: resumeText(patch.resumePrompt) };
  if (patch.loopExcludeWindows !== undefined) {
    const windows = storedWindows(patch.loopExcludeWindows, now);
    next = windows.length === 0 ? without(next, 'loopExcludeWindows') : { ...next, loopExcludeWindows: windows };
  }
  return { ...automationChange(state, next), result: { changed } };
}

// ---------------------------------------------------------------------------
// Applying an op
// ---------------------------------------------------------------------------

const payloadSize = (items: readonly QueueItemLike[]): number => JSON.stringify(items).length;

/**
 * A queue the PUT route would refuse (over QUEUE_PAYLOAD_MAX) must not be written by a side door. A queue that is
 * already over (images the editor allowed) may still shrink.
 */
function mustFit(before: readonly QueueItemLike[], after: readonly QueueItemLike[]): void {
  const size = payloadSize(after);
  if (size > QUEUE_PAYLOAD_MAX && size > payloadSize(before)) {
    throw invalid('This queue is too large to sync.', 'Remove prompts that are no longer needed first.');
  }
}

/**
 * Reads the session's stored queue, applies `op` and writes the result, as ONE synchronous call: nothing can run
 * between the read and the write, so an edit the window saved a moment earlier is part of what `op` is given. When `op`
 * refuses, nothing is written. Answers the change, for the caller to describe.
 */
export function applyQueueOp<R>(store: QueueStore, sessionId: string, op: QueueOp<R>, originClientId: string): QueueChange<R> {
  const row = store.read(sessionId);
  const change = op({ items: row.items, automation: row.automation });
  mustFit(row.items, change.items);
  store.write(sessionId, change.items, change.automation, originClientId);
  return change;
}
