// test/subagentTranscript.test.ts — a subagent's own messages, for the AGENTS tab.
//
// Clicking a subagent card opens its task, its replies and tool calls, and its
// result. The server keeps only a one-line description and the tool log per
// run; Claude Code writes the whole conversation of each subagent to
//   <session transcript without .jsonl>/subagents/agent-<agentId>.jsonl
// (SubagentStop's `agent_transcript_path` names exactly that file).
//
// Those files get big (an 18 MB one was in the user's project when this was
// written), so a page is read from the END of the file, inside a byte budget,
// and never the whole file.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, symlinkSync, statSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import express from 'express';
import { createServer } from 'http';
import {
  findSubagentTranscript,
  readSubagentTranscriptPage,
  createSubagentTranscriptRouter,
} from '../server/subagentTranscript.js';
import { readClaudeTranscript } from '../server/extractPreviousAnswer.js';

const SESSION_ID = '3b39413a-7d98-4592-bade-90d64c04bd24';
const PROJECT_PATH = '/Users/x/Documents/agent-manager';
const ENCODED = '-Users-x-Documents-agent-manager';
const AGENT_ID = 'a0331924c04c54bcb';

let home: string;
let projectDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'aasc-subagent-'));
  process.env.HOME = home; // os.homedir() honours $HOME on POSIX
  projectDir = join(home, '.claude', 'projects', ENCODED);
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const ts = (s: number) => new Date(Date.UTC(2026, 9, 15, 0, 0, s)).toISOString();

const taskLine = (text = 'Find the hook files') =>
  JSON.stringify({ type: 'user', agentId: AGENT_ID, isSidechain: true, timestamp: ts(0), message: { role: 'user', content: text } });
