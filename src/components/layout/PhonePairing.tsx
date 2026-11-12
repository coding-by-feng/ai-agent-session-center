/**
 * PhonePairing — "Pair a phone" inside the device panel (AASC-15).
 *
 * Shows a QR (the https://aasc.work/pair#… link; the codes ride in the
 * fragment, which no server ever receives), the code in text for typing, and a
 * countdown. A phone that redeems the code appears as PENDING with a 6-digit
 * confirmation code: approve only when the phone shows the same digits — that
 * is what stops a second phone that scanned the same QR.
 *
 * Desktop only: the routes answer the AASC page on this machine and nothing
 * else, so the section renders only when this device is local.
 *
 * Pairing is offered by default. With `phonePairing: false` (or
 * AASC_PHONE_PAIRING=0) there is no Pair button, and no section at all unless
 * phones were paired before, which still list here with Allow / Revoke.
 *
 * Each approved phone can be renamed in place (Enter saves, Esc cancels) and
 * signed out: its sessions and sockets end, its pairing stays, and the phone
 * signs in again from the app.
 *
 * The QR carries the Mac's code only: an approved phone gets its backend code
 * for notifications over its own session (AASC-52). Backend phone devices this
 * Mac made that no paired phone holds any more get one line and a "Remove them"
 * action. That check calls the cloud, so it runs when the panel opens and once
 * a minute, not on the 2-second refresh.
 *
 * Another computer's AASC pairs through the same link (Oct 28 2026): its owner
 * copies the link here (Copy link) and pastes it into that app's Remote
 * computers. It lists as a `desktop` device, allowed with the same code check,
 * and gets what a password sign-in gets: shared sessions.
 *
 * Before Pair, the owner picks which addresses the link carries (Oct 28 2026,
 * PairingAddressChoice). A code works once, so the card closes by itself when a
 * device that wasn't listed when it opened appears; its Allow prompt takes over.
 *
 * Plan 17: under the Pair button, "Let phones signed into my AASC Cloud account connect"
 * (AccountEnrollToggle). A phone that enrolled that way is active at once and reads "via account · <email>".
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from '@/components/ui/Button';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import { qrSvg } from '@/lib/qrSvg';
import {
  approvePhone, formatConfirmCode, formatPairingCode, loadCloudPhones, loadPairingAddresses, loadPhonePairing, removePhone,
  removeUnlinkedCloudPhones, renamePhone, signOutPhone, startPhonePairing, type PairedPhone, type PairingAddressKind,
  type PairingAddresses, type PhonePairing as Pairing, type AccountEnrollState,
} from '@/lib/mobilePairingApi';
import AccountEnrollToggle from './AccountEnrollToggle';
import { chosenAddresses, readPairingChoice } from '@/lib/pairingAddressChoice';
import PairingAddressChoice from './PairingAddressChoice';
import { pairedDeviceKind, pairedDeviceNoun } from '@/lib/deviceKind';
import { findReplaceCandidates, type ReplaceCandidate } from '@/lib/phoneReplaceCandidates';
import DeviceKindIcon from '@/components/layout/DeviceKindIcon';
import styles from '@/styles/modules/PhonePairing.module.css';

/** How often the list refreshes while the panel is open. */
const POLL_MS = 2000;
/** How often the cloud is asked about leftover phone devices (each check lists the account's devices). */
const CLOUD_POLL_MS = 60_000;

/** Every paired phone has the same, narrower set than a password sign-in (server/mobile/phoneProfile.ts). */
const ACCESS_LABEL = 'shared sessions only';
/** A paired computer signs in like a password sign-in, so it sees what one sees. */
const DESKTOP_ACCESS_LABEL = 'Shared sessions, like a password sign-in';
/** Said before Allow: a computer is a password sign-in, not a phone (the redeemer, not the owner, picks the platform). */
const DESKTOP_ALLOW_WARNING =
  'A computer can type into shared sessions’ terminals, like a password sign-in. Allow it only if you are pairing a computer.';
/** How long "Copied" shows on the Copy link button. */
const COPIED_MS = 2000;
const ACCESS_DETAIL =
  'Paired phones and tablets can watch and drive shared sessions, start Claude or Codex in a folder in your home folder, and read files '
  + 'in shared projects. They can’t run other commands, change files or change this Mac’s settings.';

