/**
 * A permission mode switched partway through a session reaches its card (Nov 25 2026).
 *
 * Reported: a central switched to `auto` with Shift+Tab mid-session, then asked AASC three times to open a worker
 * card and was refused each time: the store read `permission_mode` only on SessionStart and PermissionRequest, so
 * the central's card still had no mode, `centralCap` answered `default`, and a looser card was DENIED. Every Claude
 * Code hook carries the mode, so any event that has one now records it, except `plan` (a passing Shift+Tab stop a
 * restart must not reopen in). These go through the real `handleEvent`.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

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

const { centralCap } = await import('../server/mcp/permissionCap.js');

let n = 0;
function hook(id: string, event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/mode-switch-${id}`,
    tty_path: `/dev/ttys9${String(n).padStart(2, '0')}`,
    cli_source: 'claude',
    ...extra,
  } as never);
}
/** A session started with no mode known, as the central in the report was. */
function startedWithoutMode(): string {
  n += 1;
  const id = `msw-${n}`;
  hook(id, 'SessionStart');
  return id;
}
const modeOf = (id: string) => getSession(id)?.permissionMode ?? null;

afterAll(() => {
  vi.useRealTimers();
});

describe('a permission mode switched mid-session', () => {
  it('is recorded from the next prompt, so the central’s cap is that mode (the refused-card report)', () => {
    const id = startedWithoutMode();
    expect(modeOf(id)).toBeNull();

    hook(id, 'UserPromptSubmit', { prompt: 'open the Pipeline Build card', permission_mode: 'auto' });

    expect(modeOf(id)).toBe('auto');
    const card = { ...getSession(id)!, central: { centralId: 'c-msw', name: '★' } };
    const ctx = { central: { centralId: 'c-msw', permissionMode: null }, sessions: () => [card] };
    expect(centralCap(ctx as never)).toBe('auto');
  });

  it('follows a later switch on a tool call too, and back again', () => {
    const id = startedWithoutMode();
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' }, permission_mode: 'acceptEdits' });
    expect(modeOf(id)).toBe('acceptEdits');
    hook(id, 'PostToolUse', { tool_name: 'Read', permission_mode: 'default' });
    expect(modeOf(id)).toBe('default');
  });

  it('never records plan, and an event without a mode keeps the one it had', () => {
    const id = startedWithoutMode();
    hook(id, 'UserPromptSubmit', { prompt: 'go', permission_mode: 'auto' });
    hook(id, 'UserPromptSubmit', { prompt: 'plan it', permission_mode: 'plan' });
    expect(modeOf(id)).toBe('auto');
    hook(id, 'Stop');
    expect(modeOf(id)).toBe('auto');
  });

  it('a permission request without a mode does not blank the one recorded', () => {
    const id = startedWithoutMode();
    hook(id, 'UserPromptSubmit', { prompt: 'go', permission_mode: 'acceptEdits' });
    hook(id, 'PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(modeOf(id)).toBe('acceptEdits');
  });
});
