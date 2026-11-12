/**
 * AccountEnrollToggle — "Let phones signed into my AASC Cloud account connect" (plan 17).
 *
 * On, a phone signed into this Mac's AASC Cloud account with Google connects from the app's Mac list with
 * no QR and no Allow click: the account vouches for the phone, and the Mac seals the phone's key to the
 * address the phone dialled. The account's email shows under the box. When a signed-in Mac can't let them in,
 * the box is disabled and says why: phone pairing is off, or no dashboard password is set.
 *
 * AASC Cloud sign-in is optional (AASC-64): a Mac that isn't signed in (`blocked: 'no-cloud'`) renders nothing
 * here at all, so its owner sees QR pairing exactly as before. The panel doesn't mount this then either.
 *
 * The saved choice lives in server-config.json (`phoneAccountEnroll`); the environment can pin it, in
 * which case the Mac's refusal is shown through the panel's error line.
 */
import { useId, useState } from 'react';
import { setAccountEnroll, type AccountEnrollBlock, type AccountEnrollState } from '@/lib/mobilePairingApi';
import styles from '@/styles/modules/PhonePairing.module.css';

const LABEL = 'Let phones signed into my AASC Cloud account connect';

/** What a signed-in owner must do before the switch can be used. */
const BLOCK_REASON: Record<Exclude<AccountEnrollBlock, 'no-cloud'>, string> = {
  'pairing-off': 'Phone pairing is off on this Mac',
  'no-password': 'Set a dashboard password first',
};

interface Props {
  state: AccountEnrollState;
  onChange: (next: AccountEnrollState) => void;
  onError: (message: string | null) => void;
}

export default function AccountEnrollToggle({ state, onChange, onError }: Props) {
  const [saving, setSaving] = useState(false);
  const detailId = useId();
  // Saving holds the box (aria-busy, clicks ignored) but keeps it focusable: disabling it would drop keyboard focus.
  const blocked: AccountEnrollBlock | null = state.blocked ?? (state.available ? null : 'no-cloud');
  const disabled = blocked !== null;
  /** Why it can't be used, or the account it lets in; nothing for an account with no email (joined with a code). */
  const detail = blocked && blocked !== 'no-cloud' ? BLOCK_REASON[blocked] : state.email;

  const toggle = async (enabled: boolean) => {
    if (disabled || saving) return;
    setSaving(true);
    onError(null);
    try {
      onChange(await setAccountEnroll(enabled));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (blocked === 'no-cloud') return null; // not signed into AASC Cloud: no account UI at all (AASC-64)

  return (
    <div className={styles.accountEnroll}>
      <label className={`${styles.accountEnrollRow} ${disabled ? styles.accountEnrollDisabled : ''}`}>
        <input
          type="checkbox"
          checked={state.enabled}
          disabled={disabled}
          aria-busy={saving}
          aria-describedby={detail ? detailId : undefined}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        <span>{LABEL}</span>
      </label>
      {detail && <span id={detailId} className={styles.accountEnrollDetail}>{detail}</span>}
    </div>
  );
}
