/** `aasc` exit codes (plan §9.10). */
export const EXIT = {
  /** Done, or detached. */
  OK: 0,
  /** A usage error, or a refusal that more typing won't fix. */
  USAGE: 1,
  /** No answer on any of the server's addresses. */
  UNREACHABLE: 2,
  /** Not signed in: pending, revoked, or a bad key. */
  NOT_SIGNED_IN: 3,
  /** The session isn't there, or isn't shared with this client. */
  NOT_FOUND: 4,
  /** SSH failed: the tunnel or the token read. */
  SSH: 5,
} as const;

/** A failure that ends the command with `code` and prints `message`. */
export class CliError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}
