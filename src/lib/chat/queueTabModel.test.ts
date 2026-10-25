// queueTabModel.test.ts — the phone Queue tab's model (AASC-47): groups in the
// desktop's order, who sends queued prompts, item words, and what ⚡ does.
import { describe, it, expect } from 'vitest';
import type { DevicePresence, Session } from '@/types';
import type { QueueItem } from '@/stores/queueStore';
import { DEFAULT_AUTOMATION } from '@/stores/queueStore';
import { automationWords, dropIndex, itemSummary, moveId, promptLine, queueGroups, sendNowPlan, senderLine, waitingBlocker } from './queueTabModel';

const sess = (id: string, over: Partial<Session> = {}) =>
  ({ sessionId: id, status: 'idle', title: id, projectName: id, lastActivityAt: 0, ...over }) as unknown as Session;
const item = (id: number, over: Partial<QueueItem> = {}): QueueItem =>
  ({ id, sessionId: 's', text: `prompt ${id}`, position: id, createdAt: 0, ...over });
const device = (clientId: string, over: Partial<DevicePresence> = {}): DevicePresence =>
  ({ clientId, label: clientId, address: '', isLocal: false, connections: 1, connectedAt: 0, lastSeenAt: 0, ...over });

describe('queueGroups', () => {
  it('lists only visible sessions with queued prompts, in the desktop order, ended last', () => {
    const sessions = new Map([
      ['idle', sess('idle', { status: 'idle' })],
      ['ask', sess('ask', { status: 'approval' })],
      ['gone', sess('gone', { status: 'ended' })],
      ['empty', sess('empty')],
    ]);
    const queues = new Map<string, QueueItem[]>([
      ['idle', [item(2, { position: 1 }), item(1, { position: 0 })]],
      ['ask', [item(3)]],
      ['gone', [item(4)]],
      ['hidden', [item(5)]],
    ]);
    const groups = queueGroups(queues, sessions);
    expect(groups.map((g) => g.session.sessionId)).toEqual(['ask', 'idle', 'gone']);
    expect(groups[1].items.map((i) => i.id)).toEqual([1, 2]);
  });
});

describe('senderLine', () => {
  it('says the Mac sends queued prompts while AASC is open there', () => {
    const line = senderLine({ received: true, workspaceWriter: 'mac', devices: [device('mac', { isLocal: true, label: 'MacBook' }), device('me')] }, 'me');
    expect(line.tone).toBe('ok');
    expect(line.title).toBe('Your Mac sends queued prompts');
    expect(line.detail).toMatch(/AASC is open on your Mac/);
  });

  it('asks to open AASC on the Mac when no writer is connected', () => {
    const line = senderLine({ received: true, workspaceWriter: null, devices: [device('me')] }, 'me');
    expect(line).toMatchObject({ tone: 'warning', title: 'Open AASC on your Mac' });
    // A writer id with no connected device is the same thing.
    expect(senderLine({ received: true, workspaceWriter: 'mac', devices: [device('me')] }, 'me').title).toBe('Open AASC on your Mac');
  });

  it('names another device that writes, and this one when it does', () => {
    expect(senderLine({ received: true, workspaceWriter: 'ipad', devices: [device('ipad', { label: 'iPad' })] }, 'me').title).toBe('iPad sends queued prompts');
    expect(senderLine({ received: true, workspaceWriter: 'me', devices: [device('me')] }, 'me').title).toBe('This device sends queued prompts');
  });

  it('waits for presence before it says anything definite', () => {
    expect(senderLine({ received: false, workspaceWriter: null, devices: [] }, 'me').title).toMatch(/Checking/);
  });
});

describe('item words', () => {
  it('describes loops, schedules, chains and photos (a pause is the row\'s Paused pill, not a word here)', () => {
    expect(itemSummary(item(1))).toBe('');
    expect(itemSummary(item(1, { type: 'loop', intervalMs: 600_000 }))).toBe('Every 10 min');
    expect(itemSummary(item(1, { type: 'loop', intervalMs: 7_200_000, disabled: true }))).toBe('Every 2 h');
    expect(itemSummary(item(1, { beforeChain: [{ id: 1, text: '/clear' }], afterChain: [{ id: 2, text: '/compact' }] }))).toBe('3 steps');
    expect(itemSummary(item(1, { images: [{ name: 'a', dataUrl: '' }] }))).toBe('1 photo');
    expect(itemSummary(item(1, { type: 'schedule' }))).toBe('Scheduled');
    expect(itemSummary(item(1, { execState: 'main', beforeChain: [{ id: 1, text: 'x' }] }))).toBe('2 steps · running now');
  });

  it('shows the first line of a prompt', () => {
    expect(promptLine(item(1, { text: '\n  fix it\nthen test' }))).toBe('fix it');
    expect(promptLine(item(1, { text: 'one\\ntwo' }))).toBe('one');
    expect(promptLine(item(1, { text: '', images: [{ name: 'a', dataUrl: '' }] }))).toBe('Photos only');
  });

  it('says the session\'s automation in words, Auto-Enter first like the session\'s own queue', () => {
    expect(automationWords(DEFAULT_AUTOMATION)).toBe('Auto-Enter on · Auto-send on');
    expect(automationWords({ ...DEFAULT_AUTOMATION, autoEnter: false })).toBe('Auto-Enter off · Auto-send on');
    expect(automationWords({ ...DEFAULT_AUTOMATION, paused: true })).toBe('Paused');
  });
});