const textLine = (text: string, s: number) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolLine = (id: string, name: string, input: unknown, s: number) =>
  JSON.stringify({ type: 'assistant', timestamp: ts(s), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultLine = (id: string, content: string, s: number, isError = false) =>
  JSON.stringify({ type: 'user', timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const attachmentLine = (s: number) => JSON.stringify({ type: 'attachment', timestamp: ts(s), attachment: { type: 'x' } });

function subagentDir(sessionId = SESSION_ID, dir = projectDir): string {
  const d = join(dir, sessionId, 'subagents');
  mkdirSync(d, { recursive: true });
  return d;
}

function writeAgent(lines: string[], agentId = AGENT_ID, sessionId = SESSION_ID): string {
  const file = join(subagentDir(sessionId), `agent-${agentId}.jsonl`);
  writeFileSync(file, lines.map((l) => `${l}\n`).join(''));
  return file;
}

const owner = (over: Partial<{ sessionId: string; projectPath: string | null; transcriptPath: string | null }> = {}) => ({
  sessionId: SESSION_ID,
  projectPath: PROJECT_PATH,
  transcriptPath: join(projectDir, `${SESSION_ID}.jsonl`),
  ...over,
});

describe('findSubagentTranscript', () => {
  it('finds agent-<id>.jsonl beside the session transcript, as SubagentStop names it', async () => {
    const file = writeAgent([taskLine()]);
    expect(await findSubagentTranscript(owner(), AGENT_ID)).toBe(realpathSync(file));
  });

  it('finds it from the project path when the session has no recorded transcript path', async () => {
    const file = writeAgent([taskLine()]);
    expect(await findSubagentTranscript(owner({ transcriptPath: null }), AGENT_ID)).toBe(realpathSync(file));
  });

  it('finds a run of an earlier conversation of the same project (after /clear or a resume)', async () => {
    const file = writeAgent([taskLine()], AGENT_ID, 'older-conversation-id');
    expect(await findSubagentTranscript(owner(), AGENT_ID)).toBe(realpathSync(file));
  });

  it('returns null when there is no file for that agent', async () => {
    writeAgent([taskLine()]);
    expect(await findSubagentTranscript(owner(), 'a-someone-else')).toBeNull();
  });

  it.each(['../x', 'a/b', '..', '', 'a b', 'a\0b', 'x'.repeat(200)])('refuses agent id %j', async (bad) => {
    writeAgent([taskLine()]);
    expect(await findSubagentTranscript(owner(), bad)).toBeNull();
  });

  it('believes a miss for a while (no project-wide walk on every refresh), then looks again', async () => {
    let t = 1_000;
    const now = () => t;
    expect(await findSubagentTranscript(owner(), 'a-later', now)).toBeNull();
    const file = writeAgent([taskLine()], 'a-later', 'older-conversation-id');
    t += 5_000;
    expect(await findSubagentTranscript(owner(), 'a-later', now)).toBeNull();
    t += 6_000;
    expect(await findSubagentTranscript(owner(), 'a-later', now)).toBe(realpathSync(file));
  });

  it('a miss never hides a file that turns up where SubagentStop says it is', async () => {
    let t = 1_000;
    expect(await findSubagentTranscript(owner(), 'a-soon', () => t)).toBeNull();
    const file = writeAgent([taskLine()], 'a-soon');
    t += 1;
    expect(await findSubagentTranscript(owner(), 'a-soon', () => t)).toBe(realpathSync(file));
  });

  it('ignores a recorded transcript path outside ~/.claude/projects', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'aasc-elsewhere-'));
    try {
      const d = join(elsewhere, SESSION_ID, 'subagents');
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `agent-${AGENT_ID}.jsonl`), `${taskLine()}\n`);
      const found = await findSubagentTranscript(
        owner({ projectPath: null, transcriptPath: join(elsewhere, `${SESSION_ID}.jsonl`) }),
        AGENT_ID,
      );
      expect(found).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('does not follow a symlink that leaves ~/.claude/projects', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'aasc-elsewhere-'));
    try {
      const target = join(elsewhere, 'secret.jsonl');
      writeFileSync(target, `${taskLine('not yours')}\n`);
      symlinkSync(target, join(subagentDir(), `agent-${AGENT_ID}.jsonl`));
      expect(await findSubagentTranscript(owner(), AGENT_ID)).toBeNull();
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

describe('readSubagentTranscriptPage', () => {
  it('returns the task (the first line) apart from the messages, in file order', async () => {
    const file = writeAgent([
      taskLine('Build the phone shell'),
      attachmentLine(1),
      textLine('Reading the code first.', 2),
      toolLine('t1', 'Read', { file_path: '/x/a.ts' }, 3),
      resultLine('t1', 'file body', 4),
      textLine('Done: the shell is in place.', 5),
    ]);
    const page = await readSubagentTranscriptPage(file);
    expect(page.task).toBe('Build the phone shell');
    expect(page.entries.map((e) => e.role)).toEqual(['assistant', 'tool_use', 'tool_result', 'assistant']);
    expect(page.hasEarlier).toBe(false);
  });

  it('keeps the tool-call id on both halves so a result pairs with its call', async () => {
    const file = writeAgent([
      taskLine(),
      toolLine('t1', 'Grep', { pattern: 'a' }, 1),
      toolLine('t2', 'Grep', { pattern: 'b' }, 1),
      resultLine('t2', 'b hits', 2),
      resultLine('t1', 'a hits', 2, true),
    ]);
    const { entries } = await readSubagentTranscriptPage(file);
    expect(entries).toEqual([
      expect.objectContaining({ role: 'tool_use', id: 't1', tool: 'Grep' }),
      expect.objectContaining({ role: 'tool_use', id: 't2' }),
      expect.objectContaining({ role: 'tool_result', toolUseId: 't2', output: 'b hits' }),
      expect.objectContaining({ role: 'tool_result', toolUseId: 't1', isError: true }),
    ]);
  });

  it('pages from the end: the newest entries first, then the ones before them, with no gap or overlap', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 30; i++) lines.push(textLine(`step ${i}`, i));
    const file = writeAgent(lines);

    const newest = await readSubagentTranscriptPage(file, { limit: 12 });
    expect(newest.entries.map((e) => (e as { text: string }).text)).toEqual(
      Array.from({ length: 12 }, (_, i) => `step ${19 + i}`),
    );
    expect(newest.hasEarlier).toBe(true);

    const before = await readSubagentTranscriptPage(file, { before: newest.start, limit: 12 });
    expect(before.entries.map((e) => (e as { text: string }).text)).toEqual(
      Array.from({ length: 12 }, (_, i) => `step ${7 + i}`),
    );
    const first = await readSubagentTranscriptPage(file, { before: before.start, limit: 12 });
    expect(first.entries.map((e) => (e as { text: string }).text)).toEqual(
      Array.from({ length: 6 }, (_, i) => `step ${1 + i}`),
    );
    expect(first.hasEarlier).toBe(false);
  });

  it('reads at most its byte budget from the end of a big file, never the whole file', async () => {
    const big = 'x'.repeat(10_000);
    const lines = [taskLine('the task')];
    for (let i = 1; i <= 400; i++) lines.push(resultLine(`t${i}`, big, i));
    lines.push(textLine('the newest reply', 401));
    const file = writeAgent(lines);
    expect(statSync(file).size).toBeGreaterThan(4_000_000);

    const page = await readSubagentTranscriptPage(file, { scanBytes: 100_000 });
    expect(page.task).toBe('the task');
    expect(page.entries.at(-1)).toMatchObject({ role: 'assistant', text: 'the newest reply' });
    // ~10 KB per line: a 100 KB budget holds about ten of them, not four hundred.
    expect(page.entries.length).toBeLessThan(12);
    expect(page.hasEarlier).toBe(true);
    expect(page.start).toBeGreaterThan(statSync(file).size - 100_000);
  });

  it('a line bigger than the budget is skipped, and paging still moves back', async () => {
    const lines = [taskLine(), textLine('before the giant', 1), resultLine('g', 'y'.repeat(50_000), 2), textLine('after the giant', 3)];
    const file = writeAgent(lines);
    const newest = await readSubagentTranscriptPage(file, { scanBytes: 20_000 });
    expect(newest.entries.map((e) => e.role)).toEqual(['assistant']);
    let page = newest;
    const seen: string[] = [];
    for (let guard = 0; page.hasEarlier && guard < 10; guard++) {
      page = await readSubagentTranscriptPage(file, { before: page.start, scanBytes: 20_000 });
      for (const e of page.entries) if (e.role === 'assistant') seen.push(e.text);
    }
    expect(page.hasEarlier).toBe(false);
    expect(seen).toContain('before the giant');
  });

  it('`from` returns everything from that offset to the end (a live refresh above loaded history)', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 10; i++) lines.push(textLine(`step ${i}`, i));
    const file = writeAgent(lines);
    const newest = await readSubagentTranscriptPage(file, { limit: 4 });
    appendFileSync(file, `${textLine('step 11', 11)}\n`);

    const refreshed = await readSubagentTranscriptPage(file, { from: newest.start });
    expect(refreshed.start).toBe(newest.start);
    expect(refreshed.entries.map((e) => (e as { text: string }).text)).toEqual(['step 7', 'step 8', 'step 9', 'step 10', 'step 11']);
    expect(refreshed.reset).toBeUndefined();
  });

  it('`from` too far back for the budget falls back to the newest page and says so', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 50; i++) lines.push(textLine(`step ${i} ${'z'.repeat(1000)}`, i));
    const file = writeAgent(lines);
    const page = await readSubagentTranscriptPage(file, { from: 0, scanBytes: 5_000 });
    expect(page.reset).toBe(true);
    expect(page.entries.at(-1)).toMatchObject({ text: expect.stringContaining('step 50') });
  });

  it('skips a half-written last line (the agent is still appending)', async () => {
    const file = writeAgent([taskLine(), textLine('whole', 1)]);
    appendFileSync(file, textLine('half', 2).slice(0, 40));
    const page = await readSubagentTranscriptPage(file);
    expect(page.entries.map((e) => (e as { text: string }).text)).toEqual(['whole']);
  });

  it('cuts a very long task (it is sent with every page)', async () => {
    const page = await readSubagentTranscriptPage(writeAgent([taskLine('t'.repeat(70_000)), textLine('hi', 1)]));
    expect(page.task).toHaveLength(64 * 1024 + 1);
    expect(page.task!.endsWith('…')).toBe(true);
  });

  it('reads the task from text blocks, and gives null when the first line is not a prompt', async () => {
    const blocks = JSON.stringify({ type: 'user', timestamp: ts(0), message: { role: 'user', content: [{ type: 'text', text: 'Block task' }] } });
    expect((await readSubagentTranscriptPage(writeAgent([blocks]))).task).toBe('Block task');
    expect((await readSubagentTranscriptPage(writeAgent([attachmentLine(0), textLine('hi', 1)]))).task).toBeNull();
  });
});

