// waitingCardModel.test.ts — what a waiting card shows and which choices it offers (AASC-43).
import { describe, it, expect } from 'vitest';
import type { PendingRequest, Session } from '@/types';
import { lineDiff, offeredChoices, waitingCardModel, type CardDetail } from './waitingCardModel';

function request(extra: Partial<PendingRequest>): PendingRequest {
  return { id: 'toolu_1', kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: 1, source: 'permission_request', ...extra };
}

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'approval',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    cliSource: 'claude',
    pendingRequest: null,
    pendingTool: null,
    pendingToolDetail: null,
    waitingDetail: null,
    ...extra,
  } as unknown as Session;
}

const labels = (card: ReturnType<typeof waitingCardModel>) => card?.choices.map((c) => c.label);

describe('when nothing waits', () => {
  it('there is no card', () => {
    expect(waitingCardModel(session({ status: 'working' }))).toBeNull();
    expect(waitingCardModel(session({ status: 'waiting' }))).toBeNull();
  });

  it('an ended session shows none, even with a stale request', () => {
    expect(waitingCardModel(session({ status: 'ended', pendingRequest: request({}) }))).toBeNull();
  });
});

describe('a Claude permission', () => {
  it('shows the exact command and Claude’s own choices, Allow once nearest the thumb', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'rm -rf dist && npm run build', description: 'Build' }, canAlwaysAllow: true }) }))!;
    expect(card.title).toBe('Claude wants to run a command');
    expect(card.detail).toEqual({ type: 'command', command: 'rm -rf dist && npm run build', description: 'Build' });
    expect(card.where).toBe('in agent-manager');
    expect(labels(card)).toEqual(['Deny', 'Always allow', 'Allow once']);
    expect(card.choices.map((c) => c.answer.choice)).toEqual(['deny', 'allow_always', 'allow_once']);
    expect(card.choices.find((c) => c.answer.choice === 'allow_always')?.confirm).toBe(true);
    expect(card.tell?.label).toBe('Tell Claude what to do instead…');
    expect(card.terminalOnly).toBe(false);
    expect(card.requestId).toBe('toolu_1');
  });

  it('shows an edit as the file and its diff', () => {
    const card = waitingCardModel(session({
      pendingRequest: request({
        tool: 'Edit',
        input: { file_path: '/Users/me/agent-manager/src/ui/icons.tsx', old_string: 'a\n<rect y="10.5" />\nc', new_string: 'a\n<rect y="7" />\nc' },
      }),
    }))!;
    expect(card.title).toBe('Claude wants to edit a file');
    const detail = card.detail as Extract<CardDetail, { type: 'diff' }>;
    expect(detail.type).toBe('diff');
    expect(detail.file).toBe('src/ui/icons.tsx');
    expect(detail.lines).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: '<rect y="10.5" />' },
      { op: '+', text: '<rect y="7" />' },
      { op: ' ', text: 'c' },
    ]);
    expect([detail.added, detail.removed]).toEqual([1, 1]);
  });

  it('shows a new file as all added lines', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ tool: 'Write', input: { file_path: '/elsewhere/notes.md', content: 'one\ntwo' } }) }))!;
    expect(card.title).toBe('Claude wants to write a file');
    expect(card.detail).toMatchObject({ type: 'diff', file: '/elsewhere/notes.md', added: 2, removed: 0 });
  });

  it('shows each part of a multi-edit', () => {
    const card = waitingCardModel(session({
      pendingRequest: request({ tool: 'MultiEdit', input: { file_path: '/Users/me/agent-manager/a.ts', edits: [{ old_string: 'x', new_string: 'y' }, { old_string: 'p', new_string: 'q' }] } }),
    }))!;
    const detail = card.detail as Extract<CardDetail, { type: 'diff' }>;
    expect(detail.lines.filter((l) => l.op === '@').map((l) => l.text)).toEqual(['Change 1 of 2', 'Change 2 of 2']);
    expect([detail.added, detail.removed]).toEqual([2, 2]);
  });

  it('shows a fetch as its URL', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ tool: 'WebFetch', input: { url: 'https://example.com/docs', prompt: 'Summarise' } }) }))!;
    expect(card.title).toBe('Claude wants to fetch a page');
    expect(card.detail).toEqual({ type: 'url', url: 'https://example.com/docs', prompt: 'Summarise' });
  });

  it('names an MCP tool by its tool and server, and shows its input', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ tool: 'mcp__github__create_issue', input: { title: 'Bug' } }) }))!;
    expect(card.title).toBe('Claude wants to use create_issue (github)');
    expect(card.detail).toEqual({ type: 'text', text: '{\n  "title": "Bug"\n}' });
  });

  it('can deny but not allow an input cut to fit the card', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'echo … [truncated]' }, inputTruncated: true }) }))!;
    const allow = card.choices.filter((c) => c.answer.choice !== 'deny');
    expect(allow.every((c) => !!c.disabledReason)).toBe(true);
    expect(card.choices.find((c) => c.answer.choice === 'deny')?.disabledReason).toBeUndefined();
  });

  it('offers no "Always allow" when Claude can’t save the call as a rule (its 2 would switch to auto mode)', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'ls "$(pwd)"' } }) }))!;
    expect(labels(card)).toEqual(['Deny', 'Allow once']);
  });

  it('offers no "Always allow" in the Inbox: that one is decided in the session', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'ls' } }) }), { inbox: true })!;
    expect(labels(card)).toEqual(['Deny', 'Allow once']);
  });
});

