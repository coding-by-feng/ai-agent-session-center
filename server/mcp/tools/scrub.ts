// tools/scrub.ts — takes anything that looks like a secret out of a value before a tool hands it to a central.
//
// `aasc_config` passes on AASC's own settings. Today `GET /api/config` answers only plain ones (and a yes/no
// for "is a password set"), but a settings route grows, and what it grows must never reach a model by
// accident. So the rule is not "these keys are safe" but "nothing that looks like a secret survives":
//   * a key that names one (token, secret, password, credential, authorization, cookie, signature, anything
//     ending in "key") is dropped with its value, wherever it sits in the value, unless that value is a plain
//     true or false: a flag such as `passwordEnabled` says that a password is set, not what it is, and a
//     boolean cannot carry a secret. A string, a number, an object or an array under such a key is dropped;
//   * a string that looks like one (an AASC token, an API key, a GitHub token, a JWT, a private key, a bearer
//     header, a long hex digest or opaque token) is dropped whatever its key is called.
// A drop removes the entry; it leaves no marker, so the output does not even say what was there.
//
// Pure: it builds a new value and changes nothing it is given.

/** A key that names a secret, in any case or style (`apiKey`, `api_key`, `Authorization`, `passwordHash`). */
const SECRET_KEY =
  /token|secret|passw|credential|authori[sz]ation|bearer|cookie|signature|private|apikey|api[-_]key|key$|keys$/i;

/** Text that looks like a secret on its own. */
const SECRET_VALUE: readonly RegExp[] = [
  /^aasc_mcp_/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
  // A bare hex digest or token.
  /^[0-9a-f]{32,}$/i,
  // A long opaque token: letters and digits with no separator or path character (a path or a hyphenated name has one).
  /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{40,}$/,
];

const MAX_DEPTH = 8;

const DROP = Symbol('drop');

/** Does this key name a secret? */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Does this text look like a secret? */
export function looksSecret(text: string): boolean {
  return SECRET_VALUE.some((pattern) => pattern.test(text));
}

function clean(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return looksSecret(value) ? DROP : value;
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? DROP : value;
  if (depth >= MAX_DEPTH) return DROP;
  if (Array.isArray(value)) {
    return value.map((item) => clean(item, depth + 1)).filter((item) => item !== DROP);
  }
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    // A flag about a secret is not the secret: under a key that names one, only a true or false survives.
    if (isSecretKey(key) && typeof inner !== 'boolean') continue;
    const kept = clean(inner, depth + 1);
    if (kept !== DROP) out[key] = kept;
  }
  return out;
}

/**
 * A copy of `value` without any entry whose key names a secret (a true or false under such a key stays: it is a
 * flag, not the secret) and without any string that looks like one. A value that is itself a secret-looking
 * string comes back as `null`.
 */
export function scrubSecrets<T>(value: T): unknown {
  const cleaned = clean(value, 0);
  return cleaned === DROP ? null : cleaned;
}
