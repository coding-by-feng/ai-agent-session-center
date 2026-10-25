// notices.ts — the typed notices (Ruling P5-13): one line AASC types into an idle central about what happened while it
// waited. Claude Code has no `--channels` (P0), so this is the spec's typed-notice fallback.
//
// Two kinds of event are collected per central:
//   - a task of its own reaching done, failed or cancelled (the ledger's changes);
//   - one of its confirmations answered (allowed, denied or expired) after its first call had already answered
//     NEEDS_CONFIRMATION (`decidedAt − createdAt ≥ ASK_WAIT_MS`). A withdrawn one is not: its central has left. One
//     allowed and then carried out (`consumed`, or forgotten by the book) is dropped when the batch is built.
//
// Every NOTICE_TICK_MS a central with something to tell is typed one line, only when all of these hold, in this order:
//   1. `mcp.notices` is on (`on()`; default off, Ruling P5-19: a notice starts a paid model turn nobody asked for);
//   2. its card is in its own terminal, `idle` or `waiting` for NOTICE_IDLE_MS (its `lastActivityAt`), started
//      (`startPending`), with no open dialog (`waitsOnPerson`), not hands-off, and not held by the person's Esc;
//   3. its card holds no task (a child central's handed-down task would be failed by a stray prompt, Ruling 46);
//   4. no person input since its last Stop (heard here, per terminal), and none in NOTICE_GAP_MS: a draft is never sent;
//   5. its queue holds no prompt switched on while auto-send is on, or not stored (the window's default is on; an
//      unreadable queue holds it too);
//   6. its last notice was NOTICE_GAP_MS ago or more.
//
// The line starts `[AASC · notice] ` (never `/` or `!`), lists at most NOTICE_MAX_ITEMS events ("and N more"), and is
// at most NOTICE_TEXT_MAX characters. It holds AASC's words, task ids, short session ids, tool names and the central's
// own confirmIds only, each checked against its shape: never a title, an answer, a cardId or text a session wrote.
// A batch is cleared once its submit is `submitted`. A submit that typed nothing is tried again at the next tick, at
// most NOTICE_TRIES times in all; one that typed text but was not taken is dropped at once (typing it again could
// double the line in the input box). Each line typed writes one activity row (`aasc_notice`, `write`).
//
// The box is pure apart from its timer: the store, the ledger, the book, the hooks, presence, the queue and the
// submitter are handed in (deliverWiring.ts), so the tests type into nothing.

import { randomUUID } from 'node:crypto';
import type { Session } from '../../src/types/session.js';
import { EVENT_TYPES } from '../constants.js';
import { startPending } from '../heardTerminals.js';
import type { HookSignal } from '../hookSignals.js';
import log from '../logger.js';
import type { PromptRequest, PromptResult } from '../promptSubmit.js';
import type { ActivityLog } from './activity.js';
import { resolveCentralSession, type CentralRegistry } from './centrals.js';
import { ASK_WAIT_MS, type ConfirmBook, type PendingConfirm } from './confirm.js';
import { isEscHeld } from './escHold.js';
import type { Ledger, TaskRecord } from './ledgerTypes.js';
import { hasEnabledItem } from './ownIdle.js';
import { MCP_CLIENT_PREFIX } from './policy.js';
import type { QueueItemLike } from './queueOps.js';
import { waitsOnPerson } from './tools/views.js';
import type { CentralRecord } from './types.js';
import type { WorkerController } from './workers.js';

/** How long the central's card must have been idle or waiting. */
export const NOTICE_IDLE_MS = 5_000;
/** The least time between two notices to one central, and since a person's last input. */
export const NOTICE_GAP_MS = 60_000;
export const NOTICE_MAX_ITEMS = 8;
export const NOTICE_TEXT_MAX = 1_000;
/** An event older than this is no longer news. */
export const NOTICE_ITEM_TTL_MS = 30 * 60_000;
export const NOTICE_TICK_MS = 2_000;
/** The most submits one batch gets. */
export const NOTICE_TRIES = 3;
/** The most events held per central (the line says "and N more" for those past NOTICE_MAX_ITEMS). */
const HELD_MAX = 64;
/** Task ids remembered as noticed, so a task's later changes are not noticed twice. */
const NOTED_MAX = 1_000;