const PLATFORM_NAME: Record<PairedPhone['platform'], string> = { ios: 'iPhone', android: 'Android', desktop: 'Computer' };
/** Words that already tell the platform when they appear in a phone's name (an iPad pairs as `ios` too). */
const PLATFORM_IN_NAME: Record<PairedPhone['platform'], RegExp> = {
  ios: /\bi(phone|pad)\b/i,
  android: /\bandroid\b/i,
  desktop: /\bcomputer\b/i,
};

/**
 * The platform word to show beside a phone's name, or null when the name
 * already says it: "iPhone 13" over "iPhone · shared sessions only" repeated
 * the word on every row. Exported for tests.
 */
function platformLabel(p: Pick<PairedPhone, 'label' | 'platform'>): string | null {
  if (PLATFORM_IN_NAME[p.platform].test(p.label)) return null;
  // An iOS tablet is an iPad, not an iPhone ("Kason’s tablet" · iPad).
  return p.platform === 'ios' && pairedDeviceKind(p) === 'tablet' ? 'iPad' : PLATFORM_NAME[p.platform];
}

/** The rename field's label, by what the device is: "iPad name", "Computer name". */
const NAME_FIELD_LABEL: Record<string, string> = {
  computer: 'Computer name', phone: 'Phone name', iPad: 'iPad name', tablet: 'Tablet name',
};

/** The platform word for an Allow prompt: a computer is always named as one, whatever its label says. */
function pendingPlatformLabel(p: Pick<PairedPhone, 'label' | 'platform'>): string | null {
  return p.platform === 'desktop' ? PLATFORM_NAME.desktop : platformLabel(p);
}

function accessLabel(p: Pick<PairedPhone, 'platform'>): string {
  return p.platform === 'desktop' ? DESKTOP_ACCESS_LABEL : ACCESS_LABEL;
}

