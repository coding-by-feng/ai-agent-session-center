// test/mcp/phoneAnswerable.test.ts — the one rule for "may a paired phone answer this card" (server/mcp/phoneAnswerable.ts,
// Rulings P5-15, P5-25, P5-36): a tool listed in PHONE_ANSWERABLE, the central's card shared, and the target shared when
// the card has one (or none, for a tool that needs none). Pure: the caller hands in what it sees.
import { describe, expect, it } from 'vitest';
import type { Session } from '../../src/types/session.js';
import { PHONE_ANSWERABLE, phoneMayAnswer, shareable, type PhoneAnswerDeps, type PhoneCard } from '../../server/mcp/phoneAnswerable.js';
import { allTools } from '../../server/mcp/registry.js';
import { makeSession } from './toolHarness.js';

const CENTRAL_CARD = makeSession('central-card');
const TARGET = makeSession('target-1');

function depsOf(shared: readonly string[], sessions: readonly Session[] = [CENTRAL_CARD, TARGET]): PhoneAnswerDeps {
  return {
    getSession: (id) => sessions.find((s) => s.sessionId === id) ?? null,
    centralCard: (centralId) => (centralId === 'central-1' ? CENTRAL_CARD : null),
    isShared: (id) => shared.includes(id),
  };
}

const card = (over: Partial<PhoneCard> = {}): PhoneCard => ({
  tool: 'session_kill',
  centralId: 'central-1',
  targetSessionId: 'target-1',
  ...over,
});

describe('PHONE_ANSWERABLE', () => {
  it('lists exactly the tools a phone could already do itself, and none of the Mac-only ones', () => {
    expect([...PHONE_ANSWERABLE.keys()].sort()).toEqual(
      [
        'note_delete',
        'queue_clear',
        'session_close',
        'session_interrupt',
        'session_kill',
        'session_restart',
        'snippet_create',
        'snippet_delete',
        'snippet_rename',
      ].sort(),
    );
    for (const macOnly of ['session_set_shared', 'resource_uninstall', 'history_delete', 'agenda_delete']) {
      expect(PHONE_ANSWERABLE.has(macOnly)).toBe(false);
    }
  });

  it('no P6 tool is phone-answerable (P6-5: the phone profile allows no cloud write)', () => {
    const p6 = allTools().filter((t) => t.phase === 6);
    expect(p6.length).toBe(25);
    expect(p6.filter((t) => PHONE_ANSWERABLE.has(t.name)).map((t) => t.name)).toEqual([]);
    expect([...PHONE_ANSWERABLE.keys()].filter((n) => n.startsWith('cloud_') || n.startsWith('remote_'))).toEqual([]);
  });
});

describe('shareable', () => {
  const both = depsOf(['central-card', 'target-1']);

  it('passes a listed tool whose central card and target are both shared', () => {
    expect(shareable(card(), both)).toBe(true);
  });

  it('refuses a Mac-only tool, an unshared central card, an unshared or unknown target', () => {
    expect(shareable(card({ tool: 'resource_uninstall' }), both)).toBe(false);
    expect(shareable(card(), depsOf(['target-1']))).toBe(false);
    expect(shareable(card(), depsOf(['central-card']))).toBe(false);
    expect(shareable(card({ targetSessionId: 'nobody' }), depsOf(['central-card', 'nobody']))).toBe(false);
    expect(shareable(card({ centralId: 'central-9' }), both)).toBe(false);
  });

  it('a card with no target passes only for a tool that needs none', () => {
    expect(shareable(card({ targetSessionId: null }), both)).toBe(false);
    expect(shareable(card({ tool: 'snippet_delete', targetSessionId: null }), both)).toBe(true);
  });
});

describe('phoneMayAnswer', () => {
  it('only while the record is pending', () => {
    const both = depsOf(['central-card', 'target-1']);
    expect(phoneMayAnswer({ ...card(), state: 'pending' }, both)).toBe(true);
    for (const state of ['allowed', 'denied', 'expired'] as const) {
      expect(phoneMayAnswer({ ...card(), state }, both)).toBe(false);
    }
  });
});
