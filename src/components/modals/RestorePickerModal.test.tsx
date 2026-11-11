import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import RestorePickerModal, { requestRestoreSelection } from './RestorePickerModal';
import type { SessionSnapshot, WorkspaceSnapshot } from '@/lib/workspaceSnapshot';
const saved = (id: string, title: string, command: string): SessionSnapshot => ({ originalSessionId: id, title, enableOpsTerminal: false, projectTabs: null, sshConfig: { host: 'localhost', port: 22, username: 'test', authMethod: 'key', command, workingDir: '/workspace/project' } });
const snapshot: WorkspaceSnapshot = { version: 1, exportedAt: Date.now(), rooms: [], sessions: [saved('term-shell', 'VPS Terminal', '/bin/bash'), saved('term-claude', 'Claude', '/usr/local/bin/claude'), saved('existing-conversation', 'Codex', 'codex')] };
afterEach(cleanup);
function open() { render(<RestorePickerModal />); let result!: ReturnType<typeof requestRestoreSelection>; act(() => { result = requestRestoreSelection(snapshot); }); return result; }
it('warns only for agent conversations without a saved identity, not shell terminals', () => {
  void open();
  expect(screen.getAllByTitle('Will start a fresh conversation')).toHaveLength(1);
  expect(screen.getByText(/1 session will start a fresh conversation/)).toHaveTextContent('(Claude)');
});
it('keeps the selection count accurate while filtering and resumes hidden selections too', async () => {
  const result = open();
  fireEvent.change(screen.getByPlaceholderText('Search title or workdir…'), { target: { value: 'Claude' } });
  fireEvent.click(screen.getByRole('button', { name: 'Resume selected (3/3)' }));
  expect(await result).toEqual({ cancelled: false, selectedIds: new Set(['term-shell', 'term-claude', 'existing-conversation']) });
});
