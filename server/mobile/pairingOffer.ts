// pairingOffer.ts — is "Pair a phone" offered on this Mac?
//
// On by default now that the AASC phone app ships. It was off until then
// (AASC-30), so a QR wouldn't send people to an app that didn't exist.
// Turning it off needs no code change:
//   server-config.json  "phonePairing": false
//   environment         AASC_PHONE_PAIRING=0 (or false); 1 / true turns it on
// The variable wins over the file. Phones paired before are never affected:
// listing, approving and revoking them don't depend on this. The QR still
// needs a dashboard password (POST /pairing refuses without one).

export interface PairingOfferConfig {
  phonePairing?: boolean;
}

export function isPhonePairingOffered(
  config: PairingOfferConfig,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  const raw = (env.AASC_PHONE_PAIRING ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return config.phonePairing !== false;
}
