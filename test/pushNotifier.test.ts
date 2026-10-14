// test/pushNotifier.test.ts — AASC-16 (Mac side): which session changes reach a phone, and what they carry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  decidePush, settleMs, stillApplies, cooldownMs, type PushView,
} from '../server/push/pushRules.js';
import { createPushNotifier, buildPushMessage, type PushMessage } from '../server/push/pushNotifier.js';
import type { Session } from '../src/types/session.js';

const v = (status: string, extra: Partial<PushView> = {}): PushView => ({ status, hasInterruption: false, ...extra });

describe('decidePush', () => {
  it.each([
    [v('working'), v('approval'), 'approval'],
    [v('working'), v('input'), 'input'],
    [v('working'), v('waiting'), 'finished'],
    [v('prompting'), v('waiting'), 'finished'],
    [v('waiting'), v('waiting', { hasInterruption: true }), 'interrupted'],
    [v('working'), v('waiting', { hasInterruption: true }), 'interrupted'],
  ] as const)('%o → %o is %s', (prev, next, kind) => {
    expect(decidePush(prev, next)).toBe(kind);
  });

  it.each([
    [v('approval'), v('approval')],
    [v('waiting'), v('waiting')],
    [v('waiting'), v('idle')],
    [v('ended'), v('waiting')],
    [v('idle'), v('working')],
  ])('%o → %o needs no notification', (prev, next) => {
    expect(decidePush(prev, next)).toBeNull();
  });

  it('never notifies on a first sighting (startup restores every session)', () => {
    expect(decidePush(undefined, v('approval'))).toBeNull();
  });
});

describe('settle, still-applies and cooldown rules', () => {
  it('sends a real permission request at once and waits out the timeout guess', () => {
    expect(settleMs('approval', v('approval', { approvalSource: 'permission_request' }))).toBe(0);
    expect(settleMs('approval', v('approval', { approvalSource: 'notification' }))).toBe(0);
    expect(settleMs('approval', v('approval', { approvalSource: 'timer' }))).toBe(10_000);
    expect(settleMs('approval', v('approval'))).toBe(10_000);
    expect(settleMs('input', v('input'))).toBe(5_000);
    expect(settleMs('finished', v('waiting'))).toBe(8_000);
    expect(settleMs('interrupted', v('waiting'))).toBe(3_000);
  });

  it('a finished turn no longer applies once it was interrupted or the queue moved on', () => {
    expect(stillApplies('finished', v('waiting'))).toBe(true);
    expect(stillApplies('finished', v('idle'))).toBe(true);
    expect(stillApplies('finished', v('prompting'))).toBe(false);
    expect(stillApplies('finished', v('waiting', { hasInterruption: true }))).toBe(false);
  });

  it('cooldowns grow with how routine the event is', () => {
    expect(cooldownMs('approval')).toBe(60_000);
    expect(cooldownMs('finished')).toBe(120_000);
    expect(cooldownMs('interrupted')).toBe(300_000);
  });
});

// ── The notifier with injected clock, timers and sink ──────────────────────────────────────────────

const SECRET_PROMPT = 'deploy with AWS_SECRET_ACCESS_KEY=abc123';
const SECRET_DETAIL = 'rm -rf / --token=sk-live-123';

function session(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1', status: 'working', title: 'Fix login bug', projectName: 'agent-manager', remoteVisible: true,
    pendingTool: 'Bash', pendingToolDetail: SECRET_DETAIL, currentPrompt: SECRET_PROMPT, interruption: null, muted: false,
    ...over,
  } as unknown as Session;
}

let clock: number;
let timers: Array<{ at: number; fn: () => void; cancelled: boolean }>;
let live: Map<string, Session>;
let sent: PushMessage[];
let sinkEnabled: boolean;
let errors: string[];
let notifier: ReturnType<typeof createPushNotifier>;

function advance(ms: number): void {
  clock += ms;
  for (const t of timers.filter((x) => !x.cancelled && x.at <= clock)) {
    t.cancelled = true;
    t.fn();
  }
}

/** Put a session in the live store and broadcast it, as the server does. */
function update(over: Partial<Session>): void {
  const next = session({ ...live.get('s1'), ...over });
  live.set(next.sessionId, next);
  notifier.onBroadcast({ type: 'session_update', session: next });
}

beforeEach(() => {
  clock = 1_000_000;
  timers = [];
  live = new Map();
  sent = [];
  sinkEnabled = true;
  errors = [];
  notifier = createPushNotifier({
    getSession: (id) => live.get(id) ?? null,
    canNotify: (s) => s.remoteVisible === true,
    sink: () => (sinkEnabled ? { notify: async (m) => { sent.push(m); } } : null),
    now: () => clock,
    setTimer: (fn, ms) => { const t = { at: clock + ms, fn, cancelled: false }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { cancelled: boolean }).cancelled = true; },
    onError: (m) => errors.push(m),
  });
  update({ status: 'working' }); // first sighting
});

