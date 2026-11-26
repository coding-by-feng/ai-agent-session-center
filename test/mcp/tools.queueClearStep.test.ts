// test/mcp/tools.queueClearStep.test.ts — a bare `/clear` as a chain step (Nov 27 2026, Ruling 68). The never-list
// refuses `/clear` everywhere a central's text reaches the queue (Ruling 60), except one place: a step in the before or
// after chain of a loop or a schedule that is switched OFF, in a Claude session that is not the central's own card. A
// prompt that is off waits for a person: in a session the central did not open only the person (or queue_ask_enable's
// card, which spells the clear out) turns it on. The off and loop/schedule checks run inside the write, on the queue it
// writes. Everything else stays refused: the prompt's own text, `/clear x`, other casings, a prompt that is on (also in
// the central's own worker), the central's own card, a session that is not Claude's, and the rest of the never-list.
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { automationOf, item, itemWith, NOW } from './queueFixtures.js';
import { queueWorld, worker } from './queueToolFixtures.js';

const DAY = 86_400_000;

/** 1 once (off, one before step 10), 3 loop (off, one before step 30), 4 schedule (off), 5 loop (on). */
const rows = () => ({
  s1: {
    items: [
      item(1, { position: 0, disabled: true, beforeChain: [{ id: 10, text: 'first step' }] }),
      item(3, { position: 1, type: 'loop', intervalMs: DAY, nextFireAt: NOW + DAY, disabled: true, beforeChain: [{ id: 30, text: '/model opus' }] }),
      item(4, { position: 2, type: 'schedule', runAt: NOW + 3_600_000, nextFireAt: NOW + 3_600_000, disabled: true }),
      item(5, { position: 3, type: 'loop', intervalMs: DAY, nextFireAt: NOW + DAY }),
    ],
    automation: automationOf(),
  },
});

const claude = (id: string, over: Partial<Session> = {}): Session => worker(id, { cliSource: 'claude', projectPath: '/a/proj', ...over });

/** Another session (the lock holds), or the central's own worker (`unlocked`, what the lock lets through there). */
const world = (opts: { unlocked?: boolean; session?: Session } = {}) =>
  queueWorld({ sessions: [opts.session ?? claude('s1')], rows: rows(), unlocked: opts.unlocked === true });

const stepsOf = (w: ReturnType<typeof world>, itemId: number, chain: 'beforeChain' | 'afterChain') =>
  (itemWith(w.store.rows.get('s1')!.items, itemId)[chain] as Array<{ text: string }> | undefined)?.map((s) => s.text) ?? [];

describe('queue_add_step with a bare /clear', () => {
  it('adds it first in the before chain of a loop that is off, in another session', async () => {
    const w = world();
    await w.call('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text: '/clear', position: 0 });
    expect(stepsOf(w, 3, 'beforeChain')).toEqual(['/clear', '/model opus']);
    expect(itemWith(w.store.rows.get('s1')!.items, 3).disabled).toBe(true);
  });

  it('adds it to the after chain of a schedule that is off', async () => {
    const w = world();
    await w.call('queue_add_step', { id: 's1', itemId: 4, chain: 'after', text: '/clear' });
    expect(stepsOf(w, 4, 'afterChain')).toEqual(['/clear']);
  });

  it('asks no catalog for it', async () => {
    const w = world();
    await w.call('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text: '/clear' });
    expect(w.client.calls.filter((c) => c.path === '/commands')).toEqual([]);
  });

  it('allows it in the central’s own worker too, on a prompt that is off', async () => {
    const w = world({ unlocked: true });
    await w.call('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text: '/clear', position: 0 });
    expect(stepsOf(w, 3, 'beforeChain')[0]).toBe('/clear');
  });

  it('refuses it for a once prompt', async () => {
    const w = world();
    const err = await w.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'before', text: '/clear' });
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/loop or a schedule/);
    expect(w.store.writes).toEqual([]);
  });

  it('refuses it for a prompt that is on, in another session (the lock on unattended runs)', async () => {
    const w = world();
    expect((await w.refused('queue_add_step', { id: 's1', itemId: 5, chain: 'before', text: '/clear' })).code).toBe('DENIED');
    expect(w.store.writes).toEqual([]);
  });

  it('refuses it for a prompt that is on, even in the central’s own worker (Ruling 68)', async () => {
    const w = world({ unlocked: true });
    const err = await w.refused('queue_add_step', { id: 's1', itemId: 5, chain: 'before', text: '/clear' });
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/switched off/);
    expect(w.store.writes).toEqual([]);
  });

  it.each(['/clear x', '/clear now please', '/CLEAR', '/Clear'])('refuses %s: only the bare, lowercase command', async (text) => {
    const w = world();
    const err = await w.refused('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text });
    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/never queues/);
    expect(w.store.writes).toEqual([]);
  });

  it.each(['/reset', '/new', '/exit', '/quit', '/logout', '/login', '/permissions', '/hooks', '/mcp', '/config'])(
    'still refuses %s on a loop that is off',
    async (text) => {
      const w = world();
      expect((await w.refused('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text })).message).toMatch(/never queues/);
      expect(w.store.writes).toEqual([]);
    },
  );

  it('refuses it on the central’s own card', async () => {
    const own = claude('s1', { terminalId: 'term-central', central: { centralId: 'central-1', kind: 'global', scopeRef: null } });
    const w = world({ session: own, unlocked: true });
    const err = await w.refused('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text: '/clear' });
    expect(err.code).toBe('INVALID');
    expect(w.store.writes).toEqual([]);
  });

  it('refuses it in a session that is not Claude’s', async () => {
    const w = world({ session: claude('s1', { cliSource: 'codex' }) });
    expect((await w.refused('queue_add_step', { id: 's1', itemId: 3, chain: 'before', text: '/clear' })).message).toMatch(/never queues/);
    expect(w.store.writes).toEqual([]);
  });
});

describe('a bare /clear elsewhere', () => {
  it('queue_edit_step may turn a step of a loop that is off into /clear', async () => {
    const w = world();
    await w.call('queue_edit_step', { id: 's1', itemId: 3, chain: 'before', stepId: 30, text: '/clear' });
    expect(stepsOf(w, 3, 'beforeChain')).toEqual(['/clear']);
  });

  it('queue_edit_step refuses it on a once prompt', async () => {
    const w = world();
    expect((await w.refused('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: '/clear' })).code).toBe('INVALID');
    expect(w.store.writes).toEqual([]);
  });

  it.each([
    ['queue_add_item', { id: 's1', text: '/clear' }],
    ['queue_edit_item', { id: 's1', itemId: 3, text: '/clear' }],
  ] as const)('%s refuses it as a prompt’s own text', async (name, args) => {
    const w = world({ unlocked: true });
    expect((await w.refused(name, args)).message).toMatch(/never queues/);
    expect(w.store.writes).toEqual([]);
  });
});