const PREFIX = '[AASC · notice] ';
const OPENING = 'Since your last turn: ';
const CLOSING = '. If you already handled these, there is nothing to do.';
const TASK_ID = /^T\d{1,9}$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONFIRM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = new Set(['done', 'failed', 'cancelled']);
const IDLE = new Set(['idle', 'waiting']);
const TURN_OVER: ReadonlySet<string> = new Set([EVENT_TYPES.STOP, EVENT_TYPES.AGENT_TURN_COMPLETE]);

export interface NoticeDeps {
  registry: Pick<CentralRegistry, 'list' | 'byId'>;
  sessions(): readonly Session[];
  ledger: Pick<Ledger, 'onChange' | 'isLocked'>;
  confirms: Pick<ConfirmBook, 'onChange' | 'forCentral'>;
  onTerminalHook(terminalId: string, listener: (signal: HookSignal) => void): () => void;
  /** Who drove the session last (presence), or null. */
  controller(sessionId: string): WorkerController | null;
  readQueue(sessionId: string): Promise<{ items: readonly QueueItemLike[]; automation: unknown }>;
  submit(req: PromptRequest): Promise<PromptResult>;
  activity: Pick<ActivityLog, 'logActivity'>;
  /** `mcp.notices` (routerConfig.ts `noticesOn`). */
  on(): boolean;
  now(): number;
}

export interface NoticeBox {
  /** Looks at every central with something to tell, and types its line when it may. */
  tick(): Promise<void>;
  /** How many events wait for this central. */
  pending(centralId: string): number;
  close(): void;
}

type NoticeItem =
  | { readonly kind: 'task'; readonly taskId: string; readonly state: string; readonly session: string; readonly at: number }
  | { readonly kind: 'confirm'; readonly confirmId: string; readonly tool: string; readonly state: string; readonly at: number };

/** A session id as the notice names it: its first 8 letters and digits, or '' when it has none. */
const shortId = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);

function phrase(item: NoticeItem): string {
  if (item.kind === 'task') {
    const where = item.session === '' ? '' : ` in #${item.session}`;
    if (item.state === 'done') return `${item.taskId} done${where} (task_get ${item.taskId} has its answer)`;
    if (item.state === 'failed') return `${item.taskId} failed${where} (task_get ${item.taskId} says why)`;
    return `${item.taskId} was cancelled${where}`;
  }
  if (item.state === 'allowed') {
    return `the person allowed ${item.tool} (confirm_wait with confirmId ${item.confirmId} carries it out)`;
  }
  if (item.state === 'denied') return `the person said no to ${item.tool}`;
  return `the person did not answer ${item.tool} in time`;
}

/** The one line for these events: at most NOTICE_MAX_ITEMS listed, the rest counted, within NOTICE_TEXT_MAX. */
export function noticeText(items: readonly NoticeItem[]): string {
  for (let shown = Math.min(items.length, NOTICE_MAX_ITEMS); shown >= 1; shown -= 1) {
    const more = items.length - shown;
    const parts = items.slice(0, shown).map(phrase);
    const tail = more > 0 ? `; and ${more} more: task_list shows them` : '';
    const text = `${PREFIX}${OPENING}${parts.join('; ')}${tail}${CLOSING}`;
    if (text.length <= NOTICE_TEXT_MAX) return text;
  }
  return `${PREFIX}${OPENING}${items.length} events: task_list shows them${CLOSING}`;
}

