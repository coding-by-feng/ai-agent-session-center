import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CloudRemoteAccess, { REMOTE_ACCESS_POLL_MS } from './CloudRemoteAccess';
import { CloudApiError, cloudApi } from '@/lib/cloudApi';
import type { PhoneReachView, RemoteAccessView, TailscaleState } from '@/types/remoteAccess';

const ADDRESS = '100.101.102.103';
const PORT = 3334;
/** A local wall-clock time, so "HH:MM" reads the same in every time zone the suite runs in. */
const at = (hour: number, minute: number) => new Date(2026, 9, 21, hour, minute).getTime();

interface ViewPatch {
  tailscale?: Partial<RemoteAccessView['tailscale']>;
  publish?: Partial<RemoteAccessView['publish']>;
  phones?: PhoneReachView[];
}
const view = (patch: ViewPatch = {}): RemoteAccessView => ({
  tailscale: {
    state: 'connected',
    address: ADDRESS,
    account: null,
    tailnet: null,
    dnsName: null,
    canOpenApp: true,
    ...patch.tailscale,
  },
  publish: { state: 'published', tailnet: ADDRESS, port: PORT, at: at(14, 5), ...patch.publish },
  phones: patch.phones ?? [],
  port: PORT,
});
/** A Mac that has no Tailscale address (every state but `connected`). */
const noAddress = (state: TailscaleState, canOpenApp = true): ViewPatch['tailscale'] => ({
  state,
  address: null,
  account: null,
  tailnet: null,
  dnsName: null,
  canOpenApp,
});
const phone = (patch: Partial<PhoneReachView> = {}): PhoneReachView => ({
  id: 'phone-1',
  label: "Kason's iPhone",
  platform: 'ios',
  status: 'active',
  hasTailnet: true,
  tailnetSentAt: at(10, 30),
  lastPath: 'tailnet',
  lastPathAt: at(14, 5),
  ...patch,
});

const read = (first: RemoteAccessView) =>
  vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(first);
function show(props: { visible?: boolean; onConnection?: () => void } = {}) {
  const onConnection = props.onConnection ?? vi.fn();
  const ui = (visible: boolean) => (
    <CloudRemoteAccess visible={visible} onConnection={onConnection} />
  );
  const result = render(ui(props.visible ?? true));
  return {
    ...result,
    onConnection,
    setVisible: (visible: boolean) => result.rerender(ui(visible)),
  };
}
const tailscaleCard = () => screen.getByRole('region', { name: 'Tailscale on this Mac' });
const publishCard = () =>
  screen.getByRole('region', { name: 'Tell your phones where this Mac is' });