describe('createPushNotifier', () => {
  it('a real permission request notifies at once, with the title and tool name only', () => {
    update({ status: 'approval', approvalSource: 'permission_request' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'approval', sessionRef: 's1', title: 'Fix login bug', toolName: 'Bash', collapseKey: 's1' });
    const json = JSON.stringify(sent[0]);
    expect(json).not.toContain(SECRET_PROMPT);
    expect(json).not.toContain('sk-live-123');
  });

  it('the timeout guess waits 10 s and is dropped when the command finishes first', () => {
    update({ status: 'approval', approvalSource: 'timer' });
    advance(8_000);
    update({ status: 'working' }); // PostToolUse arrived: it was an auto-approved long command
    advance(5_000);
    expect(sent).toHaveLength(0);
  });

  it('the timeout guess still notifies when the session is really stuck', () => {
    update({ status: 'approval', approvalSource: 'timer' });
    advance(10_000);
    expect(sent.map((m) => m.kind)).toEqual(['approval']);
  });

  it('finished waits 8 s and is cancelled when a queued prompt fires', () => {
    update({ status: 'waiting' });
    advance(2_000);
    update({ status: 'prompting' });
    advance(10_000);
    expect(sent).toHaveLength(0);
  });

  it('a 529 ends with interrupted, not finished', () => {
    update({ status: 'waiting' });
    advance(1_000);
    update({ interruption: { line: 'API Error: 529 overloaded', kind: 'overloaded', detectedAt: clock } as Session['interruption'] });
    advance(10_000);
    expect(sent.map((m) => m.kind)).toEqual(['interrupted']);
  });

  it('a hidden session never notifies', () => {
    update({ remoteVisible: false });
    update({ status: 'approval', approvalSource: 'permission_request' });
    update({ status: 'working' });
    update({ status: 'waiting' });
    advance(60_000);
    expect(sent).toHaveLength(0);
  });

  it('a muted session stays silent', () => {
    update({ muted: true });
    update({ status: 'approval', approvalSource: 'permission_request' });
    expect(sent).toHaveLength(0);
  });

  it('with no backend connected nothing is sent and nothing throws', () => {
    sinkEnabled = false;
    expect(() => update({ status: 'approval', approvalSource: 'permission_request' })).not.toThrow();
    expect(sent).toHaveLength(0);
  });

  it('respects the cooldown, then notifies again', () => {
    update({ status: 'approval', approvalSource: 'permission_request' });
    update({ status: 'working' });
    advance(30_000);
    update({ status: 'approval', approvalSource: 'permission_request' });
    expect(sent).toHaveLength(1);
    update({ status: 'working' });
    advance(31_000);
    update({ status: 'approval', approvalSource: 'permission_request' });
    expect(sent).toHaveLength(2);
  });

  it('keeps one pending notification per session and kind', () => {
    update({ status: 'input' });
    update({ status: 'input', pendingTool: 'AskUserQuestion' });
    advance(6_000);
    expect(sent.map((m) => m.kind)).toEqual(['input']);
    expect(notifier.pendingCount()).toBe(0);
  });

  it('a failed send is reported without the title', async () => {
    notifier = createPushNotifier({
      getSession: (id) => live.get(id) ?? null,
      canNotify: () => true,
      sink: () => ({ notify: async () => { throw new Error('backend offline'); } }),
      now: () => clock,
      onError: (m) => errors.push(m),
    });
    notifier.onBroadcast({ type: 'session_update', session: live.get('s1') });
    update({ status: 'approval', approvalSource: 'permission_request' });
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toEqual(['push approval failed: backend offline']);
    expect(errors.join(' ')).not.toContain('Fix login bug');
  });

  it('ignores other broadcasts', () => {
    notifier.onBroadcast({ type: 'queue_update' });
    notifier.onBroadcast({ type: 'session_update' });
    expect(sent).toHaveLength(0);
  });
});

describe('buildPushMessage', () => {
  it('falls back to the project name, strips control characters and caps the title', () => {
    const m = buildPushMessage('finished', session({ title: '', projectName: 'proj\u0007' + 'x'.repeat(200) }), 'm1')!;
    expect(m.title.startsWith('proj x')).toBe(true);
    expect(m.title.length).toBeLessThanOrEqual(80);
    expect(m.toolName).toBeUndefined(); // only approval/input carry a tool name
  });

  it('refuses a session id the backend schema would reject', () => {
    expect(buildPushMessage('approval', session({ sessionId: 'has spaces' }), 'm1')).toBeNull();
  });

  it('keeps only safe characters of the tool name', () => {
    const m = buildPushMessage('approval', session({ pendingTool: 'mcp__github__create_issue <script>' }), 'm1')!;
    expect(m.toolName).toBe('mcp__github__create_issuescript');
  });
});
