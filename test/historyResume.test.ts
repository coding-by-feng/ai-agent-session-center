// test/historyResume.test.ts — which CLI can reopen a session that is only in the history.
//
// HISTORY lists every session the database has seen (4,268 on the Mac this was found on); the live store
// holds the few still on screen (29). Resume read only the live store, so every other row answered
// "Session not found". A history row keeps no launch command, so the saved conversation itself says
// which CLI to resume it with, and how it was launched: Claude's transcript records the permission mode
// of every prompt, a Codex rollout its approval and sandbox policy, model and effort per turn.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planHistoryResume } from '../server/historyResume.js';

const CLAUDE_ID = '6f337c03-0906-4507-8627-13c8ea3ff83a';
const OTHER_CLAUDE_ID = '78d6331a-0142-4e16-8396-64247344ce0b';
const CODEX_ID = '01a15342-7471-77b3-9e17-f8a66d3c8256';
const STRICT_CODEX_ID = '01a152a6-3d5b-72a3-ac83-34a17ab94f0a';
const LONG_CODEX_ID = '01a152a2-cdfd-70a0-8653-b79c7ef829c5';
const MOVED_CLAUDE_ID = '9bc79ddf-c8ea-4aae-a38e-70db1e8b19db';
const PROJECT = '/Users/dev/Documents/exmouth';

