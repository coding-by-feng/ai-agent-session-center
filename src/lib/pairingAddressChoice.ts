// pairingAddressChoice.ts — the remembered choice of addresses a new pairing link carries (Oct 28 2026).
// Home network and Tailscale by default; Public IP only when ticked (PairingAddressChoice).
import { PAIRING_ADDRESS_KINDS, type PairingAddressKind, type PairingAddresses } from '@/lib/mobilePairingApi';

const STORAGE_KEY = 'pairing-addresses';
const DEFAULT_CHOICE: readonly PairingAddressKind[] = ['lan', 'tailnet'];

/** The remembered choice, or home network and Tailscale. */
export function readPairingChoice(): PairingAddressKind[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (Array.isArray(saved)) return PAIRING_ADDRESS_KINDS.filter((k) => saved.includes(k));
  } catch { /* unreadable: the default */ }
  return [...DEFAULT_CHOICE];
}

export function savePairingChoice(choice: readonly PairingAddressKind[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(choice)); } catch { /* storage off: not remembered */ }
}

/** The ticked addresses this computer has, in link order: what POST /pairing is asked to include. */
export function chosenAddresses(choice: readonly PairingAddressKind[], addresses: PairingAddresses): PairingAddressKind[] {
  return PAIRING_ADDRESS_KINDS.filter((k) => choice.includes(k) && addresses[k] !== null);
}