export function createNoticeBox(deps: NoticeDeps): NoticeBox {
  // Central id → its events, oldest first; replaced, never edited.
  let held = new Map<string, readonly NoticeItem[]>();
  const noted = new Set<string>();
  const tries = new Map<string, number>();
  const lastNoticeAt = new Map<string, number>();
  const flushing = new Set<string>();
  // Terminal id → its hook subscription, and when it last ended a turn.
  const hooks = new Map<string, () => void>();
  const lastStopAt = new Map<string, number>();
  let closed = false;

  const add = (centralId: string, item: NoticeItem): void => {
    held = new Map(held).set(centralId, [...(held.get(centralId) ?? []), item].slice(-HELD_MAX));
  };

  const onTask = (t: TaskRecord): void => {
    if (closed || !deps.on() || !CLOSED.has(t.state) || !TASK_ID.test(String(t.taskId))) return;
    const key = `${t.centralId}|${t.taskId}`;
    if (noted.has(key)) return;
    noted.add(key);
    if (noted.size > NOTED_MAX) noted.delete(noted.values().next().value as string);
    add(t.centralId, { kind: 'task', taskId: t.taskId, state: t.state, session: shortId(String(t.sessionId)), at: deps.now() });
  };

  const onConfirm = (r: PendingConfirm): void => {
    if (closed || !deps.on() || r.withdrawn || r.state === 'pending' || r.decidedAt === null) return;
    if (r.decidedAt - r.createdAt < ASK_WAIT_MS || !CONFIRM_ID.test(r.confirmId)) return;
    const tool = TOOL_NAME.test(r.tool) ? r.tool : 'a tool';
    add(r.centralId, { kind: 'confirm', confirmId: r.confirmId, tool, state: r.state, at: deps.now() });
  };

  const stopLedger = deps.ledger.onChange(onTask);
  const stopConfirms = deps.confirms.onChange((e) => {
    if (e.kind === 'resolved') onConfirm(e.confirm);
  });

  /** One hook subscription per live central's terminal; the others' are ended, and their events dropped. */
  const syncCentrals = (centrals: readonly CentralRecord[]): void => {
    const terminals = new Set(centrals.map((c) => c.terminalId).filter((t): t is string => typeof t === 'string' && t !== ''));
    for (const terminalId of terminals) {
      if (hooks.has(terminalId)) continue;
      hooks.set(
        terminalId,
        deps.onTerminalHook(terminalId, (signal) => {
          if (TURN_OVER.has(signal.event)) lastStopAt.set(terminalId, deps.now());
        }),
      );
    }
    for (const [terminalId, stop] of hooks) {
      if (terminals.has(terminalId)) continue;
      stop();
      hooks.delete(terminalId);
      lastStopAt.delete(terminalId);
    }
    const ids = new Set(centrals.map((c) => c.centralId));
    held = new Map([...held].filter(([id]) => ids.has(id)));
  };

  /** Has a person given the card input since its last Stop, or been at it within NOTICE_GAP_MS? */
  const personThere = (card: Session): boolean => {
    const holder = deps.controller(card.sessionId);
    if (holder === null || holder.clientId.startsWith(MCP_CLIENT_PREFIX)) return false;
    if (deps.now() - holder.lastActivityAt < NOTICE_GAP_MS) return true;
    if (holder.lastInputAt === undefined) return false;
    const stop = card.terminalId ? lastStopAt.get(card.terminalId) : undefined;
    return stop === undefined || holder.lastInputAt > stop;
  };

  /** What may change between keystrokes: re-checked before each one (PromptRequest.mayDrive). */
  const stillClear = (card: Session): boolean =>
    card.handsOff !== true &&
    !isEscHeld(card.userCancelledAt, null) &&
    !deps.ledger.isLocked(card.sessionId) &&
    !personThere(card);

  /** The central's card when every condition but the queue's and the gap's holds; null otherwise. */
  const readyCard = (central: CentralRecord): Session | null => {
    const card = resolveCentralSession(central.centralId, deps.sessions());
    if (card === null || !central.terminalId || card.terminalId !== central.terminalId) return null;
    if (!IDLE.has(card.status) || deps.now() - card.lastActivityAt < NOTICE_IDLE_MS) return null;
    if (startPending(card) || waitsOnPerson(card)) return null;
    return stillClear(card) ? card : null;
  };

  const queueHolds = async (sessionId: string): Promise<boolean> => {
    try {
      const { items, automation } = await deps.readQueue(sessionId);
      // The window fills what is not stored from its defaults (queueStore DEFAULT_AUTOMATION: auto-send on), so
      // only an explicit `autoSend: false` says the queue will not send by itself.
      const stored = typeof automation === 'object' && automation !== null ? (automation as Record<string, unknown>) : {};
      return stored.autoSend !== false && hasEnabledItem(items);
    } catch {
      return true;
    }
  };

  /** The events still worth telling: young enough, and an allowed confirmation not yet carried out. */
  const liveItems = (centralId: string): readonly NoticeItem[] => {
    const now = deps.now();
    return (held.get(centralId) ?? []).filter((item) => {
      if (now - item.at > NOTICE_ITEM_TTL_MS) return false;
      if (item.kind !== 'confirm' || item.state !== 'allowed') return true;
      const record = deps.confirms.forCentral(item.confirmId, centralId);
      return record !== null && !record.consumed;
    });
  };

  const dropBatch = (centralId: string, batch: readonly NoticeItem[]): void => {
    const sent = new Set(batch);
    held = new Map(held).set(centralId, (held.get(centralId) ?? []).filter((item) => !sent.has(item)));
    tries.delete(centralId);
  };

  const flush = async (central: CentralRecord): Promise<void> => {
    const { centralId } = central;
    const batch = liveItems(centralId);
    held = new Map(held).set(centralId, batch);
    if (batch.length === 0) return;
    const card = readyCard(central);
    if (card === null || card.terminalId === null || (await queueHolds(card.sessionId))) return;
    const last = lastNoticeAt.get(centralId);
    if (last !== undefined && deps.now() - last < NOTICE_GAP_MS) return;
    const key = `notice-${randomUUID()}`;
    let result: PromptResult;
    try {
      result = await deps.submit({
        sessionId: card.sessionId,
        terminalId: card.terminalId,
        text: noticeText(batch),
        mode: 'now',
        mayDrive: (sessionId) => {
          const now = deps.sessions().find((s) => s.sessionId === sessionId);
          return now !== undefined && stillClear(now);
        },
      });
    } catch (err) {
      log.warn('mcp', `A notice could not be typed: ${err instanceof Error ? err.message : String(err)}`);
      result = { outcome: 'failed', typed: false };
    }
    if (result.outcome === 'submitted') {
      dropBatch(centralId, batch);
      lastNoticeAt.set(centralId, deps.now());
      deps.activity.logActivity({
        centralId,
        centralSessionId: card.sessionId,
        tool: 'aasc_notice',
        risk: 'write',
        targetSessionId: card.sessionId,
        summary: `AASC typed a notice of ${batch.length === 1 ? 'one event' : `${batch.length} events`} into the central's own session.`,
        outcome: 'ok',
        detail: { events: batch.length, key },
      });
      return;
    }
    const tried = (tries.get(centralId) ?? 0) + 1;
    tries.set(centralId, tried);
    if (result.typed || tried >= NOTICE_TRIES) {
      log.warn('mcp', `A notice of ${batch.length} event(s) was dropped after ${tried} tries (${result.outcome})`);
      dropBatch(centralId, batch);
    }
  };

  const tick = async (): Promise<void> => {
    if (closed || !deps.on()) return;
    const centrals = deps.registry.list();
    syncCentrals(centrals);
    await Promise.all(
      centrals
        .filter((c) => (held.get(c.centralId)?.length ?? 0) > 0 && !flushing.has(c.centralId))
        .map(async (c) => {
          flushing.add(c.centralId);
          try {
            await flush(c);
          } catch (err) {
            log.warn('mcp', `A notice check failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            flushing.delete(c.centralId);
          }
        }),
    );
  };

  const timer = setInterval(() => void tick(), NOTICE_TICK_MS);
  timer.unref?.();

  return {
    tick,
    pending: (centralId) => held.get(centralId)?.length ?? 0,
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stopLedger();
      stopConfirms();
      for (const stop of hooks.values()) stop();
      hooks.clear();
      held = new Map();
    },
  };
}
