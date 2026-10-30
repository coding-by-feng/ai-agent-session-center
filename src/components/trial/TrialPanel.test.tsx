import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { NativeTrialAPI, TrialSnapshot, TrialResult } from '@/types/trial';
import TrialPanel from './TrialPanel';
import TrialLauncher from './TrialLauncher';
import WelcomeStep from '../setup/steps/WelcomeStep';

const status: TrialSnapshot['status'] = {
  available: true,
  mode: 'native_qa',
  policyVersion: 'native-qa-v1',
  runtime: 'claude-code',
  client: 'aasc',
  turnLimit: 3,
  inputLimit: 600,
  contextTokenLimit: 2500,
  outputTokenLimit: 800,
  historyPairs: 2,
  timeoutMs: 45000,
  concurrentTurns: 1,
};
function snapshot(active = false): TrialSnapshot {
  return {
    status,
    session: active
      ? {
          id: 'trial',
          state: 'active',
          remaining: 3,
          completed: 0,
          reserved: 0,
          expiresAt: Date.now() + 86400000,
          transcriptExpiresAt: Date.now() + 86400000,
          turns: [],
        }
      : null,
    pending: null,
    busy: false,
  };
}
function makeAPI(initial = snapshot()): NativeTrialAPI {
  return {
    refresh: vi.fn(async () => ({ ok: true as const, data: initial })),
    activate: vi.fn(async () => ({ ok: true as const, data: snapshot(true) })),
    ask: vi.fn(async () => ({ ok: true as const, data: snapshot(true) })),
    retry: vi.fn(async () => ({ ok: true as const, data: snapshot(true) })),
    logout: vi.fn(async () => ({ ok: true as const, data: snapshot() })),
  };
}
afterEach(() => {
  cleanup();
  window.electronAPI = undefined;
  vi.useRealTimers();
});
it('requires consent and available service before sending the activation code', async () => {
  const api = makeAPI();
  render(<TrialPanel api={api} />);
  await screen.findByLabelText('体验码');
  fireEvent.change(screen.getByLabelText('体验码'), { target: { value: 'AASC-valid-test-code' } });
  expect(screen.getByRole('button', { name: '开始体验' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: '开始体验' }));
  await screen.findByLabelText('输入问题');
  expect(api.activate).toHaveBeenCalledWith('AASC-valid-test-code');
  expect(screen.getByText('剩余 3 / 3 次')).toBeInTheDocument();
});
it('does not activate unavailable services or expose a browser-only substitute', async () => {
  const s = snapshot();
  s.status = { ...status!, available: false };
  const api = makeAPI(s);
  render(<TrialPanel api={api} />);
  await screen.findByText(/体验服务暂未开放/);
  fireEvent.change(screen.getByLabelText('体验码'), { target: { value: 'AASC-valid-test-code' } });
  fireEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('button', { name: '开始体验' })).toBeDisabled();
  cleanup();
  render(<TrialLauncher />);
  expect(screen.queryByText('使用体验码')).not.toBeInTheDocument();
});
it('keeps an ambiguous request locked and retries only its existing key', async () => {
  const api = makeAPI(snapshot(true));
  const pending = {
    ...snapshot(true),
    pending: { requestKey: 'existing-key', prompt: '解释一个概念' },
  };
  vi.mocked(api.ask).mockResolvedValue({ ok: false, error: 'network_error', data: pending });
  render(<TrialPanel api={api} />);
  await screen.findByLabelText('输入问题');
  fireEvent.change(screen.getByLabelText('输入问题'), { target: { value: '解释一个概念' } });
  fireEvent.click(screen.getByRole('button', { name: '发送问题' }));
  await screen.findByRole('button', { name: '重试同一问题' });
  expect(screen.getByLabelText('输入问题')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '重试同一问题' }));
  await waitFor(() => expect(api.retry).toHaveBeenCalledWith());
  expect(api.ask).toHaveBeenCalledTimes(1);
});
it('enforces exhaustion and renders model output as plain text', async () => {
  const s = snapshot(true);
  s.session = {
    ...s.session!,
    state: 'exhausted',
    remaining: 0,
    completed: 3,
    turns: [
      {
        id: 'one',
        requestKey: 'one',
        prompt: '解释 HTML',
        answer: '<script>bad()</script>',
        status: 'completed',
        createdAt: Date.now(),
        truncated: 1,
      },
    ],
  };
  render(<TrialPanel api={makeAPI(s)} />);
  await screen.findByText('剩余 0 / 3 次');
  expect(screen.getByRole('button', { name: '发送问题' })).toBeDisabled();
  expect(screen.getByText('<script>bad()</script>')).toBeInTheDocument();
  expect(document.querySelector('script')).toBeNull();
  expect(screen.getByText(/回复已达到长度上限/)).toBeInTheDocument();
});
it('opens a real desktop trial before local CLI checks or setup', async () => {
  const api = makeAPI();
  const onNext = vi.fn();
  window.electronAPI = { trial: api } as never;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  render(
    <WelcomeStep
      onNext={onNext}
      setConfig={vi.fn()}
      config={{
        port: 3333,
        enabledClis: ['claude'],
        hookDensity: 'medium',
        debug: false,
        sessionHistoryHours: 24,
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '使用体验码' }));
  await screen.findByRole('dialog');
  await screen.findByLabelText('体验码');
  expect(onNext).not.toHaveBeenCalled();
});
it('ignores a late refresh after logout', async () => {
  const api = makeAPI(snapshot(true));
  render(<TrialPanel api={api} />);
  await screen.findByLabelText('输入问题');
  let resolve!: (v: TrialResult) => void;
  vi.mocked(api.refresh).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  fireEvent.click(screen.getByRole('button', { name: '退出体验' }));
  fireEvent.click(screen.getByRole('button', { name: '确认退出' }));
  await screen.findByLabelText('体验码');
  await act(async () => resolve({ ok: true as const, data: snapshot(true) }));
  expect(screen.queryByLabelText('输入问题')).not.toBeInTheDocument();
});
