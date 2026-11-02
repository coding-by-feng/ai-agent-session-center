import { describe, it, expect } from 'vitest';
import {
  APP_DISPLAY_NAME,
  IS_LITE,
  LITE_NAV_ROUTES,
  LITE_SETTINGS_TABS,
  liteAllowsShortcut,
  liteSessionTabs,
  liteAllowsAutoResume,
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
    expect([...LITE_SETTINGS_TABS]).toEqual(['appearance', 'sound']);
  });
});

describe('liteSessionTabs', () => {
  it('opens with TERMINAL, then PROJECT, and leaves the rest out', () => {
    expect(liteSessionTabs(TABS, 0).map((t) => t.id)).toEqual(['terminal', 'project']);
  });

  it('adds QUEUE only while the session has queued prompts, so none send out of sight', () => {
    expect(liteSessionTabs(TABS, 1).map((t) => t.id)).toEqual(['terminal', 'project', 'queue']);
    expect(liteSessionTabs(TABS, 0).map((t) => t.id)).not.toContain('queue');
  });

  it('adds CONVERSATION for a session with no terminal, which has nothing else to read', () => {
    expect(liteSessionTabs(TABS, 0, false).map((t) => t.id)).toEqual(['terminal', 'conversation', 'project']);
    expect(liteSessionTabs(TABS, 1, false).map((t) => t.id)).toEqual(['terminal', 'conversation', 'project', 'queue']);
  });
});

describe('liteAllowsAutoResume', () => {
  it('needs queued prompts, because its switch lives in QUEUE and QUEUE shows only with them', () => {
    expect(liteAllowsAutoResume(0)).toBe(false);
    expect(liteAllowsAutoResume(1)).toBe(true);
  });
});

describe('liteAllowsShortcut', () => {
  it.each([
    'toggleFullscreen', 'scrollToBottom', 'terminalToggleAutoScroll', 'switchSession1', 'switchSession9',
    'switchLatestSession', 'jumpToSession', 'switchTabProject', 'switchTabTerminal', 'fileBrowserSearch',
  ])('keeps %s', (actionId) => {
    expect(liteAllowsShortcut(actionId)).toBe(true);
  });

  it.each([
    'terminalRefresh', 'terminalClone', 'terminalFork', 'terminalPopOut', 'switchTabCommands', 'switchTabPrompts',
    'switchTabNotes', 'switchTabQueue', 'floatMinimize', 'floatMaximize', 'floatClose', 'someFutureShortcut',
  ])('leaves out %s', (actionId) => {
    expect(liteAllowsShortcut(actionId)).toBe(false);
  });
});
