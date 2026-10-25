// MoreScreens.test.tsx — the phone's More tab and what it opens (AASC-47): the
// grouped list, Appearance (the ten desktop themes, text size — AASC-58), Notifications per
// session, Advanced → Reset with a confirm, This phone, and Saved prompts.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/alarmEngine', () => ({ muteSession: vi.fn(), unmuteSession: vi.fn(), alertSession: vi.fn(), unalertSession: vi.fn() }));
vi.mock('@/lib/deviceIdentity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/deviceIdentity')>()),
  getClientId: () => 'phone',
}));

import MoreScreen from './MoreScreen';
import SettingsScreen from './SettingsScreen';
import ThisPhoneScreen from './ThisPhoneScreen';
import SavedPromptsView from './SavedPromptsView';
import { usePhoneNavStore, defaultStacks } from '@/stores/phoneNavStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useWsStore } from '@/stores/wsStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import { useQueueStore } from '@/stores/queueStore';
import { PHONE_TEXT_SCALE_KEY, readPhoneTextScale, resetPhoneAppearanceForTest } from '@/lib/chat/phoneAppearance';

const sess = (id: string, title: string, over: Partial<Session> = {}) =>
  ({ sessionId: id, title, projectName: title, status: 'idle', lastActivityAt: 0, ...over }) as unknown as Session;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
  localStorage.clear();
  resetPhoneAppearanceForTest();
  usePhoneNavStore.setState({ tab: 'more', stacks: defaultStacks() });
  useSessionStore.setState({ sessions: new Map([['s1', sess('s1', 'web')], ['s2', sess('s2', 'api', { muted: true })], ['s3', sess('s3', 'old', { status: 'ended' })]]) });
  usePresenceStore.getState().applyPresence({
    devices: [
      { clientId: 'mac', label: 'MacBook', address: '', isLocal: true, connections: 1, connectedAt: 0, lastSeenAt: 0 },
      { clientId: 'phone', label: 'Kason’s iPhone', address: '', isLocal: false, connections: 1, connectedAt: 0, lastSeenAt: 0 },
    ],
    controllers: [],
    restoreOwner: 'mac',
    workspaceWriter: 'mac',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MoreScreen', () => {
  it('lists Library, Settings and This phone, each a pushed screen; About lives in This phone', async () => {
    const user = userEvent.setup();
    render(<MoreScreen />);
    const library = within(screen.getByRole('region', { name: 'Library' })).getAllByRole('button').map((b) => b.textContent ?? '');
    for (const t of ['History', 'Saved prompts', 'Review', 'Agenda']) expect(library.some((l) => l.startsWith(t))).toBe(true);
    // A paired phone reads prompts one session at a time: its session's Prompts tab, not a second Prompt Trace.
    expect(library.some((l) => l.startsWith('Prompt Trace'))).toBe(false);
    expect(screen.queryByRole('region', { name: 'About' })).toBeNull();
    const settings = within(screen.getByRole('region', { name: 'Settings' })).getAllByRole('button').map((b) => b.textContent ?? '');
    for (const t of ['Appearance', 'Notifications', 'Voice', 'Translation', 'Advanced']) expect(settings.some((s) => s.startsWith(t))).toBe(true);
    await user.click(screen.getByRole('button', { name: /Saved prompts/ }));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/saved-prompts');
    await user.click(screen.getByRole('button', { name: /Paired with MacBook/ }));
    expect(usePhoneNavStore.getState().stacks.more.at(-1)).toBe('/more/phone');
  });

  it('lists Prompt Trace on the Mac itself, where it reads every session', () => {
    usePresenceStore.getState().applyPresence({
      devices: [{ clientId: 'phone', label: 'MacBook browser', address: '', isLocal: true, connections: 1, connectedAt: 0, lastSeenAt: 0 }],
      controllers: [], restoreOwner: 'phone', workspaceWriter: 'phone',
    });
    render(<MoreScreen />);
    const library = within(screen.getByRole('region', { name: 'Library' })).getAllByRole('button').map((b) => b.textContent ?? '');
    expect(library.some((l) => l.startsWith('Prompt Trace'))).toBe(true);
  });

  // Oct 21 2026: the shell now reopens the Mac used last, so its list of Macs needs a way in from here.
  it('offers Switch Mac in the phone app: back to the app’s Your Macs, to open another Mac or pair one', async () => {
    const user = userEvent.setup();
    const ua = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile/15E148 AASC-Mobile/1 (ios)');
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, hostname: window.location.hostname, assign });
    try {
      render(<MoreScreen />);
      await user.click(within(screen.getByRole('region', { name: 'This phone' })).getByRole('button', { name: /Switch Mac/ }));
      expect(assign).toHaveBeenCalledWith('capacitor://localhost/?tap=1');
    } finally {
      ua.mockRestore();
    }
  });

  it('has no Switch Mac in a phone browser: there is no app list of Macs to go back to', () => {
    render(<MoreScreen />);
    expect(screen.queryByRole('button', { name: /Switch Mac/ })).toBeNull();
  });

  it('has no layout switch: every phone has this design (AASC-48)', () => {
    render(<MoreScreen />);
    expect(screen.queryByRole('switch', { name: /New design/ })).toBeNull();
    expect(screen.queryByText(/classic/i)).toBeNull();
  });
});

