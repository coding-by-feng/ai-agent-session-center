// Settings ▸ ADVANCED ▸ Terminal: the replay-buffer MB box and the live-scrollback
// lines box, with their presets. Each value is clamped by the store and saved;
// a typed value survives the panel closing with Esc (Modal unmounts, no blur).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import SettingsPanel from './SettingsPanel';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';

vi.mock('./ThemeSettings', () => ({ default: () => null }));
vi.mock('./SoundSettings', () => ({ default: () => null }));
vi.mock('./HookSettings', () => ({ default: () => null }));
vi.mock('./ApiKeySettings', () => ({ default: () => null }));
vi.mock('./SummaryPromptSettings', () => ({ default: () => null }));
vi.mock('@/components/ui/Modal', () => ({
  default: ({ modalId, children }: { modalId: string; children: React.ReactNode }) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const activeModal = useUiStore((s) => s.activeModal);
    return activeModal === modalId ? <div role="dialog">{children}</div> : null;
  },
}));

const MB = 1024 * 1024;
const mbBox = () => screen.getByRole('spinbutton', { name: 'Terminal scrollback replay buffer size in megabytes' }) as HTMLInputElement;
const linesBox = () => screen.getByRole('spinbutton', { name: 'Terminal live scrollback in lines' }) as HTMLInputElement;
const state = () => useSettingsStore.getState();

function openAdvanced() {
  useUiStore.setState({ activeModal: 'settings' });
  const view = render(<SettingsPanel />);
  fireEvent.click(screen.getByText('ADVANCED'));
  return view;
}

describe('Settings ▸ Terminal', () => {
  let persist: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    persist = vi.fn(async () => {});
    useSettingsStore.setState({ terminalReplayBufferBytes: MB, terminalScrollbackLines: 5000, persistSetting: persist } as never);
  });

  it('the MB box commits on Enter, clamps to 0.25–32 and reverts junk', () => {
    openAdvanced();
    fireEvent.change(mbBox(), { target: { value: '7.5' } });
    fireEvent.keyDown(mbBox(), { key: 'Enter' });
    fireEvent.blur(mbBox());
    expect(state().terminalReplayBufferBytes).toBe(7.5 * MB);
    expect(persist).toHaveBeenCalledWith('terminalReplayBufferBytes', 7.5 * MB);

    fireEvent.change(mbBox(), { target: { value: '500' } });
    fireEvent.blur(mbBox());
    expect(state().terminalReplayBufferBytes).toBe(32 * MB);
    expect(mbBox().value).toBe('32');

    fireEvent.change(mbBox(), { target: { value: '0' } });
    fireEvent.blur(mbBox());
    expect(state().terminalReplayBufferBytes).toBe(0.25 * MB);

    fireEvent.change(mbBox(), { target: { value: '' } });
    fireEvent.blur(mbBox());
    expect(state().terminalReplayBufferBytes).toBe(0.25 * MB);
    expect(mbBox().value).toBe('0.25');
  });

  it('each MB preset sets the size and lights up', () => {
    openAdvanced();
    for (const mb of [1, 2, 5, 10, 20]) {
      const btn = screen.getByRole('button', { name: `${mb} MB` });
      fireEvent.click(btn);
      expect(state().terminalReplayBufferBytes).toBe(mb * MB);
      expect(mbBox().value).toBe(String(mb));
      expect(btn.className).toMatch(/bufferPresetActive/);
    }
  });

  it('the lines box commits, clamps to 1,000–200,000 and reverts junk', () => {
    openAdvanced();
    fireEvent.change(linesBox(), { target: { value: '30000' } });
    fireEvent.blur(linesBox());
    expect(state().terminalScrollbackLines).toBe(30000);
    expect(persist).toHaveBeenCalledWith('terminalScrollbackLines', 30000);

    fireEvent.change(linesBox(), { target: { value: '10' } });
    fireEvent.blur(linesBox());
    expect(state().terminalScrollbackLines).toBe(1000);
    expect(linesBox().value).toBe('1000');

    fireEvent.change(linesBox(), { target: { value: '9999999' } });
    fireEvent.blur(linesBox());
    expect(state().terminalScrollbackLines).toBe(200000);

    fireEvent.change(linesBox(), { target: { value: 'abc' } });
    fireEvent.blur(linesBox());
    expect(state().terminalScrollbackLines).toBe(200000);
    expect(linesBox().value).toBe('200000');
  });

  it('each lines preset sets the depth and lights up', () => {
    openAdvanced();
    for (const lines of [5000, 20000, 50000, 100000]) {
      const btn = screen.getByRole('button', { name: lines.toLocaleString() });
      fireEvent.click(btn);
      expect(state().terminalScrollbackLines).toBe(lines);
      expect(linesBox().value).toBe(String(lines));
      expect(btn.className).toMatch(/bufferPresetActive/);
    }
  });

  it('a value typed but never blurred is kept when the panel closes (Esc unmounts it)', () => {
    openAdvanced();
    fireEvent.change(mbBox(), { target: { value: '3' } });
    fireEvent.change(linesBox(), { target: { value: '40000' } });
    // Esc: the Modal closes by rendering nothing; the inputs never blur.
    fireEvent.keyDown(document, { key: 'Escape' });
    act(() => useUiStore.setState({ activeModal: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(state().terminalReplayBufferBytes).toBe(3 * MB);
    expect(state().terminalScrollbackLines).toBe(40000);
  });

  it('closing without typing writes nothing', () => {
    openAdvanced();
    act(() => useUiStore.setState({ activeModal: null }));
    expect(persist).not.toHaveBeenCalled();
  });
});
