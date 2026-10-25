// test/mcp/tools.skillNoteWrite.test.ts — the skill-notes toolset's P3 writes (server/mcp/tools/skillNoteWrite.ts):
// `skillnote_set_favorite`, `skillnote_set_tags` and `skillnote_set_abbr`, each one POST /skill-notes/ops on a fake
// client. The route itself is in skillNoteOpsRouter.test.ts; the window's side is src/lib/skillNoteOps.ts.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { fail, makeCtx, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const toolNamed = (name: string) => allTools().find((t) => t.name === name);
type Field = { safeParse(v: unknown): { success: boolean } };
const fieldsOf = (name: string) => toolNamed(name)?.input as unknown as Record<string, Field>;

const APPLIED = ok({ ok: true, applied: true });
const ROUTE = 'POST /skill-notes/ops';

describe('the skill-note tools', () => {
  it('each tool’s body and its mapping of 202/400/409', async () => {
    const cases: Array<[string, Record<string, unknown>, unknown]> = [
      ['skillnote_set_favorite', { agent: 'claude', name: 'retouch', on: true }, { fav: true }],
      ['skillnote_set_favorite', { agent: 'codex', name: 'superpowers:brainstorming', on: false }, { fav: false }],
      ['skillnote_set_tags', { agent: 'shared', name: 'review', tags: ['plan', 'x_1'] }, { tags: ['plan', 'x_1'] }],
      ['skillnote_set_tags', { agent: 'claude', name: 'review', tags: [] }, { tags: [] }],
      ['skillnote_set_abbr', { agent: 'claude', name: 'retouch', abbr: 'rar' }, { abbr: 'rar' }],
      ['skillnote_set_abbr', { agent: 'claude', name: 'retouch', abbr: null }, { abbr: null }],
    ];
    for (const [tool, args, set] of cases) {
      const h = makeCtx({ routes: { [ROUTE]: APPLIED } });

      const result = await run(tool, args, h.ctx);

      expect(h.client.calls).toEqual([{ method: 'POST', path: '/skill-notes/ops', body: { agent: args.agent, name: args.name, set } }]);
      expect(result.data).toEqual({ applied: true });
    }

    const pending = makeCtx({ routes: { [ROUTE]: ok({ ok: true, applied: false, pending: true }, 202) } });
    expect((await run('skillnote_set_favorite', { agent: 'claude', name: 'x1', on: true }, pending.ctx)).data).toEqual({ applied: false, pending: true });

    const refused = makeCtx({ routes: { [ROUTE]: fail(400, 'abbr-taken') } });
    const invalid = await runRefused('skillnote_set_abbr', { agent: 'claude', name: 'x1', abbr: 'rar' }, refused.ctx);
    expect(invalid.code).toBe('INVALID');
    expect(invalid.message).toBe('Another skill already uses that abbreviation.');

    const closed = makeCtx({ routes: { [ROUTE]: fail(409, 'no-writer') } });
    const noWindow = await runRefused('skillnote_set_tags', { agent: 'claude', name: 'x1', tags: ['a'] }, closed.ctx);
    expect(noWindow.code).toBe('NO_WINDOW');
    expect(noWindow.message).toBe('The AASC window on the Mac is closed.');
  });

  it('the window’s own codes: not-ready and catalog-unavailable are UNAVAILABLE, bad-tags and bad-op INVALID, failed UPSTREAM', async () => {
    const codeFor = async (reason: string): Promise<string> => {
      const h = makeCtx({ routes: { [ROUTE]: fail(400, reason) } });
      return (await runRefused('skillnote_set_favorite', { agent: 'claude', name: 'x1', on: true }, h.ctx)).code;
    };
    expect(await codeFor('not-ready')).toBe('UNAVAILABLE');
    expect(await codeFor('catalog-unavailable')).toBe('UNAVAILABLE');
    expect(await codeFor('bad-tags')).toBe('INVALID');
    expect(await codeFor('bad-op')).toBe('INVALID');
    expect(await codeFor('failed')).toBe('UPSTREAM');
    expect(await codeFor('unknown-skill')).toBe('NOT_FOUND');
    for (const abbr of ['abbr-format', 'abbr-taken', 'abbr-shadows']) expect(await codeFor(abbr)).toBe('INVALID');
    expect(await codeFor('some reason of the store')).toBe('INVALID');
  });

  it('no refusal passes the window’s words through, and the abbr refusals say which rule', async () => {
    const refusedFor = async (reason: string) => {
      const h = makeCtx({ routes: { [ROUTE]: fail(400, reason) } });
      return runRefused('skillnote_set_abbr', { agent: 'claude', name: 'x1', abbr: 'rar' }, h.ctx);
    };
    const store = await refusedFor('"rar" is already the abbreviation of secret-skill-4e2a.');
    expect(JSON.stringify(store)).not.toContain('secret-skill-4e2a');
    expect(JSON.stringify(store)).not.toContain('rar');
    expect((await refusedFor('abbr-format')).message).toBe('That abbreviation is not 2 to 12 lowercase letters, digits, - or _ starting with a letter or digit.');
    expect((await refusedFor('abbr-shadows')).message).toBe('That abbreviation is the name of a real skill or command.');
    expect((await refusedFor('unknown-skill')).message).toBe('The Library has no skill or command of that agent with that name.');
  });

  it('a build without the route is UNAVAILABLE, and any other failure is UPSTREAM', async () => {
    const missing = makeCtx({ routes: { [ROUTE]: fail(404, 'Not found') } });
    expect((await runRefused('skillnote_set_favorite', { agent: 'claude', name: 'x1', on: true }, missing.ctx)).code).toBe('UNAVAILABLE');
    const broken = makeCtx({ routes: { [ROUTE]: fail(500, 'boom') } });
    expect((await runRefused('skillnote_set_favorite', { agent: 'claude', name: 'x1', on: true }, broken.ctx)).code).toBe('UPSTREAM');
  });

  it('the opId never reaches the tool’s answer', async () => {
    const h = makeCtx({ routes: { [ROUTE]: ok({ ok: true, applied: true, opId: 'op-secret-77c1' }) } });

    const result = await run('skillnote_set_favorite', { agent: 'claude', name: 'x1', on: true }, h.ctx);

    expect(JSON.stringify(result)).not.toContain('op-secret-77c1');
  });

  it('tags and abbr outside the rules are INVALID', () => {
    const tags = fieldsOf('skillnote_set_tags');
    expect(tags.tags.safeParse(['ok', 'a_b-1']).success).toBe(true);
    expect(tags.tags.safeParse(['Upper']).success).toBe(false);
    expect(tags.tags.safeParse(['has space']).success).toBe(false);
    expect(tags.tags.safeParse(['x'.repeat(24)]).success).toBe(true);
    expect(tags.tags.safeParse(['x'.repeat(25)]).success).toBe(false);
    for (const folded of ['a--b', '-a', 'a-']) expect(tags.tags.safeParse([folded]).success, folded).toBe(false);
    expect(tags.tags.safeParse(['a', '_x', 'a-b-c']).success).toBe(true);
    expect(tags.tags.safeParse(Array.from({ length: 11 }, (_, i) => `t${i}`)).success).toBe(false);
    expect(tags.tags.safeParse(Array.from({ length: 10 }, (_, i) => `t${i}`)).success).toBe(true);

    const abbr = fieldsOf('skillnote_set_abbr');
    expect(abbr.abbr.safeParse('rar').success).toBe(true);
    expect(abbr.abbr.safeParse(null).success).toBe(true);
    expect(abbr.abbr.safeParse('Rar').success).toBe(false);
    expect(abbr.abbr.safeParse('').success).toBe(false);
    expect(abbr.abbr.safeParse('x'.repeat(21)).success).toBe(false);

    for (const tool of ['skillnote_set_favorite', 'skillnote_set_tags', 'skillnote_set_abbr']) {
      const f = fieldsOf(tool);
      expect(f.agent.safeParse('shared').success).toBe(true);
      expect(f.agent.safeParse('gemini').success).toBe(false);
      expect(f.name.safeParse('superpowers:brainstorming').success).toBe(true);
      expect(f.name.safeParse('../x').success).toBe(false);
      expect(f.name.safeParse('-x').success).toBe(false);
      expect(f.name.safeParse('a'.repeat(101)).success).toBe(false);
    }
  });

  it('are phase-3 idempotent writes of the skillNotes toolset, and the descriptions carry the rules', () => {
    for (const name of ['skillnote_set_favorite', 'skillnote_set_tags', 'skillnote_set_abbr']) {
      expect(toolNamed(name)).toMatchObject({ toolset: 'skillNotes', risk: 'write', phase: 3, idempotent: true });
      expect(toolNamed(name)?.description).toContain('NO_WINDOW');
    }
    expect(toolNamed('skillnote_set_tags')?.description).toContain('replaces');
    expect(toolNamed('skillnote_set_tags')?.description).toContain('1 to 24');
    for (const name of ['skillnote_set_favorite', 'skillnote_set_tags', 'skillnote_set_abbr']) {
      expect(toolNamed(name)?.description).toContain('NOT_FOUND');
      expect(toolNamed(name)?.description).toContain('uninstalled skill can still be emptied');
    }
    expect(toolNamed('skillnote_set_abbr')?.description).toContain('shadow');
    expect(toolNamed('skillnote_set_abbr')?.description).toContain('pending');
    expect(toolNamed('skillnote_set_note')).toBeUndefined();
  });
});
