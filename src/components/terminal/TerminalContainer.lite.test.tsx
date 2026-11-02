// TerminalContainer.lite.test.tsx — the Lite desktop's terminal keeps the buttons it needs. A phone
// paired to Lite loads this same bundle and keeps its whole terminal, including the AI popup.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));
const platform = vi.hoisted(() => ({ isMobile: false }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));
vi.mock('@/lib/deviceIdentity', () => ({ getClientId: () => 'me', getClientLabel: () => 'Mac' }));
const fn = vi.hoisted(() => () => () => {});
const stableTerminal = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/hooks/useTerminal', () => ({
  useTerminal: () => {
    stableTerminal.value ??= {
      containerRef: { current: null }, attach: fn(), detach: fn(), terminalClosed: null, isFullscreen: false,
      toggleFullscreen: fn(), sendEscape: fn(), sendArrowUp: fn(), sendArrowDown: fn(), sendEnter: fn(), sendKeys: fn(),
      pasteToTerminal: fn(), refitTerminal: fn(), setTheme: fn(), handleTerminalOutput: fn(), handleTerminalGeometry: fn(),
      widthMode: 'pan', setWidthMode: fn(), handleTerminalReady: fn(), handleTerminalClosed: fn(), handleTerminalCleared: fn(),
      reparent: fn(), scrollToBottom: fn(), refreshOutput: fn(), clearOutput: fn(), scrollPageUp: fn(), scrollPageDown: fn(),
      autoScrollEnabled: false, toggleAutoScroll: fn(), readRecentText: () => ({ text: '', absBottom: 0 }),
      getXtermSelection: () => null, hasXtermSelection: () => false,
    };
    return stableTerminal.value;
  },
}));
// Every toolbar the container draws: the docked one, and the fullscreen overlay's own.
const toolbar = vi.hoisted(() => ({ all: [] as Array<Record<string, unknown>> }));
vi.mock('./TerminalToolbar', () => ({
  default: (props: Record<string, unknown>) => { toolbar.all.push(props); return null; },
}));
const selection = vi.hoisted(() => ({ enabled: null as boolean | null }));
vi.mock('@/hooks/useSelectionPopup', () => ({
  useSelectionPopup: (options: { enabled: boolean }) => {
    selection.enabled = options.enabled;
    return { active: null, dismiss: () => {}, openFromExternal: () => {} };
  },
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

import TerminalContainer from './TerminalContainer';
import { useSettingsStore } from '@/stores/settingsStore';

const actions = { onFork: vi.fn(), onClone: vi.fn(), onRestart: vi.fn(), onPopOut: vi.fn(), onReconnect: vi.fn() };

function mount() {
  return render(<TerminalContainer terminalId="term-1" ws={null} originSessionId="s1" {...actions} />);
}

describe('TerminalContainer in the Lite build', () => {
  beforeEach(() => {
    toolbar.all = [];
    selection.enabled = null;
    platform.isMobile = false;
    useSettingsStore.setState({ translationEnabled: true } as never);
  });

  it('keeps the desktop buttons Lite needs, in both toolbars', () => {
    mount();
    expect(toolbar.all.length).toBeGreaterThanOrEqual(2);
    for (const props of toolbar.all) {
      expect(props.onRestart).toBe(actions.onRestart);
      expect(props.onReconnect).toBe(actions.onReconnect);
      for (const kept of ['onToggleAutoScroll', 'onScrollToBottom', 'onFullscreen']) {
        expect(props[kept], kept).toEqual(expect.any(Function));
      }
    }
  });

  it('hides the rest on the desktop, fullscreen included', () => {
    mount();
    for (const props of toolbar.all) {
      for (const hidden of ['onFork', 'onClone', 'onPopOut', 'onRefreshOutput', 'onClearOutput', 'onToggleAiPopup', 'onToggleWrapMode', 'wrapMode']) {
        expect(props[hidden], hidden).toBeUndefined();
      }
      expect(props.ttsEnabled).toBeFalsy();
    }
  });

  it('never opens the AI popup from a desktop selection', () => {
    mount();
    expect(selection.enabled).toBe(false);
  });

  it('keeps the AI popup for a phone paired to Lite', () => {
    platform.isMobile = true;
    mount();
    expect(selection.enabled).toBe(true);
  });

  describe('voice set up in Full, which shares these settings', () => {
    /** fireEvent answers false when a handler called preventDefault, which is what taking over Space does. */
    const spaceReachesTheButton = () => {
      const { container } = mount();
      const inside = container.firstElementChild?.appendChild(document.createElement('button'));
      return fireEvent.keyDown(inside as HTMLElement, { code: 'Space' });
    };
    beforeEach(() => {
      useSettingsStore.setState({ ttsEnabled: true, googleTtsApiKey: 'key' } as never);
    });
    afterEach(() => {
      useSettingsStore.setState({ ttsEnabled: false, googleTtsApiKey: '' } as never);
    });

    it('leaves Space alone on the desktop, which has no way to turn voice off', () => {
      expect(spaceReachesTheButton()).toBe(true);
    });

    it('keeps hold-to-speak on a phone paired to Lite', () => {
      platform.isMobile = true;
      expect(spaceReachesTheButton()).toBe(false);
    });
  });
});
