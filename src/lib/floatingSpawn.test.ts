// floatingSpawn.test.ts — AASC-57: the AI popup's request for every desktop mode from every phone source
// (Chat, Terminal, a project file, a popup's own answer), which modes a source offers, and the REVIEW row.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./translationLog', () => ({ createLog: vi.fn(async () => 'uuid-1') }));

import { createLog } from './translationLog';
import {
  aiActionsFor,
  buildFloatingSpawnRequest,
  logFloatingSpawn,
  MAX_TRANSLATE_FILE_BYTES,
  requestFloatingSpawn,
  type AiSource,
  type FloatingSpawnMode,
  type SpawnSettings,
} from './floatingSpawn';

const settings: SpawnSettings = {
  nativeLanguage: '简体中文', learningLanguage: 'English', inheritContext: true, model: '', codexModel: '', effort: '',
};
const SEL = { text: 'the baton', contextLine: 'Only one device holds the baton.' };

const chat: AiSource = { kind: 'chat' };
const terminal: AiSource = { kind: 'terminal', spawnTerminalId: 'term-main' };
const file: AiSource = { kind: 'file', filePath: '/w/proj/docs/a.md', fileContent: '# Title\nBody' };
const popup: AiSource = { kind: 'popup', spawnTerminalId: 'term-pop' };

const build = (mode: FloatingSpawnMode, source: AiSource, extra: Partial<Parameters<typeof buildFloatingSpawnRequest>[0]> = {}) =>
  buildFloatingSpawnRequest({ originSessionId: 'root', cli: 'claude', mode, source, selection: SEL, settings, ...extra });

describe('buildFloatingSpawnRequest', () => {
  it.each([
    ['explain-learning'], ['explain-native'], ['vocab-native'],
    ['translate-selection-learning'], ['translate-selection-native'],
  ] as const)('%s carries the selection and its passage, from every source', (mode) => {
    for (const source of [chat, terminal, file, popup]) {
      const req = build(mode, source);
      expect(req).toMatchObject({ originSessionId: 'root', mode, selection: 'the baton', contextLine: SEL.contextLine });
      expect(req.spawnTerminalId).toBe(source.spawnTerminalId);
      expect(req.fileContent).toBeUndefined();
      expect(req.customPrompt).toBeUndefined();
    }
  });

  it('custom sends your instruction with the selection', () => {
    expect(build('custom', terminal, { customPrompt: '  Is this safe?  ' })).toMatchObject({
      mode: 'custom', customPrompt: 'Is this safe?', selection: 'the baton', spawnTerminalId: 'term-main',
    });
  });

  it('translate-answer sends no selection: the Mac reads the answer itself', () => {
    const req = build('translate-answer', chat);
    expect(req.mode).toBe('translate-answer');
    expect(req.selection).toBeUndefined();
    expect(build('translate-answer', terminal).spawnTerminalId).toBe('term-main');
  });

  it('translate-file sends the file’s text and path, and no selection', () => {
    const req = build('translate-file', file, { selection: null });
    expect(req).toMatchObject({ mode: 'translate-file', filePath: '/w/proj/docs/a.md', fileContent: '# Title\nBody' });
    expect(req.selection).toBeUndefined();
  });

  it('names the file in an explanation only when asked to', () => {
    expect(build('explain-native', file).filePath).toBeUndefined();
    expect(build('explain-native', file, { attachFilePath: true }).filePath).toBe('/w/proj/docs/a.md');
    expect(build('translate-selection-native', file, { attachFilePath: true }).filePath).toBeUndefined();
  });

  it('applies the quick settings per CLI, blank inheriting the origin’s', () => {
    const s = { ...settings, model: 'sonnet', codexModel: 'gpt-5.5', effort: 'high' };
    expect(build('explain-native', chat, { settings: s })).toMatchObject({ model: 'sonnet', effortLevel: 'high' });
    const codex = build('explain-native', chat, { settings: s, cli: 'codex' });
    expect(codex.model).toBe('gpt-5.5');
    expect(codex.effortLevel).toBeUndefined();
    expect(build('explain-native', chat).model).toBeUndefined();
  });
});

