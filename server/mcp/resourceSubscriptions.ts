// resourceSubscriptions.ts — resources/subscribe for one MCP session: which resources its central follows, and the
// `notifications/resources/updated` sent when one of them changes.
//
// A central may follow only what it could read. A subscription is checked as a read is (the URI names a resource it
// is offered, its arguments pass the tool's own input check, and a session it names resolves in its scope), and
// refused the way the read would be refused. The session a URI names is resolved to its whole id then, so the
// notification can go out under the URI exactly as the central wrote it, short id and all.
//
// Changes come from the broadcast feed, through the event hub the tools share (`deps.events`), which is attached
// only while something is followed. Each broadcast says which URIs it touches (the table in resourceDefs.ts), and
// each URI answers to the scope rule of its kind:
//   session  the broadcast is about the session the URI names, and that session is in scope now (a removal also
//            counts when it was in scope a moment ago: the store no longer holds it, so scope cannot be asked);
//   scope    the session it is about is in scope now, or was: the list gained or lost it;
//   account  no session decides: snippets, plan usage.
// "A moment ago" is the scope as of the previous broadcast looked at, kept per MCP session; a new subscription adds
// the scope as it is then to it, so a session that joined the scope since, and is now followed, is remembered.
//
// A burst is one notification: the first change to a URI starts a window of `debounceMs` (500 ms), and what comes
// within it rides on the notification sent when the window ends. A URI never waits longer than that, however busy
// its session is. Everything stops when the MCP session closes (`close`).
//
// A session that is removed is gone for good: once its removal is told (the one notification `aasc://sessions/{id}`
// is promised), every subscription bound to it is dropped, so a central that followed it does not keep slots of the
// cap for what can never be read again.
//
// A session that is re-keyed (a worker's /clear, a resume, a terminal's first hook) is the same session under a new
// id, and keeps its subscriptions: the `session_update` that tells of it names the id it replaces
// (`session.replacesId`), and what was bound to that id is bound to the new one from then on. The URI is still told
// as the central wrote it, and the scope is asked again at every notification, for the new id, as ever.
//
// Plan usage rides every session update but changes rarely, so a subscriber to it is told only of a report newer than
// the newest it has seen. What it could already have read, in the store when it subscribed, counts as seen.
//
// A notification names nothing but the URI. The broadcasts' own content (a queue update carries the queue's prompt
// text) is never read here.

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import { contextFor, neverAborted } from './callContext.js';
import type { BroadcastMessage } from './events.js';
import type { OfferedResource, ResourceDef } from './resourceDefs.js';
import { checkedArgs, parseResourceUri } from './resourceUri.js';
import type { McpDeps } from './server.js';
import { isRecord, resolveTarget } from './tools/define.js';
import { ToolError } from './types.js';

/** How long a burst of changes to one resource waits before it is sent as one notification. */
export const RESOURCE_UPDATE_DEBOUNCE_MS = 500;

/** How many resources one MCP session may follow. A runaway client cannot grow this book without bound. */
export const MAX_SUBSCRIPTIONS = 100;

/** A hook may name a session with any text up to this long; a longer id in a broadcast is not one. */
const SESSION_ID_MAX = 256;

const EMPTY: ReadonlySet<string> = new Set();

interface Subscription {
  /** The URI as the central wrote it: what the notification names. */
  uri: string;
  offered: OfferedResource;
  /** The whole id of the session the URI names; null for a resource that is not about one. */
  sessionId: string | null;
  /**
   * For a stamped resource (plan usage): the newest report this subscription has been told of or could have read,
   * by key (the CLI). Each subscription keeps its own, so the same resource under another spelling is told too.
   */
  seen: Map<string, number>;
}

export interface ResourceSubscriptionOptions {
  centralId: string;
  deps: McpDeps;
  /** The resources this central is offered. */
  offered: readonly OfferedResource[];
  /** Sends `notifications/resources/updated` for a URI. May throw: the book logs it and carries on. */
  notify(uri: string): void;
  debounceMs?: number;
}

export interface ResourceSubscriptions {
  /** Follows a resource. Throws a ToolError when the central could not read it. Following one twice is following it once. */
  subscribe(uri: string): Promise<void>;
  /** Stops following a resource, and drops the notification waiting for it. Not following it is not an error. */
  unsubscribe(uri: string): void;
  /** How many resources are followed. */
  count(): number;
  /** Ends everything: the notifications waiting, the feed, the subscriptions. Nothing can be followed after it. */
  close(): void;
}

