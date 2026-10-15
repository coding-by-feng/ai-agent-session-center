// secretPaths.ts — what a paired phone never reads (AASC-28): secrets folders and secret-looking
// files. One list for the project browser (phoneProfile.ts) and for what the chat and changes
// routes show a phone of a file the agent touched (phoneChatFilter.ts).

/**
 * Never read by a phone, wherever they sit. Compared lower-cased: on a
 * case-insensitive disk `.AWS` is `.aws`. Agent and tool config folders are on
 * the list too: `~/.codex/auth.json` and `~/.config/gh/hosts.yml` hold tokens.
 */
export const SECRET_SEGMENTS: ReadonlySet<string> = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.gcloud', '.kube', '.docker', '.netrc', '.git-credentials', '.npmrc', '.pypirc',
  '.password-store', 'keychains', '.claude', '.codex', '.config', '.git',
]);

/** Secret-looking file names: env files, keys and certificates, credential files. */
export const SECRET_FILE_RE = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|credentials(?:\.json)?|.*\.(?:pem|key|p12|pfx|jks|keystore|ppk))$/;

/** Folders that are secret only directly under the home folder (a project may well be called "library"). */
export const HOME_SECRET_SEGMENTS: ReadonlySet<string> = new Set(['library']);

/** One path segment (a folder or file name) that a phone may never read through. */
export function segmentLooksSecret(segment: string): boolean {
  const s = segment.toLowerCase();
  return SECRET_SEGMENTS.has(s) || SECRET_FILE_RE.test(s);
}

/**
 * Does a path as an agent wrote it (absolute, relative, `~/…`, either slash) name a secret
 * folder or file anywhere along it? No disk access: the file may be gone, or on another Mac.
 */
export function pathLooksSecret(path: string): boolean {
  return path.split(/[\\/]+/).filter(Boolean).some(segmentLooksSecret);
}