describe('a Codex permission', () => {
  it('uses Codex’s own words and shows its command', () => {
    const card = waitingCardModel(session({
      cliSource: 'codex',
      pendingRequest: request({ cli: 'codex', tool: 'shell', input: { command: ['bash', '-lc', 'npm test'] } }),
    }))!;
    expect(card.title).toBe('Codex wants to run a command');
    expect(card.detail).toEqual({ type: 'command', command: 'npm test' });
    expect(labels(card)).toEqual(['Deny', 'Always approve', 'Approve']);
    expect(card.tell?.label).toBe('Tell Codex what to do…');
  });

  it('joins a plain argument list', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ cli: 'codex', tool: 'shell', input: { command: ['git', 'status'] } }) }))!;
    expect(card.detail).toEqual({ type: 'command', command: 'git status' });
  });

  it('reads an apply_patch as a diff', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old line\n+new line\n context\n*** End Patch';
    const card = waitingCardModel(session({ pendingRequest: request({ cli: 'codex', tool: 'apply_patch', input: { input: patch } }) }))!;
    expect(card.title).toBe('Codex wants to change files');
    expect(card.detail).toMatchObject({ type: 'diff', file: 'src/a.ts', added: 1, removed: 1 });
  });
});

describe('a question', () => {
  const ask = request({
    kind: 'question',
    tool: 'AskUserQuestion',
    source: 'pre_tool_use',
    input: { questions: [{ question: 'Which payment phase applies?', header: 'Phase', options: [{ label: 'Deposit' }, { label: 'Stage 2' }, { label: 'Final' }] }] },
    options: [{ label: 'Deposit' }, { label: 'Stage 2', description: 'After fit-out' }, { label: 'Final' }],
  });

  it('shows the question with the agent’s options, then Other…', () => {
    const card = waitingCardModel(session({ status: 'input', pendingRequest: ask }))!;
    expect(card.kind).toBe('question');
    expect(card.title).toBe('Claude asks');
    expect(card.detail).toEqual({ type: 'question', question: 'Which payment phase applies?', header: 'Phase' });
    expect(labels(card)).toEqual(['Deposit', 'Stage 2', 'Final']);
    expect(card.choices[1]).toMatchObject({ answer: { choice: 'option', optionIndex: 1 }, description: 'After fit-out' });
    expect(card.tell?.label).toBe('Other…');
  });

  it('sends a question it can’t pick for (several picks) to the terminal, still showing it', () => {
    const card = waitingCardModel(session({ status: 'input', pendingRequest: { ...ask, options: undefined } }))!;
    expect(card.terminalOnly).toBe(true);
    expect(card.choices).toEqual([]);
    expect(card.detail).toMatchObject({ type: 'question', question: 'Which payment phase applies?' });
  });
});