/** The session a broadcast is about: the one inside a session update, else its `sessionId`; null when it names none. */
function aboutSession(message: BroadcastMessage): string | null {
  const raw =
    message.type === 'session_update'
      ? isRecord(message.session)
        ? message.session.sessionId
        : undefined
      : message.sessionId;
  return typeof raw === 'string' && raw !== '' && raw.length <= SESSION_ID_MAX ? raw : null;
}

/**
 * The id a session update says its card replaces (it was re-keyed, and this is the id it had); null when the broadcast is
 * not a session update, or names none. It is only ever compared with the ids subscriptions are bound to, so what it
 * holds needs no more checking than being text.
 */
function replacedId(message: BroadcastMessage): string | null {
  if (message.type !== 'session_update' || !isRecord(message.session)) return null;
  const raw = message.session.replacesId;
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

/**
 * What a subscriber to a stamped resource could already have read when it subscribed: the newest report of each key
 * (plan usage, by CLI) among every session in the store. Plan usage is account-wide, so every session counts, in scope
 * or not, as it does for the tool. Empty for a resource that is not stamped.
 */
function reportsHeld(def: ResourceDef, sessions: readonly Session[]): Map<string, number> {
  const held = new Map<string, number>();
  if (def.stamp === undefined) return held;
  for (const session of sessions) {
    const report = def.stamp(session);
    if (report !== null && report.at > (held.get(report.key) ?? Number.NEGATIVE_INFINITY)) {
      held.set(report.key, report.at);
    }
  }
  return held;
}

/** Does a broadcast of this type, about this session, reach a subscriber? See the scope rules above. */
function reaches(
  sub: Subscription,
  type: string,
  about: string | null,
  scope: ReadonlySet<string>,
  before: ReadonlySet<string>,
): boolean {
  switch (sub.offered.def.follows) {
    case 'account':
      return true;
    case 'scope':
      return about !== null && (scope.has(about) || before.has(about));
    case 'session':
      if (about === null || about !== sub.sessionId) return false;
      return scope.has(about) || (type === 'session_removed' && before.has(about));
  }
}

export function createResourceSubscriptions(
  options: ResourceSubscriptionOptions,
): ResourceSubscriptions {
  const { centralId, deps, offered, notify } = options;
  const delay = options.debounceMs ?? RESOURCE_UPDATE_DEBOUNCE_MS;
  const subscriptions = new Map<string, Subscription>();
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  /** URIs of a removed session whose subscription goes as soon as the notification waiting for it has been sent. */
  const leaving = new Set<string>();
  let stopFeed: (() => void) | null = null;
  /** The sessions in the central's scope as of the last broadcast looked at (and every subscription since). */
  let scopeBefore: ReadonlySet<string> | null = null;
  let closed = false;

  /** The sessions in scope now, by the context a tool call gets; null when the central is gone. */
  function scopeNow(): ReadonlySet<string> | null {
    try {
      return new Set(
        contextFor(centralId, deps, neverAborted)
          .scopedSessions()
          .map((s) => s.sessionId),
      );
    } catch (err) {
      log.debug(
        'mcp',
        `Central ${centralId}: scope not read for a resource update: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * A stamped resource is news to a subscription only when the report the updated session carries is newer than the
   * newest that subscription has seen for the same key. Nothing else is: a broadcast with no report tells it nothing.
   */
  function isNews(sub: Subscription, message: BroadcastMessage): boolean {
    const { stamp } = sub.offered.def;
    if (stamp === undefined) return true;
    const report =
      message.type === 'session_update' && isRecord(message.session)
        ? stamp(message.session)
        : null;
    if (report === null) return false;
    const last = sub.seen.get(report.key);
    if (last !== undefined && report.at <= last) return false;
    sub.seen.set(report.key, report.at);
    return true;
  }

  /** Starts the window for a URI, unless one is open: what changes within it rides on the notification that ends it. */
  function schedule(uri: string): void {
    if (waiting.has(uri)) return;
    const timer = setTimeout(() => {
      waiting.delete(uri);
      if (closed || !subscriptions.has(uri)) return;
      try {
        notify(uri);
      } catch (err) {
        log.debug(
          'mcp',
          `Central ${centralId}: a resource update was not sent: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      // The session this URI is bound to was removed: that was the notification, and nothing is left to follow.
      if (leaving.delete(uri)) unsubscribe(uri);
    }, delay);
    // A pending notification never keeps the process alive on its own.
    timer.unref?.();
    waiting.set(uri, timer);
  }

  /** Schedules the notifications a broadcast is owed, and remembers the scope it looked at. */
  function tell(message: BroadcastMessage, about: string | null): void {
    const hits = [...subscriptions.values()].filter((sub) =>
      sub.offered.def.updatesOn.includes(message.type),
    );
    if (hits.length === 0) return;
    const needsScope = hits.some((sub) => sub.offered.def.follows !== 'account');
    let scope: ReadonlySet<string> = EMPTY;
    if (needsScope) {
      const now = scopeNow();
      if (now === null) return;
      scope = now;
    }
    const before = scopeBefore ?? scope;
    for (const sub of hits) {
      if (isNews(sub, message) && reaches(sub, message.type, about, scope, before))
        schedule(sub.uri);
    }
    if (needsScope) scopeBefore = scope;
  }

  /**
   * A session was removed: it is gone for good, so nothing bound to it is followed any more, and its subscriptions
   * no longer hold slots of the cap. The one notification its removal is owed to `aasc://sessions/{id}`, if it waits,
   * is still sent; that subscription goes after it. The others go at once, with what they were waiting to say.
   */
  function forget(sessionId: string): void {
    for (const sub of [...subscriptions.values()]) {
      if (sub.sessionId !== sessionId) continue;
      if (waiting.has(sub.uri) && sub.offered.def.updatesOn.includes('session_removed')) {
        leaving.add(sub.uri);
      } else {
        unsubscribe(sub.uri);
      }
    }
  }

  /**
   * A card was re-keyed: what was bound to its old id is bound to the new one, so the URI the central wrote keeps its
   * meaning. Done before the broadcast is looked at, so the re-key itself reaches a subscription that follows the card.
   * It widens nothing: whether the new id is in scope is asked at every notification, as for any id.
   */
  function followReKey(message: BroadcastMessage, about: string | null): void {
    const replaced = replacedId(message);
    if (replaced === null || about === null || replaced === about) return;
    for (const sub of [...subscriptions.values()]) {
      if (sub.sessionId === replaced) subscriptions.set(sub.uri, { ...sub, sessionId: about });
    }
  }

  function react(message: BroadcastMessage): void {
    const about = aboutSession(message);
    followReKey(message, about);
    tell(message, about);
    if (message.type === 'session_removed' && about !== null) forget(about);
  }

  function onBroadcast(message: BroadcastMessage): void {
    if (closed) return;
    try {
      react(message);
    } catch (err) {
      log.warn(
        'mcp',
        `Central ${centralId}: a broadcast was not followed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Nothing is followed any more: the feed is let go, and what was remembered of it forgotten. */
  function release(): void {
    stopFeed?.();
    stopFeed = null;
    scopeBefore = null;
  }

  async function subscribe(uri: string): Promise<void> {
    if (closed)
      throw new ToolError('UNAVAILABLE', 'This MCP session is closed.', 'Open a new one.');
    const { offered: found, vars } = parseResourceUri(offered, uri);
    await checkedArgs(found, vars);
    // The session closed while the arguments were being checked: nothing may be left behind.
    if (closed)
      throw new ToolError('UNAVAILABLE', 'This MCP session is closed.', 'Open a new one.');
    const ctx = contextFor(centralId, deps, neverAborted);
    const sessionId =
      found.def.follows === 'session' ? resolveTarget(ctx, vars.id).sessionId : null;
    if (!subscriptions.has(uri) && subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new ToolError(
        'INVALID',
        `One MCP session follows at most ${MAX_SUBSCRIPTIONS} resources.`,
        'Unsubscribe from some first.',
      );
    }
    // What can fail comes first, so a failure leaves nothing subscribed; then the book changes. The scope as it is now
    // joins what the book remembers of it: a session that came into scope since the last look is followed from here.
    const scopeAtStart = new Set([
      ...(scopeBefore ?? []),
      ...ctx.scopedSessions().map((s) => s.sessionId),
    ]);
    const seen = reportsHeld(found.def, ctx.sessions());
    const feed = stopFeed ?? deps.events.on(onBroadcast);
    subscriptions.set(uri, { uri, offered: found, sessionId, seen });
    leaving.delete(uri);
    scopeBefore = scopeAtStart;
    stopFeed = feed;
    log.debug('mcp', `Central ${centralId} follows ${found.def.name}`);
  }

  function unsubscribe(uri: string): void {
    if (!subscriptions.delete(uri)) return;
    leaving.delete(uri);
    const timer = waiting.get(uri);
    if (timer !== undefined) clearTimeout(timer);
    waiting.delete(uri);
    if (subscriptions.size === 0) release();
  }

  function close(): void {
    closed = true;
    for (const timer of waiting.values()) clearTimeout(timer);
    waiting.clear();
    leaving.clear();
    subscriptions.clear();
    release();
  }

  return { subscribe, unsubscribe, count: () => subscriptions.size, close };
}
