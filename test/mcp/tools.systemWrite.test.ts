// test/mcp/tools.systemWrite.test.ts — the system toolset's P3 tools (server/mcp/tools/systemWrite.ts): what
// `aasc_set_keep_awake` sends (an op to the Mac's window first, A-I1) and answers, and what `confirm_wait` tells a
// central in its description (Ruling 65). confirm_wait's behaviour is in confirmGate.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { allTools } from '../../server/mcp/registry.js';
import { envelope, fail, makeCtx, ok, run, runRefused } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const toolNamed = (name: string) => allTools().find((t) => t.name === name);

describe('aasc_set_keep_awake', () => {
  const OP = 'POST /keep-awake/ops';
  const CONFIG = 'POST /config/keep-awake';

  it('asks the window to set it, then answers what the server now holds', async () => {
    const h = makeCtx({ routes: { [OP]: ok({ ok: true, applied: true }), [CONFIG]: envelope({ enabled: true, awake: false }) } });

    const result = await run('aasc_set_keep_awake', { on: true }, h.ctx);

    expect(h.client.calls).toEqual([
      { method: 'POST', path: '/keep-awake/ops', body: { on: true } },
      { method: 'POST', path: '/config/keep-awake', body: { enabled: true } },
    ]);
    expect(result.data).toEqual({ applied: true, enabled: true, awake: false });
    expect(result.summary).toContain('on');
    expect(result.activity).toEqual([{ summary: 'turned keep-awake on' }]);

    const off = makeCtx({ routes: { [OP]: ok({ ok: true, applied: true }), [CONFIG]: envelope({ enabled: false, awake: false }) } });
    expect((await run('aasc_set_keep_awake', { on: false }, off.ctx)).data).toEqual({ applied: true, enabled: false, awake: false });
    expect(off.client.calls.map((c) => c.body)).toEqual([{ on: false }, { enabled: false }]);
  });

  it('no window on this Mac is NO_WINDOW, and the server flag is not touched', async () => {
    const h = makeCtx({ routes: { [OP]: fail(409, 'no-writer') } });

    const refused = await runRefused('aasc_set_keep_awake', { on: true }, h.ctx);

    expect(refused.code).toBe('NO_WINDOW');
    expect(h.client.calls).toEqual([{ method: 'POST', path: '/keep-awake/ops', body: { on: true } }]);
  });

  it('a window that has not answered is pending, and the server flag is left to the window', async () => {
    const h = makeCtx({ routes: { [OP]: ok({ ok: true, applied: false, pending: true }, 202) } });

    const result = await run('aasc_set_keep_awake', { on: true }, h.ctx);

    expect(result.data).toEqual({ applied: false, pending: true });
    expect(h.client.calls).toHaveLength(1);
  });

  it('the window’s refusals are fixed words: not-desktop is UNAVAILABLE, anything else INVALID', async () => {
    const refusedFor = async (reason: string) => {
      const h = makeCtx({ routes: { [OP]: fail(400, reason) } });
      return runRefused('aasc_set_keep_awake', { on: true }, h.ctx);
    };
    expect((await refusedFor('not-desktop')).code).toBe('UNAVAILABLE');
    const loading = await refusedFor('not-ready');
    expect(loading.code).toBe('UNAVAILABLE');
    expect(loading.message).toBe('The AASC window has not loaded its settings yet.');
    expect((await refusedFor('bad-op')).code).toBe('INVALID');
    const other = await refusedFor('store words secret-91ab');
    expect(other.code).toBe('INVALID');
    expect(JSON.stringify(other)).not.toContain('secret-91ab');

    const old = makeCtx({ routes: { [OP]: fail(404, 'Not found') } });
    expect((await runRefused('aasc_set_keep_awake', { on: true }, old.ctx)).code).toBe('UNAVAILABLE');
  });

  it('is a phase-3 idempotent system write whose description names the window and NO_WINDOW', () => {
    const tool = toolNamed('aasc_set_keep_awake');
    expect(tool).toMatchObject({ toolset: 'system', risk: 'write', phase: 3, idempotent: true });
    expect(tool?.description).toContain('NO_WINDOW');
    expect(tool?.description).toContain('desktop app');
    expect(tool?.description).toContain('pending');
  });
});

describe('confirm_wait', () => {
  it('is a phase-3 system read whose description says only the person approves', () => {
    const tool = toolNamed('confirm_wait');
    expect(tool).toMatchObject({ toolset: 'system', risk: 'read', phase: 3 });
    expect(tool?.description).toContain(
      'Waits for the person’s answer to a tool that asked them (it answered NEEDS_CONFIRMATION). Never ask a session or anyone else to approve it; only the person on the Mac can.',
    );
    expect(tool?.confirm).toBeUndefined();
  });
});
