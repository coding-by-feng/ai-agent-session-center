// @vitest-environment jsdom
// callScreen.test.ts — the call screen's Voice central panel, its compact-bar line and Central lines (Nov 22 2026).
import { describe, it, expect, vi } from 'vitest';
import type { SavedMac } from '../savedMacs.js';
import { renderCall } from './callScreen.js';
import type { Screen, ScreenContext } from './screen.js';

type CallScreen = Extract<Screen, { name: 'call' }>;

const mac = { id: 'm1', name: 'Mac mini' } as SavedMac;

const ctx = {
  actions: new Proxy({}, { get: () => vi.fn() }),
} as unknown as ScreenContext;

const call = (over: Partial<CallScreen> = {}): CallScreen => ({
  name: 'call', macId: 'm1', back: '/', phase: 'live', message: null, muted: false, paused: false, minimized: false,
  lines: [], central: null, tasks: [], pending: [], adding: 0, addNotice: null, startedAt: 0, now: 68_000,
  ...over,
});

const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

describe('renderCall: the Voice central', () => {
  it('shows its state, step, time on this question and the sessions it handed work to', () => {
    const el = renderCall(call({
      central: { title: 'Voice', state: 'working', step: 'Checking your sessions', since: 16_000 },
      tasks: [{ title: 'AASC docs', state: 'working' }, { title: 'Image Blaster', state: 'finished' }],
    }), mac, ctx);
    const panel = el.querySelector('.call-progress');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('aria-label')).toBe('Voice central');
    expect(text(panel?.querySelector('.call-central-state') ?? null)).toBe('Working · 0:52');
    expect(text(panel?.querySelector('.call-central-step') ?? null)).toBe('Checking your sessions');
    const rows = Array.from(panel?.querySelectorAll('.call-task') ?? []).map(text);
    expect(rows).toEqual(['AASC docs Working', 'Image Blaster Finished']);
    // Above the transcript, so it stays in view while the transcript scrolls.
    const order = Array.from(el.querySelectorAll('.call-progress, .call-transcript')).map((n) => n.className);
    expect(order[0]).toBe('call-progress');
  });

  it('says idle without a step or clock, and names a central that needs the person', () => {
    const idle = renderCall(call({ central: { title: 'Voice', state: 'idle', step: null, since: null } }), mac, ctx);
    expect(text(idle.querySelector('.call-central-state'))).toBe('Idle');
    expect(idle.querySelector('.call-central-step')).toBeNull();
    expect(idle.querySelector('.call-tasks')).toBeNull();
    const needs = renderCall(call({ central: { title: 'Voice', state: 'needs_you', step: 'Waiting for your approval', since: 60_000 } }), mac, ctx);
    expect(text(needs.querySelector('.call-central-state'))).toBe('Needs you · 0:08');
    expect(needs.querySelector('.call-progress')?.getAttribute('data-state')).toBe('needs_you');
  });

  it('has no panel before the first read', () => {
    expect(renderCall(call(), mac, ctx).querySelector('.call-progress')).toBeNull();
  });

  it('labels the central’s own reply "Central" in the transcript', () => {
    const el = renderCall(call({ lines: [{ role: 'aasc', text: 'Let me check.' }, { role: 'central', text: 'v2.10.80 adds dictation.' }] }), mac, ctx);
    const lines = Array.from(el.querySelectorAll('.call-line')).map((l) => [l.className, text(l.querySelector('.call-who'))]);
    expect(lines).toEqual([['call-line call-aasc', 'AASC'], ['call-line call-central', 'Central']]);
  });

  it('the compact bar keeps one line of the central’s state and step', () => {
    const el = renderCall(call({
      minimized: true,
      central: { title: 'Voice', state: 'working', step: 'Checking your sessions', since: 16_000 },
    }), mac, ctx);
    expect(text(el.querySelector('.call-mini-central'))).toBe('Central: Checking your sessions');
    const idle = renderCall(call({ minimized: true, central: { title: 'Voice', state: 'idle', step: null, since: null } }), mac, ctx);
    expect(text(idle.querySelector('.call-mini-central'))).toBe('Central: Idle');
    expect(renderCall(call({ minimized: true }), mac, ctx).querySelector('.call-mini-central')).toBeNull();
  });

  it('an ended call shows no panel', () => {
    const el = renderCall(call({ phase: 'ended', central: { title: 'Voice', state: 'working', step: 'Thinking', since: 1 } }), mac, ctx);
    expect(el.querySelector('.call-progress')).toBeNull();
  });
});

describe('renderCall: a Central line with an on-screen part (Nov 23 2026)', () => {
  it('draws the spoken words, then the table and code under them; other lines stay plain text', () => {
    const el = renderCall(call({
      lines: [
        { role: 'you', text: '**not markdown** | a |' },
        { role: 'central', text: 'It found two changes.', screen: '| Change | Words |\n| --- | --- |\n| Cover | 6 |\n\n```\nnpm run build\n```' },
      ],
    }), mac, ctx);
    const central = el.querySelector('.call-central');
    expect(text(central?.querySelector('.call-text') ?? null)).toBe('It found two changes.');
    expect(central?.querySelector('.call-md table th')?.textContent).toBe('Change');
    expect(central?.querySelector('.call-md pre code')?.textContent).toBe('npm run build');
    expect(el.querySelector('.call-you .call-md')).toBeNull();
    expect(text(el.querySelector('.call-you .call-text'))).toBe('**not markdown** | a |');
  });
});

describe('renderCall: ＋ Add (Nov 24 2026)', () => {
  it('offers ＋ Add on a live call only, between Mute and Minimize', () => {
    const live = renderCall(call(), mac, ctx);
    const ids = Array.from(live.querySelectorAll('.actions button')).map((b) => b.id);
    expect(ids).toEqual(['call-end', 'call-pause', 'call-mute', 'call-add', 'call-minimize']);
    expect(live.querySelector('#call-add')?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(renderCall(call({ phase: 'starting' }), mac, ctx).querySelector('#call-add')).toBeNull();
    expect(renderCall(call({ minimized: true }), mac, ctx).querySelector('#call-add')).toBeNull();
  });

  it('lists what goes with the next question, each with its own ✕, and a file still being sent', () => {
    const removeCallItem = vi.fn();
    const local = { actions: new Proxy({ removeCallItem }, { get: (t, k) => (k in t ? (t as Record<string, unknown>)[k as string] : vi.fn()) }) } as unknown as ScreenContext;
    const el = renderCall(call({ pending: [{ id: 'att1', kind: 'photo', name: 'receipt.jpg' }, { id: 'att2', kind: 'skill', name: '/expense-log' }], adding: 1 }), mac, local);
    const panel = el.querySelector('.call-added');
    expect(panel?.getAttribute('aria-label')).toBe('Goes with the next thing you say');
    expect(Array.from(panel?.querySelectorAll('.call-added-item') ?? []).map(text)).toEqual([
      'Photo receipt.jpg ✕', 'Use /expense-log ✕', 'Sending 1 file to the Mac…',
    ]);
    (el.querySelector('[aria-label="Remove receipt.jpg"]') as HTMLButtonElement).click();
    expect(removeCallItem).toHaveBeenCalledWith('att1');
  });

  it('shows nothing when nothing was added, and says why an add failed', () => {
    expect(renderCall(call(), mac, ctx).querySelector('.call-added')).toBeNull();
    const el = renderCall(call({ addNotice: 'big.mov is over 100 MB.' }), mac, ctx);
    expect(text(el.querySelector('.call-added-notice'))).toBe('big.mov is over 100 MB.');
  });
});