function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function formatCountdown(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function relative(at: number | null): string {
  if (!at) return 'never';
  const mins = Math.round((Date.now() - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Oct", with the year when it isn't this one. */
function shortDate(at: number): string {
  const d = new Date(at);
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date().getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The server's cap (deviceAuth MAX_LABEL). */
const MAX_NAME = 80;

/** "via account · me@example.com" on a phone that enrolled through the AASC Cloud account (plan 17). */
/** Shown before revoking a phone that joined through the account (review H1): the Mac also signs it out of the cloud. */
const ACCOUNT_REVOKE_NOTE =
  'This also signs it out of AASC Cloud. Signing in with Google on that phone again lets it connect again unless you turn off account phones here.';

function accountTag(p: Pick<PairedPhone, 'origin' | 'accountEmail'>): string | null {
  if (p.origin !== 'account') return null;
  return p.accountEmail ? `via account · ${p.accountEmail}` : 'via account';
}

function cloudLine(n: number): string {
  return n === 1
    ? '1 cloud phone device isn’t linked to a paired phone.'
    : `${n} cloud phone devices aren’t linked to a paired phone.`;
}

function PairingQr({ link }: { link: string }) {
  const qr = useMemo(() => qrSvg(link), [link]);
  return (
    <svg
      className={styles.qr}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      role="img"
      aria-label="QR code to pair a phone"
      shapeRendering="crispEdges"
    >
      <rect width={qr.size} height={qr.size} className={styles.qrLight} />
      <path d={qr.path} className={styles.qrDark} />
    </svg>
  );
}

/** Copies the pairing link, for a computer to paste into its Remote computers. */
function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    setFailed(false);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setFailed(true);
    }
  };

  return (
    // .pairingText again: a third child of the wrapping .pairing row, so it drops under the QR at full width.
    <div className={styles.pairingText}>
      <Button size="sm" onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy link'}
      </Button>
      <span className={styles.hint}>For a computer: paste this link into its AASC → Remote computers.</span>
      {failed && (
        <span className={styles.error} role="alert">Couldn’t copy the link. Allow clipboard access and try again.</span>
      )}
    </div>
  );
}

export default function PhonePairing() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [phones, setPhones] = useState<PairedPhone[]>([]);
  /** Null until the Mac says; the Pair button shows only on a clear yes. */
  const [offered, setOffered] = useState<boolean | null>(null);
  /** The account switch (plan 17); null until the Mac says, and from a server without it. */
  const [accountEnroll, setAccountEnrollState] = useState<AccountEnrollState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  /** Replace boxes the user changed, keyed `<pending id> <old id>`; untouched ones follow their default. */
  const [replaceTicks, setReplaceTicks] = useState<Record<string, boolean>>({});
  /** The phone being renamed and the name typed so far; the 2-second refresh leaves it alone. */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  /** Backend phone devices no paired phone holds (AASC-52); 0 with no cloud or when the check fails. */
  const [cloudUnlinked, setCloudUnlinked] = useState(0);
  const [confirmCloud, setConfirmCloud] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  /** This computer's addresses for the link choices; null from an older server, which gets its usual link. */
  const [addresses, setAddresses] = useState<PairingAddresses | null>(null);
  const [choice, setChoice] = useState<PairingAddressKind[]>(readPairingChoice);
  /** The device ids listed when the open card was made: any other one means its code was used. */
  const openedWith = useRef<Set<string> | null>(null);

  const refreshCloud = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await loadCloudPhones(signal);
      setCloudUnlinked(state.cloud ? state.unlinked : 0);
    } catch {
      // A background check: an unreachable cloud just shows no line.
      if (!signal?.aborted) setCloudUnlinked(0);
    }
  }, []);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const state = await loadPhonePairing(signal);
      const known = openedWith.current;
      if (known && state.devices.some((d) => !known.has(d.id))) {
        openedWith.current = null;
        setPairing(null);
      }
      setPhones(state.devices);
      setOffered(state.pairingOffered);
      setAccountEnrollState(state.accountEnroll);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => {
      setNow(Date.now());
      void refresh(controller.signal);
    }, POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const controller = new AbortController();
    void loadPairingAddresses(controller.signal).then((found) => {
      if (!controller.signal.aborted) setAddresses(found);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshCloud(controller.signal);
    const timer = setInterval(() => void refreshCloud(controller.signal), CLOUD_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refreshCloud]);

  const remaining = pairing ? secondsLeft(pairing.expiresAt, now) : 0;
  const pairingLive = pairing !== null && remaining > 0;

  /** Choices only when the server named an address; otherwise it makes its usual link (and says why it can't). */
  const choosable = addresses !== null && Object.values(addresses).some((a) => a !== null) ? addresses : null;
  const include = choosable ? chosenAddresses(choice, choosable) : undefined;

  const closePairing = () => {
    openedWith.current = null;
    setPairing(null);
  };

  const handleStart = async () => {
    setBusy(true);
    setError(null);
    try {
      openedWith.current = new Set(phones.map((p) => p.id));
      const next = await startPhonePairing(include);
      setPairing(next);
      setNow(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn: () => Promise<void>, done: string | (() => string)) => {
    setError(null);
    try {
      await fn();
      showToast(typeof done === 'string' ? done : done(), 'info', 3000);
      setConfirmRevoke(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRemoveCloud = async () => {
    setCloudBusy(true);
    setError(null);
    try {
      const { removed, failed } = await removeUnlinkedCloudPhones();
      if (removed > 0) showToast(`Removed ${removed} cloud phone ${removed === 1 ? 'device' : 'devices'}`, 'info', 3000);
      if (failed > 0) setError(`${failed} couldn’t be removed. Try again later.`);
      setConfirmCloud(false);
      await refreshCloud();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCloudBusy(false);
    }
  };

  const saveRename = (p: PairedPhone) => {
    const name = editing?.draft.trim() ?? '';
    if (!name || name === p.label) return;
    void act(async () => {
      await renamePhone(p.id, name);
      setEditing(null);
    }, `Renamed to ${name}`);
  };

  const pending = phones.filter((p) => p.status === 'pending');
  const active = phones.filter((p) => p.status === 'active');

  const tickKey = (p: PairedPhone, c: ReplaceCandidate) => `${p.id} ${c.device.id}`;
  const isTicked = (p: PairedPhone, c: ReplaceCandidate) => replaceTicks[tickKey(p, c)] ?? c.preselected;

  /** Allow, revoking the ticked older pairings of the same phone once it is in (Nov 6 2026). */
  const allow = (p: PairedPhone, candidates: readonly ReplaceCandidate[]) => {
    const replaces = candidates.filter((c) => isTicked(p, c)).map((c) => c.device.id);
    let result = { replaced: [] as string[], skipped: [] as string[] };
    void act(async () => {
      result = await approvePhone(p.id, replaces);
    }, () => {
      const n = result.replaced.length;
      const kept = result.skipped.length ? ` · ${result.skipped.length} kept (no longer the same ${pairedDeviceNoun(p)})` : '';
      return `${p.label} can now connect${n ? ` · replaced ${n} older pairing${n === 1 ? '' : 's'}` : ''}${kept}`;
    });
  };

  /** Account phones may connect right now: the section stays, so its switch can turn that off. */
  const accountOpen = accountEnroll?.enabled === true && accountEnroll.available;
  /**
   * The account switch, only for a Mac signed into AASC Cloud: sign-in is optional (AASC-64), so a Mac that isn't
   * shows QR pairing exactly as before. Rows that joined through the account still show their tag.
   */
  const showAccountSwitch = accountEnroll !== null && accountEnroll.blocked !== 'no-cloud';
  // Not offered and nothing paired or left over: a release without the phone app shows nothing about phones.
  if (offered !== true && !accountOpen && phones.length === 0 && !pairingLive && !error && cloudUnlinked === 0) return null;

  return (
    <section className={styles.section} aria-label="Paired phones and computers">
      <div className={styles.head}>
        <span className={styles.title}>Phones &amp; computers</span>
        {offered === true && !pairingLive && (
          <Button size="sm" onClick={handleStart} disabled={busy || include?.length === 0}>
            {busy ? 'Starting…' : 'Pair a phone or computer'}
          </Button>
        )}
      </div>

      {offered === true && !pairingLive && choosable && (
        <PairingAddressChoice addresses={choosable} choice={choice} onChange={setChoice} />
      )}

      {accountEnroll && showAccountSwitch && !pairingLive && (
        <AccountEnrollToggle state={accountEnroll} onChange={setAccountEnrollState} onError={setError} />
      )}

      {pairingLive && pairing && (
        <div className={styles.pairing}>
          <PairingQr link={pairing.link} />
          <div className={styles.pairingText}>
            <span className={styles.hint}>Scan with the AASC app, or enter</span>
            <code className={styles.code}>{formatPairingCode(pairing.code)}</code>
            <span className={styles.countdown} aria-live="polite">
              Expires in {formatCountdown(remaining)}
            </span>
            <Button size="sm" variant="quiet" onClick={closePairing}>Cancel</Button>
          </div>
          <CopyLink link={pairing.link} />
        </div>
      )}

      {pending.map((p) => (
        <div key={p.id} className={styles.pending} role="alert">
          <span className={styles.pendingText}>
            Allow <strong>{p.label}</strong>{pendingPlatformLabel(p) ? ` (${pendingPlatformLabel(p)})` : ''}?
          </span>
          <span className={styles.confirm}>
            Code on the {pairedDeviceNoun(p)}: <code>{p.confirmCode ? formatConfirmCode(p.confirmCode) : '—'}</code>
          </span>
          <span className={styles.note}>
            Allow only if your {pairedDeviceNoun(p)} shows the same code.
          </span>
          {p.platform === 'desktop' && <span className={styles.note}>{DESKTOP_ALLOW_WARNING}</span>}
          {findReplaceCandidates(p, phones, now).map((c) => (
            <label key={c.device.id} className={styles.replaceRow}>
              <input
                type="checkbox"
                checked={isTicked(p, c)}
                onChange={(e) => {
                  const ticked = e.currentTarget.checked;
                  setReplaceTicks((t) => ({ ...t, [tickKey(p, c)]: ticked }));
                }}
              />
              <span>
                Replaces {c.device.label}
                {/* Each phrase keeps its words together (no-break spaces); only the " · " seams wrap. */}
                {[c.device.approvedAt ? `paired ${shortDate(c.device.approvedAt)}` : '', `last seen ${relative(c.device.lastSeenAt)}`]
                  .filter(Boolean).map((part) => ` · ${part.replace(/ /g, ' ')}`).join('')}
              </span>
            </label>
          ))}
          <span className={styles.actions}>
            <Button size="sm" variant="primary" onClick={() => allow(p, findReplaceCandidates(p, phones, now))}>
              Allow
            </Button>
            <Button size="sm" variant="danger" onClick={() => act(() => removePhone(p.id), `${p.label} was refused`)}>
              Deny
            </Button>
          </span>
        </div>
      ))}

      {active.length > 0 && (
        <ul className={styles.list}>
          {active.map((p) => (
            <li key={p.id} className={styles.phone}>
              <span className={styles.phoneIcon}><DeviceKindIcon kind={pairedDeviceKind(p)} /></span>
              <span className={styles.phoneMain}>
                {editing?.id === p.id ? (
                  <span className={styles.rename}>
                    <TextInput
                      className={styles.renameInput}
                      aria-label={NAME_FIELD_LABEL[pairedDeviceNoun(p)]}
                      value={editing.draft}
                      maxLength={MAX_NAME}
                      autoFocus
                      onChange={(e) => setEditing({ id: p.id, draft: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); saveRename(p); }
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                      }}
                    />
                    <span className={styles.renameButtons}>
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={!editing.draft.trim() || editing.draft.trim() === p.label}
                        onClick={() => saveRename(p)}
                      >
                        Save
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setEditing(null)}>Cancel</Button>
                    </span>
                  </span>
                ) : (
                  <span className={styles.phoneName} title={p.label}>{p.label}</span>
                )}
                <span className={styles.phoneMeta}>
                  {[platformLabel(p), accessLabel(p)].filter(Boolean).join(' · ')}
                </span>
                {accountTag(p) && <span className={styles.accountTag}>{accountTag(p)}</span>}
                <span className={styles.phoneMeta}>
                  {[p.approvedAt ? `paired ${shortDate(p.approvedAt)}` : null, `last seen ${relative(p.lastSeenAt)}`]
                    .filter(Boolean).join(' · ')}
                </span>
                {editing?.id !== p.id && (
                  <span className={`${styles.actions} ${styles.phoneActions}`}>
                    {confirmRevoke === p.id ? (
                      <>
                        {p.origin === 'account' && (
                          <span id={`revoke-note-${p.id}`} className={styles.revokeNote}>{ACCOUNT_REVOKE_NOTE}</span>
                        )}
                        <Button
                          size="sm"
                          variant="danger"
                          aria-describedby={p.origin === 'account' ? `revoke-note-${p.id}` : undefined}
                          onClick={() => act(() => removePhone(p.id), `${p.label} was revoked`)}
                        >
                          Revoke
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setConfirmRevoke(null)}>Keep</Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`Rename ${p.label}`}
                          onClick={() => { setConfirmRevoke(null); setEditing({ id: p.id, draft: p.label }); }}
                        >
                          Rename
                        </Button>
                        <Button
                          size="sm"
                          variant="quiet"
                          aria-label={`Sign out ${p.label}`}
                          title="End its sessions now. It stays paired and can sign in again from the app."
                          onClick={() => act(() => signOutPhone(p.id), `${p.label} was signed out`)}
                        >
                          Sign out
                        </Button>
                        <Button size="sm" variant="quiet" onClick={() => setConfirmRevoke(p.id)}>Revoke…</Button>
                      </>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {active.some((p) => p.platform !== 'desktop') && <p className={styles.note}>{ACCESS_DETAIL}</p>}

      {cloudUnlinked > 0 && (
        <div className={styles.cloudLeftover}>
          <span className={styles.cloudText}>{cloudLine(cloudUnlinked)}</span>
          {confirmCloud ? (
            <span className={styles.actions}>
              <Button size="sm" variant="danger" onClick={handleRemoveCloud} disabled={cloudBusy}>
                Remove {cloudUnlinked}
              </Button>
              <Button size="sm" variant="quiet" onClick={() => setConfirmCloud(false)} disabled={cloudBusy}>Keep</Button>
            </span>
          ) : (
            <Button size="sm" variant="quiet" onClick={() => setConfirmCloud(true)}>Remove them</Button>
          )}
        </div>
      )}

      {offered === true && active.length === 0 && pending.length === 0 && !pairingLive && (
        <p className={styles.empty}>No phones or computers paired.</p>
      )}

      {error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}
