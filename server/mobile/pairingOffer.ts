// pairingOffer.ts — is "Pair a phone" offered on this Mac? (AASC-30)
//
// Off until the AASC phone app can be installed and aasc.work/pair is live:
// before that, a QR would send people to an app that doesn't exist. Turning it
// on needs no code change:
//   server-config.json  "phonePairing": true
//   environment         AASC_PHONE_PAIRING=1 (or true); 0 / false turns it off
// The variable wins over the file. Phones paired before are never affected:
// listing, approving and revoking them don't depend on this.

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
  return config.phonePairing === true;
}
