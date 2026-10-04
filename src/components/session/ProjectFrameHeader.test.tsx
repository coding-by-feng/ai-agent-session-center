import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import ProjectFrameHeader from './ProjectFrameHeader';
import { launchSession, type LaunchResult } from '@/lib/launchSession';
import type { ProjectGroup } from '@/lib/projectGroups';
import { usePresenceStore } from '@/stores/presenceStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import { getClientId } from '@/lib/deviceIdentity';
import type { DevicePresence } from '@/types/websocket';

// The header decides WHAT to ask for and when to hold the buttons; the request itself (body, toast,
// selection) is launchSession's, covered in launchSession.test.ts. `launchBlocker` is the real one.
vi.mock('@/lib/launchSession', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/launchSession')>()),
  launchSession: vi.fn(),
}));

const group = (over: Partial<ProjectGroup> = {}): ProjectGroup => ({
  key: 'localhost|/Users/me/agent-manager',
  path: '/Users/me/agent-manager',
  launchPath: '/Users/me/agent-manager',
  host: 'localhost',
  local: true,
  label: 'agent-manager',
  colorIndex: 0,
  sessions: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }] as never,
  ...over,
});

const claudeBtn = () => screen.getByRole('button', { name: 'New Claude session in agent-manager' });
const codexBtn = () => screen.getByRole('button', { name: 'New Codex session in agent-manager' });
const anyChip = () => screen.queryByRole('button', { name: /^New .* session in/ });

/** Click, and let the launch settle inside act: the header updates state when the request returns. */
const press = async (button: HTMLElement) => {
  await act(async () => { fireEvent.click(button); });
};

const OK: LaunchResult = { ok: true, terminalId: 't1', deduplicated: false };

/** This device as the server's presence list reports it. */
const thisDevice = (isLocal: boolean): DevicePresence => ({
  clientId: getClientId(),
  label: isLocal ? 'Mac' : 'iPhone',
  address: isLocal ? '127.0.0.1' : '192.168.1.20',
  isLocal,
  connections: 1,
  connectedAt: 0,
  lastSeenAt: 0,
});

const room = (id: string, sessionIds: string[]): Room => ({ id, name: id.toUpperCase(), sessionIds, collapsed: false, createdAt: 0 });

