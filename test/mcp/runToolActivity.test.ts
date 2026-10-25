// test/mcp/runToolActivity.test.ts — two rows runTool (server/mcp/runTool.ts) writes to the activity log: a tool's
// own refusal of a session (a SteerRefusal it throws itself, like the unattended lock's DENIED) names that session
// (K5), and a call whose every target the policy refused writes no `ok` row of its own beside those refusals (A-M3).
// The rest of the activity log's rules: activity.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import { SteerRefusal } from '../../server/mcp/policy.js';
import type { ToolDef } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { runCleanups } from './endpointHarness.js';
import { fakeClient, makeSession, NOW } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

afterEach(runCleanups);

/** A tool of the test's own: a P2 steers tool by default. */
const tool = (over: Partial<ToolDef> & Pick<ToolDef, 'name' | 'run'>): ToolDef => ({
  toolset: 'prompts',
  title: `Stub ${over.name}`,
  description: 'A stand-in.',
  risk: 'steers',
  phase: 2,
  input: {},
  ...over,
});

/** A global central with its card, and two hands-off workers. */
function world() {
  const registry = createCentralRegistry();
  const central = registry.mint(globalInput());
  const sessions: Session[] = [
    makeSession('card-1', { terminalId: 'term-card', central: { centralId: central.centralId, kind: 'global', scopeRef: null } }),
    makeSession('w1', { terminalId: 'term-w1', status: 'waiting', handsOff: true }),
    makeSession('w2', { terminalId: 'term-w2', status: 'waiting', handsOff: true }),
  ];
  const t = testDeliver({ sessions: () => sessions });
  const deps: McpDeps = {
    registry,
    client: () => fakeClient(),
    sessions: () => sessions,
    rooms: () => [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    deliver: t.deliver,
  };
  const call = (def: ToolDef) => runTool(def, {}, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
  const rows = () => t.activity.listActivity().reverse().map((r) => [r.targetSessionId, r.outcome, r.detail?.code ?? null]);
  return { call, rows };
}

const failureOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => null, (e: unknown) => e);

describe('runTool’s activity rows', () => {
  it('logs a tool’s own DENIED refusal with the session it names (K5)', async () => {
    const w = world();
    const locked = tool({
      name: 'demo_enable',
      run: async () => {
        throw new SteerRefusal('DENIED', 'A central does not start unattended runs yet.', 'Ask the person.', 'w1');
      },
    });
    const plain = tool({
      name: 'demo_refuse',
      run: async () => {
        throw new ToolError('INVALID', 'That is not a thing.', 'Try another.');
      },
    });

    expect(await failureOf(w.call(locked))).toMatchObject({ code: 'DENIED' });
    expect(await failureOf(w.call(plain))).toMatchObject({ code: 'INVALID' });

    expect(w.rows()).toEqual([
      ['w1', 'refused', 'DENIED'],
      [null, 'refused', 'INVALID'],
    ]);
  });

  it('writes no ok row for a fan-out whose every target was refused (A-M3)', async () => {
    const w = world();
    const fanOut = tool({
      name: 'demo_fan_out',
      run: async (_args, ctx) => {
        const sent: string[] = [];
        for (const s of ctx.sessions().filter((x) => x.sessionId !== 'card-1')) {
          try {
            ctx.mayDrive(s);
            sent.push(s.sessionId);
          } catch {
            // Each refusal is that session's result; the call answers with what it did.
          }
        }
        return { data: sent, summary: 'sent to none', activity: sent.map((id) => ({ summary: 'Sent', targetSessionId: id })) };
      },
    });

    await w.call(fanOut);

    expect(w.rows()).toEqual([
      ['w1', 'refused', 'HANDS_OFF'],
      ['w2', 'refused', 'HANDS_OFF'],
    ]);
  });

  it('still writes its title row for a call that gave no notes and was refused nothing', async () => {
    const w = world();
    const quiet = tool({ name: 'demo_quiet', run: async () => ({ data: null, summary: 'done' }) });

    await w.call(quiet);

    expect(w.rows()).toEqual([[null, 'ok', null]]);
  });
});
