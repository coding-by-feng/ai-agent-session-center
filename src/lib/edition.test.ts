import { describe, it, expect } from 'vitest';
import {
  APP_DISPLAY_NAME,
  IS_LITE,
  LITE_NAV_ROUTES,
  LITE_SETTINGS_TABS,
  liteAllowsShortcut,
  liteSessionTabs,
} from './edition';

const TABS = ['project', 'terminal', 'commands', 'conversation', 'aiPopups', 'notes', 'queue', 'agents', 'activity']
  .map((id) => ({ id }));

describe('edition', () => {
  it('is the full app when no build set an edition (tests, harnesses, the npm server)', () => {
    expect(IS_LITE).toBe(false);
    expect(APP_DISPLAY_NAME).toBe('AI Agent Session Center');
  });

  it('keeps the mandatory top tabs and settings, and nothing else', () => {
    expect([...LITE_NAV_ROUTES]).toEqual(['/', '/history']);
    expect([...LITE_SETTINGS_TABS]).toEqual(['appearance', 'sound', 'translation']);
  });
});

describe('liteSessionTabs', () => {
  it('opens with TERMINAL and COMMANDS, then PROJECT, AI POPUPS and QUEUE, and leaves the rest out', () => {
    expect(liteSessionTabs(TABS).map((t) => t.id)).toEqual(['terminal', 'commands', 'project', 'aiPopups', 'queue']);
  });

  it('adds CONVERSATION for a session with no terminal, which has nothing else to read', () => {
    expect(liteSessionTabs(TABS, false).map((t) => t.id)).toEqual(['terminal', 'commands', 'conversation', 'project', 'aiPopups', 'queue']);
  });
});


describe('liteAllowsShortcut', () => {
  it.each([
    'toggleFullscreen', 'scrollToBottom', 'terminalToggleAutoScroll', 'switchSession1', 'switchSession9',
    'switchLatestSession', 'jumpToSession', 'switchTabProject', 'switchTabTerminal', 'switchTabCommands', 'switchTabQueue',
    'fileBrowserSearch', 'floatMinimize', 'floatMaximize', 'floatClose',
  ])('keeps %s', (actionId) => {
    expect(liteAllowsShortcut(actionId)).toBe(true);
  });

  it.each([
    'terminalRefresh', 'terminalClone', 'terminalFork', 'terminalPopOut', 'switchTabPrompts',
    'switchTabNotes', 'someFutureShortcut',
  ])('leaves out %s', (actionId) => {
    expect(liteAllowsShortcut(actionId)).toBe(false);
  });
});
