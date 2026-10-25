// test/mcp/phoneConfirmRoutes.test.ts — a paired phone's side of a central's confirmation (server/mcp/phoneConfirmRoutes.ts,
// Ruling P5-15, Ruling P5-20): GET /api/phone-confirms, POST /api/phone-confirms/:cardId, and the `mcp_phone_confirm` /
// `mcp_phone_confirm_resolved` feed to remote devices.
//
// A phone answers only a tool whose route it could already call itself, on a card whose central's card AND target are
// shared with it, checked again when it answers. A central's own call is 403 before its body is read; anyone that is
// not a phone (the Mac included) is 404, and so is everyone with central sessions off. A phone never sees a confirmId,
// a fingerprint or the call's arguments.
//
// The router is mounted on a real Express app on an ephemeral port over a real confirmation book. The AASC server is
// never started and nothing here reaches a terminal or a process.
import { readFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_PHONE_CONFIRM, MCP_PHONE_CONFIRM_RESOLVED } from '../../src/types/mcpPhoneConfirm.js';
import type { Session } from '../../src/types/session.js';
import { CONFIRM_TTL_MS, confirms as serverBook, createConfirmBook, type ConfirmBook, type PendingConfirm } from '../../server/mcp/confirm.js';
import type { PushMessage } from '../../server/push/pushNotifier.js';
import { PHONE_ANSWERABLE, phoneMayAnswer } from '../../server/mcp/phoneAnswerable.js';
import {
  PHONE_FEED_RESYNC_MS,
  createPhoneConfirmRouter,
  isCentralRequest,
  startPhoneConfirmFeed,
  startServerPhoneConfirms,
  type PhoneConfirmDeps,
  type PhoneConfirmFeedMessage,
} from '../../server/mcp/phoneConfirmRoutes.js';
import log from '../../server/logger.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const SECRET_ARG = 'central-argument-91aa';
const SECRET_FINGERPRINT = 'term-w|pid-4242-fp';
const PHONE = { 'x-test-phone': 'phone-1' };
const CENTRAL_CALL = { 'x-aasc-client-id': 'mcp:central-1' };

interface World {
  shared: Set<string>;
  sessions: Map<string, Session>;
  enabled: { on: boolean };
}

const world = (): World => ({
  shared: new Set(['central-card', 'target-1']),
  sessions: new Map([
    ['central-card', makeSession('central-card')],
    ['target-1', makeSession('target-1')],
    ['target-2', makeSession('target-2')],
  ]),
  enabled: { on: true },
});

function depsOf(w: World, book: ConfirmBook): PhoneConfirmDeps {
  return {
    phoneOf: (req: Request) => {
      const raw = req.headers['x-test-phone'];
      return typeof raw === 'string' && raw !== '' ? raw : null;
    },
    isCentral: isCentralRequest,
    enabled: () => w.enabled.on,
    book,
    getSession: (id) => w.sessions.get(id) ?? null,
    centralCard: (centralId) => (centralId === 'central-1' ? (w.sessions.get('central-card') ?? null) : null),
    isShared: (id) => w.shared.has(id) && w.sessions.has(id),
  };
}

interface Rig {
  port: number;
  book: ConfirmBook;
  w: World;
}

let server: Server | undefined;
const books: ConfirmBook[] = [];

