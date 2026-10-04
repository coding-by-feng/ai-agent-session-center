/**
 * The approval timer honours the permission mode carried by the hook itself.
 *
 * Reported: a session in `bypassPermissions` mode, an hour into "still thinking with max effort" after a
 * Read that had not reported back yet ("Reading 1 file…"), showed the amber "!" (Approval needed) on its
 * card. In that mode Claude Code never stops for approval (its own decision function returns "allow"),
 * so the PostToolUse-timeout heuristic could only be wrong. These cases go through the real
 * `handleEvent`, so they also prove the session store hands the event's mode to the timer — a unit
 * test on approvalDetector alone could not catch a call site that forgets to pass it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));

vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/wsManager.js')>();
  return { ...mod, broadcast: ws.broadcast };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
  };
});

// The store starts its 10 s auto-idle interval when it is imported, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getSession } = await import('../server/sessionStore.js');

let n = 0;
/** A session the hook path really creates (a controlling tty is what makes an unknown card real). */
function hook(id: string, event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/approval-mode-${id}`,
    tty_path: `/dev/ttys8${String(n).padStart(2, '0')}`,
    cli_source: 'claude',
    ...extra,
  } as never);
}
function newSession(startMode?: string): string {
  n += 1;
  const id = `apm-${n}`;
  hook(id, 'SessionStart', startMode ? { permission_mode: startMode } : {});
  hook(id, 'UserPromptSubmit', { prompt: 'go', ...(startMode ? { permission_mode: startMode } : {}) });
  return id;
}
const statusOf = (id: string) => getSession(id)?.status;

beforeEach(() => {
  ws.broadcast.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('approval timer and the hook permission mode', () => {
  it('bypassPermissions: a Read that has not reported back stays "working", however long the model thinks', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/06-cache.png' }, permission_mode: 'bypassPermissions' });
    await vi.advanceTimersByTimeAsync(60_000); // Read's approval timeout is 3 s
    expect(statusOf(id)).toBe('working');
    expect(getSession(id)?.pendingTool).toBe('Read'); // the robot still shows the running tool
  });

  it('dontAsk: a silent Bash stays "working"', async () => {
    const id = newSession('dontAsk');
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'dontAsk' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusOf(id)).toBe('working');
  });

  it('the mode switched mid-session is read from the event, not from SessionStart', async () => {
    const id = newSession('default'); // started in default, then Shift+Tab to bypass
    hook(id, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' }, permission_mode: 'bypassPermissions' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusOf(id)).toBe('working');
  });

  it('an event without a mode falls back to the session started in bypass', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusOf(id)).toBe('working');
  });

  it('default mode is unchanged: a silent Read still becomes "approval"', async () => {
    const id = newSession('default');
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, permission_mode: 'default' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusOf(id)).toBe('approval');
  });

  it('bypassPermissions: a question to the user still becomes "input"', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'AskUserQuestion', tool_input: { question: 'Which?' }, permission_mode: 'bypassPermissions' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusOf(id)).toBe('input');
  });

  it('a real PermissionRequest still wins in any mode', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, permission_mode: 'bypassPermissions' });
    hook(id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, permission_mode: 'bypassPermissions' });
    expect(statusOf(id)).toBe('approval');
  });

  it('a default-mode timer already armed is cancelled by the next, bypass-mode PreToolUse', async () => {
    const id = newSession('default');
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/a' }, permission_mode: 'default' });
    await vi.advanceTimersByTimeAsync(1_000); // under Read's 3 s
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/b' }, permission_mode: 'bypassPermissions' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusOf(id)).toBe('working');
  });
});

// Bypass mode can still prompt: explicit `ask` rules and Claude Code's
// bypass-immune safety checks (a dangerous `rm`, an `sh -c` script with `rm` it
// cannot analyse) show a real dialog. Those send PermissionRequest — but each hook
// is appended by its own detached shell, so it can land BEFORE the PreToolUse,
// which then resets the card to working. While a dialog is open Claude Code also
// sends `Notification` with notification_type "permission_prompt" ("Claude needs
// your permission to use …"): that is the backstop no ordering can break.
describe('the permission_prompt notification marks a real dialog', () => {
  it('restores approval after a PermissionRequest that landed before its PreToolUse (bypass mode)', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: "sh -c 'rm -rf out'" }, permission_mode: 'bypassPermissions' });
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: "sh -c 'rm -rf out'" }, permission_mode: 'bypassPermissions' });
    expect(statusOf(id)).toBe('working'); // the race the review reproduced
    hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(statusOf(id)).toBe('approval');
    expect(getSession(id)?.waitingDetail).toMatch(/permission to use Bash/);
  });

  it('works in default mode too, without waiting for the timer', async () => {
    const id = newSession('default');
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm publish' }, permission_mode: 'default' });
    hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(statusOf(id)).toBe('approval');
  });

  it('a late one, after the tool already finished, changes nothing', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'bypassPermissions' });
    hook(id, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'bypassPermissions' });
    hook(id, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
    expect(statusOf(id)).toBe('working');
  });

  it('other notifications (idle, auth) do not touch the status', async () => {
    const id = newSession('bypassPermissions');
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, permission_mode: 'bypassPermissions' });
    hook(id, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(statusOf(id)).toBe('working');
  });
});
