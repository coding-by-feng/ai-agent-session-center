// test/mcp/skillNoteOpsRouter.test.ts — the window op routes (server/skillNoteOpsRouter.ts): POST /skill-notes/ops
// forwards one change to the workspace writer's window as `skill_note_op` and waits for the window's answer on
// POST /skill-notes/ops/:opId/result; only that window may answer it. POST /keep-awake/ops does the same with
// `keep_awake_op`. The router is mounted on a real Express app on
// an ephemeral port with fake deps. The AASC server is never started and no socket or window is real.
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKILL_NOTE_OP } from '../../src/types/skillNoteOps.js';
import { KEEP_AWAKE_OP } from '../../src/types/websocket.js';
import { createSkillNoteOpsRouter, type SkillNoteOpsDeps, type WindowOpMessage } from '../../server/skillNoteOpsRouter.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const WRITER = 'mac-window-1';
const OP_ID = 'op-0000-1111';

interface Rig {
  port: number;
  sent: Array<{ clientId: string; msg: WindowOpMessage }>;
}

const servers: Server[] = [];

async function rig(over: Partial<SkillNoteOpsDeps> = {}): Promise<Rig> {
  const sent: Rig['sent'] = [];
  const deps: SkillNoteOpsDeps = {
    isLocal: (req: Request) => req.headers['x-test-remote'] === undefined,
    clientId: (req: Request) => String(req.headers['x-aasc-client-id'] ?? ''),
    writer: () => WRITER,
    sendToClient: (clientId, msg) => {
      sent.push({ clientId, msg });
      return 1;
    },
    newOpId: () => OP_ID,
    waitMs: 60,
    ...over,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createSkillNoteOpsRouter(deps));
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, sent };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

interface Answer {
  status: number;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

function call(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method, headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers } },
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
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const postOp = (port: number, body: unknown, headers: Record<string, string> = {}) => call(port, 'POST', '/api/skill-notes/ops', body, headers);
const postResult = (port: number, opId: string, body: unknown, clientId: string | null = WRITER, headers: Record<string, string> = {}) =>
  call(port, 'POST', `/api/skill-notes/ops/${opId}/result`, body, clientId === null ? headers : { 'x-aasc-client-id': clientId, ...headers });

const CHANGE = { agent: 'claude', name: 'retouch', set: { fav: true } };

/** Posts an op and, once the window has been sent it, posts `result` as the writer; both answers. */
async function opAnsweredBy(r: Rig, result: unknown, body: unknown = CHANGE): Promise<{ op: Answer; result: Answer }> {
  const op = postOp(r.port, body);
  await vi.waitFor(() => expect(r.sent).toHaveLength(1));
  const answered = await postResult(r.port, OP_ID, result);
  return { op: await op, result: answered };
}

describe('POST /skill-notes/ops', () => {
  it('forwards skill_note_op to the writer with key and set', async () => {
    const r = await rig();

    await opAnsweredBy(r, { ok: true }, { agent: 'codex', name: 'superpowers:brainstorming', set: { tags: ['plan', 'x_1'], abbr: null } });

    expect(r.sent).toEqual([
      { clientId: WRITER, msg: { type: SKILL_NOTE_OP, opId: OP_ID, key: 'codex:superpowers:brainstorming', set: { tags: ['plan', 'x_1'], abbr: null } } },
    ]);
  });

  it('waits for the window’s result: 200 applied, 400 refused', async () => {
    const applied = await opAnsweredBy(await rig(), { ok: true });
    expect(applied.op.status).toBe(200);
    expect(applied.op.body).toEqual({ ok: true, applied: true });
    expect(applied.result.status).toBe(200);
  });

  it('a refusal by the window is 400 with its words', async () => {
    const refused = await opAnsweredBy(await rig(), { ok: false, error: '"rar" is already the abbreviation of retouch.' }, { agent: 'claude', name: 'x1', set: { abbr: 'rar' } });
    expect(refused.op.status).toBe(400);
    expect(refused.op.body).toEqual({ ok: false, error: '"rar" is already the abbreviation of retouch.' });
  });

  it('no result in 5 s is 202 pending', async () => {
    const r = await rig({ waitMs: 30 });

    const answer = await postOp(r.port, CHANGE);

    expect(answer.status).toBe(202);
    expect(answer.body).toEqual({ ok: true, applied: false, pending: true });
    // A late result finds nothing waiting.
    expect((await postResult(r.port, OP_ID, { ok: true })).status).toBe(404);
  });

  it('no writer is 409', async () => {
    const none = await rig({ writer: () => null });
    expect(await postOp(none.port, CHANGE)).toMatchObject({ status: 409, body: { ok: false, error: 'no-writer' } });
  });

  it('a writer with no open socket is 409 too, and nothing is left waiting', async () => {
    const r = await rig({ sendToClient: () => 0 });

    expect(await postOp(r.port, CHANGE)).toMatchObject({ status: 409, body: { error: 'no-writer' } });
    expect((await postResult(r.port, OP_ID, { ok: true })).status).toBe(404);
  });

  it('a remote caller is 404 and nothing is sent', async () => {
    const r = await rig();

    const answer = await postOp(r.port, CHANGE, { 'x-test-remote': '1' });

    expect(answer.status).toBe(404);
    expect(r.sent).toEqual([]);
  });

  it('an op outside the rules is 400 and nothing is sent, and the words never repeat a value', async () => {
    const r = await rig();
    const bad = [
      { agent: 'gemini', name: 'x', set: { fav: true } },
      { agent: 'claude', name: '../etc', set: { fav: true } },
      { agent: 'claude', name: 'ok', set: {} },
      { agent: 'claude', name: 'ok', set: { fav: 'yes' } },
      { agent: 'claude', name: 'ok', set: { tags: Array.from({ length: 11 }, (_, i) => `t${i}`) } },
      { agent: 'claude', name: 'ok', set: { tags: ['UPPER-secret-5d1e'] } },
      { agent: 'claude', name: 'ok', set: { tags: ['x'.repeat(25)] } },
      { agent: 'claude', name: 'ok', set: { abbr: 'x'.repeat(21) } },
      { agent: 'claude', name: 'ok', set: { fav: true, extra: 1 } },
    ];
    for (const body of bad) {
      const answer = await postOp(r.port, body);
      expect(answer.status, JSON.stringify(body)).toBe(400);
      expect(answer.text).not.toContain('secret-5d1e');
    }
    expect(r.sent).toEqual([]);
  });

  it('the opId is in no answer to the caller', async () => {
    const r = await rig();
    for (const done of [{ ok: true }, { ok: false, error: 'bad' }]) {
      r.sent.length = 0;
      const { op } = await opAnsweredBy(r, done);
      expect(op.text).not.toContain(OP_ID);
    }
    const pending = await postOp((await rig({ waitMs: 20 })).port, CHANGE);
    expect(pending.text).not.toContain(OP_ID);
  });
});

