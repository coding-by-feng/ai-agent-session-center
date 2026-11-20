/**
 * MachineAccountSettings — the "Account" group in the devices panel's This computer part (plan 18 stage 2):
 * what this computer tells and allows its AASC Cloud account.
 *
 *   Account
 *   [x] Show this computer to my account
 *       [x] Home network   [x] Tailscale   [ ] Public IP, unencrypted
 *   [ ] Connect my account’s computers without asking
 *   Listed at 192.168.1.57 (home network) and 100.101.102.103 (Tailscale), port 3333.
 *
 * Not rendered at all on a computer that is not signed in to AASC Cloud (`publisher.state: 'no-cloud'`: sign-in is
 * optional, AASC-64) or whose server has no such route (404).
 *
 * The boxes are the panel's own checkbox idiom (AccountEnrollToggle, PairingAddressChoice). A tick shows at once
 * and is saved by `machineAccountStore`: one save at a time, each on top of what the one before it answered, and
 * a save that fails puts the boxes back and says why. The saves belong to the page, not to this group: a tick
 * still waiting when the group unmounts (the panel closes, the Switch tab is pressed) is saved all the same, and
 * a group mounted while saves are still out shows them and reads nothing itself. While saves are out the boxes
 * are `aria-busy`, not disabled, which would drop keyboard focus. A setting the environment decides is disabled
 * and says so.
 *
 * The status line is the publisher's last finding. A save waits for it for 3 s at most, so it can answer
 * `pending`: the group then reads again every 3 s until the publisher has an answer.
 */
import { useEffect, useId, useState } from 'react';
import {
  ACCOUNT_ADDRESS_KINDS, loadMachineSettings, publisherLine,
  type AccountAddressKind, type MachineAccountSettings as Settings,
} from '@/lib/machineAccountApi';
import { useMachineAccountStore, withWaiting, type AccountChange } from '@/stores/machineAccountStore';
import pairing from '@/styles/modules/PhonePairing.module.css';
import styles from '@/styles/modules/MachineAccountSettings.module.css';

const SHOW_LABEL = 'Show this computer to my account';
const AUTO_LABEL = 'Connect my account’s computers without asking';
const PINNED_NOTE = 'Set by this computer’s environment';
const ADDRESS_LABEL: Record<AccountAddressKind, string> = {
  lan: 'Home network',
  tailnet: 'Tailscale',
  public: 'Public IP, unencrypted',
};
/** How often the settings are read again while the publisher is still looking. */
const PENDING_POLL_MS = 3_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** This mount's own read: `out` until it answers, then `done`, or why it failed. */
type Read = 'out' | 'done' | { failed: string };

export default function MachineAccountSettings() {
  const saved = useMachineAccountStore((s) => s.saved);
  const waiting = useMachineAccountStore((s) => s.waiting);
  const saving = useMachineAccountStore((s) => s.saving);
  const error = useMachineAccountStore((s) => s.error);
  const adopt = useMachineAccountStore((s) => s.adopt);
  const change = useMachineAccountStore((s) => s.change);
  // Saves from before this mount are still going out: what they answer is newer than a read made now.
  const [read, setRead] = useState<Read>(() => (useMachineAccountStore.getState().saving ? 'done' : 'out'));

  useEffect(() => {
    if (useMachineAccountStore.getState().saving) return undefined;
    const controller = new AbortController();
    loadMachineSettings(controller.signal).then(
      (settings) => {
        if (controller.signal.aborted) return;
        adopt(settings, true);
        setRead('done');
      },
      (err: unknown) => { if (!controller.signal.aborted) setRead({ failed: errorText(err) }); },
    );
    return () => controller.abort();
  }, [adopt]);

  const pending = read === 'done' && saved?.publisher.state === 'pending';
  useEffect(() => {
    if (!pending) return undefined;
    const controller = new AbortController();
    let reading = false;
    const timer = setInterval(() => {
      if (reading || useMachineAccountStore.getState().saving) return;
      reading = true;
      loadMachineSettings(controller.signal).then(
        (settings) => { if (!controller.signal.aborted) adopt(settings); },
        // A background read: the line keeps saying "Checking…" and the next round asks again.
        () => {},
      ).finally(() => { reading = false; });
    }, PENDING_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [pending, adopt]);

  if (read === 'out') return null;
  const failed = typeof read === 'object' ? read.failed : null;
  if (failed === null && saved === null) return null;

  return (
    <section className={pairing.section} aria-label="Account">
      <span className={pairing.title}>Account</span>
      {failed !== null || saved === null
        ? <p className={styles.error} role="alert">{failed}</p>
        : <Controls settings={withWaiting(saved, waiting)} saving={saving} onChange={change} />}
      {failed === null && error && <p className={styles.error} role="alert">{error}</p>}
    </section>
  );
}

interface ControlsProps {
  settings: Settings;
  saving: boolean;
  onChange: (tick: AccountChange) => void;
}

function Controls({ settings, saving, onChange }: ControlsProps) {
  const showNoteId = useId();
  const enrollNoteId = useId();
  const { pinned, addresses } = settings;
  const line = publisherLine(settings.publisher);
  const addressesOff = !settings.showOnAccount;

  return (
    <>
      <div className={pairing.accountEnroll}>
        <label className={`${pairing.accountEnrollRow} ${pinned.showOnAccount ? pairing.accountEnrollDisabled : ''}`}>
          <input
            type="checkbox"
            checked={settings.showOnAccount}
            disabled={pinned.showOnAccount}
            aria-busy={saving}
            aria-describedby={pinned.showOnAccount ? showNoteId : undefined}
            onChange={(e) => onChange({ set: 'showOnAccount', to: e.currentTarget.checked })}
          />
          <span>{SHOW_LABEL}</span>
        </label>
        {pinned.showOnAccount && <span id={showNoteId} className={pairing.accountEnrollDetail}>{PINNED_NOTE}</span>}
        <div className={styles.addresses} role="group" aria-label="Addresses shown to my account">
          {ACCOUNT_ADDRESS_KINDS.map((kind) => (
            <label key={kind} className={addressesOff ? `${styles.address} ${styles.addressOff}` : styles.address}>
              <input
                type="checkbox"
                checked={addresses[kind]}
                disabled={addressesOff}
                aria-busy={saving}
                onChange={(e) => onChange({ set: 'address', kind, to: e.currentTarget.checked })}
              />
              <span>{ADDRESS_LABEL[kind]}</span>
            </label>
          ))}
        </div>
      </div>

      <div className={pairing.accountEnroll}>
        <label className={`${pairing.accountEnrollRow} ${pinned.computerEnroll ? pairing.accountEnrollDisabled : ''}`}>
          <input
            type="checkbox"
            checked={settings.computerEnroll === 'auto'}
            disabled={pinned.computerEnroll}
            aria-busy={saving}
            aria-describedby={pinned.computerEnroll ? enrollNoteId : undefined}
            onChange={(e) => onChange({ set: 'computerEnroll', to: e.currentTarget.checked ? 'auto' : 'ask' })}
          />
          <span>{AUTO_LABEL}</span>
        </label>
        {pinned.computerEnroll && <span id={enrollNoteId} className={pairing.accountEnrollDetail}>{PINNED_NOTE}</span>}
      </div>

      {line && <p className={styles.status} aria-live="polite" data-status-line="">{line}</p>}
    </>
  );
}