describe('GET /sessions/:id/subagents/:agentId/transcript', () => {
  const run = (agentId: string) => ({
    agentId, agentType: 'Explore', description: 'Find hook files', descriptionConfirmed: true, status: 'working' as const,
    startedAt: 1, endedAt: null, lastActivityAt: 1, toolCount: 0, currentTool: null, currentTarget: null,
  });
  const session = () => ({ ...owner(), subagents: [run(AGENT_ID), run('a-without-file')] });

  function app(getSession: (id: string) => ReturnType<typeof session> | undefined = (id) => (id === SESSION_ID ? session() : undefined)) {
    const a = express();
    a.use(createSubagentTranscriptRouter({ getSession: getSession as never }));
    return a;
  }

  /** One GET against a throwaway server (the suite has no supertest). */
  async function get(a: express.Express, path: string): Promise<{ status: number; body: Record<string, any> }> {
    const server = createServer(a);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: res.status, body: await res.json().catch(() => ({})) };
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }

  it('returns the newest page for a run of the session', async () => {
    writeAgent([taskLine('the task'), textLine('hello', 1)]);
    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.task).toBe('the task');
    expect(res.body.data.entries).toEqual([expect.objectContaining({ role: 'assistant', text: 'hello' })]);
  });

  it('passes `before` through', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 5; i++) lines.push(textLine(`step ${i}`, i));
    writeAgent(lines);
    const first = await get(app(), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript`);
    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript?before=${first.body.data.start}`);
    expect(res.body.data.entries).toEqual([]);
    expect(res.body.data.hasEarlier).toBe(false);
  });

  it('takes an optional `limit`: the newest entries of the page, and `before` continues from them with nothing skipped', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 10; i++) lines.push(textLine(`step ${i}`, i));
    writeAgent(lines);
    const texts = (r: { body: Record<string, any> }) => (r.body.data.entries as Array<{ text: string }>).map((e) => e.text);
    const url = `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript`;

    const newest = await get(app(), `${url}?limit=3`);
    expect(texts(newest)).toEqual(['step 8', 'step 9', 'step 10']);
    expect(newest.body.data.hasEarlier).toBe(true);
    const above = await get(app(), `${url}?before=${newest.body.data.start}&limit=3`);

    expect(texts(above)).toEqual(['step 5', 'step 6', 'step 7']);
  });

  it('gives a full page when `limit` is left out', async () => {
    const lines = [taskLine()];
    for (let i = 1; i <= 10; i++) lines.push(textLine(`step ${i}`, i));
    writeAgent(lines);

    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript`);

    expect(res.body.data.entries).toHaveLength(10);
  });

  it('says there is no transcript (data null) for a known run without a file', async () => {
    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/a-without-file/transcript`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: null });
  });

  it('404s an agent that is not one of the session\'s runs, even when its file exists', async () => {
    writeAgent([taskLine()], 'a-not-a-run');
    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/a-not-a-run/transcript`);
    expect(res.status).toBe(404);
  });

  it('404s an unknown session', async () => {
    const res = await get(app(), `/sessions/nope/subagents/${AGENT_ID}/transcript`);
    expect(res.status).toBe(404);
  });

  it.each(['before=-1', 'before=abc', 'from=1.5', 'before=1&from=2', 'limit=0', 'limit=201', 'limit=abc', 'limit=1.5', 'limit=', 'limit=5&limit=6'])('400s a bad query (%s)', async (q) => {
    writeAgent([taskLine()]);
    const res = await get(app(), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript?${q}`);
    expect(res.status).toBe(400);
  });

  it('500s without a stack trace when the read throws', async () => {
    writeAgent([taskLine()]);
    const boom = vi.fn(() => { throw new Error('disk on fire /private/path'); });
    const res = await get(app(boom as never), `/sessions/${SESSION_ID}/subagents/${AGENT_ID}/transcript`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('/private/path');
  });
});

