/**
 * accountDevices — a device on the AASC Cloud account, in words (RESOURCES → Machines › Devices on your account).
 *
 * The account says what a device is in three short codes, any of which can be missing or one a later backend adds:
 * `kind`, `platform` (macos · windows · linux · ios · android) and `edition` (full · lite · server · client), plus
 * the app's version. A known code gets its plain word, an unknown one is shown as given, and a missing one is left
 * out, never printed as "null".
 *
 * `kind` is `phone` or `server` today, and `server` means any AASC host, a MacBook included (server/cloud/
 * devices.ts). So a host's word comes from what else it says: "Server" only for the headless edition, "Mac" on
 * macOS, "Computer" otherwise. `mac`, should a backend say it, reads the same way.
 */

/** The parts of a device this module puts into words. */
export interface DeviceParts {
  kind: string | null;
  platform: string | null;
  edition: string | null;
  appVersion: string | null;
}

const PLATFORM: Record<string, string> = { macos: 'macOS', windows: 'Windows', linux: 'Linux', ios: 'iOS', android: 'Android' };
const EDITION: Record<string, string> = { full: 'Full', lite: 'Lite', server: 'Server', client: 'Client' };
/** The kinds that name an AASC host. */
const HOST_KINDS: ReadonlySet<string> = new Set(['server', 'mac']);

function word(code: string | null, words: Record<string, string>): string | null {
  if (code === null || code === '') return null;
  return Object.hasOwn(words, code) ? words[code] : code;
}

function kindWord({ kind, platform, edition }: DeviceParts): string | null {
  if (kind === null || kind === '') return null;
  if (kind === 'phone') return 'Phone';
  if (!HOST_KINDS.has(kind)) return kind;
  if (edition === 'server') return 'Server';
  return platform === 'macos' ? 'Mac' : 'Computer';
}

/** "Mac · macOS · Full 2.10.80", "Phone · iOS · 1.1.0", "Server · Linux · 2.10.80"; '' when the account knows nothing of it. */
export function deviceWords(device: DeviceParts): string {
  const kind = kindWord(device);
  const edition = word(device.edition, EDITION);
  // "Server · Linux · Server 2.10.80" would say the kind twice.
  const app = [edition === kind ? null : edition, device.appVersion || null].filter(Boolean).join(' ');
  return [kind, word(device.platform, PLATFORM), app || null].filter(Boolean).join(' · ');
}
