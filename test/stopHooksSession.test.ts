/**
 * `Session.stopHooksSince` through the real session store (Nov 6 2026): set by a Claude Stop
 * while its Stop hooks still run, cleared once the transcript has the hook summary, by the next
 * prompt, or never set for Codex. Real transcript files; the read after Stop is real I/O.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return { ...mod, broadcast: vi.fn() };
});

// No process scans against the real `ps`.
vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return { ...mod, startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn() };
});

const { handleEvent, getSession, startSessionRuntime, stopSessionRuntime } = await import('../server/sessionStore.js');

const dir = mkdtempSync(join(tmpdir(), 'aasc-stophooks-'));
afterAll(() => {
  stopSessionRuntime();
  rmSync(dir, { recursive: true, force: true });
});

const ANSWER = { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Built it.' }] } };
const SUMMARY = { type: 'system', subtype: 'stop_hook_summary', hookCount: 5, hookErrors: [], preventedContinuation: false };

function transcript(name: string, entries: object[]): string {
  const file = join(dir, `${name}.jsonl`);
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return file;
}

let n = 0;
function hook(id: string, event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/stophooks-${id}`,
    tty_path: `/dev/ttys7${String(n).padStart(2, '0')}`,
    cli_source: 'claude',
    ...extra,
  } as never);
}
function newSession(extra: Record<string, unknown> = {}): string {
  n += 1;
  const id = `sh-${n}`;
  hook(id, 'SessionStart', extra);
  hook(id, 'UserPromptSubmit', { prompt: 'build it', ...extra });
  return id;
}
const since = (id: string) => getSession(id)?.stopHooksSince ?? null;
const READ = { timeout: 5000, interval: 20 };

describe('stopHooksSince', () => {
  it('is set at Stop while the hooks still run, and the status still says waiting', async () => {
    const path = transcript('running', [ANSWER]);
    const id = newSession({ transcript_path: path });
    hook(id, 'Stop', { last_assistant_message: 'Built it.', transcript_path: path });
    expect(getSession(id)?.status).toBe('waiting');
    expect(since(id)).toBeTypeOf('number');
    // The read after Stop finds no summary: the mark stays.
    await new Promise((r) => setTimeout(r, 100));
    expect(since(id)).toBeTypeOf('number');
  });

  it('is cleared at once when the hooks had already finished before Stop was handled', async () => {
    const path = transcript('done', [ANSWER, SUMMARY]);
    const id = newSession({ transcript_path: path });
    hook(id, 'Stop', { last_assistant_message: 'Built it.', transcript_path: path });
    await vi.waitFor(() => expect(since(id)).toBeNull(), READ);
  });

  it('is cleared by the held prompt arriving', () => {
    const path = transcript('held', [ANSWER]);
    const id = newSession({ transcript_path: path });
    hook(id, 'Stop', { last_assistant_message: 'Built it.', transcript_path: path });
    expect(since(id)).toBeTypeOf('number');
    hook(id, 'UserPromptSubmit', { prompt: '/build', transcript_path: path });
    expect(since(id)).toBeNull();
  });

  it('is cleared by the transcript watcher when the summary lands after Stop (the main path)', async () => {
    const path = transcript('watched', [ANSWER]);
    const id = newSession({ transcript_path: path });
    startSessionRuntime(); // watches every live session's transcript, this one included
    hook(id, 'Stop', { last_assistant_message: 'Built it.', transcript_path: path });
    expect(since(id)).toBeTypeOf('number');
    await new Promise((r) => setTimeout(r, 400)); // the post-Stop read and the first watcher read find no summary
    expect(since(id)).toBeTypeOf('number');
    appendFileSync(path, JSON.stringify(SUMMARY) + '\n');
    await vi.waitFor(() => expect(since(id)).toBeNull(), READ);
  });

  it('survives a Stop whose cli_source is not a string', () => {
    n += 1;
    const id = `sh-${n}`;
    expect(() => {
      hook(id, 'SessionStart', { cli_source: 7 });
      hook(id, 'Stop', { last_assistant_message: 'Done.', cli_source: { x: 1 } });
    }).not.toThrow();
    expect(getSession(id)?.status).toBe('waiting');
  });

  it('is never set for Codex', () => {
    const id = newSession({ cli_source: 'codex' });
    hook(id, 'Stop', { last_assistant_message: 'Done.', cli_source: 'codex' });
    expect(since(id)).toBeNull();
  });
});