async function rig(): Promise<Rig> {
  const w = world();
  const book = createConfirmBook();
  books.push(book);
  const app = express();
  app.use('/api', createPhoneConfirmRouter(depsOf(w, book)));
  server = createServer(app);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, book, w };
}

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  for (const b of books.splice(0)) b.close();
  vi.useRealTimers();
});

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function call(port: number, method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => {
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, text, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const list = (r: Rig, headers: Record<string, string> = PHONE) => call(r.port, 'GET', '/api/phone-confirms', undefined, headers);
const answer = (r: Rig, cardId: string, decision: unknown, headers: Record<string, string> = PHONE) =>
  call(r.port, 'POST', `/api/phone-confirms/${encodeURIComponent(cardId)}`, JSON.stringify({ decision }), headers);

const open = (book: ConfirmBook, over: { tool?: string; targetSessionId?: string | null; centralId?: string } = {}): PendingConfirm =>
  book.open({
    centralId: over.centralId ?? 'central-1',
    tool: over.tool ?? 'session_kill',
    risk: 'destructive',
    args: { sessionId: 'target-1', secret: SECRET_ARG },
    summary: 'Kill a session',
    detail: null,
    targetSessionId: over.targetSessionId === undefined ? 'target-1' : over.targetSessionId,
    fingerprint: SECRET_FINGERPRINT,
  });

describe('one phone rule (D-2)', () => {
  it('phoneConfirmRoutes.ts keeps no copy of the table or the rule: it imports phoneAnswerable.ts', async () => {
    const source = await readFile(new URL('../../server/mcp/phoneConfirmRoutes.ts', import.meta.url), 'utf8');
    expect(source).toContain("from './phoneAnswerable.js'");
    expect(source).not.toMatch(/new Map<string, PhoneAnswerable>|function shareable|function phoneMayAnswer|export const PHONE_ANSWERABLE/);
  });
});

describe('PHONE_ANSWERABLE', () => {
  it('lists the tools a phone could do itself, and none of the Mac-only ones', () => {
    expect([...PHONE_ANSWERABLE.keys()].sort()).toEqual(
      [
        'note_delete',
        'queue_clear',
        'session_close',
        'session_interrupt',
        'session_kill',
        'session_restart',
        'snippet_create',
        'snippet_delete',
        'snippet_rename',
      ].sort(),
    );
    for (const macOnly of ['session_set_shared', 'resource_uninstall', 'history_delete', 'agenda_delete', 'resource_restore']) {
      expect(PHONE_ANSWERABLE.has(macOnly)).toBe(false);
    }
  });
});

describe('phoneMayAnswer', () => {
  it('needs the tool, a shared central card and a shared target', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const deps = depsOf(w, book);
    expect(phoneMayAnswer(open(book), deps)).toBe(true);
    expect(phoneMayAnswer(open(book, { tool: 'resource_uninstall' }), deps)).toBe(false);
    expect(phoneMayAnswer(open(book, { targetSessionId: 'target-2' }), deps)).toBe(false);
    expect(phoneMayAnswer(open(book, { centralId: 'central-9' }), deps)).toBe(false);
  });

  it('a session tool with no target is not answerable; a snippet tool with none is', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const deps = depsOf(w, book);
    expect(phoneMayAnswer(open(book, { targetSessionId: null }), deps)).toBe(false);
    expect(phoneMayAnswer(open(book, { tool: 'snippet_delete', targetSessionId: null }), deps)).toBe(true);
  });

  it('a decided card is not answerable', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const r = open(book);
    const decided = book.answer(r.cardId, 'deny');
    expect(phoneMayAnswer(decided as PendingConfirm, depsOf(w, book))).toBe(false);
  });
});

describe('GET /api/phone-confirms', () => {
  it('lists the phone-answerable cards only, as views', async () => {
    const r = await rig();
    const ok = open(r.book);
    open(r.book, { tool: 'history_delete' });
    open(r.book, { targetSessionId: 'target-2' });
    const res = await list(r);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.confirms.map((c: { cardId: string }) => c.cardId)).toEqual([ok.cardId]);
    expect(Object.keys(res.body.confirms[0]).sort()).toEqual(
      ['cardId', 'centralId', 'createdAt', 'detail', 'expiresAt', 'risk', 'summary', 'targetSessionId', 'tool'].sort(),
    );
  });

  it('says the Mac’s time with the list, so a phone counts each card’s time left on its own clock (D-9)', async () => {
    const r = await rig();
    open(r.book);
    const before = Date.now();
    const res = await list(r);
    expect(Object.keys(res.body).sort()).toEqual(['confirms', 'now', 'ok']);
    expect(res.body.now).toBeGreaterThanOrEqual(before);
    expect(res.body.now).toBeLessThanOrEqual(Date.now());
  });

  it('a card whose central’s card is not shared is not listed', async () => {
    const r = await rig();
    open(r.book);
    r.w.shared.delete('central-card');
    expect((await list(r)).body.confirms).toEqual([]);
  });

  it('the Mac (no phone) is 404', async () => {
    const r = await rig();
    open(r.book);
    const res = await list(r, {});
    expect(res.status).toBe(404);
    expect(res.text).not.toContain('Kill');
  });

  it('an mcp: caller is 403', async () => {
    const r = await rig();
    expect((await list(r, { ...PHONE, ...CENTRAL_CALL })).status).toBe(403);
    expect((await list(r, { 'x-aasc-client-id': 'MCP:central-1' })).status).toBe(403);
  });

  it('mcp.enabled false is 404', async () => {
    const r = await rig();
    r.w.enabled.on = false;
    expect((await list(r)).status).toBe(404);
  });
});

