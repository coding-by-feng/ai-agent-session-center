// test/mcp/resourceUri.test.ts — a URI as a resource and its variables (server/mcp/resourceUri.ts): which of the
// resources a central is offered a URI names, how percent-escapes are read, and how the variables become the
// backing tool's arguments, checked against the tool's own input shape. Pure: nothing here starts a server.
import { describe, expect, it, vi } from 'vitest';
import { allTools, MCP_MAX_PHASE, toolsFor } from '../../server/mcp/registry.js';
import { offerResources } from '../../server/mcp/resourceDefs.js';
import { checkedArgs, parseResourceUri } from '../../server/mcp/resourceUri.js';
import { ALL_TOOLSETS, CORE_TOOLSETS, ToolError, type Toolset } from '../../server/mcp/types.js';
import { MEDIA, RES } from './resourceWorld.js';

vi.mock('../../server/logger.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    debugJson: vi.fn(),
    isDebug: false,
  },
}));

/** What a central of these toolsets is given at this build. */
const toolsOf = (toolsets: readonly Toolset[]) =>
  toolsFor({ toolsets: [...toolsets] }, MCP_MAX_PHASE, allTools());

const all = offerResources({ toolsets: [...ALL_TOOLSETS] }, toolsOf(ALL_TOOLSETS));
const parsed = (uri: string) => parseResourceUri(all, uri);

