import { describe, it, expect } from 'vitest';
import {
  buildCallProgress, centralState, REPLY_SCREEN_MAX, REPLY_SCREEN_LINES, REPLY_TEXT_MAX, stepPhrase, TASKS_SHOWN, type ProgressCentral, type ProgressTask,
} from '../../server/voice/callProgress.js';

const central = (over: Partial<ProgressCentral> = {}): ProgressCentral => ({
  title: 'Voice',
  status: 'working',
  toolLog: [],
  ...over,
});

const task = (over: Partial<ProgressTask> = {}): ProgressTask => ({
  title: 'AASC docs',
  state: 'running',
  createdAt: 1_000,
  ...over,
});

describe('stepPhrase', () => {
  it('turns an AASC tool into plain words', () => {
    expect(stepPhrase('mcp__aasc__session_list')).toBe('Checking your sessions');
    expect(stepPhrase('mcp__aasc__task_delegate')).toBe('Handing the work to a session');
    expect(stepPhrase('mcp__aasc__session_create')).toBe('Opening a new session');
    expect(stepPhrase('mcp__aasc__queue_add_item')).toBe('Updating a queue');
    expect(stepPhrase('aasc.chat_read')).toBe('Reading a session’s chat');
  });

  it('names common agent tools without their inputs', () => {
    expect(stepPhrase('Bash')).toBe('Running a command');
    expect(stepPhrase('exec_command')).toBe('Running a command');
    expect(stepPhrase('Read')).toBe('Reading files');
    expect(stepPhrase('Edit')).toBe('Editing files');
    expect(stepPhrase('WebFetch')).toBe('Reading a web page');
  });

  it('falls back to the tool’s words, never a server or id', () => {
    expect(stepPhrase('mcp__aasc__brand_new_tool')).toBe('Using AASC: brand new tool');
    expect(stepPhrase('mcp__phonedesk__phone_observe')).toBe('Using phonedesk');
    expect(stepPhrase('SomethingElse')).toBe('Working');
  });
});

describe('centralState', () => {
  it('maps a session status to what the call shows', () => {
    expect(centralState('working')).toBe('working');
    expect(centralState('prompting')).toBe('working');
    expect(centralState('approval')).toBe('needs_you');
    expect(centralState('input')).toBe('needs_you');
    expect(centralState('waiting')).toBe('idle');
    expect(centralState('idle')).toBe('idle');
    expect(centralState('ended')).toBe('offline');
    expect(centralState('connecting')).toBe('working');
  });
});