describe('only "Open terminal"', () => {
  it('for a guess with no request: the Mac can’t see what the agent asks', () => {
    const card = waitingCardModel(session({ status: 'approval', pendingTool: 'Bash', pendingToolDetail: 'npm test' }))!;
    expect(card.kind).toBe('guess');
    expect(card.terminalOnly).toBe(true);
    expect(card.detail).toEqual({ type: 'text', text: 'npm test' });
    expect(card.terminalOnlyReason).toMatch(/terminal/);
  });

  it('for a timer request', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ source: 'timer', input: undefined }) }))!;
    expect(card.terminalOnly).toBe(true);
    expect(card.choices).toEqual([]);
    expect(card.tell).toBeNull();
  });

  it('for an ambiguous request (another dialog may be on screen)', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ ambiguous: true, input: { command: 'ls' } }) }))!;
    expect(card.terminalOnly).toBe(true);
    expect(card.detail).toEqual({ type: 'command', command: 'ls' });
  });

  it('for a plan, whose choices change between versions', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ kind: 'plan', tool: 'ExitPlanMode', input: { plan: '1. Do it' } }) }))!;
    expect(card.kind).toBe('plan');
    expect(card.detail).toEqual({ type: 'plan', text: '1. Do it' });
    expect(card.terminalOnly).toBe(true);
  });

  it('for a question waiting without a request', () => {
    const card = waitingCardModel(session({ status: 'input', waitingDetail: 'Which branch?' }))!;
    expect(card.title).toBe('Claude asks');
    expect(card.detail).toEqual({ type: 'question', question: 'Which branch?' });
    expect(card.terminalOnly).toBe(true);
  });
});

describe('lineDiff', () => {
  it('keeps common lines and marks the rest', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
    ]);
  });

  it('handles an empty side', () => {
    expect(lineDiff('', 'x')).toEqual([{ op: '+', text: 'x' }]);
    expect(lineDiff('x', '')).toEqual([{ op: '-', text: 'x' }]);
  });

  it('trims what both sides share before comparing', () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const out = lineDiff(big, `${big}\nmore`);
    expect(out.filter((l) => l.op === '+')).toEqual([{ op: '+', text: 'more' }]);
    expect(out.filter((l) => l.op === '-')).toEqual([]);
  });

  it('falls back to remove-then-add when the changed middle is very long', () => {
    const a = Array.from({ length: 1000 }, (_, i) => `a ${i}`).join('\n');
    const b = Array.from({ length: 1000 }, (_, i) => `b ${i}`).join('\n');
    const out = lineDiff(a, b);
    expect(out.slice(0, 1000).every((l) => l.op === '-')).toBe(true);
    expect(out.slice(1000).every((l) => l.op === '+')).toBe(true);
  });
});

describe('long diffs on the card', () => {
  it('keeps three lines of context around a change and says how many were skipped', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const after = [...lines];
    after[10] = 'changed';
    const card = waitingCardModel(session({
      pendingRequest: request({ tool: 'Edit', input: { file_path: 'x.ts', old_string: lines.join('\n'), new_string: after.join('\n') } }),
    }))!;
    const detail = card.detail as Extract<CardDetail, { type: 'diff' }>;
    expect(detail.lines[0]).toEqual({ op: '@', text: '7 unchanged lines' });
    expect(detail.lines.filter((l) => l.op === ' ').length).toBe(6);
    expect(detail.lines[detail.lines.length - 1]).toEqual({ op: '@', text: '6 unchanged lines' });
  });

  it('cuts a very long diff and says so', () => {
    const content = Array.from({ length: 900 }, (_, i) => `row ${i}`).join('\n');
    const card = waitingCardModel(session({ pendingRequest: request({ tool: 'Write', input: { file_path: 'big.txt', content } }) }))!;
    const detail = card.detail as Extract<CardDetail, { type: 'diff' }>;
    expect(detail.truncated).toBe(true);
    expect(detail.lines.length).toBeLessThanOrEqual(401);
    expect(detail.added).toBe(900);
  });
});

describe('offeredChoices', () => {
  it('offers what can be answered, and says once why the rest can’t', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'echo … [truncated]' }, inputTruncated: true }) }))!;
    const { offered, reasons } = offeredChoices(card.choices);
    expect(offered.map((c) => c.label)).toEqual(['Deny']);
    expect(reasons).toEqual(['Too long to show in full: allow it in the terminal.']);
  });

  it('offers everything when nothing is blocked', () => {
    const card = waitingCardModel(session({ pendingRequest: request({ input: { command: 'ls' } }) }))!;
    expect(offeredChoices(card.choices)).toEqual({ offered: card.choices, reasons: [] });
  });
});