/** The ToolError a call throws (the test fails when it answers, or throws something else). */
function refusal(fn: () => unknown): ToolError {
  try {
    fn();
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}

describe('parseResourceUri', () => {
  const CASES: Array<[string, string, Record<string, string>]> = [
    ['aasc://sessions', 'aasc://sessions', {}],
    ['aasc://sessions/s1', 'aasc://sessions/{id}', { id: 's1' }],
    ['aasc://sessions/s1/conversation', 'aasc://sessions/{id}/conversation', { id: 's1' }],
    ['aasc://sessions/s1/answer', 'aasc://sessions/{id}/answer', { id: 's1' }],
    ['aasc://sessions/s1/changes', 'aasc://sessions/{id}/changes', { id: 's1' }],
    [
      'aasc://sessions/s1/changes/3',
      'aasc://sessions/{id}/changes/{fileIndex}',
      { id: 's1', fileIndex: '3' },
    ],
    ['aasc://sessions/s1/terminal', 'aasc://sessions/{id}/terminal', { id: 's1' }],
    ['aasc://sessions/s1/queue', 'aasc://sessions/{id}/queue', { id: 's1' }],
    [
      'aasc://sessions/s1/subagents/a-1',
      'aasc://sessions/{id}/subagents/{agentId}',
      { id: 's1', agentId: 'a-1' },
    ],
    ['aasc://tasks/t-9', 'aasc://tasks/{taskId}', { taskId: 't-9' }],
    ['aasc://rooms', 'aasc://rooms', {}],
    [`aasc://resources/${RES}`, 'aasc://resources/{id}', { id: RES }],
    [`aasc://resources/${RES}/file`, 'aasc://resources/{id}/file', { id: RES }],
    ['aasc://snippets', 'aasc://snippets', {}],
    ['aasc://history/h1', 'aasc://history/{id}', { id: 'h1' }],
    [`aasc://notes/media/${MEDIA}`, 'aasc://notes/media/{id}', { id: MEDIA }],
    ['aasc://plan-usage', 'aasc://plan-usage', {}],
    ['aasc://workspace', 'aasc://workspace', {}],
  ];

  it.each(CASES)('reads %s as %s', (uri, template, vars) => {
    const found = parsed(uri);
    expect(found.offered.def.uri).toBe(template);
    expect(found.vars).toEqual(vars);
  });

  it('decodes percent-escapes in a variable, so an id with a slash or a comma can be named', () => {
    expect(parsed('aasc://sessions/ext%2F9/answer').vars).toEqual({ id: 'ext/9' });
    expect(parsed('aasc://sessions/a%2Cb').vars).toEqual({ id: 'a,b' });
    expect(parsed('aasc://sessions/%E6%B5%8B%E8%AF%95').vars).toEqual({ id: '测试' });
  });

  it('refuses a URI that is no resource of the central’s, as NOT_FOUND, without repeating it', () => {
    for (const uri of [
      'aasc://nothing',
      'aasc://sessions/a/b/c/d',
      'http://sessions',
      'aasc://sessions/',
      'aasc://SESSIONS',
      'secret-text',
    ]) {
      const err = refusal(() => parsed(uri));
      expect(err.code, uri).toBe('NOT_FOUND');
      expect(err.message, uri).not.toContain(uri);
    }
  });

  it('refuses a URI longer than any the table can make, before it is matched', () => {
    const long = `aasc://sessions/${'a'.repeat(3_000)}`;

    expect(refusal(() => parsed(long)).code).toBe('NOT_FOUND');
    // Within the limit a long id is matched, and left to the tool’s own input check (200 characters).
    expect(parsed(`aasc://sessions/${'a'.repeat(300)}`).vars.id).toHaveLength(300);
  });

  it('refuses a resource the central was not offered, as NOT_FOUND', () => {
    const codex = offerResources({ toolsets: [...CORE_TOOLSETS] }, toolsOf(CORE_TOOLSETS));
    expect(refusal(() => parseResourceUri(codex, 'aasc://rooms')).code).toBe('NOT_FOUND');
    expect(parseResourceUri(codex, 'aasc://sessions').offered.def.uri).toBe('aasc://sessions');
  });

  it('refuses a malformed percent-escape as INVALID', () => {
    expect(refusal(() => parsed('aasc://sessions/%E0%A4%A')).code).toBe('INVALID');
    expect(refusal(() => parsed('aasc://sessions/100%')).code).toBe('INVALID');
  });
});

// ---------------------------------------------------------------------------
// A URI's variables as a tool's arguments
// ---------------------------------------------------------------------------

describe('what each resource asks its tool', () => {
  const ARGS: Array<[string, Record<string, unknown>]> = [
    ['aasc://sessions', { includeEnded: false }],
    ['aasc://sessions/s1', { id: 's1' }],
    ['aasc://sessions/s1/conversation', { id: 's1' }],
    ['aasc://sessions/s1/answer', { id: 's1' }],
    ['aasc://sessions/s1/changes', { id: 's1' }],
    ['aasc://sessions/s1/changes/3', { id: 's1', fileIndex: 3 }],
    ['aasc://sessions/s1/terminal', { id: 's1' }],
    ['aasc://sessions/s1/queue', { id: 's1' }],
    ['aasc://sessions/s1/subagents/a-1', { id: 's1', agentId: 'a-1' }],
    ['aasc://rooms', {}],
    [`aasc://resources/${RES}`, { id: RES }],
    [`aasc://resources/${RES}/file`, { id: RES, file: 'SKILL.md' }],
    ['aasc://snippets', {}],
    ['aasc://history/h1', { id: 'h1' }],
    [`aasc://notes/media/${MEDIA}`, { id: MEDIA }],
    ['aasc://plan-usage', {}],
    ['aasc://workspace', {}],
  ];

  it.each(ARGS)('%s asks for %j', async (uri, expected) => {
    const found = parsed(uri);
    expect(await checkedArgs(found.offered, found.vars)).toEqual(expected);
  });

  it('asks for the skill’s main file, SKILL.md, from a resource’s /file', async () => {
    const found = parsed(`aasc://resources/${RES}/file`);
    expect((await checkedArgs(found.offered, found.vars)).file).toBe('SKILL.md');
  });

  it('refuses what the tool’s own input check refuses, as INVALID, without repeating the value', async () => {
    for (const uri of [
      'aasc://sessions/s1/changes/abc',
      'aasc://sessions/s1/changes/-1',
      'aasc://sessions/s1/changes/1.5',
      'aasc://sessions/s1/changes/99999',
      'aasc://sessions/s1/changes/0x10',
      'aasc://sessions/s1/changes/1e2',
      'aasc://resources/nothex',
      'aasc://sessions/s1/subagents/a.b',
    ]) {
      const found = parsed(uri);
      const err = await checkedArgs(found.offered, found.vars).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, uri).toBeInstanceOf(ToolError);
      expect((err as ToolError).code, uri).toBe('INVALID');
      const value = uri.split('/').pop() as string;
      expect((err as ToolError).message, uri).not.toContain(value);
    }
  });

  it('takes a file index of up to four digits, and nothing else, as a number', async () => {
    for (const [segment, index] of [
      ['0', 0],
      ['7', 7],
      ['9999', 9999],
      ['0007', 7],
    ] as const) {
      const found = parsed(`aasc://sessions/s1/changes/${segment}`);
      expect((await checkedArgs(found.offered, found.vars)).fileIndex).toBe(index);
    }
  });

  it('checks a task id with task_get’s own check: T12 and t12 pass, anything else is INVALID (K3)', async () => {
    for (const id of ['T12', 't12']) {
      const found = parsed(`aasc://tasks/${id}`);
      expect(found.offered.tool?.name).toBe('task_get');
      expect(await checkedArgs(found.offered, found.vars)).toEqual({ id });
    }
    const bad = parsed('aasc://tasks/t-9');
    const err = await checkedArgs(bad.offered, bad.vars).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).code).toBe('INVALID');
    expect((err as ToolError).message).not.toContain('t-9');
  });
});
