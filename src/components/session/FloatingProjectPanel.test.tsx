import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import FloatingProjectPanel from './FloatingProjectPanel';

// Tooltip just wraps children; render them directly so aria-labels are queryable.
vi.mock('@/components/ui/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Drive `projectPath` (gates the pop-out button + canPopOut) through one fake session.
let mockProjectPath: string | undefined = '/Users/me/proj';
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: { sessions: Map<string, { projectPath?: string }> }) => unknown) =>
    selector({ sessions: new Map([['s1', { projectPath: mockProjectPath }]]) }),
}));

const POP_LABEL = 'Pop out to a window';

describe('FloatingProjectPanel — pop-out (button)', () => {
  beforeEach(() => {
    localStorage.clear();
    mockProjectPath = '/Users/me/proj';
  });
  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opens a native window via electronAPI when the ⧉ button is clicked', () => {
    const openProjectWindow = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('electronAPI', { openProjectWindow });

    render(<FloatingProjectPanel sessionId="s1" bodyRef={() => {}} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(POP_LABEL));

    expect(openProjectWindow).toHaveBeenCalledWith({ path: '/Users/me/proj', label: 'Project' });
  });

  it('hides the pop-out button when the session has no project path', () => {
    mockProjectPath = undefined;
    render(<FloatingProjectPanel sessionId="s1" bodyRef={() => {}} onClose={vi.fn()} />);
    expect(screen.queryByLabelText(POP_LABEL)).toBeNull();
  });

  it('falls back to window.open with a stable per-path name in the browser', () => {
    vi.stubGlobal('electronAPI', undefined);
    const openSpy = vi.spyOn(window, 'open').mockReturnValue({} as Window);

    render(<FloatingProjectPanel sessionId="s1" bodyRef={() => {}} onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(POP_LABEL));

    expect(openSpy).toHaveBeenCalledWith(
      expect.stringContaining('/project-browser?path='),
      'aasc-project-_Users_me_proj',
    );
  });
});

describe('FloatingProjectPanel — drag-to-edge auto pop-out', () => {
  // jsdom computes no layout, so stub the geometry the drag math reads:
  // offsetParent (→ parentRef) and a fixed container rect.
  const RECT = {
    left: 0, top: 0, right: 600, bottom: 400, width: 600, height: 400, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  let originalOffsetParent: PropertyDescriptor | undefined;

  beforeEach(() => {
    localStorage.clear();
    mockProjectPath = '/Users/me/proj';
    originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent');
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() { return this.parentElement; },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT);
  });
  afterEach(() => {
    if (originalOffsetParent) {
      Object.defineProperty(HTMLElement.prototype, 'offsetParent', originalOffsetParent);
    }
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const startDrag = (clientX: number) => {
    // The header carries onMouseDown; the title span bubbles to it (and is not a button).
    fireEvent.mouseDown(screen.getByText('PROJECT'), { clientX, clientY: 50 });
  };
  const moveTo = (clientX: number) =>
    act(() => {
      document.dispatchEvent(new MouseEvent('mousemove', { clientX, clientY: 50, bubbles: true }));
    });
  const release = async () =>
    act(async () => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });

  it('pops out and closes the in-app float when dragged past the container edge', async () => {
    const openProjectWindow = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('electronAPI', { openProjectWindow });
    const onClose = vi.fn();

    render(<FloatingProjectPanel sessionId="s1" bodyRef={() => {}} onClose={onClose} />);

    startDrag(100);
    moveTo(360); // far past the right edge → arms the gesture
    // Hint appears while armed.
    expect(screen.getByText('Release to pop out')).toBeTruthy();
    await release();

    expect(openProjectWindow).toHaveBeenCalledWith({ path: '/Users/me/proj', label: 'Project' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('does NOT pop out on a normal in-bounds reposition', async () => {
    const openProjectWindow = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('electronAPI', { openProjectWindow });
    const onClose = vi.fn();

    render(<FloatingProjectPanel sessionId="s1" bodyRef={() => {}} onClose={onClose} />);

    startDrag(100);
    moveTo(130); // small move, never crosses the edge threshold
    expect(screen.queryByText('Release to pop out')).toBeNull();
    await release();

    expect(openProjectWindow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
