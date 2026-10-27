/**
 * CloudRemoteAccess — RESOURCES → Cloud → Remote access (AASC-60): how a phone away from home
 * reaches this Mac. Three cards, top to bottom:
 *
 *  1. Tailscale on this Mac — its state and the next step (install it, open it, sign in, turn it on);
 *  2. Tell your phones where this Mac is — whether the Mac has shared its Tailscale address and port
 *     through AASC Cloud (left out when nothing publishes at all);
 *  3. Phones — for each paired phone, whether it knows the address and how it last connected (one not
 *     yet approved says it is waiting).
 *
 * The page reads this Mac's own server (`/api/resources/cloud/remote-access`), which answers with
 * no cloud connection and no account binding, so it does not use `CloudContext`. CloudPanel keeps
 * it mounted once opened; `visible` says whether it is the view in front. Only then does it read:
 * at once, and again every REMOTE_ACCESS_POLL_MS. A read still running when it is hidden or
 * unmounted is aborted.
 *
 * Whatever a call or the schema says about a failure stays out of the page (the one exception is
 * the server's own two refusals to open the app, which it words for this page). The page says what
 * it could not do, in plain words, and keeps the last answer on screen. A field the Mac does not
 * know is left out of its sentence, never printed as "null".
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonClass';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import StaleNote from '@/components/ui/StaleNote';
import { CloudApiError, cloudApi } from '@/lib/cloudApi';
import type {
  PhoneReachView,
  PublishView,
  RemoteAccessView,
  TailscaleState,
} from '@/types/remoteAccess';
import styles from '@/styles/modules/CloudResources.module.css';

/** How often the page asks again while it is in front. (CloudPanel's own poll is private to it.) */
export const REMOTE_ACCESS_POLL_MS = 15_000;
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
/** The two refusals `open-tailscale` can send, each already worded for this page by the server. */
const OPEN_REFUSALS: ReadonlySet<string> = new Set(['unsupported', 'open_failed']);
const OPEN_FAILED = "Couldn't open the Tailscale app.";

interface Words {
  lead: string;
  hint?: string;
}
const TAILSCALE_WORDS: Record<Exclude<TailscaleState, 'connected'>, Words> = {
  'not-installed': {
    lead: "Tailscale isn't installed. It lets your phone reach this Mac from any network, encrypted.",
    hint: 'Install it on this Mac and on your phone, and sign in to both with the same account. Google works.',
  },
  'not-running': { lead: 'Tailscale is installed but not running.' },
  'signed-out': {
    lead: 'Tailscale is installed but signed out.',
    hint: 'Sign in from its menu bar icon, with the same account as your phone.',
  },
  stopped: {
    lead: 'Tailscale is switched off.',
    hint: 'Turn it on from its menu bar icon.',
  },
};
/** States where the next step is in the Tailscale app itself, so opening it helps. */
const OPENABLE: ReadonlySet<TailscaleState> = new Set(['not-running', 'signed-out', 'stopped']);