describe('ProjectFrameHeader', () => {
  beforeEach(() => {
    vi.mocked(launchSession).mockReset();
    vi.mocked(launchSession).mockResolvedValue(OK);
    // The machine that hosts the dashboard — the only place the chips are offered.
    usePresenceStore.setState({ devices: [thisDevice(true)] });
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ selectedRoomIds: new Set() });
  });

  afterEach(() => {
    // Unmount first: updating a store a mounted component reads, outside act, is a warning per test.
    cleanup();
    usePresenceStore.setState({ devices: [] });
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ selectedRoomIds: new Set() });
    window.history.pushState({}, '', '/');
  });

  describe('collapse', () => {
    it('offers to fold an open frame and says which project it is', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      const toggle = screen.getByRole('button', { name: 'Collapse project agent-manager' });
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    });

    it('offers to unfold a folded frame and shows how many sessions it hides', () => {
      const { container } = render(<ProjectFrameHeader group={group()} collapsed onToggleCollapse={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Expand project agent-manager' })).toHaveAttribute('aria-expanded', 'false');
      expect(container.querySelector('[class*="roomCollapsedCount"]')?.textContent).toBe('3');
    });

    it('shows no count while open', () => {
      const { container } = render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(container.querySelector('[class*="roomCollapsedCount"]')).toBeNull();
    });

    it('calls back when the triangle is clicked', () => {
      const onToggle = vi.fn();
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={onToggle} />);
      fireEvent.click(screen.getByRole('button', { name: 'Collapse project agent-manager' }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });

  describe('quick launch', () => {
    it('has one button per CLI, named for the CLI and the project', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(claudeBtn()).toBeInTheDocument();
      expect(codexBtn()).toBeInTheDocument();
    });

    it('starts a NEW session of the chosen CLI in the project directory, and never in home instead', async () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      await press(codexBtn());
      // forceNew is the whole point: without it the server hands back the session already running there and
      // the button would appear to do nothing. requireExistingDir: a directory that is gone must be refused —
      // the server's own fallback is to start the agent in the home directory.
      expect(launchSession).toHaveBeenCalledWith({
        workingDir: '/Users/me/agent-manager',
        command: 'codex',
        forceNew: true,
        requireExistingDir: true,
      });
    });

    it('launches Claude the same way', async () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      await press(claudeBtn());
      expect(launchSession).toHaveBeenCalledWith({
        workingDir: '/Users/me/agent-manager',
        command: 'claude',
        forceNew: true,
        requireExistingDir: true,
      });
    });

    it('launches in the path a session really used, not the tidied key — a folder can end in a space', async () => {
      render(
        <ProjectFrameHeader
          group={group({ path: '/w/app', launchPath: '/w/app ' })}
          collapsed={false}
          onToggleCollapse={vi.fn()}
        />,
      );
      await press(claudeBtn());
      expect(vi.mocked(launchSession).mock.calls[0][0].workingDir).toBe('/w/app ');
    });

    it('keeps the buttons while the frame is folded', async () => {
      render(<ProjectFrameHeader group={group()} collapsed onToggleCollapse={vi.fn()} />);
      await press(claudeBtn());
      expect(launchSession).toHaveBeenCalledTimes(1);
    });

    it('does not let the click reach whatever the frame sits in', async () => {
      const onParentClick = vi.fn();
      render(
        <div onClick={onParentClick}>
          <ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />
        </div>,
      );
      await press(claudeBtn());
      fireEvent.click(screen.getByRole('button', { name: 'Collapse project agent-manager' }));
      expect(onParentClick).not.toHaveBeenCalled();
    });
  });

  // `~/Projects/site (old)` is an ordinary folder, and the server refuses its path outright.
  describe('a path the server would refuse', () => {
    const blocked = () => group({ path: '/Users/me/site (old)', launchPath: '/Users/me/site (old)' });

    it('shows the chips but disabled, with the reason where the name was', () => {
      render(<ProjectFrameHeader group={blocked()} collapsed={false} onToggleCollapse={vi.fn()} />);
      const chip = screen.getByRole('button', { name: 'New Claude session in agent-manager' });
      expect(chip).toHaveAttribute('aria-disabled', 'true');
      expect(chip.getAttribute('title')).toMatch(/can't start a session here/i);
      expect(chip.getAttribute('title')).toContain('( )');
    });

    it('does not send a request that is certain to fail', () => {
      render(<ProjectFrameHeader group={blocked()} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      fireEvent.click(codexBtn());
      expect(launchSession).not.toHaveBeenCalled();
    });

    it('leaves a path with only ordinary characters launchable, spaces and all', async () => {
      render(
        <ProjectFrameHeader
          group={group({ path: '/Users/me/My Projects/site', launchPath: '/Users/me/My Projects/site' })}
          collapsed={false}
          onToggleCollapse={vi.fn()}
        />,
      );
      expect(claudeBtn()).not.toHaveAttribute('aria-disabled');
      await press(claudeBtn());
      expect(launchSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('one launch at a time', () => {
    let release: (result: LaunchResult) => void;
    beforeEach(() => {
      vi.mocked(launchSession).mockImplementation(
        () => new Promise<LaunchResult>((resolve) => { release = resolve; }),
      );
    });

    it('holds BOTH buttons while a launch is in flight, since every click would start another PTY', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      expect(claudeBtn()).toHaveAttribute('aria-disabled', 'true');
      expect(codexBtn()).toHaveAttribute('aria-disabled', 'true');
      expect(claudeBtn()).toHaveAttribute('aria-busy', 'true');
      expect(codexBtn()).not.toHaveAttribute('aria-busy', 'true');
    });

    it('keeps keyboard focus on the chip that was pressed — a real `disabled` would drop it to <body>', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      claudeBtn().focus();
      fireEvent.click(claudeBtn());
      expect(claudeBtn()).toHaveAttribute('aria-disabled', 'true');
      expect(claudeBtn()).toHaveFocus();
    });

    it('ignores a second click that lands before the first launch has finished', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      fireEvent.click(claudeBtn());
      fireEvent.click(codexBtn());
      expect(launchSession).toHaveBeenCalledTimes(1);
    });

    it('ignores a second click in the same instant as the first, before React has re-rendered the buttons as held', () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      const btn = claudeBtn();
      act(() => {
        btn.click();
        btn.click();
      });
      expect(launchSession).toHaveBeenCalledTimes(1);
    });

    it('lets go of the buttons once the launch is done', async () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      await act(async () => { release(OK); });
      expect(claudeBtn()).not.toHaveAttribute('aria-disabled');
      expect(codexBtn()).not.toHaveAttribute('aria-disabled');
      expect(claudeBtn()).not.toHaveAttribute('aria-busy');
    });

    it('lets go after a failed launch too, so the user can try again', async () => {
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      await act(async () => { release({ ok: false, error: 'Directory not found: /Users/me/agent-manager' }); });
      expect(claudeBtn()).not.toHaveAttribute('aria-disabled');
      fireEvent.click(claudeBtn());
      expect(launchSession).toHaveBeenCalledTimes(2);
    });
  });

  // A session the server starts has no room. With the room filter on, the strip shows only sessions in the
  // selected rooms, so the one a chip starts would never appear — and a user who thinks it failed clicks again.
  describe('the room the new session joins', () => {
    const launchAndSettle = async (g: ProjectGroup = group()) => {
      render(<ProjectFrameHeader group={g} collapsed={false} onToggleCollapse={vi.fn()} />);
      fireEvent.click(claudeBtn());
      await act(async () => { await Promise.resolve(); });
    };
    const membersOf = (id: string) => useRoomStore.getState().rooms.find((r) => r.id === id)?.sessionIds;

    it("joins the room its project's sessions are in", async () => {
      useRoomStore.setState({ rooms: [room('ops', ['a', 'b']), room('sms', ['x'])] });
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['a', 'b', 't1']);
      expect(membersOf('sms')).toEqual(['x']);
    });

    it('is the room the room filter shows, when the project spans two', async () => {
      useRoomStore.setState({ rooms: [room('ops', ['a']), room('sms', ['b'])] });
      useUiStore.setState({ selectedRoomIds: new Set(['sms']) });
      await launchAndSettle();
      expect(membersOf('sms')).toEqual(['b', 't1']);
      expect(membersOf('ops')).toEqual(['a']);
    });

    it('is no room when the project spans two and nothing is filtered — that would be a guess', async () => {
      useRoomStore.setState({ rooms: [room('ops', ['a']), room('sms', ['b'])] });
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['a']);
      expect(membersOf('sms')).toEqual(['b']);
    });

    it('is no room when the project is in none', async () => {
      useRoomStore.setState({ rooms: [room('ops', ['x'])] });
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['x']);
    });

    it('is not assigned when the launch failed', async () => {
      useRoomStore.setState({ rooms: [room('ops', ['a'])] });
      vi.mocked(launchSession).mockResolvedValue({ ok: false, error: 'nope' });
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['a']);
    });

    it('is not assigned when the server handed back a session that already existed — it has a room of its own, or chose none', async () => {
      // An id that is NOT already in the room: addSession is idempotent, so reusing a member would pass either way.
      useRoomStore.setState({ rooms: [room('ops', ['a']), room('sms', ['reused'])] });
      vi.mocked(launchSession).mockResolvedValue({ ok: true, terminalId: 'reused', deduplicated: true });
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['a']);
      expect(membersOf('sms')).toEqual(['reused']);
    });

    it('is not assigned from a pop-out window, whose copy of the room list may be hours old and would be written back over the main window\'s', async () => {
      useRoomStore.setState({ rooms: [room('ops', ['a'])] });
      window.history.pushState({}, '', '/?popout=session&sessionId=a');
      await launchAndSettle();
      expect(membersOf('ops')).toEqual(['a']);
    });
  });

  // A session is created hidden from every device but the host, so on a phone each tap would start a
  // PTY running an AI CLI that the phone can never see, select or kill — while toasting "Launched".
  describe('a device that is not the machine hosting the dashboard', () => {
    it('has no launch buttons on a phone', () => {
      usePresenceStore.setState({ devices: [thisDevice(false)] });
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(anyChip()).toBeNull();
    });

    it('has none until the server says this device is local — "not confirmed local" fails closed', () => {
      usePresenceStore.setState({ devices: [] });
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(anyChip()).toBeNull();

      act(() => usePresenceStore.setState({ devices: [thisDevice(true)] }));
      expect(claudeBtn()).toBeInTheDocument();
      expect(codexBtn()).toBeInTheDocument();
    });

    it('does not take a different device\'s "local" for this one', () => {
      usePresenceStore.setState({ devices: [{ ...thisDevice(true), clientId: 'some-other-device' }] });
      render(<ProjectFrameHeader group={group()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(anyChip()).toBeNull();
    });

    it('still folds, and still counts what it hides', () => {
      usePresenceStore.setState({ devices: [thisDevice(false)] });
      const onToggle = vi.fn();
      const { container } = render(<ProjectFrameHeader group={group()} collapsed onToggleCollapse={onToggle} />);
      fireEvent.click(screen.getByRole('button', { name: 'Expand project agent-manager' }));
      expect(onToggle).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[class*="roomCollapsedCount"]')?.textContent).toBe('3');
    });
  });

  describe('another machine', () => {
    const remote = () => group({ key: 'build-box|/srv/app', path: '/srv/app', launchPath: '/srv/app', host: 'build-box', local: false, label: 'app@build-box' });

    it('has no launch buttons — the request carries no host, so it would start a LOCAL session in a directory that may not exist here', () => {
      render(<ProjectFrameHeader group={remote()} collapsed={false} onToggleCollapse={vi.fn()} />);
      expect(anyChip()).toBeNull();
    });

    it('still folds', () => {
      const onToggle = vi.fn();
      render(<ProjectFrameHeader group={remote()} collapsed={false} onToggleCollapse={onToggle} />);
      fireEvent.click(screen.getByRole('button', { name: 'Collapse project app@build-box' }));
      expect(onToggle).toHaveBeenCalledTimes(1);
    });
  });
});
