// contextBreakdown.test.ts — what a Claude session's context window holds (Oct 22 2026), measured
// from its own transcript: the window size Claude reports at each request, with what each turn
// added split across that turn's content by size.
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { measureContext, readContextBreakdown, CHARS_PER_TOKEN } from '../server/chat/contextBreakdown.js';
import type { ContextBreakdown, ContextKind } from '../src/types/chat.js';

const T = Date.parse('2026-10-22T00:00:00Z');
let msg = 0;

const at = (s: number) => new Date(T + s * 1000).toISOString();
const usage = (window: number) => ({ input_tokens: 2, cache_read_input_tokens: window - 1002, cache_creation_input_tokens: 1000, output_tokens: 50 });
/** One assistant API reply, written the way Claude Code does: one entry per content block. */
function reply(window: number, blocks: unknown[], s: number): unknown[] {
  msg += 1;
  const id = `msg_${msg}`;
  return blocks.map((block) => ({ type: 'assistant', timestamp: at(s), message: { id, role: 'assistant', content: [block], usage: usage(window) } }));
}
const user = (content: unknown, s: number, extra: Record<string, unknown> = {}) => ({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
const result = (id: string, text: string, s: number) => user([{ type: 'tool_result', tool_use_id: id, content: text }], s);
const tokensOf = (b: ContextBreakdown, kind: ContextKind) => b.kinds.find((k) => k.kind === kind)?.tokens ?? 0;
const sum = (b: ContextBreakdown) => b.kinds.reduce((n, k) => n + k.tokens, 0);

const SHAPE = {
  type: 'api-request-shape',
  shape: { system: [{ type: 'text', text: 's'.repeat(36_000) }], tools: [{ name: 'Read', description: 't'.repeat(72_000) }] },
};

function session(): unknown[] {
  return [
    { type: 'system', subtype: 'compact_boundary', timestamp: at(0) },
    user('Summary of the earlier conversation. '.repeat(100), 1, { isCompactSummary: true }),
    user('continue', 2),
    SHAPE,
    ...reply(60_000, [
      { type: 'text', text: 'Reading it.' },
      { type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/repo/server/index.ts' } },
    ], 3),
    result('toolu_read', 'x'.repeat(36_000), 4),
    ...reply(70_000, [
      { type: 'tool_use', id: 'toolu_bash', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
    ], 5),
    result('toolu_bash', 'y'.repeat(7_200), 6),
    ...reply(72_000, [{ type: 'text', text: 'All green.' }], 7),
  ];
}

describe('measureContext', () => {
  it('adds up to the window Claude reported at the last request', () => {
    const b = measureContext(session(), { projectRoot: '/repo' }) as ContextBreakdown;
    expect(b.tokens).toBe(72_000);
    expect(sum(b)).toBe(72_000);
    expect(b.requests).toBe(3);
    expect(b.sinceCompaction).toBe(true);
    expect(b.measuredAt).toBe(T + 7000);
  });

  it('gives each turn’s growth to what that turn added, by size', () => {
    const b = measureContext(session(), { projectRoot: '/repo' }) as ContextBreakdown;
    // 60k → 70k: the 36,000-char Read result and the first reply's small text and call.
    expect(tokensOf(b, 'read')).toBeGreaterThan(9_500);
    expect(tokensOf(b, 'read')).toBeLessThan(10_000);
    // 70k → 72k: the Bash result and its call.
    expect(tokensOf(b, 'bash')).toBeGreaterThan(1_800);
    expect(tokensOf(b, 'bash')).toBeLessThanOrEqual(2_000);
    expect(b.kinds.map((k) => k.kind)).toEqual([...b.kinds].sort((x, y) => y.tokens - x.tokens).map((k) => k.kind));
  });

  it('splits the start of the window into the system prompt and the tool definitions, from the request shape', () => {
    const b = measureContext(session(), { projectRoot: '/repo' }) as ContextBreakdown;
    expect(tokensOf(b, 'tools')).toBe(Math.round(JSON.stringify(SHAPE.shape.tools).length / CHARS_PER_TOKEN));
    expect(tokensOf(b, 'system')).toBeGreaterThan(30_000);
    expect(tokensOf(b, 'summary')).toBeGreaterThan(0);
    expect(tokensOf(b, 'fixed')).toBe(0);
  });

  it('lumps system prompt, tools and memory together when the CLI logged no request shape', () => {
    const b = measureContext(session().filter((r) => r !== SHAPE), { projectRoot: '/repo' }) as ContextBreakdown;
    expect(tokensOf(b, 'fixed')).toBeGreaterThan(55_000);
    expect(tokensOf(b, 'system')).toBe(0);
    expect(tokensOf(b, 'tools')).toBe(0);
  });

  it('names the largest items, relative to the project', () => {
    const b = measureContext(session(), { projectRoot: '/repo' }) as ContextBreakdown;
    expect(b.items[0]).toMatchObject({ kind: 'read', label: 'Read · server/index.ts' });
    expect(b.items.map((i) => i.label)).toContain('Bash · Run the tests');
    expect(b.items.length).toBeLessThanOrEqual(5);
  });

  it('never names a secret file', () => {
    const records = session().map((r) => JSON.parse(JSON.stringify(r).replace('/repo/server/index.ts', '/repo/.env')));
    const b = measureContext(records, { projectRoot: '/repo' }) as ContextBreakdown;
    expect(JSON.stringify(b)).not.toContain('.env');
    expect(b.items[0].label).toBe('Read · a secret file');
  });

  it('still adds up when the window shrank (Claude cleared old tool results)', () => {
    const records = [...session(), ...reply(50_000, [{ type: 'text', text: 'ok' }], 9)];
    const b = measureContext(records, { projectRoot: '/repo' }) as ContextBreakdown;
    expect(b.tokens).toBe(50_000);
    expect(sum(b)).toBe(50_000);
  });

  it('counts memory and skills from Claude Code’s attachments, and skips its own records', () => {
    const [boundary, summary, prompt, ...rest] = session();
    const records = [
      boundary, summary, prompt,
      { type: 'attachment', attachment: { type: 'instructions', files: [{ path: 'CLAUDE.md', content: 'm'.repeat(20_000) }] } },
      { type: 'attachment', attachment: { type: 'skill_listing', content: 'k'.repeat(4_000) } },
      { type: 'attachment', attachment: { type: 'prompt_snapshot', systemPrompt: 'p'.repeat(500_000) } },
      ...rest,
    ];
    const b = measureContext(records, { projectRoot: '/repo' }) as ContextBreakdown;
    expect(tokensOf(b, 'memory')).toBe(Math.round(JSON.stringify([{ path: 'CLAUDE.md', content: 'm'.repeat(20_000) }]).length / CHARS_PER_TOKEN));
    expect(tokensOf(b, 'skills')).toBeGreaterThan(1_000);
    expect(b.items.map((i) => i.label)).toContain('Memory · CLAUDE.md and rules');
    expect(sum(b)).toBe(72_000); // the 500k-char record took nothing from anyone
  });

  it('reads only the main conversation: a subagent’s sidechain is not in this window', () => {
    const side = reply(900_000, [{ type: 'text', text: 'side' }], 8).map((r) => ({ ...(r as object), isSidechain: true }));
    const b = measureContext([...session(), ...side], { projectRoot: '/repo' }) as ContextBreakdown;
    expect(b.tokens).toBe(72_000);
  });

  it('starts at the session’s start without a compaction, and is null before any request', () => {
    const fresh = session().slice(2);
    expect((measureContext(fresh, {}) as ContextBreakdown).sinceCompaction).toBe(false);
    expect(measureContext([user('hi', 1)], {})).toBeNull();
  });
});

describe('readContextBreakdown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aasc-context-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const lines = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';

  it('reads from the last compaction on, and sees what is appended later', async () => {
    const file = join(dir, 'a.jsonl');
    const earlier = [user('old', 0), ...reply(900_000, [{ type: 'text', text: 'old window' }], 0)];
    writeFileSync(file, lines([...earlier, ...session()]));
    const first = await readContextBreakdown(file, { projectRoot: '/repo' });
    expect(first?.tokens).toBe(72_000);
    expect(first?.sinceCompaction).toBe(true);

    appendFileSync(file, lines(reply(80_000, [{ type: 'text', text: 'more' }], 10)));
    expect((await readContextBreakdown(file, { projectRoot: '/repo' }))?.tokens).toBe(80_000);
  });

  it('is null for a missing file', async () => {
    expect(await readContextBreakdown(join(dir, 'none.jsonl'), {})).toBeNull();
  });
});