const phonesCard = () => screen.getByRole('region', { name: 'Phones' });
const buttonsIn = (card: HTMLElement) =>
  within(card)
    .queryAllByRole('button')
    .map((b) => b.textContent);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('card 1: Tailscale on this Mac', () => {
  const STATES: {
    state: TailscaleState;
    tailscale: ViewPatch['tailscale'];
    lead: string;
    hint?: string;
    buttons: string[];
  }[] = [
    {
      state: 'not-installed',
      tailscale: noAddress('not-installed', false),
      lead: "Tailscale isn't installed. It lets your phone reach this Mac from any network, encrypted.",
      hint: 'Install it on this Mac and on your phone, and sign in to both with the same account. Google works.',
      buttons: ['Check again'],
    },
    {
      state: 'not-running',
      tailscale: noAddress('not-running'),
      lead: 'Tailscale is installed but not running.',
      buttons: ['Open Tailscale', 'Check again'],
    },
    {
      state: 'signed-out',
      tailscale: noAddress('signed-out'),
      lead: 'Tailscale is installed but signed out.',
      hint: 'Sign in from its menu bar icon, with the same account as your phone.',
      buttons: ['Open Tailscale', 'Check again'],
    },
    {
      state: 'stopped',
      tailscale: noAddress('stopped'),
      lead: 'Tailscale is switched off.',
      hint: 'Turn it on from its menu bar icon.',
      buttons: ['Open Tailscale', 'Check again'],
    },
    {
      state: 'connected',
      tailscale: { state: 'connected', address: ADDRESS },
      lead: `Connected · ${ADDRESS}`,
      hint: `Phones reach this Mac at http://${ADDRESS}:${PORT} through Tailscale.`,
      buttons: ['Check again'],
    },
  ];

  it.each(STATES)(
    'shows each Tailscale state with its exact text and buttons ($state)',
    async ({ tailscale, lead, hint, buttons }) => {
      read(view({ tailscale }));
      show();
      await screen.findByText(lead);
      const card = tailscaleCard();
      expect(within(card).getByText(lead)).toBeInTheDocument();
      if (hint) expect(within(card).getByText(hint)).toBeInTheDocument();
      // One lead, at most one hint: nothing else (no "Signed in as", no stray state) is said.
      expect(card.querySelectorAll('p')).toHaveLength(hint ? 2 : 1);
      expect(buttonsIn(card)).toEqual(buttons);
    },
  );

  it('offers Get Tailscale, not Open Tailscale, when Tailscale is not installed', async () => {
    read(view({ tailscale: noAddress('not-installed', false) }));
    show();
    await screen.findByRole('link', { name: 'Get Tailscale' });
    expect(within(tailscaleCard()).queryByRole('button', { name: 'Open Tailscale' })).toBeNull();
  });

  it('Get Tailscale links to https://tailscale.com/download in a new tab', async () => {
    read(view({ tailscale: noAddress('not-installed', false) }));
    show();
    const link = await screen.findByRole('link', { name: 'Get Tailscale' });
    expect(link).toHaveAttribute('href', 'https://tailscale.com/download');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    // Only the one link, and only in that state.
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it.each(['not-running', 'signed-out', 'stopped'] as const)(
    'leaves out Open Tailscale when the Mac cannot open the app (%s)',
    async (state) => {
      read(view({ tailscale: noAddress(state, false) }));
      show();
      await screen.findByRole('button', { name: 'Check again' });
      expect(buttonsIn(tailscaleCard())).toEqual(['Check again']);
    },
  );

  it('shows "Signed in as" only for a connected Mac that reports an account', async () => {
    read(view({ tailscale: { account: 'kason@example.com' } }));
    show();
    expect(await screen.findByText('Signed in as kason@example.com')).toBeInTheDocument();
  });

  it('shows no account line outside the connected state, whatever the Mac reports', async () => {
    read(view({ tailscale: { ...noAddress('stopped'), account: 'kason@example.com' } }));
    show();
    await screen.findByText('Tailscale is switched off.');
    expect(screen.queryByText(/Signed in as/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/kason@example.com/);
  });

  it('never shows an account the Mac did not report', async () => {
    read(view({ tailscale: { account: null } }));
    show();
    await screen.findByText(`Connected · ${ADDRESS}`);
    expect(screen.queryByText(/Signed in as/)).toBeNull();
  });

  it('shows plain "Connected" with no address and no reach hint when Tailscale reports none', async () => {
    read(
      view({
        tailscale: { state: 'connected', address: null, account: 'kason@example.com' },
        publish: { state: 'no-tailscale', tailnet: null, at: null },
        phones: [phone({ hasTailnet: false })],
      }),
    );
    show();
    await screen.findByText('Connected');
    expect(screen.queryByText(/Phones reach this Mac at/)).toBeNull();
    expect(screen.queryByText(/Connected ·/)).toBeNull();
    // No "null", "undefined" or half-built address anywhere on the page.
    expect(document.body.textContent).not.toMatch(/null|undefined|http:\/\/|:3334/);
  });

  it.each(STATES)('never renders null or undefined text ($state)', async ({ tailscale, lead }) => {
    read(view({ tailscale, publish: { state: 'pending', tailnet: null, at: null } }));
    show();
    await screen.findByText(lead);
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });

  it('Check again calls refreshRemoteAccess and shows the new state', async () => {
    read(view({ tailscale: noAddress('stopped') }));
    const refresh = vi
      .spyOn(cloudApi, 'refreshRemoteAccess')
      .mockResolvedValue(view({ tailscale: { state: 'connected', address: ADDRESS } }));
    show();
    await screen.findByText('Tailscale is switched off.');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText('Tailscale is switched off.')).toBeNull();
    expect(buttonsIn(tailscaleCard())).toEqual(['Check again']);
  });

  it('Check again is busy, keeps its focus and sends one request however often it is pressed', async () => {
    read(view({ tailscale: noAddress('stopped') }));
    let finish!: (v: RemoteAccessView) => void;
    const refresh = vi
      .spyOn(cloudApi, 'refreshRemoteAccess')
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    show();
    await screen.findByText('Tailscale is switched off.');
    const button = screen.getByRole('button', { name: 'Check again' });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    // Busy, not disabled: a disabled button drops the focus the keyboard user is on.
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    expect(within(tailscaleCard()).getByText('Checking…')).toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => finish(view()));
    expect(await screen.findByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).not.toHaveAttribute('aria-busy');
    // The Open Tailscale button left the row; Check again is the same button and keeps the focus.
    expect(screen.getByRole('button', { name: 'Check again' })).toBe(button);
    expect(button).toHaveFocus();
  });

  it('keeps what it showed and says so when Check again fails, and its Retry looks again', async () => {
    read(view({ tailscale: noAddress('stopped') }));
    const refresh = vi
      .spyOn(cloudApi, 'refreshRemoteAccess')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(view());
    show();
    await screen.findByText('Tailscale is switched off.');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    const note = await screen.findByText("Couldn't refresh. Showing the last results.");
    expect(note.closest('[role="alert"]')).not.toBeNull();
    expect(screen.getByText('Tailscale is switched off.')).toBeInTheDocument();
    // Plain words only: nothing a schema or the network said reaches the page.
    expect(document.body.textContent).not.toMatch(/boom/);

    // The note's Retry is a fresh Check again; its success clears the note.
    fireEvent.click(
      within(note.closest('[role="alert"]') as HTMLElement).getByRole('button', { name: 'Retry' }),
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't refresh. Showing the last results.")).toBeNull();
  });

  it('Open Tailscale asks the server to open the app', async () => {
    read(view({ tailscale: noAddress('stopped') }));
    const open = vi.spyOn(cloudApi, 'openTailscale').mockResolvedValue(undefined);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
    expect(open).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Open Tailscale is busy, keeps its focus and sends one request however often it is pressed', async () => {
    read(view({ tailscale: noAddress('stopped') }));
    let finish!: () => void;
    const open = vi
      .spyOn(cloudApi, 'openTailscale')
      .mockImplementation(
        () => new Promise<undefined>((resolve) => (finish = () => resolve(undefined))),
      );
    show();
    const button = await screen.findByRole('button', { name: 'Open Tailscale' });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeEnabled();
    expect(button).toHaveFocus();
    await act(async () => finish());
    expect(button).not.toHaveAttribute('aria-busy');
    // Free again once the app has opened.
    fireEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'a failed launch',
      new CloudApiError('open_failed', "Couldn't open the Tailscale app."),
      "Couldn't open the Tailscale app.",
    ],
    [
      'an error the server did not word for this page',
      new CloudApiError('cloud_error', 'Cloud action failed.'),
      "Couldn't open the Tailscale app.",
    ],
    [
      'a refused write',
      new CloudApiError('forbidden', 'Same-origin request required'),
      "Couldn't open the Tailscale app.",
    ],
    ['a dropped connection', new TypeError('Failed to fetch'), "Couldn't open the Tailscale app."],
  ])('says it could not open the app after %s, in plain words', async (_what, error, words) => {
    read(view({ tailscale: noAddress('stopped') }));
    vi.spyOn(cloudApi, 'openTailscale').mockRejectedValue(error);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(words);
    expect(document.body.textContent).not.toMatch(
      /Same-origin|Cloud action failed|Failed to fetch/,
    );
  });

  it("says why Open Tailscale failed, in the server's own words, and clears it on the next try", async () => {
    read(view({ tailscale: noAddress('stopped') }));
    const open = vi
      .spyOn(cloudApi, 'openTailscale')
      .mockRejectedValueOnce(new CloudApiError('unsupported', 'Open Tailscale from your menu bar.'))
      .mockResolvedValueOnce(undefined);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Open Tailscale from your menu bar.');
    expect(within(tailscaleCard()).getByRole('alert')).toBe(alert);
    fireEvent.click(screen.getByRole('button', { name: 'Open Tailscale' }));
    await act(async () => {});
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('an Open Tailscale failure', () => {
    // It belongs to the Tailscale state it was met in. Once a read or Check again moves the card
    // to another state it is old news, and the Open button it was about may be gone.
    const REFUSED = new CloudApiError('unsupported', 'Open Tailscale from your menu bar.');
    const REFUSED_TEXT = 'Open Tailscale from your menu bar.';
    const stopped = () => view({ tailscale: noAddress('stopped') });

    it.each([
      ['connected', () => view(), `Connected · ${ADDRESS}`],
      [
        'not-installed',
        () => view({ tailscale: noAddress('not-installed', false) }),
        "Tailscale isn't installed. It lets your phone reach this Mac from any network, encrypted.",
      ],
      [
        'signed-out',
        () => view({ tailscale: noAddress('signed-out') }),
        'Tailscale is installed but signed out.',
      ],
    ])(
      'goes when Check again moves the card to %s, and does not come back with the old state',
      async (_state, next, lead) => {
        read(stopped());
        vi.spyOn(cloudApi, 'openTailscale').mockRejectedValue(REFUSED);
        const refresh = vi.spyOn(cloudApi, 'refreshRemoteAccess').mockResolvedValueOnce(next());
        show();
        fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
        expect(await screen.findByRole('alert')).toHaveTextContent(REFUSED_TEXT);

        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByText(lead)).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(document.body.textContent).not.toContain(REFUSED_TEXT);

        // Back where it was: nobody pressed Open since, so the old failure is not brought back.
        refresh.mockResolvedValueOnce(stopped());
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        expect(await screen.findByText('Tailscale is switched off.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open Tailscale' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
      },
    );

    it('goes when a poll finds another state (tailscaled started from a terminal), and stays while the state is the same', async () => {
      vi.useFakeTimers();
      const reading = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValue(stopped());
      vi.spyOn(cloudApi, 'openTailscale').mockRejectedValue(REFUSED);
      show();
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Open Tailscale' }));
      await act(async () => {});
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED_TEXT);

      // A poll that finds nothing new leaves it standing: it is still the last word on the subject.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
      });
      expect(reading).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED_TEXT);

      // Tailscale comes up some other way: the next poll finds it connected, and the failure goes.
      reading.mockResolvedValue(view());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
      });
      expect(screen.getByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();

      // Switched off again later: still no failure nobody asked about.
      reading.mockResolvedValue(stopped());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
      });
      expect(screen.getByText('Tailscale is switched off.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('stands while Check again finds the same state', async () => {
      read(stopped());
      vi.spyOn(cloudApi, 'openTailscale').mockRejectedValue(REFUSED);
      const refresh = vi.spyOn(cloudApi, 'refreshRemoteAccess').mockResolvedValue(stopped());
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
      await screen.findByRole('alert');
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await act(async () => {});
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('alert')).toHaveTextContent(REFUSED_TEXT);
    });

    it('goes when the Open button is taken away, even if the state is the same', async () => {
      read(stopped());
      vi.spyOn(cloudApi, 'openTailscale').mockRejectedValue(REFUSED);
      const refresh = vi
        .spyOn(cloudApi, 'refreshRemoteAccess')
        .mockResolvedValueOnce(view({ tailscale: noAddress('stopped', false) }));
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
      await screen.findByRole('alert');

      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await act(async () => {});
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Tailscale is switched off.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open Tailscale' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();

      // The button is back (the Mac can open the app again): the old failure stays gone.
      refresh.mockResolvedValueOnce(stopped());
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await act(async () => {});
      expect(screen.getByRole('button', { name: 'Open Tailscale' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('is never shown when it arrives after the card has moved on', async () => {
      read(stopped());
      let fail!: (error: Error) => void;
      vi.spyOn(cloudApi, 'openTailscale').mockImplementation(
        () => new Promise<undefined>((_resolve, reject) => (fail = reject)),
      );
      const refresh = vi.spyOn(cloudApi, 'refreshRemoteAccess').mockResolvedValueOnce(view());
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Open Tailscale' }));
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();

      // The app launch gives up only now, for a card that is no longer asking.
      await act(async () => fail(REFUSED));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(document.body.textContent).not.toContain(REFUSED_TEXT);

      // And it does not turn up when the card goes back to the state it was met in.
      refresh.mockResolvedValueOnce(stopped());
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Tailscale is switched off.')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });
});

describe('card 2: Tell your phones where this Mac is', () => {
  const SHARING = `Sharing ${ADDRESS}:${PORT} with your phones…`;
  const SHARED = `Shared ${ADDRESS}:${PORT} with your phones through AASC Cloud · 14:05`;
  const PUBLISHED_HINT =
    "Only the Tailscale address and port. A phone opens it only after this Mac proves it holds that phone's key.";
  const CASES: {
    state: RemoteAccessView['publish']['state'];
    text: string;
    hint?: string;
    button?: string;
  }[] = [
    {
      state: 'no-cloud',
      text: "This Mac isn't connected to AASC Cloud. Phones still learn the Tailscale address the next time they connect.",
      button: 'Open Connection',
    },
    { state: 'not-needed', text: 'No phone uses this Mac yet. Pair a phone first.' },
    { state: 'no-tailscale', text: 'Waiting for Tailscale on this Mac.' },
    { state: 'pending', text: SHARING },
    { state: 'published', text: SHARED, hint: PUBLISHED_HINT },
    {
      state: 'forbidden',
      text: "This Mac's cloud link can't share addresses. Make a new pairing code with mac-paths:publish on the backend, then connect again in Connection.",
    },
    {
      state: 'unsupported',
      text: "Your AASC Cloud backend doesn't offer this yet. Update it, then press Check again.",
    },
    { state: 'failed', text: "Couldn't reach AASC Cloud. Trying again every minute." },
  ];

  it.each(CASES)(
    'shows each sharing state with its exact text and button ($state)',
    async ({ state, text, hint, button }) => {
      read(view({ publish: { state } }));
      show();
      await screen.findByText(text);
      const card = publishCard();
      expect(within(card).getByText(text)).toBeInTheDocument();
      if (hint) expect(within(card).getByText(hint)).toBeInTheDocument();
      else expect(card.querySelectorAll('p')).toHaveLength(1);
      expect(buttonsIn(card)).toEqual(button ? [button] : []);
    },
  );

  it('hides card 2 when publishing is unavailable and shows Open Connection when the Mac has no cloud', async () => {
    const reading = read(view({ publish: { state: 'unavailable', tailnet: null, at: null } }));
    const { onConnection, unmount } = show();
    await screen.findByText(`Connected · ${ADDRESS}`);
    expect(screen.queryByText('Tell your phones where this Mac is')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Tell your phones where this Mac is' })).toBeNull();
    unmount();

    reading.mockResolvedValue(view({ publish: { state: 'no-cloud', tailnet: null, at: null } }));
    const second = show({ onConnection });
    fireEvent.click(await screen.findByRole('button', { name: 'Open Connection' }));
    expect(onConnection).toHaveBeenCalledTimes(1);
    second.unmount();
  });

  it('shows the time as the local 24-hour HH:MM, zero padded', async () => {
    const reading = read(view({ publish: { at: at(9, 7) } }));
    const first = show();
    expect(
      await screen.findByText(
        `Shared ${ADDRESS}:${PORT} with your phones through AASC Cloud · 09:07`,
      ),
    ).toBeInTheDocument();
    first.unmount();
    reading.mockResolvedValue(view({ publish: { at: at(0, 5) } }));
    const second = show();
    expect(
      await screen.findByText(
        `Shared ${ADDRESS}:${PORT} with your phones through AASC Cloud · 00:05`,
      ),
    ).toBeInTheDocument();
    second.unmount();
    reading.mockResolvedValue(view({ publish: { at: at(23, 59) } }));
    show();
    expect(
      await screen.findByText(
        `Shared ${ADDRESS}:${PORT} with your phones through AASC Cloud · 23:59`,
      ),
    ).toBeInTheDocument();
  });

  it('names the address the Mac is sharing, not the one it holds now', async () => {
    read(
      view({
        tailscale: { address: '100.64.0.9' },
        publish: { state: 'published', tailnet: '100.101.102.103', port: 3399 },
      }),
    );
    show();
    expect(
      await screen.findByText(
        'Shared 100.101.102.103:3399 with your phones through AASC Cloud · 14:05',
      ),
    ).toBeInTheDocument();
  });

  it('says what it is sharing before the first check has named it', async () => {
    read(view({ publish: { state: 'pending', tailnet: null, at: null } }));
    show();
    expect(await screen.findByText(SHARING)).toBeInTheDocument();
  });

  it('leaves a missing address or time out of the sentence instead of printing null', async () => {
    const reading = read(
      view({
        tailscale: { state: 'connected', address: null },
        publish: { state: 'pending', tailnet: null, at: null },
      }),
    );
    const first = show();
    expect(
      await screen.findByText('Sharing your Tailscale address with your phones…'),
    ).toBeInTheDocument();
    first.unmount();
    reading.mockResolvedValue(view({ publish: { state: 'published', at: null } }));
    show();
    expect(
      await screen.findByText(`Shared ${ADDRESS}:${PORT} with your phones through AASC Cloud`),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/null|undefined/);
  });
});

describe('card 3: Phones', () => {
  it('says so when no phone is paired', async () => {
    read(view({ phones: [] }));
    show();
    expect(await screen.findByText('No paired phones')).toBeInTheDocument();
    expect(within(phonesCard()).queryByRole('list')).toBeNull();
  });

  it('lists phones with what each knows and how it last connected', async () => {
    const warnings = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    read(
      view({
        phones: [
          phone(),
          phone({
            id: 'phone-2',
            label: 'Pixel',
            platform: 'android',
            hasTailnet: false,
            tailnetSentAt: null,
            lastPath: 'lan',
            lastPathAt: at(9, 7),
          }),
          phone({
            id: 'phone-3',
            label: 'Spare phone',
            hasTailnet: false,
            tailnetSentAt: null,
            lastPath: null,
            lastPathAt: null,
          }),
        ],
      }),
    );
    show();
    await screen.findByText("Kason's iPhone");
    const rows = within(phonesCard()).getAllByRole('listitem');
    expect(rows).toHaveLength(3);

    expect(within(rows[0]!).getByText("Kason's iPhone")).toBeInTheDocument();
    expect(within(rows[0]!).getByText('iOS')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Knows the Tailscale address')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Last connected over Tailscale · 14:05')).toBeInTheDocument();

    expect(within(rows[1]!).getByText('Pixel')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Android')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Learns it at its next connection')).toBeInTheDocument();
    expect(
      within(rows[1]!).getByText('Last connected over the home network · 09:07'),
    ).toBeInTheDocument();

    expect(within(rows[2]!).getByText('Spare phone')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Learns it at its next connection')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Not since AASC started')).toBeInTheDocument();
    // Each phone is its own row (React would warn about a repeated key).
    expect(warnings).not.toHaveBeenCalled();
  });

  it('shows a dash for what a phone knows while the Mac has no Tailscale address', async () => {
    read(
      view({
        tailscale: noAddress('stopped'),
        publish: { state: 'no-tailscale', tailnet: null, at: null },
        phones: [
          phone({ hasTailnet: false, tailnetSentAt: null, lastPath: 'lan', lastPathAt: at(8, 30) }),
        ],
      }),
    );
    show();
    await screen.findByText("Kason's iPhone");
    const row = within(phonesCard()).getByRole('listitem');
    expect(within(row).getByText('—')).toBeInTheDocument();
    expect(within(row).queryByText(/Knows the Tailscale address|Learns it/)).toBeNull();
    expect(
      within(row).getByText('Last connected over the home network · 08:30'),
    ).toBeInTheDocument();
  });

  it('says a phone nobody has approved yet is waiting, not that it will learn the address', async () => {
    read(
      view({
        phones: [
          phone({
            id: 'phone-4',
            label: 'New iPhone',
            status: 'pending',
            hasTailnet: false,
            tailnetSentAt: null,
            lastPath: null,
            lastPathAt: null,
          }),
          phone({ id: 'phone-5', label: 'Paired iPhone', status: 'active', hasTailnet: false }),
        ],
      }),
    );
    show();
    await screen.findByText('New iPhone');
    const [pending, active] = within(phonesCard()).getAllByRole('listitem');
    expect(within(pending!).getByText('Waiting for approval on this Mac')).toBeInTheDocument();
    expect(
      within(pending!).queryByText(/Learns it|Knows the Tailscale address|Last connected|Not since/),
    ).toBeNull();
    // A phone that is approved can ask for the address, and still reads as before.
    expect(within(active!).getByText('Learns it at its next connection')).toBeInTheDocument();
    expect(within(active!).queryByText('Waiting for approval on this Mac')).toBeNull();
  });

  it('a phone waiting for approval reads the same whether or not the Mac has an address', async () => {
    read(
      view({
        tailscale: noAddress('stopped'),
        publish: { state: 'no-tailscale', tailnet: null, at: null },
        phones: [phone({ status: 'pending', hasTailnet: false, lastPath: null, lastPathAt: null })],
      }),
    );
    show();
    await screen.findByText("Kason's iPhone");
    const row = within(phonesCard()).getByRole('listitem');
    expect(within(row).getByText('Waiting for approval on this Mac')).toBeInTheDocument();
    expect(within(row).queryByText('—')).toBeNull();
  });

  it('drops the time from a last connection that has none', async () => {
    read(view({ phones: [phone({ lastPath: 'tailnet', lastPathAt: null })] }));
    show();
    expect(await screen.findByText('Last connected over Tailscale')).toBeInTheDocument();
  });
});

describe('reading the view', () => {
  it('shows that it is looking before the first answer, then the cards', async () => {
    let finish!: (v: RemoteAccessView) => void;
    vi.spyOn(cloudApi, 'remoteAccess').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    show();
    expect(screen.getByText('Checking Tailscale…')).toBeInTheDocument();
    expect(screen.queryByRole('region')).toBeNull();
    await act(async () => finish(view()));
    expect(screen.queryByText('Checking Tailscale…')).toBeNull();
    expect(tailscaleCard()).toBeInTheDocument();
  });

  it('says it could not read the page, offers a retry (a fresh Check again), and recovers', async () => {
    vi.spyOn(cloudApi, 'remoteAccess').mockRejectedValueOnce(new Error('zod says no'));
    const refresh = vi
      .spyOn(cloudApi, 'refreshRemoteAccess')
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(view());
    show();
    const title = await screen.findByText("Couldn't read Remote access.");
    expect(title.closest('[role="alert"]')).not.toBeNull();
    // Plain words only: nothing a schema or the network said reaches the page.
    expect(document.body.textContent).not.toMatch(/zod says no/);
    expect(screen.queryByRole('region')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(screen.getByText("Couldn't read Remote access.")).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/still down/);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText("Couldn't read Remote access.")).toBeNull();
  });

  it('keeps the cards on screen when a later poll fails, and clears the note when one succeeds', async () => {
    vi.useFakeTimers();
    const reading = vi.spyOn(cloudApi, 'remoteAccess').mockResolvedValueOnce(view());
    show();
    await act(async () => {});
    expect(screen.getByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();

    reading.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });
    expect(screen.getByText("Couldn't refresh. Showing the last results.")).toBeInTheDocument();
    expect(screen.getByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();

    reading.mockResolvedValueOnce(view());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });
    expect(screen.queryByText("Couldn't refresh. Showing the last results.")).toBeNull();
  });
});

describe('polling', () => {
  it('polls every 15 s only while visible', async () => {
    vi.useFakeTimers();
    expect(REMOTE_ACCESS_POLL_MS).toBe(15_000);
    const reading = read(view());
    const { setVisible } = show();
    await act(async () => {});
    expect(reading).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS - 1);
    });
    expect(reading).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reading).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });
    expect(reading).toHaveBeenCalledTimes(3);

    // Another tab is in front: the view stays mounted but asks for nothing.
    setVisible(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 4);
    });
    expect(reading).toHaveBeenCalledTimes(3);

    // Back in front: it reads at once, then on the clock again.
    setVisible(true);
    await act(async () => {});
    expect(reading).toHaveBeenCalledTimes(4);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });
    expect(reading).toHaveBeenCalledTimes(5);
  });

  it('asks for nothing while it has never been visible', async () => {
    vi.useFakeTimers();
    const reading = read(view());
    const { setVisible } = show({ visible: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS * 3);
    });
    expect(reading).not.toHaveBeenCalled();
    setVisible(true);
    await act(async () => {});
    expect(reading).toHaveBeenCalledTimes(1);
  });

  it('aborts the request in flight when it is hidden and when it unmounts', async () => {
    const signals: AbortSignal[] = [];
    vi.spyOn(cloudApi, 'remoteAccess').mockImplementation((signal) => {
      signals.push(signal!);
      return new Promise(() => {});
    });
    const { setVisible, unmount } = show();
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    setVisible(false);
    expect(signals[0]!.aborted).toBe(true);
    setVisible(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]!.aborted).toBe(false);
    unmount();
    expect(signals[1]!.aborted).toBe(true);
  });

  it('aborts a Check again that is still running when it unmounts', async () => {
    read(view());
    let signal: AbortSignal | undefined;
    vi.spyOn(cloudApi, 'refreshRemoteAccess').mockImplementation((s) => {
      signal = s;
      return new Promise(() => {});
    });
    const { unmount } = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('ignores an answer that arrives after it was hidden', async () => {
    let finish!: (v: RemoteAccessView) => void;
    vi.spyOn(cloudApi, 'remoteAccess').mockImplementation(
      (signal) =>
        new Promise((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const { setVisible } = show();
    setVisible(false);
    await act(async () => {});
    // The aborted read is not an error to report.
    expect(screen.queryByText("Couldn't read Remote access.")).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => finish(view()));
    expect(screen.queryByText(`Connected · ${ADDRESS}`)).toBeNull();
  });

  it('drops a read that still resolves after the page was hidden or unmounted', async () => {
    let finish!: (v: RemoteAccessView) => void;
    vi.spyOn(cloudApi, 'remoteAccess').mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const { setVisible, unmount } = show();
    setVisible(false);
    await act(async () => finish(view()));
    expect(screen.queryByText(`Connected · ${ADDRESS}`)).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    // And one that fails after it was hidden reports nothing either.
    let fail!: (e: Error) => void;
    vi.mocked(cloudApi.remoteAccess).mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject)),
    );
    setVisible(true);
    setVisible(false);
    await act(async () => fail(new Error('late')));
    expect(screen.queryByText("Couldn't read Remote access.")).toBeNull();
    unmount();
  });

  it('a poll that began before Check again cannot overwrite its fresher answer', async () => {
    vi.useFakeTimers();
    let finishPoll!: (v: RemoteAccessView) => void;
    vi.spyOn(cloudApi, 'remoteAccess')
      .mockResolvedValueOnce(view({ tailscale: noAddress('stopped') }))
      .mockImplementationOnce(() => new Promise((resolve) => (finishPoll = resolve)));
    vi.spyOn(cloudApi, 'refreshRemoteAccess').mockResolvedValue(view());
    show();
    await act(async () => {});
    expect(screen.getByText('Tailscale is switched off.')).toBeInTheDocument();

    // The poll goes out, and is slow...
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REMOTE_ACCESS_POLL_MS);
    });
    // ...the person presses Check again and gets the fresh answer...
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    });
    expect(screen.getByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    // ...then the old poll answers with what it saw before.
    await act(async () => finishPoll(view({ tailscale: noAddress('stopped') })));
    expect(screen.getByText(`Connected · ${ADDRESS}`)).toBeInTheDocument();
    expect(screen.queryByText('Tailscale is switched off.')).toBeNull();
  });
});
