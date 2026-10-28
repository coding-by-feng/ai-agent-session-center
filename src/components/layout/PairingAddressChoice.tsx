/**
 * PairingAddressChoice — which of this computer's addresses a new pairing link carries (Oct 28 2026).
 *
 * One checkbox per address the server names (GET /api/mobile/pairing/addresses), showing the address
 * itself so "Public IP" reads as 45.63.31.79 before it is handed out. Home network and Tailscale are
 * ticked by default; Public IP is not, since everything to it crosses the Internet unencrypted. The
 * choice is remembered on this computer. A link with neither home network nor Tailscale is one the
 * phone app refuses, so the panel says it is for computers only.
 */
import { PAIRING_ADDRESS_KINDS, type PairingAddressKind, type PairingAddresses } from '@/lib/mobilePairingApi';
import { chosenAddresses, savePairingChoice } from '@/lib/pairingAddressChoice';
import styles from '@/styles/modules/PhonePairing.module.css';

const LABEL: Record<PairingAddressKind, string> = { lan: 'Home network', tailnet: 'Tailscale', public: 'Public IP' };

interface Props {
  addresses: PairingAddresses;
  choice: readonly PairingAddressKind[];
  onChange: (next: PairingAddressKind[]) => void;
}

export default function PairingAddressChoice({ addresses, choice, onChange }: Props) {
  const available = PAIRING_ADDRESS_KINDS.filter((k) => addresses[k] !== null);
  if (available.length === 0) return null;
  const chosen = chosenAddresses(choice, addresses);
  const toggle = (kind: PairingAddressKind, on: boolean) => {
    const next = PAIRING_ADDRESS_KINDS.filter((k) => (k === kind ? on : choice.includes(k)));
    savePairingChoice(next);
    onChange(next);
  };

  return (
    <fieldset className={styles.addresses}>
      <legend className={styles.hint}>Link carries</legend>
      {available.map((kind) => (
        <label key={kind} className={styles.addressRow}>
          <input type="checkbox" checked={chosen.includes(kind)} onChange={(e) => toggle(kind, e.target.checked)} />
          <span className={styles.addressLabel}>{LABEL[kind]}</span>
          <code className={styles.addressValue}>{addresses[kind]}</code>
        </label>
      ))}
      {chosen.includes('public') && (
        <span className={styles.warning}>
          Unencrypted over the Internet: open the port only to the computer that pairs.
        </span>
      )}
      {chosen.length > 0 && !chosen.includes('lan') && !chosen.includes('tailnet') && (
        <span className={styles.note}>Phones can’t use this link: computers only.</span>
      )}
    </fieldset>
  );
}