describe('aiActionsFor', () => {
  it('offers the six selection modes only with a selection', () => {
    const none = aiActionsFor({ source: chat, cli: 'claude', hasSelection: false });
    const some = aiActionsFor({ source: chat, cli: 'claude', hasSelection: true });
    for (const mode of ['explain-learning', 'explain-native', 'vocab-native', 'translate-selection-learning', 'translate-selection-native', 'custom'] as const) {
      expect(none[mode].offered).toBe(false);
      expect(some[mode].offered).toBe(true);
    }
  });

  it('offers the last answer from Chat and Terminal, Claude and Codex, never from a file or a popup', () => {
    expect(aiActionsFor({ source: chat, cli: 'claude', hasSelection: false })['translate-answer']).toEqual({ offered: true });
    expect(aiActionsFor({ source: terminal, cli: 'claude', hasSelection: true })['translate-answer']).toEqual({ offered: true });
    // Oct 30 2026: the Mac reads a Codex answer from its rollout.
    expect(aiActionsFor({ source: terminal, cli: 'codex', hasSelection: false })['translate-answer']).toEqual({ offered: true });
    const other = aiActionsFor({ source: chat, cli: null, hasSelection: false })['translate-answer'];
    expect(other.offered).toBe(true);
    expect(other.disabledReason).toMatch(/Claude Code and Codex only/);
    expect(aiActionsFor({ source: file, cli: 'claude', hasSelection: true })['translate-answer'].offered).toBe(false);
    expect(aiActionsFor({ source: popup, cli: 'claude', hasSelection: true })['translate-answer'].offered).toBe(false);
  });

  it('offers the whole file from a file only, when it has text that fits', () => {
    expect(aiActionsFor({ source: file, cli: 'claude', hasSelection: false })['translate-file']).toEqual({ offered: true });
    expect(aiActionsFor({ source: chat, cli: 'claude', hasSelection: true })['translate-file'].offered).toBe(false);
    expect(aiActionsFor({ source: { kind: 'file', filePath: '/w/a.pdf' }, cli: 'claude', hasSelection: false })['translate-file'].disabledReason)
      .toMatch(/text file/);
    const big = { kind: 'file' as const, filePath: '/w/big.md', fileContent: 'x'.repeat(MAX_TRANSLATE_FILE_BYTES + 1) };
    expect(aiActionsFor({ source: big, cli: 'claude', hasSelection: false })['translate-file'].disabledReason).toMatch(/too long/);
  });
});

describe('requestFloatingSpawn', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, terminalId: 'term-f1', label: 'Translate file → 简体中文' })));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const sent = () => JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));

  it('POSTs the request, the file’s text only for translate-file', async () => {
    await expect(requestFloatingSpawn(build('translate-file', file, { selection: null }))).resolves.toEqual({ terminalId: 'term-f1', label: 'Translate file → 简体中文' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/spawn-floating');
    expect(sent()).toMatchObject({ mode: 'translate-file', fileContent: '# Title\nBody', filePath: '/w/proj/docs/a.md' });
    fetchMock.mockClear();
    await requestFloatingSpawn({ ...build('explain-native', file), fileContent: 'leak' });
    expect(sent().fileContent).toBeUndefined();
  });

  it('cuts a long selection to the server’s cap instead of being refused', async () => {
    await requestFloatingSpawn(build('explain-native', chat, { selection: { text: 'y'.repeat(70 * 1024) } }));
    expect(sent().selection).toHaveLength(64 * 1024);
  });

  it('says a hidden session is not shared', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    await expect(requestFloatingSpawn(build('explain-native', chat))).rejects.toThrow('This session is not shared with this device');
  });
});

describe('logFloatingSpawn', () => {
  it('records the mode, the file and where the text came from for REVIEW', async () => {
    const req = build('translate-file', file, { selection: null });
    await logFloatingSpawn(req, { terminalId: 'term-f1', label: 'x' }, { projectName: 'proj', title: 'AASC' }, '/w/proj/docs/a.md');
    expect(createLog).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'translate-file', filePath: '/w/proj/docs/a.md', fileContent: '# Title\nBody', sourceFilePath: '/w/proj/docs/a.md',
      selection: '', originSessionId: 'root', originProjectName: 'proj', floatTerminalId: 'term-f1',
    }));
  });
});
