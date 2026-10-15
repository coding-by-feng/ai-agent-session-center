// DiffScreen.test.tsx — one file's diff on the phone (AASC-44): line numbers and
// − / + marks, fold a hunk or all, wrap, neighbours found by path, a line's
// Comment reference into the composer draft, and a secret file shown as hidden.
// Also the Changes list it is opened from.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';
import type { ApiResult } from '@/lib/chat/chatApi';
import type { PhoneFileChanges, PhoneSessionChanges } from '@/lib/chat/changesApi';

const fetchSessionChanges = vi.fn<(id: string) => Promise<ApiResult<PhoneSessionChanges>>>();
const fetchFileChanges = vi.fn<(id: string, index: number) => Promise<ApiResult<PhoneFileChanges>>>();
vi.mock('@/lib/chat/changesApi', () => ({
  fetchSessionChanges: (id: string) => fetchSessionChanges(id),
  fetchFileChanges: (id: string, index: number) => fetchFileChanges(id, index),
}));

const { default: DiffScreen } = await import('./DiffScreen');
const { default: ChangesView } = await import('../chat/ChangesView');
const { useChangesStore } = await import('@/stores/changesStore');
const { useComposerDraftStore } = await import('@/stores/composerDraftStore');
const { usePhoneNavStore } = await import('@/stores/phoneNavStore');

const list: PhoneSessionChanges = {
  files: [
    { path: 'src/a.css', added: 0, removed: 1, lastAt: Date.now() - 60_000 },
    { path: 'src/ui/icons.tsx', added: 2, removed: 1, lastAt: Date.now() - 120_000 },
    { path: '.env', added: 1, removed: 1, lastAt: Date.now() - 180_000, redacted: true },
  ],
  total: { added: 3, removed: 3 },
  cli: 'claude',
};

const icons: PhoneFileChanges = {
  path: 'src/ui/icons.tsx',
  added: 2,
  removed: 1,
  lastAt: 1,
  hunks: [
    { oldStart: 40, oldLines: 3, newStart: 40, newLines: 3, lines: [' <svg>', '-  <rect y="10.5" />', '+  <rect y="7" />'] },
    { oldStart: 90, oldLines: 0, newStart: 90, newLines: 1, lines: ['+export default {};'] },
  ],
};

beforeEach(() => {
  fetchSessionChanges.mockReset();
  fetchFileChanges.mockReset();
  useChangesStore.getState().clearAll();
  useComposerDraftStore.setState({ drafts: {} });
  fetchSessionChanges.mockResolvedValue({ ok: true, data: list });
});

