// test/chatAssistantCap.test.ts — Ruling 48: the task ledger reads a task's answer whole, up to 20 000 characters,
// through an opt-in reader option (`assistantCap`). Without it both readers keep assistant text at 16 KB, as the phone
// chat always had it; with it only assistant text grows. The route takes it from the Mac itself only.
// Synthetic transcripts in a temp dir (test/chatFixtures.ts); HOME points there, so no real transcript is read.
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSISTANT_TEXT_CAP_MAX, TEXT_CAP } from '../server/chat/chatEntries.js';
import { createChatRouter } from '../server/chat/chatRouter.js';
import { readClaudeChatPage } from '../server/chat/claudeTranscript.js';
import { readCodexChatPage } from '../server/chat/codexTranscript.js';
import { resetTranscriptLocatorCache } from '../server/chat/transcriptLocator.js';
import type { ChatEntry, ChatPage } from '../src/types/chat.js';
import { claude, codex, tempDir, writeJsonl } from './chatFixtures.js';

const assistants = (entries: readonly ChatEntry[]) =>
  entries.flatMap((e) => (e.kind === 'assistant' ? [{ length: e.text.length, truncated: e.truncated === true }] : []));

describe('the readers’ assistantCap', () => {
  let dir = '';
  beforeEach(() => {
    dir = tempDir('aasc-assistant-cap-');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps assistant text at 16 KB without it (the phone chat as it was)', async () => {
    const file = writeJsonl(join(dir, 'c.jsonl'), [claude.user('go'), claude.assistant([claude.text('a'.repeat(19_000))])]);
    expect(assistants((await readClaudeChatPage(file)).entries)).toEqual([{ length: TEXT_CAP, truncated: true }]);
  });

  it('gives a 19 000-character Claude answer whole, and cuts a 25 000-character one at the cap', async () => {
    const file = writeJsonl(join(dir, 'c.jsonl'), [
      claude.user('go'),
      claude.assistant([claude.text('a'.repeat(19_000))]),
      claude.user('again'),
      claude.assistant('b'.repeat(25_000)),
    ]);
    const page = await readClaudeChatPage(file, { assistantCap: ASSISTANT_TEXT_CAP_MAX });
    expect(assistants(page.entries)).toEqual([
      { length: 19_000, truncated: false },
      { length: ASSISTANT_TEXT_CAP_MAX, truncated: true },
    ]);
  });

  it('does the same for a Codex answer', async () => {
    const file = writeJsonl(join(dir, 'x.jsonl'), [codex.meta(), codex.user('go'), codex.assistant('a'.repeat(19_000))]);
    expect(assistants((await readCodexChatPage(file)).entries)).toEqual([{ length: TEXT_CAP, truncated: true }]);
    const whole = await readCodexChatPage(file, { assistantCap: ASSISTANT_TEXT_CAP_MAX });
    expect(assistants(whole.entries)).toEqual([{ length: 19_000, truncated: false }]);
  });

  it('leaves every other text at its cap', async () => {
    const file = writeJsonl(join(dir, 'c.jsonl'), [claude.user('u'.repeat(19_000)), claude.assistant('ok')]);
    const page = await readClaudeChatPage(file, { assistantCap: ASSISTANT_TEXT_CAP_MAX });
    const user = page.entries.find((e) => e.kind === 'user');
    expect(user?.kind === 'user' ? user.text.length : 0).toBe(TEXT_CAP);
  });

  it('never reads more than the most a caller may ask for', async () => {
    const file = writeJsonl(join(dir, 'c.jsonl'), [claude.user('go'), claude.assistant('a'.repeat(30_000))]);
    const page = await readClaudeChatPage(file, { assistantCap: 50_000 });
    expect(assistants(page.entries)).toEqual([{ length: ASSISTANT_TEXT_CAP_MAX, truncated: true }]);
  });
});

describe('GET /sessions/:id/chat?assistantCap=', () => {
  let tmp = '';
  let server: Server;
  let base = '';
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    saved.HOME = process.env.HOME;
    tmp = realpathSync(tempDir('aasc-assistant-cap-route-'));
    process.env.HOME = join(tmp, 'home');
    resetTranscriptLocatorCache();
    const claudeDir = join(tmp, 'home', '.claude', 'projects', '-proj');
    mkdirSync(claudeDir, { recursive: true });
    const transcript = writeJsonl(join(claudeDir, 'long.jsonl'), [claude.user('go'), claude.assistant('a'.repeat(19_000))]);
    const session = { sessionId: 's', cliSource: 'claude', projectPath: join(tmp, 'home', 'proj'), transcriptPath: transcript, remoteVisible: true };
    const app = express();
    app.use('/api', createChatRouter({ getSession: (id) => (id === 's' ? (session as never) : null) }));
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr && typeof addr === 'object') base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = async (query: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api/sessions/s/chat?${query}`, { headers });
    return { status: res.status, body: (await res.json()) as { success: boolean; data: ChatPage; error?: string } };
  };

  it('reads the answer whole for the Mac’s own caller, and as before without it', async () => {
    const whole = await get(`assistantCap=${ASSISTANT_TEXT_CAP_MAX}`);
    expect(whole.status).toBe(200);
    expect(assistants(whole.body.data.entries)).toEqual([{ length: 19_000, truncated: false }]);
    const plain = await get('');
    expect(assistants(plain.body.data.entries)).toEqual([{ length: TEXT_CAP, truncated: true }]);
  });

  it('refuses a cap that is not a whole number up to the most, in its own words', async () => {
    for (const bad of ['0', `${ASSISTANT_TEXT_CAP_MAX + 1}`, 'abc', '1.5']) {
      const r = await get(`assistantCap=${bad}`);
      expect(r.status).toBe(400);
      expect(r.body.error).toContain('assistantCap');
    }
  });

  it('refuses it from another device', async () => {
    const r = await get(`assistantCap=${ASSISTANT_TEXT_CAP_MAX}`, { 'X-Forwarded-For': '192.168.1.50' });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('assistantCap');
  });
});