describe('buildCallProgress', () => {
  it('shows the step of the newest tool call since the question was handed over', () => {
    const view = buildCallProgress({
      central: central({ toolLog: [{ tool: 'Read', timestamp: 500 }, { tool: 'mcp__aasc__session_list', timestamp: 2_100 }] }),
      busySince: 2_000,
      callStartedAt: 0,
      now: 5_000,
      tasks: [],
      replies: [],
    });
    expect(view.central).toEqual({ title: 'Voice', state: 'working', step: 'Checking your sessions', elapsedMs: 3_000 });
  });

  it('says it is thinking when nothing ran yet for this question', () => {
    const view = buildCallProgress({
      central: central({ toolLog: [{ tool: 'Read', timestamp: 500 }] }),
      busySince: 2_000,
      callStartedAt: 0,
      now: 5_000,
      tasks: [],
      replies: [],
    });
    expect(view.central?.step).toBe('Thinking');
  });

  it('shows no step while idle and nothing is asked', () => {
    const view = buildCallProgress({
      central: central({ status: 'idle', toolLog: [{ tool: 'Bash', timestamp: 500 }] }),
      busySince: null,
      callStartedAt: 0,
      now: 5_000,
      tasks: [],
      replies: [],
    });
    expect(view.central).toEqual({ title: 'Voice', state: 'idle', step: null, elapsedMs: null });
  });

  it('counts an asked question as working even before the hooks say so', () => {
    const view = buildCallProgress({ central: central({ status: 'idle' }), busySince: 2_000, callStartedAt: 0, now: 5_000, tasks: [], replies: [] });
    expect(view.central?.state).toBe('working');
  });

  it('keeps "needs you" while a question waits on an approval', () => {
    const view = buildCallProgress({ central: central({ status: 'approval' }), busySince: 2_000, callStartedAt: 0, now: 5_000, tasks: [], replies: [] });
    expect(view.central?.state).toBe('needs_you');
    expect(view.central?.step).toBe('Waiting for your approval');
  });

  it('has no central when there is none', () => {
    const view = buildCallProgress({ central: null, busySince: null, callStartedAt: 0, now: 5_000, tasks: [], replies: [] });
    expect(view.central).toBeNull();
  });

  it('lists only the tasks handed out during this call, newest first, capped', () => {
    const tasks = [
      task({ title: 'Before the call', createdAt: 10 }),
      ...Array.from({ length: TASKS_SHOWN + 2 }, (_, i) => task({ title: `T${i}`, createdAt: 2_000 + i, state: i === 0 ? 'done' : 'running' })),
    ];
    const view = buildCallProgress({ central: central(), busySince: null, callStartedAt: 1_000, now: 5_000, tasks, replies: [] });
    expect(view.tasks).toHaveLength(TASKS_SHOWN);
    expect(view.tasks[0].title).toBe(`T${TASKS_SHOWN + 1}`);
    expect(view.tasks.some((t) => t.title === 'Before the call')).toBe(false);
  });

  it('maps task states to plain states', () => {
    const states = ['queued', 'sent', 'running', 'blocked', 'stalled', 'done', 'failed', 'cancelled'] as const;
    const shown: Record<string, string> = {};
    for (let from = 0; from < states.length; from += TASKS_SHOWN) {
      const view = buildCallProgress({
        central: central(), busySince: null, callStartedAt: 0, now: 5_000, replies: [],
        tasks: states.slice(from, from + TASKS_SHOWN).map((state, i) => task({ title: state, state, createdAt: 100 - i })),
      });
      for (const t of view.tasks) shown[t.title] = t.state;
    }
    expect(shown).toEqual({
      queued: 'working', sent: 'working', running: 'working', blocked: 'needs_you', stalled: 'stalled',
      done: 'finished', failed: 'failed', cancelled: 'cancelled',
    });
  });

  it('passes the replies through, trimmed and capped', () => {
    const view = buildCallProgress({
      central: central(), busySince: null, callStartedAt: 0, now: 5_000, tasks: [],
      replies: [{ at: 5, text: '  v2.10.80 adds dictation.  ' }, { at: 6, text: 'x'.repeat(REPLY_TEXT_MAX + 50) }],
    });
    expect(view.replies[0]).toEqual({ at: 5, text: 'v2.10.80 adds dictation.' });
    expect(view.replies[1].text.length).toBe(REPLY_TEXT_MAX);
    expect(view.replies[1].text.endsWith('…')).toBe(true);
  });
});

describe('the phone allow-list', () => {
  it('lets a paired phone read its call’s progress (the route itself checks the owner)', async () => {
    const { phoneRuleFor } = await import('../../server/mobile/phoneProfile.js');
    expect(phoneRuleFor('GET', '/voice/call/call_abc-1/progress')).toBe('allow');
    expect(phoneRuleFor('POST', '/voice/call/call_abc-1/progress')).toBeNull();
  });
});