describe('readClaudeTranscript (CONVERSATION tab) after the shared line parser', () => {
  it('reads a result made of content blocks (MCP tools) as its text, not as escaped JSON', async () => {
    const mcp = JSON.stringify({
      type: 'user', timestamp: ts(5),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'text', text: '{\n  "id": "AASC-19"\n}' },
        { type: 'image', source: { data: 'xxxx' } },
      ] }] },
    });
    const odd = JSON.stringify({
      type: 'user', timestamp: ts(6),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'tool_reference', name: 'x' }] }] },
    });
    const file = writeAgent([taskLine(), mcp, odd]);
    const { entries } = await readSubagentTranscriptPage(file);
    expect(entries[0]).toMatchObject({ role: 'tool_result', output: '{\n  "id": "AASC-19"\n}\n[image]' });
    // Blocks it does not know stay JSON, so nothing is lost.
    expect(entries[1]).toMatchObject({ output: '[{"type":"tool_reference","name":"x"}]' });
  });

  it('reads the same entries, now with call ids, and still skips system records and their times', () => {
    const file = join(projectDir, `${SESSION_ID}.jsonl`);
    const system = JSON.stringify({ type: 'system', timestamp: ts(50), content: 'hook ran' });
    const noTime = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'no time' } });
    writeFileSync(file, [taskLine('hi'), toolLine('t1', 'Bash', { command: 'ls' }, 2), system, noTime, resultLine('t1', 'a b', 3)].map((l) => `${l}\n`).join(''));
    expect(readClaudeTranscript(SESSION_ID, PROJECT_PATH, null)).toEqual([
      { role: 'user', text: 'hi', timestamp: Date.parse(ts(0)) },
      { role: 'tool_use', tool: 'Bash', input: '{"command":"ls"}', timestamp: Date.parse(ts(2)), id: 't1' },
      // the system record's time does not carry over to the timeless entry
      { role: 'assistant', text: 'no time', timestamp: Date.parse(ts(2)) },
      { role: 'tool_result', output: 'a b', timestamp: Date.parse(ts(3)), isError: false, toolUseId: 't1' },
    ]);
  });
});
