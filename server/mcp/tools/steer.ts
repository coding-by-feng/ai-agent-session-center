// tools/steer.ts — what the tools that type into several sessions at once share (prompt_send, command_run,
// task_delegate): naming a call's targets, the fan-out rule, running the rails on each target, and how a refusal is
// told. One module, so a tool cannot decide any of it differently.
//
// A call names one session or up to 8 (`assertFanOut`, policy.ts). Each name goes through `resolveTarget` (scope-checked,
// aliases followed) and then `ctx.mayDrive` (the policy with live presence and the ledger's lock). A refusal means
// different things by how many were named:
//   * one session named: the refusal is the call's, thrown, so the central reads a code and a hint;
//   * several: the call goes on to the next session and the refusal becomes that target's result.
// A policy refusal from `ctx.mayDrive` is written to the activity log as it is thrown; one that `resolveTarget` threw
// (no such session, out of scope, a reference that fits several) is not, so a tool that records it as a result adds
// a note for it (`refusalNote`). No refusal ever repeats what the central wrote.

import type { Session } from '../../../src/types/session.js';
import type { ActivityNote } from '../activity.js';
import { assertFanOut } from '../policy.js';
import type { ToolContext } from '../registry.js';
import { ToolError } from '../types.js';
import { plain, resolveTarget } from './define.js';

/** The longest reference shown back to the central: its own words, cleaned to plain characters. */
const REF_SHOWN = 80;

/** What one call names: a session, or a list of them. */
export function sessionRefs(to: string | readonly string[]): string[] {
  return typeof to === 'string' ? [to] : [...to];
}

/** One session a call was asked to steer, and why it may not be, when it may not. */
export type Target =
  | { ref: string; session: Session; refusal: null }
  | {
      ref: string;
      /** The session, when the refusal came after it was named (the policy's); null when it could not be named. */
      session: Session | null;
      refusal: ToolError;
      /** The refusal is in the activity log already: the policy writes its own as it throws it. */
      logged: boolean;
    };

/**
 * Names each target: `assertFanOut` first (1 to 8, none twice as written), then each reference through `resolveTarget`.
 * A reference that cannot be resolved becomes a refused target rather than aborting the call. Two references that name
 * one session (a prefix and the whole id) refuse the whole call, before anything is sent.
 */
export function resolveTargets(ctx: ToolContext, refs: readonly string[]): Target[] {
  assertFanOut(refs);
  const targets = refs.map((raw): Target => {
    const ref = plain(raw.trim(), REF_SHOWN);
    try {
      return { ref, session: resolveTarget(ctx, raw), refusal: null };
    } catch (err) {
      if (err instanceof ToolError) return { ref, session: null, refusal: err, logged: false };
      throw err;
    }
  });
  const named = targets.flatMap((t) => (t.session === null ? [] : [t.session.sessionId]));
  if (named.length > 1) assertFanOut(named);
  return targets;
}

/** The target after the rails (`ctx.mayDrive`): itself when it may be steered, else refused with the policy's own words. */
export function checkSteerable(ctx: ToolContext, target: Target): Target {
  if (target.refusal !== null) return target;
  try {
    ctx.mayDrive(target.session);
    return target;
  } catch (err) {
    if (err instanceof ToolError) return { ref: target.ref, session: target.session, refusal: err, logged: true };
    throw err;
  }
}

/** The row for a refusal nobody has logged yet (a reference `resolveTarget` refused): its code and AASC's words. */
export function refusalNote(err: ToolError): ActivityNote {
  return { summary: `Refused (${err.code}): ${err.message}`, outcome: 'refused', detail: { code: err.code } };
}
