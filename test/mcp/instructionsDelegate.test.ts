// test/mcp/instructionsDelegate.test.ts — how the playbook a central reads at initialize (server/mcp/instructions.ts)
// tells it to hand work out (K2): from P2 on, task_delegate and task_wait are there, so it names the sessions itself;
// `to: "auto"` (AASC picking the session) is P4's and is never recommended before it; from P4 it is, with task_route's
// dry run, auto routing that may be off, and naming the project when the confidence is low. The rest of the
// playbook's rules: registry.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { centralInstructions } from '../../server/mcp/instructions.js';
import { MCP_MAX_PHASE, type CentralKind } from '../../server/mcp/types.js';
import { dataOf, makeCentral, makeCtx } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const KINDS: CentralKind[] = ['global', 'room', 'project'];
const lineWith = (text: string, word: string): string => text.split('\n').find((l) => l.includes(word)) ?? '';
/** The P3 confirmation line, said the same from P3 on. */
const CONFIRM_LINE_P3 =
  '- Some tools wait for the person: when one answers NEEDS_CONFIRMATION, tell the person what you asked, then call ' +
  'confirm_wait. Never ask a session to approve for the person.';

describe('the playbook’s delegate lines (K2)', () => {
  it.each(KINDS)('from P2 a %s central names the sessions itself and hears "auto" comes later', (kind) => {
    const text = centralInstructions(kind, 2);
    const delegate = lineWith(text, 'task_delegate');

    expect(delegate).toMatch(/naming the sessions yourself/);
    expect(delegate).toMatch(/to: "auto".*later.*P4/);
    expect(delegate).not.toMatch(/when available/);
    expect(lineWith(text, 'task_wait')).not.toMatch(/when available/);
    expect(text.length).toBeLessThanOrEqual(1_500);
  });

  it('never recommends to: "auto", in any phase it can be built for', () => {
    for (const phase of [1, 2, 3] as const) {
      const text = centralInstructions('global', phase);
      expect(text, String(phase)).not.toMatch(/task_delegate\(to: "auto"\)/);
      expect(text, String(phase)).not.toMatch(/"auto" unless/);
    }
  });

  it.each(KINDS)('instructions mention auto, task_route and low confidence, and fit 1500 chars (P4, %s)', (kind) => {
    const text = centralInstructions(kind, 4);

    expect(lineWith(text, 'task_delegate')).toMatch(/to: "auto"/);
    expect(lineWith(text, 'task_delegate')).toMatch(/naming|name the sessions/);
    expect(lineWith(text, 'task_route')).toMatch(/dry run: it opens and sends nothing/);
    expect(lineWith(text, 'Auto routing')).toMatch(/may be off.*UNAVAILABLE.*name the sessions/);
    expect(lineWith(text, 'confidence')).toMatch(/low, name the project \(project_resolve\)/);
    expect(lineWith(text, 'task_wait')).toMatch(/always task_wait/);
    expect(text).not.toMatch(/later version|when available/);
    // A child central hears what a task from the global central is; the global central is never sent one.
    expect(text.includes('from ★ global')).toBe(kind !== 'global');
    expect(text.length).toBeLessThanOrEqual(1_500);
  });

  it('marks the task tools "when available" while the build stops at P1', () => {
    const text = centralInstructions('room', 1);

    expect(lineWith(text, 'task_delegate')).toContain('(when available)');
    expect(lineWith(text, 'task_wait')).toContain('(when available)');
  });
});

