// test/mcp/tools.commandRun.runOnly.test.ts — command_run and the run-only built-ins (server/mcp/tools/commandRun.ts,
// findings D-I1 and D-I2, ruling P3-37). `/review` (Codex) is typed bare, `/code-review` (Claude) with exactly one level
// (low, medium, high, xhigh, max: bare, it reuses the person's last level, which may be ultra); `ultra`, a `--` option or
// any other argument is refused before anything is typed. Typing `/review` marks its terminal's menu known open
// (server/mcp/menuMark.ts), which is what lets key_send's keys through; `/code-review` marks nothing. A mock client stands in for the routes: nothing here reaches a terminal or a process.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandEntry } from '../../server/commandIndex.js';
import { clearMenuMarks, menuMarked } from '../../server/mcp/menuMark.js';
import { allTools } from '../../server/mcp/registry.js';
import { deliverCtx, promptBodies, promptRoutes, refusedBy, worker } from './deliverToolFixtures.js';
import { NOW, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

afterEach(clearMenuMarks);

const entry = (over: Partial<CommandEntry> & Pick<CommandEntry, 'name'>): CommandEntry => ({
  description: 'x',
  cli: 'claude',
  kind: 'command',
  source: 'global',
  ...over,
});
const codeReview = entry({ name: 'code-review', source: 'builtin' });
const codexReview = entry({ name: 'review', cli: 'codex', source: 'builtin' });
const deploy = entry({ name: 'deploy', kind: 'skill', source: 'project' });

const claudeWorker = () => worker('w1', { cliSource: 'claude', projectPath: '/a/proj' });
const codexWorker = () => worker('w1', { cliSource: 'codex', projectPath: '/a/proj' });

function setup(entries: CommandEntry[], session = claudeWorker(), prompt = promptRoutes('w1')) {
  return deliverCtx({ sessions: [session], routes: { 'GET /commands': ok({ entries }), ...prompt } });
}

const sentText = (h: ReturnType<typeof setup>): string[] => promptBodies(h).map((b) => b.text as string);

/** Is term-w1's menu known open, a moment after NOW and with no hook since? */
const marked = (): boolean => menuMarked('term-w1', NOW - 10_000, NOW + 1);

describe('command_run: the arguments of a run-only built-in (D-I2)', () => {
  it('/code-review ultra, --comment and --fix are refused, and nothing is typed', async () => {
    const h = setup([codeReview]);

    for (const args of ['ultra', '--comment', '--fix', '--post', 'high --fix', 'ultra high', 'the diff']) {
      const err = await runRefused('command_run', { id: 'w1', name: '/code-review', args }, h.ctx);
      expect(err.code, args).toBe('INVALID');
      if (args !== 'ultra') expect(`${err.message} ${err.hint}`, args).not.toContain(args);
    }
    expect(promptBodies(h)).toEqual([]);
    expect(marked()).toBe(false);
  });

  it('/code-review high passes, typed as the level alone', async () => {
    const h = setup([codeReview]);

    await run('command_run', { id: 'w1', name: 'code-review', args: 'high' }, h.ctx);
    await run('command_run', { id: 'w1', name: 'code-review', args: '  max ' }, h.ctx);

    expect(sentText(h)).toEqual(['/code-review high', '/code-review max']);
  });

  it('bare /code-review is refused: it reuses the person’s last level, which may be ultra', async () => {
    const h = setup([codeReview]);

    for (const args of [undefined, '', '  ']) {
      const err = await runRefused('command_run', { id: 'w1', name: 'code-review', ...(args === undefined ? {} : { args }) }, h.ctx);
      expect(err.code, String(args)).toBe('INVALID');
    }
    expect(promptBodies(h)).toEqual([]);
  });

  it('/review takes no arguments', async () => {
    const h = setup([codexReview], codexWorker());

    expect((await runRefused('command_run', { id: 'w1', name: 'review', args: 'the last commit' }, h.ctx)).code).toBe('INVALID');
    expect((await runRefused('command_run', { id: 'w1', name: '/review', args: 'high' }, h.ctx)).code).toBe('INVALID');
    await run('command_run', { id: 'w1', name: '/review' }, h.ctx);

    expect(sentText(h)).toEqual(['/review']);
  });

  it('a catalog command that is not a built-in keeps its arguments', async () => {
    const h = setup([deploy, codeReview]);

    await run('command_run', { id: 'w1', name: 'deploy', args: '--dry-run ultra' }, h.ctx);

    expect(sentText(h)).toEqual(['/deploy --dry-run ultra']);
    expect(marked()).toBe(false);
  });

  it('says the rule in its description', () => {
    const { description } = allTools().find((t) => t.name === 'command_run')!;
    for (const words of ['typed bare', 'exactly one level', 'low, medium, high, xhigh or max', 'ultra', '--', 'last level']) {
      expect(description, words).toContain(words);
    }
  });
});

describe('command_run: the menu mark key_send reads (D-I1)', () => {
  it('typing a run-only built-in marks its terminal’s menu known open, and says so in data', async () => {
    const h = setup([codexReview], codexWorker());

    const result = await run('command_run', { id: 'w1', name: 'review' }, h.ctx);

    expect(marked()).toBe(true);
    expect(result.data).toMatchObject({ command: '/review', accepted: true, menuKnownOpen: true });
  });

  it('/code-review high sets no mark', async () => {
    const h = setup([codeReview]);

    const result = await run('command_run', { id: 'w1', name: 'code-review', args: 'high' }, h.ctx);

    expect(result.data).toMatchObject({ command: '/code-review', accepted: true, menuKnownOpen: false });
    expect(marked()).toBe(false);
  });

  it('a safe built-in or a catalog command marks nothing', async () => {
    const h = setup([deploy]);

    const result = await run('command_run', { id: 'w1', name: 'model', args: 'sonnet' }, h.ctx);
    await run('command_run', { id: 'w1', name: 'deploy' }, h.ctx);

    expect(marked()).toBe(false);
    expect(result.data).toMatchObject({ menuKnownOpen: false });
  });

  it('/review typed into a card mid-turn marks nothing: no menu opens (ruling P3-40)', async () => {
    for (const status of ['working', 'prompting', 'approval', 'input']) {
      const h = setup([codexReview], worker('w1', { cliSource: 'codex', projectPath: '/a/proj', status }));

      const result = await run('command_run', { id: 'w1', name: 'review' }, h.ctx);

      expect(result.data, status).toMatchObject({ menuKnownOpen: false });
      expect(marked(), status).toBe(false);
    }
  });

  it('/review typed into an idle card marks its menu', async () => {
    const h = setup([codexReview], worker('w1', { cliSource: 'codex', projectPath: '/a/proj', status: 'idle' }));

    await run('command_run', { id: 'w1', name: 'review' }, h.ctx);

    expect(marked()).toBe(true);
  });

  it('a run-only built-in the prompt route refused marks nothing', async () => {
    const h = setup([codexReview], codexWorker(), { 'POST /sessions/w1/prompt': refusedBy(409, 'busy', 'busy') });

    const result = await run('command_run', { id: 'w1', name: 'review' }, h.ctx);

    expect(result.data).toMatchObject({ accepted: false, menuKnownOpen: false });
    expect(marked()).toBe(false);
  });
});