describe('Settings pages', () => {
  it('offers the desktop’s ten themes as swatches; a tap picks one for this phone and saves it', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({ themeName: 'windows-xp' });
    const persist = vi.spyOn(useSettingsStore.getState(), 'persistSetting').mockResolvedValue();
    render(<SettingsScreen page="appearance" />);
    const themes = within(screen.getByRole('region', { name: 'Theme' })).getAllByRole('button');
    expect(themes.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Command Center, dark', 'Cyberpunk, dark', 'Warm, light', 'Dracula, dark', 'Solarized, dark',
      'Nord, dark', 'Monokai, dark', 'Light, light', 'Blonde, light', 'Windows XP, light, selected',
    ]);
    expect(themes.every((b) => b.querySelector('[data-swatch]'))).toBe(true);
    // No separate light / dark switch any more: it comes with the theme.
    expect(screen.queryByRole('button', { name: /^System/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Nord, dark' }));
    expect(useSettingsStore.getState().themeName).toBe('nord');
    expect(persist).toHaveBeenCalledWith('themeName', 'nord');
    expect(screen.getByRole('button', { name: 'Nord, dark, selected' })).toBeTruthy();
  });

  it('keeps the app’s text size adjustable on this phone', async () => {
    const user = userEvent.setup();
    render(<SettingsScreen page="appearance" />);
    expect(screen.getByText('100%')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Larger text' }));
    expect(readPhoneTextScale()).toBeGreaterThan(1);
    expect(localStorage.getItem(PHONE_TEXT_SCALE_KEY)).toBe(String(readPhoneTextScale()));
    // 110 % → 100 → 90 → 85 %, the smallest (100 % is what used to be 80 %).
    for (let i = 0; i < 3; i++) await user.click(screen.getByRole('button', { name: 'Smaller text' }));
    expect(readPhoneTextScale()).toBe(0.85);
    expect(screen.getByText('85%')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Smaller text' })).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows the chosen theme on the Appearance row', () => {
    useSettingsStore.setState({ themeName: 'dracula' });
    render(<MoreScreen />);
    expect(within(screen.getByRole('region', { name: 'Settings' })).getByRole('button', { name: /^Appearance/ }).textContent).toContain('Dracula');
  });

  it('says it is loading, not "No live sessions", before the Mac’s first snapshot (Oct 20 2026)', () => {
    useSessionStore.setState({ sessions: new Map() });
    useWsStore.setState({ snapshotReceived: false, connected: true });
    render(<SettingsScreen page="notifications" />);
    expect(screen.getByText('Loading sessions…')).toBeTruthy();
    expect(screen.queryByText('No live sessions')).toBeNull();
  });

  it('switches each live session\'s notifications', async () => {
    const user = userEvent.setup();
    render(<SettingsScreen page="notifications" />);
    const web = screen.getByRole('switch', { name: 'Notifications from web' });
    const api = screen.getByRole('switch', { name: 'Notifications from api' });
    expect(web).toHaveAttribute('aria-checked', 'true');
    expect(api).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('switch', { name: 'Notifications from old' })).toBeNull();
    await user.click(web);
    expect(useSessionStore.getState().sessions.get('s1')?.muted).toBe(true);
  });

  it('resets this phone\'s settings only after a confirm', async () => {
    const user = userEvent.setup();
    const reset = vi.spyOn(useSettingsStore.getState(), 'resetDefaults').mockImplementation(() => {});
    render(<SettingsScreen page="advanced" />);
    await user.click(screen.getByRole('button', { name: /Reset to defaults/ }));
    expect(reset).not.toHaveBeenCalled();
    localStorage.setItem(PHONE_TEXT_SCALE_KEY, '1.5');
    resetPhoneAppearanceForTest();
    await user.click(within(await screen.findByRole('dialog', { name: 'Reset all settings?' })).getByRole('button', { name: 'Reset' }));
    expect(reset).toHaveBeenCalled();
    expect(readPhoneTextScale()).toBe(1); // the text size is one of this phone's settings too
  });

  it('lists every settings page on More → Settings', () => {
    render(<SettingsScreen />);
    expect(screen.getAllByRole('button').map((b) => b.textContent ?? '').filter((t) => /^(Appearance|Notifications|Voice|Translation|Advanced)/.test(t))).toHaveLength(5);
  });
});

describe('ThisPhoneScreen', () => {
  it('names the paired Mac, the connection and this phone, and says where lock and unpair live', () => {
    render(<ThisPhoneScreen />);
    expect(screen.getByText('MacBook')).toBeTruthy();
    expect(screen.getByText('Kason’s iPhone')).toBeTruthy();
    expect(screen.getByText('On this Mac')).toBeTruthy();
    expect(screen.getByText('In the AASC app')).toBeTruthy();
  });

  it('says which AASC serves it and where it runs (what About said)', () => {
    render(<ThisPhoneScreen />);
    const about = screen.getByRole('region', { name: 'AASC' });
    expect(within(about).getByText('AASC on your Mac')).toBeTruthy();
    expect(within(about).getByText('Running in')).toBeTruthy();
    expect(within(about).getByText('A phone browser')).toBeTruthy();
    // The bundle's version, or "Unknown" where the build set none (tests, harnesses).
    expect(within(about).getByText(/^(\d+\.\d+\.\d+.*|Unknown)$/)).toBeTruthy();
  });
});

describe('SavedPromptsView', () => {
  beforeEach(() => {
    usePromptSnippetStore.setState({
      loaded: true,
      revision: 1,
      snippets: [
        { id: 1, text: 'Run the full test suite.', label: 'Fix tests', useCount: 3, lastUsedAt: 10, createdAt: 1 },
        { id: 2, text: 'Summarise the changes.\nIn five bullets.', label: '', useCount: 0, lastUsedAt: null, createdAt: 2 },
      ],
    });
    useQueueStore.setState({ queues: new Map() });
  });

  it('lists and searches the saved prompts', async () => {
    const user = userEvent.setup();
    render(<SavedPromptsView />);
    expect(screen.getByRole('button', { name: /Fix tests/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Summarise the changes\./ })).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search saved prompts' }), 'bullets');
    expect(screen.queryByRole('button', { name: /Fix tests/ })).toBeNull();
  });

  it('queues a saved prompt for a session', async () => {
    const user = userEvent.setup();
    const touch = vi.spyOn(usePromptSnippetStore.getState(), 'touch').mockResolvedValue();
    render(<SavedPromptsView />);
    await user.click(screen.getByRole('button', { name: /Fix tests/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Fix tests' })).getByRole('button', { name: /Queue it for a session/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Queue it for…' })).getByRole('button', { name: /^web/ }));
    expect(useQueueStore.getState().queues.get('s1')?.map((i) => i.text)).toEqual(['Run the full test suite.']);
    expect(touch).toHaveBeenCalledWith(1);
  });

  it('deletes a saved prompt only after a confirm', async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(usePromptSnippetStore.getState(), 'remove').mockResolvedValue();
    render(<SavedPromptsView />);
    await user.click(screen.getByRole('button', { name: /Fix tests/ }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Fix tests' })).getByRole('button', { name: 'Delete' }));
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog', { name: 'Delete this saved prompt?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(1));
  });
});