describe('DiffScreen', () => {
  it('draws hunks with line numbers and − / + marks under sticky headers', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: icons });
    render(<DiffScreen sessionId="s1" fileIndex={1} />);
    const first = await screen.findByRole('region', { name: '@@ −40,3 +40,3 @@' });
    expect(within(first).getAllByLabelText('removed')).toHaveLength(1);
    expect(within(first).getAllByLabelText('added')).toHaveLength(1);
    expect(first).toHaveTextContent('41');
    expect(screen.getByTestId('phone-diff')).toHaveTextContent('src/ui/ · +2 \u22121');
    expect(fetchFileChanges).toHaveBeenCalledWith('s1', 1);
  });

  it('folds a hunk, then all of them, and wraps long lines', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: icons });
    render(<DiffScreen sessionId="s1" fileIndex={1} />);
    const head = await screen.findByRole('button', { name: '@@ −40,3 +40,3 @@' });
    await userEvent.click(head);
    expect(head).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(head).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.getAllByRole('button', { name: /@@/ }).every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    const wrap = screen.getByRole('button', { name: 'Wrap long lines' });
    await userEvent.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
  });

  it('finds the previous and next file by path in the current list', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: icons });
    const replace = vi.spyOn(usePhoneNavStore.getState(), 'replace').mockImplementation(() => {});
    render(<DiffScreen sessionId="s1" fileIndex={1} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Next file: .env' }));
    expect(replace).toHaveBeenLastCalledWith('/sessions/s1/changes/2');
    await userEvent.click(screen.getByRole('button', { name: 'Previous file: src/a.css' }));
    expect(replace).toHaveBeenLastCalledWith('/sessions/s1/changes/0');
    replace.mockRestore();
  });

  it('puts a line’s reference into the composer draft from its menu', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: icons });
    render(<DiffScreen sessionId="s1" fileIndex={1} />);
    const added = (await screen.findByText('<rect y="7" />', { exact: false })).closest('[data-row]')!;
    fireEvent.contextMenu(added, { clientX: 20, clientY: 200 });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Comment' }));
    expect(useComposerDraftStore.getState().drafts.s1).toBe('src/ui/icons.tsx:41 — ');
  });

  it('shows a secret file as hidden, never its content', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: { path: '.env', added: 1, removed: 1, lastAt: 1, hunks: [], redacted: true } });
    render(<DiffScreen sessionId="s1" fileIndex={2} />);
    expect(await screen.findByText('Hidden on phones: a secret file')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wrap long lines' })).toBeNull();
  });

  it('reads the diff again on the next visit: the same index may be another file by then', async () => {
    fetchFileChanges.mockResolvedValue({ ok: true, data: icons });
    const first = render(<DiffScreen sessionId="s1" fileIndex={1} />);
    await screen.findByText('<rect y="7" />', { exact: false });
    first.unmount();
    fetchFileChanges.mockResolvedValue({ ok: true, data: { path: 'src/new.ts', added: 1, removed: 0, lastAt: 2, hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, lines: ['+fresh'] }] } });
    render(<DiffScreen sessionId="s1" fileIndex={1} />);
    expect(await screen.findByText('fresh')).toBeInTheDocument();
    expect(screen.queryByText('<rect y="7" />', { exact: false })).toBeNull();
  });

  it('says when the file is no longer there', async () => {
    fetchFileChanges.mockResolvedValue({ ok: false, status: 404, message: 'This file is no longer in the session’s changes.' });
    render(<DiffScreen sessionId="s1" fileIndex={9} />);
    expect(await screen.findByText('This file is no longer in the session’s changes.')).toBeInTheDocument();
  });
});

describe('ChangesView', () => {
  const session = { sessionId: 's1', status: 'waiting', totalToolCalls: 1, toolLog: [] } as unknown as Session;

  it('lists the edited files newest first with the total and opens one', async () => {
    const push = vi.spyOn(usePhoneNavStore.getState(), 'push').mockImplementation(() => {});
    render(<ChangesView session={session} onTerminal={() => {}} />);
    expect(await screen.findByText('3 files changed by this session')).toBeInTheDocument();
    const rows = screen.getAllByRole('button', { name: /lines? added|removed/ });
    expect(rows.map((r) => r.getAttribute('aria-label')?.split(',')[0])).toEqual(['src/a.css', 'src/ui/icons.tsx', '.env']);
    expect(screen.getByText('Hidden on phones: a secret file')).toBeInTheDocument();
    await userEvent.click(rows[1]);
    expect(push).toHaveBeenCalledWith('/sessions/s1/changes/1');
    push.mockRestore();
  });

  it('says a session with no transcript has nothing to list', async () => {
    fetchSessionChanges.mockResolvedValue({ ok: true, data: { files: [], total: { added: 0, removed: 0 }, cli: null } });
    const onTerminal = vi.fn();
    render(<ChangesView session={session} onTerminal={onTerminal} />);
    expect(await screen.findByText('This session has no transcript')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open Terminal' }));
    expect(onTerminal).toHaveBeenCalled();
  });

  it('says when nothing was edited yet', async () => {
    fetchSessionChanges.mockResolvedValue({ ok: true, data: { files: [], total: { added: 0, removed: 0 }, cli: 'codex' } });
    render(<ChangesView session={session} onTerminal={() => {}} />);
    expect(await screen.findByText('No edits yet')).toBeInTheDocument();
  });
});