describe('collectCallProgress', () => {
  const session = (id: string, over: Record<string, unknown> = {}) => ({
    sessionId: id, title: id, status: 'idle', toolLog: [], ...over,
  });

  it('reads the central and its tasks, leaving out sessions the caller may not see', async () => {
    const { collectCallProgress } = await import('../../server/voice/callProgress.js');
    const sessions: Record<string, ReturnType<typeof session>> = {
      central: session('central', { title: 'Voice', status: 'working', cli: 'codex', toolLog: [{ tool: 'mcp__aasc__session_list', timestamp: 3_000 }] }),
      shared: session('shared', { title: 'AASC docs' }),
      hidden: session('hidden', { title: 'Private work' }),
    };
    const view = collectCallProgress({
      call: { replies: () => [{ at: 4_000, text: 'Done.' }], busySince: () => 2_500 },
      startedAt: 1_000,
      now: 5_000,
      central: { centralId: 'c1', sessionId: 'central' },
      tasks: (centralId) => (centralId === 'c1'
        ? [
          { sessionId: 'shared', state: 'running', createdAt: 2_000 },
          { sessionId: 'hidden', state: 'done', createdAt: 2_100 },
          { sessionId: 'gone', state: 'done', createdAt: 2_200 },
        ]
        : []),
      getSession: (id) => sessions[id] ?? null,
      canSee: (s) => s.sessionId !== 'hidden',
    });
    expect(view.central).toEqual({ title: 'Voice', state: 'working', step: 'Checking your sessions', elapsedMs: 2_500, cli: 'codex' });
    expect(view.tasks).toEqual([{ title: 'AASC docs', state: 'working' }]);
    expect(view.replies).toEqual([{ at: 4_000, text: 'Done.' }]);
  });

  it('lists what waits for the next question, without its saved path (Nov 24 2026)', async () => {
    const { collectCallProgress } = await import('../../server/voice/callProgress.js');
    const view = collectCallProgress({
      call: {
        replies: () => [],
        busySince: () => null,
        pending: () => [{ id: 'att1', kind: 'photo', name: 'receipt.jpg', path: '/tmp/claude-queue-images/queue-img-1-a.jpg' }],
      },
      startedAt: 0,
      now: 0,
      central: null,
      tasks: () => [],
      getSession: (id: string) => session(id),
      canSee: () => true,
    });
    expect(view.pending).toEqual([{ id: 'att1', kind: 'photo', name: 'receipt.jpg' }]);
  });

  it('shows no central the caller may not see, and no central when there is none', async () => {
    const { collectCallProgress } = await import('../../server/voice/callProgress.js');
    const base = {
      call: { replies: () => [], busySince: () => null },
      startedAt: 0,
      now: 0,
      tasks: () => [],
      getSession: (id: string) => session(id),
    };
    expect(collectCallProgress({ ...base, central: { centralId: 'c1', sessionId: 'x' }, canSee: () => false }).central).toBeNull();
    expect(collectCallProgress({ ...base, central: null, canSee: () => true }).central).toBeNull();
  });
});

describe('a reply\'s on-screen part (Nov 23 2026)', () => {
  const view = (screen: string) => buildCallProgress({ central: null, busySince: null, callStartedAt: 0, now: 1, tasks: [], replies: [{ at: 1, text: 'Two changes.', screen }] });

  it('is sent beside the spoken words, trimmed, and left out when there is none', () => {
    expect(view('  | a | b |\n| - | - |  ').replies[0]).toEqual({ at: 1, text: 'Two changes.', screen: '| a | b |\n| - | - |' });
    expect(buildCallProgress({ central: null, busySince: null, callStartedAt: 0, now: 1, tasks: [], replies: [{ at: 1, text: 'x' }] }).replies[0]).toEqual({ at: 1, text: 'x' });
  });

  it('is capped by characters and by lines', () => {
    expect(view('y'.repeat(REPLY_SCREEN_MAX + 10)).replies[0].screen?.length).toBe(REPLY_SCREEN_MAX);
    const lines = view(Array.from({ length: REPLY_SCREEN_LINES + 30 }, (_, i) => `line ${i}`).join('\n')).replies[0].screen ?? '';
    expect(lines.split('\n')).toHaveLength(REPLY_SCREEN_LINES + 1);
    expect(lines.endsWith('…')).toBe(true);
  });
});