/** ~600 KB of replies and tool output carrying no mode, policy or folder. */
const filler = (): unknown[] => Array.from({ length: 300 }, (_, i) => ({
  type: 'assistant', timestamp: `2026-10-19T02:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
  message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x'.repeat(2000) }] },
}));

let root = '';
let roots: { claudeProjects: string; codex: string };

const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'history-resume-'));
  roots = { claudeProjects: join(root, 'claude-projects'), codex: join(root, 'codex') };

  const claudeDir = join(roots.claudeProjects, '-Users-dev-Documents-exmouth');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(join(claudeDir, `${CLAUDE_ID}.jsonl`), jsonl(
    { type: 'user', permissionMode: 'default', cwd: PROJECT, timestamp: '2026-10-19T01:00:00.000Z', message: { content: 'hi' } },
    { type: 'assistant', timestamp: '2026-10-19T01:00:05.000Z', message: { model: 'claude-opus-5-5', content: [] } },
    { type: 'system', subtype: 'local_command', timestamp: '2026-10-19T01:01:00.000Z', content: 'Set model to `sonnet`', commandRun: { command: 'model', args: 'sonnet' } },
    { type: 'system', subtype: 'local_command', timestamp: '2026-10-19T01:01:10.000Z', content: 'Set effort level to max (this session only)', commandRun: { command: 'effort', args: 'max' } },
    { type: 'user', permissionMode: 'bypassPermissions', timestamp: '2026-10-19T01:02:00.000Z', message: { content: 'go' } },
  ));
  // Another conversation in the same folder, written later: never a stand-in for this one (AASC-49).
  writeFileSync(join(claudeDir, `${OTHER_CLAUDE_ID}.jsonl`), jsonl(
    { type: 'user', permissionMode: 'bypassPermissions', timestamp: '2026-10-19T09:00:00.000Z', message: { content: 'x' } },
  ));

  const day = join(roots.codex, 'sessions', '2026', '10', '19');
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, `rollout-2026-10-19T21-23-43-${CODEX_ID}.jsonl`), jsonl(
    { type: 'session_meta', timestamp: '2026-10-19T08:23:43.000Z', payload: { id: CODEX_ID, cwd: PROJECT } },
    { type: 'turn_context', timestamp: '2026-10-19T08:24:00.000Z', payload: { model: 'gpt-6-astra', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } },
  ));
  // A long Codex session: its only turn context is megabytes before the end, and its agent moved on to
  // another folder (the row's project_path) after launching in PROJECT.
  writeFileSync(join(day, `rollout-2026-10-19T18-29-23-${LONG_CODEX_ID}.jsonl`), jsonl(
    { type: 'session_meta', timestamp: '2026-10-19T05:29:23.000Z', payload: { id: LONG_CODEX_ID, cwd: PROJECT } },
    { type: 'turn_context', timestamp: '2026-10-19T05:30:00.000Z', payload: { model: 'gpt-5.6-terra', effort: 'xhigh', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } } },
    ...filler(),
  ));

  // A Claude session launched in PROJECT whose agent later worked in PROJECT/crm/src: the row keeps the
  // last folder, Claude files the transcript under the launch folder. Its one recorded permission mode
  // sits far from the end.
  writeFileSync(join(claudeDir, `${MOVED_CLAUDE_ID}.jsonl`), jsonl(
    { type: 'custom-title', title: 'Exmouth Development' },
    { type: 'user', permissionMode: 'bypassPermissions', cwd: PROJECT, timestamp: '2026-10-19T01:00:00.000Z', message: { content: 'start' } },
    ...filler(),
    { type: 'user', cwd: `${PROJECT}/crm/src`, timestamp: '2026-10-19T03:00:00.000Z', message: { content: 'later' } },
  ));

  writeFileSync(join(day, `rollout-2026-10-19T18-33-05-${STRICT_CODEX_ID}.jsonl`), jsonl(
    { type: 'turn_context', timestamp: '2026-10-19T05:34:00.000Z', payload: { model: 'gpt-6-astra', effort: 'medium', approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write' } } },
  ));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('planHistoryResume', () => {
  it('a Claude conversation resumes with claude, in the permission mode, model and effort it last ran with', async () => {
    const plan = await planHistoryResume(CLAUDE_ID, PROJECT, roots);
    expect(plan).toMatchObject({ cli: 'claude', command: 'claude', workingDir: PROJECT, permissionMode: 'bypassPermissions', model: 'sonnet', effortLevel: 'max' });
  });

  it('a reply never pins the model: with no /model the CLI default applies', async () => {
    const plan = await planHistoryResume(OTHER_CLAUDE_ID, PROJECT, roots);
    expect(plan?.cli).toBe('claude');
    expect(plan?.model).toBeUndefined();
    expect(plan?.effortLevel).toBeUndefined();
  });

  it('a Codex conversation resumes with codex; "never ask" + full access comes back as the bypass flag', async () => {
    const plan = await planHistoryResume(CODEX_ID, PROJECT, roots);
    expect(plan).toMatchObject({ cli: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox', workingDir: PROJECT, model: 'gpt-6-astra', effortLevel: 'high' });
    expect(plan?.permissionMode).toBeUndefined();
  });

  it('a Codex conversation that asked for approvals keeps asking (no bypass flag)', async () => {
    const plan = await planHistoryResume(STRICT_CODEX_ID, PROJECT, roots);
    expect(plan).toMatchObject({ cli: 'codex', command: 'codex', effortLevel: 'medium' });
  });

  it('a Codex policy and folder are found however far from the end of the rollout they were written', async () => {
    const plan = await planHistoryResume(LONG_CODEX_ID, '/Users/dev/.codex/memories', roots);
    expect(plan).toMatchObject({ cli: 'codex', command: 'codex --dangerously-bypass-approvals-and-sandbox', workingDir: PROJECT, model: 'gpt-5.6-terra', effortLevel: 'xhigh' });
  });

  it('a Claude session whose agent moved folders resumes where it was launched, with the mode it recorded once', async () => {
    const plan = await planHistoryResume(MOVED_CLAUDE_ID, `${PROJECT}/crm/src`, roots);
    expect(plan).toMatchObject({ cli: 'claude', workingDir: PROJECT, permissionMode: 'bypassPermissions' });
  });

  it('no saved conversation for the id: nothing to resume, even with other conversations in the folder', async () => {
    expect(await planHistoryResume('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', PROJECT, roots)).toBeNull();
  });

  it('an id that is not a CLI conversation id (a term-* placeholder) is never looked up', async () => {
    expect(await planHistoryResume('term-1792229368461-xum9v2', PROJECT, roots)).toBeNull();
    expect(await planHistoryResume("x'; rm -rf ~; '", PROJECT, roots)).toBeNull();
  });

  it('with no project folder on record both are still found, and resume where they were launched', async () => {
    expect(await planHistoryResume(CLAUDE_ID, '', roots)).toMatchObject({ cli: 'claude', workingDir: PROJECT });
    expect(await planHistoryResume(CODEX_ID, '', roots)).toMatchObject({ cli: 'codex', workingDir: PROJECT });
  });
});