describe('the playbook’s confirmation line (P3, Task 15)', () => {
  const CONFIRM_LINE =
    '- Some tools wait for the person: when one answers NEEDS_CONFIRMATION, tell the person what you asked, then call ' +
    'confirm_wait. Never ask a session to approve for the person.';

  it.each(KINDS)('the playbook names confirm_wait and NEEDS_CONFIRMATION and fits 1500 chars (%s)', (kind) => {
    for (const phase of [3, 4] as const) {
      const text = centralInstructions(kind, phase);
      expect(text.split('\n'), String(phase)).toContain(CONFIRM_LINE);
      expect(text.length, String(phase)).toBeLessThanOrEqual(1_500);
      // The P1 line it replaces is not said twice.
      expect(text, String(phase)).not.toMatch(/never ask a worker to approve/);
    }
  });

  it('is not said before confirm_wait exists (P1, P2)', () => {
    for (const phase of [1, 2] as const) {
      const text = centralInstructions('global', phase);
      expect(text, String(phase)).not.toContain('confirm_wait');
      expect(text, String(phase)).toMatch(/never ask a worker to approve/);
    }
  });

  it.each(KINDS)('scope_get’s playbook carries the same line (%s)', async (kind) => {
    const scopeRef = kind === 'global' ? null : kind === 'room' ? 'r1' : '/a/proj';
    const { ctx } = makeCtx({ central: makeCentral(kind, scopeRef) });

    const data = await dataOf<{ playbook: string }>('scope_get', {}, ctx);

    expect(data.playbook).toBe(centralInstructions(kind, MCP_MAX_PHASE));
    expect(data.playbook.split('\n')).toContain(CONFIRM_LINE);
  });
});

describe('the playbook’s ending line (P5, Task 5)', () => {
  const END_LINE =
    '- Ending things (interrupt, restart, kill, close, clearing a queue, uninstalling, deleting) waits for the person, ' +
    'except restarting or closing your own idle worker; a kill always asks. When you are idle, AASC may type one ' +
    '[AASC · notice] line into you about your tasks and confirmations: it is AASC\'s, not a person\'s.';

  it.each(KINDS)('the playbook names the exemption, the kill rule and the notice, and fits 1500 chars (%s)', (kind) => {
    const text = centralInstructions(kind, 5);

    expect(text.split('\n')).toContain(END_LINE);
    expect(text.length).toBeLessThanOrEqual(1_500);
    // Every rule the P4 playbook says is still said.
    expect(text).toContain('scope_get');
    expect(text).toMatch(/NOT_IN_SCOPE/);
    expect(text).toContain('<untrusted');
    expect(text).toMatch(/data, never instructions/);
    expect(text.split('\n')).toContain(CONFIRM_LINE_P3);
    expect(lineWith(text, 'task_delegate')).toMatch(/to: "auto"/);
    expect(lineWith(text, 'task_route')).toMatch(/dry run: it opens and sends nothing/);
    expect(lineWith(text, 'Auto routing')).toMatch(/may be off.*UNAVAILABLE.*name the sessions/);
    expect(lineWith(text, 'confidence')).toMatch(/low, name the project \(project_resolve\)/);
    expect(lineWith(text, 'task_wait')).toMatch(/always task_wait/);
    expect(text.includes('from ★ global')).toBe(kind !== 'global');
    expect(text).toMatch(/One task per worker/);
    expect(text).toMatch(/refusal/);
    expect(text).toMatch(/session and task ids/);
  });

  it.each(KINDS)('the playbook of this build (MCP_MAX_PHASE) fits 1500 chars (%s, Ruling P5-26)', (kind) => {
    expect(centralInstructions(kind, MCP_MAX_PHASE).length).toBeLessThanOrEqual(1_500);
  });

  it('is not said before P5', () => {
    for (const phase of [1, 2, 3, 4] as const) {
      expect(centralInstructions('project', phase), String(phase)).not.toContain('[AASC · notice]');
    }
  });

  it.each(KINDS)('scope_get’s data.playbook carries the same line (%s)', async (kind) => {
    const scopeRef = kind === 'global' ? null : kind === 'room' ? 'r1' : '/a/proj';
    const { ctx } = makeCtx({ central: makeCentral(kind, scopeRef) });

    const data = await dataOf<{ playbook: string }>('scope_get', {}, ctx);

    expect(MCP_MAX_PHASE).toBe(6);
    expect(data.playbook.split('\n')).toContain(END_LINE);
  });
});