describe('POST /api/phone-confirms/:cardId', () => {
  it('allow and deny answer 200 with the state; a second answer is 409; expired is 404', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const r = await rig();
    const a = open(r.book);
    const b = open(r.book, { tool: 'queue_clear' });
    const c = open(r.book, { tool: 'snippet_delete', targetSessionId: null });
    const allowed = await answer(r, a.cardId, 'allow');
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ ok: true, state: 'allowed' });
    expect(r.book.forCentral(a.confirmId, 'central-1')).toMatchObject({ state: 'allowed', answeredOn: 'phone' });
    const denied = await answer(r, b.cardId, 'deny');
    expect(denied.body).toEqual({ ok: true, state: 'denied' });
    const again = await answer(r, a.cardId, 'deny');
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ ok: false, error: 'already-answered' });
    expect(r.book.forCentral(a.confirmId, 'central-1')?.state).toBe('allowed');
    vi.advanceTimersByTime(CONFIRM_TTL_MS + 1);
    expect((await answer(r, c.cardId, 'allow')).status).toBe(404);
  });

  it('the answer’s log line names the phone by 8 characters of its device id, and nothing more (D-5)', async () => {
    const info = vi.mocked(log.info);
    info.mockClear();
    const r = await rig();
    const card = open(r.book);
    const device = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    expect((await answer(r, card.cardId, 'allow', { 'x-test-phone': device })).status).toBe(200);
    const lines = info.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('on a phone'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('(device a1b2c3d4)');
    expect(lines[0]).not.toContain(device.slice(8));
    expect(lines[0]).not.toContain(card.cardId);
    expect(lines[0]).not.toContain(card.confirmId);
  });

  it('an unknown card is 404', async () => {
    const r = await rig();
    expect((await answer(r, 'no-such-card', 'allow')).status).toBe(404);
    expect((await answer(r, 'x'.repeat(65), 'allow')).status).toBe(404);
  });

  it('a card whose target is not shared is neither sent nor answerable', async () => {
    const r = await rig();
    const card = open(r.book, { targetSessionId: 'target-2' });
    const sent: PhoneConfirmFeedMessage[] = [];
    const stop = startPhoneConfirmFeed(r.book, { ...depsOf(r.w, r.book), broadcastByLocality: (_l, m) => sent.push(m) });
    open(r.book, { targetSessionId: 'target-2' });
    expect(sent).toEqual([]);
    expect((await answer(r, card.cardId, 'allow')).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
    stop();
  });

  it('a card whose central’s card is not shared is neither', async () => {
    const r = await rig();
    r.w.shared.delete('central-card');
    const sent: PhoneConfirmFeedMessage[] = [];
    const stop = startPhoneConfirmFeed(r.book, { ...depsOf(r.w, r.book), broadcastByLocality: (_l, m) => sent.push(m) });
    const card = open(r.book);
    expect(sent).toEqual([]);
    expect((await answer(r, card.cardId, 'allow')).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
    stop();
  });

  it('a Mac-only tool’s card is 404 to a phone', async () => {
    const r = await rig();
    for (const tool of ['session_set_shared', 'resource_uninstall', 'history_delete', 'agenda_delete']) {
      const card = open(r.book, { tool });
      expect((await answer(r, card.cardId, 'allow')).status, tool).toBe(404);
      expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
      r.book.answer(card.cardId, 'deny');
    }
  });

  it('a Mac-only card already answered is still 404, never 409', async () => {
    const r = await rig();
    const card = open(r.book, { tool: 'history_delete' });
    r.book.answer(card.cardId, 'deny');
    expect((await answer(r, card.cardId, 'allow')).status).toBe(404);
  });

  it('a session unshared after the card opened makes its answer 404', async () => {
    const r = await rig();
    const card = open(r.book);
    expect((await list(r)).body.confirms).toHaveLength(1);
    r.w.shared.delete('target-1');
    expect((await answer(r, card.cardId, 'allow')).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('an mcp: caller is 403 before the body is read', async () => {
    const r = await rig();
    const card = open(r.book);
    const res = await call(r.port, 'POST', `/api/phone-confirms/${card.cardId}`, '{not json', { ...PHONE, ...CENTRAL_CALL });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('central-1');
    expect((await answer(r, card.cardId, 'allow', { ...PHONE, ...CENTRAL_CALL })).status).toBe(403);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('the Mac (no phone) is 404', async () => {
    const r = await rig();
    const card = open(r.book);
    expect((await answer(r, card.cardId, 'allow', {})).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('mcp.enabled false is 404', async () => {
    const r = await rig();
    const card = open(r.book);
    r.w.enabled.on = false;
    expect((await answer(r, card.cardId, 'allow')).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('a bad body is 400 and changes nothing', async () => {
    const r = await rig();
    const card = open(r.book);
    expect((await call(r.port, 'POST', `/api/phone-confirms/${card.cardId}`, '{not json', PHONE)).status).toBe(400);
    expect((await answer(r, card.cardId, 'maybe')).status).toBe(400);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });

  it('the central’s own confirmId is no card id', async () => {
    const r = await rig();
    const card = open(r.book);
    expect((await answer(r, card.confirmId, 'allow')).status).toBe(404);
    expect(r.book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
  });
});

describe('startPhoneConfirmFeed', () => {
  function feed(w: World, book: ConfirmBook) {
    const sent: Array<[null, PhoneConfirmFeedMessage]> = [];
    const stop = startPhoneConfirmFeed(book, {
      ...depsOf(w, book),
      broadcastByLocality: (local, remote) => {
        sent.push([local, remote]);
      },
    });
    return { sent, stop };
  }

  it('the feed sends to remote clients only (local null)', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop } = feed(w, book);
    const card = open(book);
    book.answer(card.cardId, 'allow');
    expect(sent).toHaveLength(2);
    for (const [local] of sent) expect(local).toBeNull();
    expect(sent[0][1]).toMatchObject({ type: MCP_PHONE_CONFIRM, confirm: { cardId: card.cardId, tool: 'session_kill' } });
    expect(sent[1][1]).toEqual({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: card.cardId, state: 'allowed' });
    stop();
  });

  it('a resolution is sent only for cards the feed sent', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop } = feed(w, book);
    const macOnly = open(book, { tool: 'agenda_delete' });
    const hidden = open(book, { targetSessionId: 'target-2' });
    book.answer(macOnly.cardId, 'deny');
    book.answer(hidden.cardId, 'allow');
    expect(sent).toEqual([]);
    stop();
    const card = open(book);
    expect(sent).toEqual([]);
    book.answer(card.cardId, 'deny');
  });

  it('a withdrawn card is sent as denied, and expiry as expired', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop } = feed(w, book);
    open(book);
    book.forgetCentral('central-1');
    const later = open(book);
    vi.advanceTimersByTime(CONFIRM_TTL_MS + 1);
    const states = sent.filter(([, m]) => m.type === MCP_PHONE_CONFIRM_RESOLVED).map(([, m]) => (m as { state: string }).state);
    expect(states).toEqual(['denied', 'expired']);
    expect(sent.some(([, m]) => m.type === MCP_PHONE_CONFIRM && m.confirm.cardId === later.cardId)).toBe(true);
    stop();
  });

  /** A feed on a fake broadcast feed (wsManager's `onBroadcast` shape), so a test can say a session changed. */
  function feedOnBroadcasts(w: World, book: ConfirmBook) {
    const sent: PhoneConfirmFeedMessage[] = [];
    const listeners = new Set<(m: { type: string; [key: string]: unknown }) => void>();
    const stop = startPhoneConfirmFeed(book, {
      ...depsOf(w, book),
      broadcastByLocality: (_local, remote) => {
        sent.push(remote);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const emit = (m: { type: string; [key: string]: unknown }): void => {
      for (const l of listeners) l(m);
    };
    return { sent, stop, emit, listeners };
  }

  it('a card whose target is unshared mid-card is withdrawn from the phones (D-1)', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop, emit } = feedOnBroadcasts(w, book);
    const card = open(book);
    expect(sent.map((m) => m.type)).toEqual([MCP_PHONE_CONFIRM]);
    w.shared.delete('target-1');
    emit({ type: 'session_update', session: { ...makeSession('target-1'), remoteVisible: false } });
    expect(sent[1]).toEqual({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: card.cardId, state: 'denied' });
    expect(JSON.stringify(sent[1])).not.toContain(card.confirmId);
    // Withdrawn once: its later answer on the Mac is not sent again, and the card stays pending for the Mac.
    emit({ type: 'session_update', session: makeSession('target-1') });
    expect(book.forCentral(card.confirmId, 'central-1')?.state).toBe('pending');
    book.answer(card.cardId, 'deny');
    expect(sent).toHaveLength(2);
    stop();
  });

  it('a card whose central’s card is unshared, or removed, is withdrawn too', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop, emit } = feedOnBroadcasts(w, book);
    const card = open(book);
    w.sessions.delete('central-card');
    emit({ type: 'session_removed', sessionId: 'central-card' });
    expect(sent.map((m) => m.type)).toEqual([MCP_PHONE_CONFIRM, MCP_PHONE_CONFIRM_RESOLVED]);
    expect(sent[1]).toMatchObject({ cardId: card.cardId });
    book.answer(card.cardId, 'deny');
    stop();
  });

  it('a card whose target is shared after it opened is sent then, and its answer follows (the reverse)', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop, emit } = feedOnBroadcasts(w, book);
    const card = open(book, { targetSessionId: 'target-2' });
    expect(sent).toEqual([]);
    w.shared.add('target-2');
    emit({ type: 'session_update', session: { ...makeSession('target-2'), remoteVisible: true } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: MCP_PHONE_CONFIRM, confirm: { cardId: card.cardId } });
    // Sent once, however many updates follow.
    emit({ type: 'session_update', session: makeSession('target-2') });
    expect(sent).toHaveLength(1);
    book.answer(card.cardId, 'allow');
    expect(sent[1]).toEqual({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: card.cardId, state: 'allowed' });
    stop();
  });

  it('an unshare that sends no broadcast (PUT remote-visible) is still caught by the resync', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop } = feedOnBroadcasts(w, book);
    const card = open(book);
    w.shared.delete('target-1');
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(PHONE_FEED_RESYNC_MS);
    expect(sent[1]).toEqual({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: card.cardId, state: 'denied' });
    book.answer(card.cardId, 'deny');
    stop();
  });

  it('other broadcasts change nothing, and stop() ends the subscription and the resync', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const { sent, stop, emit, listeners } = feedOnBroadcasts(w, book);
    open(book);
    w.shared.delete('target-1');
    emit({ type: 'hook_stats' });
    expect(sent).toHaveLength(1);
    stop();
    expect(listeners.size).toBe(0);
    vi.advanceTimersByTime(PHONE_FEED_RESYNC_MS * 3);
    expect(sent).toHaveLength(1);
  });

  it('a broadcast that throws breaks nothing', () => {
    const w = world();
    const book = createConfirmBook();
    books.push(book);
    const stop = startPhoneConfirmFeed(book, {
      ...depsOf(w, book),
      broadcastByLocality: () => {
        throw new Error('socket gone');
      },
    });
    expect(() => open(book)).not.toThrow();
    stop();
  });
});

describe('no confirmId or fingerprint in any phone view or feed', () => {
  it('holds for the list, the answer and both feed messages', async () => {
    const r = await rig();
    const sent: PhoneConfirmFeedMessage[] = [];
    const stop = startPhoneConfirmFeed(r.book, { ...depsOf(r.w, r.book), broadcastByLocality: (_l, m) => sent.push(m) });
    const card = open(r.book);
    const listed = await list(r);
    const answered = await answer(r, card.cardId, 'allow');
    const all = [listed.text, answered.text, JSON.stringify(sent)].join('\n');
    expect(sent).toHaveLength(2);
    expect(all).not.toContain(card.confirmId);
    expect(all).not.toContain(SECRET_FINGERPRINT);
    expect(all).not.toContain(SECRET_ARG);
    expect(all).not.toMatch(/"confirmId"|"fingerprint"|"args"/);
    stop();
  });
});

describe('startServerPhoneConfirms', () => {
  it('feeds and pushes a shared card from the server’s book, and close() stops both', async () => {
    const central = {
      ...makeSession('c0ffee00-1111-4222-8333-444455556666', { remoteVisible: true, title: 'Central' }),
      central: { centralId: 'central-77', kind: 'global', scopeRef: null },
    } as Session;
    const target = makeSession('target-77', { remoteVisible: true });
    const byId = new Map([
      [central.sessionId, central],
      [target.sessionId, target],
    ]);
    const sent: Array<[null, PhoneConfirmFeedMessage]> = [];
    const pushed: PushMessage[] = [];
    const listeners = new Set<(m: { type: string; [key: string]: unknown }) => void>();
    const router = startServerPhoneConfirms({
      phoneOf: () => null,
      getSession: (id) => byId.get(id) ?? null,
      sessions: () => [...byId.values()],
      broadcastByLocality: (local, remote) => {
        sent.push([local, remote]);
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sink: () => ({
        notify: async (m) => {
          pushed.push(m);
        },
      }),
      onError: () => undefined,
    });
    const card = serverBook.open({
      centralId: 'central-77',
      tool: 'session_kill',
      risk: 'destructive',
      args: { sessionId: 'target-77' },
      summary: 'Kill a session',
      targetSessionId: 'target-77',
    });
    try {
      expect(sent).toHaveLength(1);
      expect(sent[0][0]).toBeNull();
      expect(pushed).toHaveLength(1);
      expect(pushed[0].sessionRef).toBe(central.sessionId);
      // The target unshared: the broadcast it hears withdraws the card from the phones.
      byId.set(target.sessionId, { ...target, remoteVisible: false });
      for (const l of listeners) l({ type: 'session_update', session: byId.get(target.sessionId) });
      expect(sent[1]?.[1]).toEqual({ type: MCP_PHONE_CONFIRM_RESOLVED, cardId: card.cardId, state: 'denied' });
      router.close();
      expect(listeners.size).toBe(0);
      serverBook.answer(card.cardId, 'deny');
      expect(sent).toHaveLength(2);
    } finally {
      router.close();
      serverBook.answer(card.cardId, 'deny');
    }
  });
});

describe('server/index.ts mounts it behind the phone profile', () => {
  it('sits in the /api chain after authMiddleware and phoneProfile, before apiRouter, and is closed on shutdown', async () => {
    const source = await readFile(new URL('../../server/index.ts', import.meta.url), 'utf8');
    const chain = source.split('\n').find((line) => line.includes("app.use('/api', authMiddleware,")) ?? '';
    const order = ['authMiddleware', 'phoneProfile', 'phoneConfirms', 'apiRouter'].map((name) => chain.indexOf(` ${name}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(source).toContain('try { phoneConfirms.close(); } catch');
    const start = source.indexOf('startServerPhoneConfirms({');
    const call = start < 0 ? '' : source.slice(start, source.indexOf('\n  });', start));
    expect(call).toContain('phoneOf: (req) => getTokenDeviceId(extractToken(req))');
    expect(call).toContain('subscribe: onBroadcast');
    // The call sits just above the skill-note wiring's comment, not between that comment and its line (D-10).
    const lines = source.split('\n');
    const skillNote = lines.findIndex((line) => line.includes('const skillNoteOps = '));
    expect(lines[skillNote - 1]).toMatch(/^\s*\/\/ A central's skill-note change/);
  });
});