describe('waitingBlocker', () => {
  it('blocks a send while the session waits on an approval or a question', () => {
    expect(waitingBlocker({ status: 'approval' })).toBe('Answer the waiting approval first.');
    expect(waitingBlocker({ status: 'input' })).toBe('Answer the waiting question first.');
    // A structured request outranks a status that hasn't caught up yet.
    expect(waitingBlocker({ status: 'working', pendingRequest: { kind: 'permission' } as never })).toBe('Answer the waiting approval first.');
    expect(waitingBlocker({ status: 'working', pendingRequest: { kind: 'question' } as never })).toBe('Answer the waiting question first.');
    expect(waitingBlocker({ status: 'working', pendingRequest: { kind: 'plan' } as never })).toBe('Answer the waiting plan first.');
    expect(waitingBlocker({ status: 'waiting' })).toBeNull();
    expect(waitingBlocker({ status: 'working', pendingRequest: null })).toBeNull();
  });
});

describe('sendNowPlan', () => {
  const run = { paused: false };

  it('refuses every kind while the session waits on an approval or a question', () => {
    for (const it of [item(1), item(2, { type: 'loop', intervalMs: 60_000 }), item(3, { beforeChain: [{ id: 1, text: '/clear' }] })]) {
      expect(sendNowPlan(it, run, { status: 'approval' })).toEqual({ kind: 'refuse', reason: 'Answer the waiting approval first.' });
      expect(sendNowPlan(it, run, { status: 'input' })).toEqual({ kind: 'refuse', reason: 'Answer the waiting question first.' });
    }
  });

  it('types a plain prompt straight away, even with the queue paused', () => {
    expect(sendNowPlan(item(1), run)).toEqual({ kind: 'send' });
    expect(sendNowPlan(item(1), { paused: true })).toEqual({ kind: 'send' });
  });

  it('starts a chain, loop or schedule on the Mac, and resumes one parked mid-way', () => {
    expect(sendNowPlan(item(1, { type: 'loop', intervalMs: 60_000 }), run)).toEqual({ kind: 'start', steps: 1 });
    expect(sendNowPlan(item(1, { beforeChain: [{ id: 1, text: '/clear' }] }), run)).toEqual({ kind: 'start', steps: 2 });
    expect(sendNowPlan(item(1, { type: 'loop', execState: 'after', afterChain: [{ id: 1, text: 'x' }] }), run)).toEqual({ kind: 'resume' });
  });

  it('refuses a paused prompt or a paused session\'s chain, saying why', () => {
    expect(sendNowPlan(item(1, { disabled: true }), run)).toMatchObject({ kind: 'refuse' });
    expect(sendNowPlan(item(1, { type: 'loop' }), { paused: true })).toMatchObject({ kind: 'refuse', reason: expect.stringMatching(/paused/) });
  });
});

describe('dropIndex', () => {
  it('lands a held row after every row whose centre it passed', () => {
    const mids = [32, 96, 160];
    expect(dropIndex(mids, 0, 0)).toBe(0);
    expect(dropIndex(mids, 0, 70)).toBe(1);
    expect(dropIndex(mids, 0, 140)).toBe(2);
    expect(dropIndex(mids, 2, -70)).toBe(1);
    expect(dropIndex(mids, 2, -200)).toBe(0);
  });

  it('counts rows of different heights by their centres', () => {
    // Row 1 is tall (a summary line): its centre is further down.
    const mids = [28, 112, 196];
    expect(dropIndex(mids, 0, 60)).toBe(0);
    expect(dropIndex(mids, 0, 90)).toBe(1);
  });
});

describe('moveId', () => {
  it('moves an id and clamps the target', () => {
    expect(moveId([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveId([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveId([1, 2, 3], 1, 9)).toEqual([1, 3, 2]);
    expect(moveId([1, 2, 3], 5, 0)).toEqual([1, 2, 3]);
  });
});
