/**
 * POST /api/sessions/:id/recap (Nov 18 2026): the peek's Summary. The route answers 202 at once, runs the
 * tool-less `claude -p` the summarizer uses, puts the answer on the session and does NOT archive it.
 * `execFile` is mocked and process.kill throws on anything but signal 0: no real process is started or
 * signalled (see .claude/rules/known-issues.md).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
  getRecentSessions: vi.fn(() => []),
  getSessionById: vi.fn(() => null),
  deleteSession: vi.fn(),
  default: {},
}));

const mocks = vi.hoisted(() => ({
  broadcast: vi.fn(),
  runs: [] as Array<{ cmd: string; args: string[]; stdin: string; done: (err: Error | null, stdout?: string) => void }>,
}));

vi.mock('../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/wsManager.js')>();
  return { ...mod, broadcast: mocks.broadcast };
});
vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return { ...mod, startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn(), terminateProcessTree: vi.fn() };
});
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn((cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout?: string) => void) => {
      const run = { cmd, args, stdin: '', done: cb };
      mocks.runs.push(run);
      return { stdin: { write: (text: string) => { run.stdin += text; }, end: () => undefined } };
    }),
  };
});

const realKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realKill(pid, 0);
  throw new Error(`sessionRecapRoute.test must never signal a real process (pid ${pid})`);
}) as typeof process.kill);

import express from 'express';
import { createServer, type Server } from 'http';

let server: Server | null = null;
let baseUrl = '';
let store: typeof import('../server/sessionStore.js');
let args: readonly string[];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const api = await import('../server/apiRouter.js');
  args = api.SUMMARIZE_CLAUDE_ARGS;
  store = await import('../server/sessionStore.js');
  app.use('/api', api.default);
  server = createServer(app);
  await new Promise<void>((go) => server!.listen(0, '127.0.0.1', go));
  const addr = server!.address();
  if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await new Promise<void>((done) => server?.close(() => done()));
  vi.restoreAllMocks();
});
beforeEach(() => { mocks.runs.length = 0; });

let n = 0;
async function card(prompts: string[]): Promise<string> {
  n += 1;
  const id = `term-recap-${n}`;
  await store.createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/recap-${n}`, command: 'claude' });
  // getSession hands out a shallow copy: the prompt list itself is the store's, so fill it in place.
  store.getSession(id)!.promptHistory.push(...prompts.map((text, i) => ({ text, timestamp: 1_800_000_000_000 + i })));
  return id;
}
const post = (id: string) => fetch(`${baseUrl}/api/sessions/${id}/recap`, { method: 'POST' });

describe('POST /api/sessions/:id/recap', () => {
  it('answers 202, runs the tool-less small model on the capped text, and stores the summary without archiving', async () => {
    const id = await card(['build the image skill', 'deploy']);
    const res = await post(id);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, state: 'running' });
    expect(store.getSession(id)?.recap?.state).toBe('running');
    expect(mocks.runs).toHaveLength(1);
    expect(mocks.runs[0].cmd).toBe('claude');
    expect(mocks.runs[0].args).toEqual([...args]);
    expect(mocks.runs[0].stdin).toContain('build the image skill');
    expect(mocks.runs[0].stdin.length).toBeLessThan(9_000);
    mocks.runs[0].done(null, '- Built the skill\n- Deployed\n');
    await vi.waitFor(() => expect(store.getSession(id)?.recap).toMatchObject({ state: 'done', text: '• Built the skill\n• Deployed' }));
    expect(store.getSession(id)?.archived).toBeFalsy();
    expect(store.getSession(id)?.summary).toBeUndefined();
  });

  it('is 400 with nothing typed, and starts nothing', async () => {
    const id = await card([]);
    const res = await post(id);
    expect(res.status).toBe(400);
    expect(mocks.runs).toHaveLength(0);
  });

  it('is 404 for a session that does not exist', async () => {
    expect((await post('no-such-session')).status).toBe(404);
  });

  it('puts the reason on the session when the CLI is missing', async () => {
    const id = await card(['hello']);
    await post(id);
    mocks.runs[0].done(Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    await vi.waitFor(() => expect(store.getSession(id)?.recap).toMatchObject({ state: 'error', error: 'the Claude CLI isn’t installed on this Mac' }));
  });
});