function tailscaleWords({ state, address }: RemoteAccessView['tailscale'], port: number): Words {
  if (state !== 'connected') return TAILSCALE_WORDS[state];
  // Connected with no usable address: say so, and promise phones nothing.
  if (address === null) return { lead: 'Connected' };
  return {
    lead: `Connected · ${address}`,
    hint: `Phones reach this Mac at http://${address}:${port} through Tailscale.`,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** The local 24-hour "HH:MM" of a time in ms since the epoch. */
function clock(ms: number): string {
  const date = new Date(ms);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
/** " · HH:MM", or nothing when there is no time to give. */
const atClock = (ms: number | null) => (ms === null ? '' : ` · ${clock(ms)}`);

/** What the page says about sharing the address; null for `unavailable`, where the card is left out. */
function publishWords(
  publish: PublishView,
  address: string | null,
): (Words & { openConnection?: true }) | null {
  // `pending` is about to share the address this Mac holds now; `published` names what it did share.
  const shown = publish.state === 'pending' ? (publish.tailnet ?? address) : publish.tailnet;
  const target = shown === null ? 'your Tailscale address' : `${shown}:${publish.port}`;
  switch (publish.state) {
    case 'unavailable':
      return null;
    case 'no-cloud':
      return {
        lead: "This Mac isn't connected to AASC Cloud. Phones still learn the Tailscale address the next time they connect.",
        openConnection: true,
      };
    case 'not-needed':
      return { lead: 'No phone uses this Mac yet. Pair a phone first.' };
    case 'no-tailscale':
      return { lead: 'Waiting for Tailscale on this Mac.' };
    case 'pending':
      return { lead: `Sharing ${target} with your phones…` };
    case 'published':
      return {
        lead: `Shared ${target} with your phones through AASC Cloud${atClock(publish.at)}`,
        hint: "Only the Tailscale address and port. A phone opens it only after this Mac proves it holds that phone's key.",
      };
    case 'forbidden':
      return {
        lead: "This Mac's cloud link can't share addresses. Make a new pairing code with mac-paths:publish on the backend, then connect again in Connection.",
      };
    case 'unsupported':
      return {
        lead: "Your AASC Cloud backend doesn't offer this yet. Update it, then press Check again.",
      };
    case 'failed':
      return { lead: "Couldn't reach AASC Cloud. Trying again every minute." };
  }
}

const PLATFORM_LABEL: Record<PhoneReachView['platform'], string> = {
  ios: 'iOS',
  android: 'Android',
  desktop: 'Computer',
};
/** What the phone knows of this Mac's Tailscale address: a dash while the Mac has none to know. */
function knowsWords(phone: PhoneReachView, macAddress: string | null): string {
  if (phone.hasTailnet) return 'Knows the Tailscale address';
  return macAddress === null ? '—' : 'Learns it at its next connection';
}
function lastConnectedWords(phone: PhoneReachView): string {
  if (phone.lastPath === null) return 'Not since AASC started';
  const over = phone.lastPath === 'tailnet' ? 'Tailscale' : 'the home network';
  return `Last connected over ${over}${atClock(phone.lastPathAt)}`;
}

function PhoneRow({ phone, macAddress }: { phone: PhoneReachView; macAddress: string | null }) {
  return (
    <li>
      <div className={styles.phoneName}>
        <span>{phone.label}</span>
        <Chip>{PLATFORM_LABEL[phone.platform]}</Chip>
      </div>
      {phone.status === 'pending' ? (
        // Only an approved phone can sign in or ask for the address, so there is nothing to learn or connect yet.
        <p className={styles.hint}>Waiting for approval on this Mac</p>
      ) : (
        <>
          <p className={styles.hint}>{knowsWords(phone, macAddress)}</p>
          <p className={styles.hint}>{lastConnectedWords(phone)}</p>
        </>
      )}
    </li>
  );
}

export default function CloudRemoteAccess({
  visible,
  onConnection,
}: {
  visible: boolean;
  onConnection: () => void;
}) {
  const baseId = useId();
  const [view, setView] = useState<RemoteAccessView | null>(null),
    [readFailed, setReadFailed] = useState(false),
    [checking, setChecking] = useState(false),
    [opening, setOpening] = useState(false),
    [openError, setOpenError] = useState<{ state: TailscaleState; message: string } | null>(null);
  // A Check again counts up here; a read that left before it has an older answer and is dropped.
  const generation = useRef(0);
  const checkRequest = useRef<AbortController | null>(null),
    openRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!visible) return;
    const request = new AbortController();
    const { signal } = request;
    const read = () => {
      const issued = generation.current;
      cloudApi.remoteAccess(signal).then(
        (next) => {
          if (signal.aborted || issued !== generation.current) return;
          setView(next);
          setReadFailed(false);
        },
        () => {
          if (!signal.aborted && issued === generation.current) setReadFailed(true);
        },
      );
    };
    read();
    const timer = setInterval(read, REMOTE_ACCESS_POLL_MS);
    return () => {
      clearInterval(timer);
      request.abort();
    };
  }, [visible]);
  useEffect(
    () => () => {
      checkRequest.current?.abort();
      openRequest.current?.abort();
    },
    [],
  );

  // "Check again": a fresh look at Tailscale and the publisher, one at a time.
  const check = useCallback(() => {
    if (checkRequest.current) return;
    const request = new AbortController();
    checkRequest.current = request;
    generation.current += 1;
    setChecking(true);
    cloudApi
      .refreshRemoteAccess(request.signal)
      .then(
        (next) => {
          if (request.signal.aborted) return;
          setView(next);
          setReadFailed(false);
        },
        () => {
          if (!request.signal.aborted) setReadFailed(true);
        },
      )
      .finally(() => {
        if (request.signal.aborted) return;
        checkRequest.current = null;
        setChecking(false);
      });
  }, []);

  // `from` is the Tailscale state the button was pressed in: a failure is about that state only.
  const openTailscale = useCallback((from: TailscaleState) => {
    if (openRequest.current) return;
    const request = new AbortController();
    openRequest.current = request;
    setOpening(true);
    setOpenError(null);
    cloudApi
      .openTailscale(request.signal)
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        setOpenError({
          state: from,
          message:
            error instanceof CloudApiError && OPEN_REFUSALS.has(error.code)
              ? error.message
              : OPEN_FAILED,
        });
      })
      .finally(() => {
        if (request.signal.aborted) return;
        openRequest.current = null;
        setOpening(false);
      });
  }, []);

  if (!view) {
    return readFailed ? (
      <EmptyState
        tone="error"
        title="Couldn't read Remote access."
        action={
          <Button onClick={check} aria-busy={checking || undefined}>
            Retry
          </Button>
        }
      />
    ) : (
      <EmptyState busy title="Checking Tailscale…" />
    );
  }

  const { tailscale, publish, phones } = view;
  const canOpen = tailscale.canOpenApp && OPENABLE.has(tailscale.state);
  // A failure to open the app is about the Open button in the state it was pressed in. When a read
  // or Check again moves the card to another state, or takes the button away, it is old news and
  // goes, for good: it must not come back if the card returns to that state, and a failure that
  // only arrives after the card has moved on is dropped the same way.
  if (openError && (openError.state !== tailscale.state || !canOpen)) setOpenError(null);
  const words = tailscaleWords(tailscale, view.port);
  const sharing = publishWords(publish, tailscale.address);
  const tailscaleTitle = `${baseId}-tailscale`,
    publishTitle = `${baseId}-publish`,
    phonesTitle = `${baseId}-phones`;
  return (
    <>
      {readFailed && <StaleNote onRetry={check} />}
      <div className={styles.grid}>
        <section className={styles.card} aria-labelledby={tailscaleTitle}>
          <h3 id={tailscaleTitle}>Tailscale on this Mac</h3>
          <div role="status">
            <p>{words.lead}</p>
            {words.hint && <p className={styles.hint}>{words.hint}</p>}
            {tailscale.state === 'connected' && tailscale.account !== null && (
              <p className={styles.hint}>{`Signed in as ${tailscale.account}`}</p>
            )}
          </div>
          <div className={styles.toolbar}>
            {tailscale.state === 'not-installed' && (
              <a
                className={buttonClass({ variant: 'primary' })}
                href={TAILSCALE_DOWNLOAD_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                Get Tailscale
              </a>
            )}
            {canOpen && (
              <Button
                variant="primary"
                onClick={() => openTailscale(tailscale.state)}
                aria-busy={opening || undefined}
              >
                Open Tailscale
              </Button>
            )}
            <Button onClick={check} aria-busy={checking || undefined}>
              Check again
            </Button>
            {checking && (
              <span className={styles.hint} role="status">
                Checking…
              </span>
            )}
          </div>
          {openError && (
            <div className={styles.error} role="alert">
              {openError.message}
            </div>
          )}
        </section>
        {sharing && (
          <section className={styles.card} aria-labelledby={publishTitle}>
            <h3 id={publishTitle}>Tell your phones where this Mac is</h3>
            <div role="status">
              <p>{sharing.lead}</p>
              {sharing.hint && <p className={styles.hint}>{sharing.hint}</p>}
            </div>
            {sharing.openConnection && (
              <div className={styles.toolbar}>
                <Button onClick={onConnection}>Open Connection</Button>
              </div>
            )}
          </section>
        )}
        <section className={styles.card} aria-labelledby={phonesTitle}>
          <h3 id={phonesTitle}>Phones</h3>
          {phones.length === 0 ? (
            <EmptyState compact title="No paired phones" />
          ) : (
            <ul className={styles.phoneList}>
              {phones.map((phone) => (
                <PhoneRow key={phone.id} phone={phone} macAddress={tailscale.address} />
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