describe('POST /skill-notes/ops/:opId/result', () => {
  it('a result from another client id is 403, and the op still waits for the writer', async () => {
    const r = await rig({ waitMs: 400 });
    const op = postOp(r.port, CHANGE);
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));

    expect((await postResult(r.port, OP_ID, { ok: true }, 'someone-else')).status).toBe(403);
    expect((await postResult(r.port, OP_ID, { ok: true }, null)).status).toBe(403);
    expect((await postResult(r.port, OP_ID, { ok: true }, WRITER, { 'x-test-remote': '1' })).status).toBe(403);
    expect((await postResult(r.port, OP_ID, { ok: true })).status).toBe(200);

    expect((await op).status).toBe(200);
  });

  it('an unknown op is 404, and a result is taken once', async () => {
    const r = await rig();
    expect((await postResult(r.port, 'nope', { ok: true })).status).toBe(404);

    const { result } = await opAnsweredBy(r, { ok: true });
    expect(result.status).toBe(200);
    expect((await postResult(r.port, OP_ID, { ok: true })).status).toBe(404);
  });

  it('a result that is not { ok, error? } is 400, and the error is cut and made one line', async () => {
    const r = await rig({ waitMs: 400 });
    const op = postOp(r.port, CHANGE);
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));

    expect((await postResult(r.port, OP_ID, { ok: 'yes' })).status).toBe(400);
    expect((await postResult(r.port, OP_ID, { ok: false, error: 7 })).status).toBe(400);
    expect((await postResult(r.port, OP_ID, { ok: false, error: `bad\n\u0007${'x'.repeat(500)}` })).status).toBe(200);

    const refused = await op;
    expect(refused.status).toBe(400);
    expect(refused.body.error.length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(refused.body.error).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('POST /keep-awake/ops', () => {
  const postKeepAwake = (port: number, body: unknown, headers: Record<string, string> = {}) => call(port, 'POST', '/api/keep-awake/ops', body, headers);
  const postKeepAwakeResult = (port: number, opId: string, body: unknown, clientId: string = WRITER) =>
    call(port, 'POST', `/api/keep-awake/ops/${opId}/result`, body, { 'x-aasc-client-id': clientId });

  it('forwards keep_awake_op to the writer and waits for its result', async () => {
    const r = await rig();

    const op = postKeepAwake(r.port, { on: true });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    expect((await postKeepAwakeResult(r.port, OP_ID, { ok: true })).status).toBe(200);

    expect(r.sent).toEqual([{ clientId: WRITER, msg: { type: KEEP_AWAKE_OP, opId: OP_ID, on: true } }]);
    expect(await op).toMatchObject({ status: 200, body: { ok: true, applied: true } });
  });

  it('a refusal is 400, no answer is 202, no writer is 409, a remote caller is 404, a bad body is 400', async () => {
    const r = await rig();
    const op = postKeepAwake(r.port, { on: false });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));
    await postKeepAwakeResult(r.port, OP_ID, { ok: false, error: 'not-desktop' });
    expect(await op).toMatchObject({ status: 400, body: { ok: false, error: 'not-desktop' } });

    expect(await postKeepAwake((await rig({ waitMs: 20 })).port, { on: true })).toMatchObject({ status: 202, body: { applied: false, pending: true } });
    expect(await postKeepAwake((await rig({ writer: () => null })).port, { on: true })).toMatchObject({ status: 409, body: { error: 'no-writer' } });

    const quiet = await rig();
    expect((await postKeepAwake(quiet.port, { on: true }, { 'x-test-remote': '1' })).status).toBe(404);
    expect((await postKeepAwake(quiet.port, { on: 'yes' })).status).toBe(400);
    expect((await postKeepAwake(quiet.port, { on: true, extra: 1 })).status).toBe(400);
    expect(quiet.sent).toEqual([]);
  });

  it('a keep-awake op is answered on its own result route only', async () => {
    const r = await rig({ waitMs: 400 });
    const op = postKeepAwake(r.port, { on: true });
    await vi.waitFor(() => expect(r.sent).toHaveLength(1));

    expect((await postResult(r.port, OP_ID, { ok: true })).status).toBe(404);
    expect((await postKeepAwakeResult(r.port, OP_ID, { ok: true }, 'someone-else')).status).toBe(403);
    expect((await postKeepAwakeResult(r.port, OP_ID, { ok: true })).status).toBe(200);
    expect((await op).status).toBe(200);
  });
});
