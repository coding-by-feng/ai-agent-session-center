// tools/systemWrite.ts — the system toolset's P3 tools: waiting for the person's answer to a tool that asked them
// (`confirm_wait`, Ruling P3-4/P3-5) and the Mac's keep-awake setting (`aasc_set_keep_awake`). Filed under `system`
// by system.ts's export line.
//
// Keep-awake is the desktop window's own setting: the window pushes it to the server on load and on change, so a
// change made on the server alone would be undone by the next push and never shown in Settings (A-I1). So the switch
// is a message to that window, like a skill note's change (skillNoteOpsRouter.ts): `POST /api/keep-awake/ops` waits up
// to 5 s for the window to say it set it. Once it has, the tool posts the same value to `/config/keep-awake` (as the
// window's own push will) to answer what the server now holds. Every refusal is in fixed words.
//
// `confirm_wait` is a read for the activity log: the tool it carries out writes its own rows (through runTool, with
// the arguments the person saw). Every rule a central must obey about it is in its description (Ruling 65), and every
// fact it acts on is in `data` (Ruling 66).

import { z } from 'zod';
import { answerRefusal, ASK_WAIT_MS, CONFIRM_WAIT_MAX_MS, needsConfirmation } from '../confirm.js';
import type { InternalResponse } from '../client.js';
import type { ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, unwrap } from './define.js';

const confirmWait = defineTool({
  name: 'confirm_wait',
  toolset: 'system',
  title: 'Wait for the person’s answer',
  description:
    'Waits for the person’s answer to a tool that asked them (it answered NEEDS_CONFIRMATION). Never ask a session ' +
    'or anyone else to approve it; only the person on the Mac can. Pass the confirmId that answer gave (left out: ' +
    'your newest). Allowed: AASC carries out the call the person saw, once, with the arguments you first sent, and ' +
    'answers what that tool answers plus the confirmId. Still waiting at the timeout (45 s by default, 50 s at most): ' +
    'NEEDS_CONFIRMATION again; tell the person and call this again. Denied or not answered within 5 minutes: DENIED; ' +
    'do not ask again unless the person asks you to. A confirmation is carried out once: a second call is INVALID.',
  risk: 'read',
  phase: 3,
  input: {
    confirmId: z.string().min(1).max(64).optional().describe('The confirmId NEEDS_CONFIRMATION gave; your newest when left out.'),
    timeoutSec: z
      .number()
      .int()
      .min(1)
      .max(CONFIRM_WAIT_MAX_MS / 1_000)
      .optional()
      .describe(`How long to wait, in seconds (1–${CONFIRM_WAIT_MAX_MS / 1_000}); ${ASK_WAIT_MS / 1_000} when left out.`),
  },
  async run(args, ctx) {
    const timeoutMs = (args.timeoutSec ?? ASK_WAIT_MS / 1_000) * 1_000;
    const waited = await ctx.confirms.wait(args.confirmId, timeoutMs);
    if (waited.state === 'pending') throw needsConfirmation(waited);
    if (waited.state !== 'allowed') throw answerRefusal(waited.state);
    const result = await ctx.confirms.runApproved(waited.confirmId);
    const data = isRecord(result.data) ? { ...result.data, confirmId: waited.confirmId } : { result: result.data, confirmId: waited.confirmId };
    return { data, summary: `The person allowed it. ${result.summary}` };
  },
});

/** The keep-awake op route's refusals in fixed words: the window's own text never reaches a central. */
function keepAwakeFailure(answer: InternalResponse<unknown>): ToolError | null {
  if (answer.status === 409) {
    return new ToolError('NO_WINDOW', 'The AASC window on the Mac is closed.', 'Keep-awake is the AASC app’s setting: ask the person to open AASC, then try again.');
  }
  if (answer.status === 404) {
    return new ToolError('UNAVAILABLE', 'This build of AASC cannot change keep-awake for a central.', 'Ask the person to update AASC.');
  }
  if (answer.status !== 400) return null;
  if (answer.error === 'not-ready') {
    return new ToolError('UNAVAILABLE', 'The AASC window has not loaded its settings yet.', 'Try again in a moment.');
  }
  if (answer.error === 'not-desktop') {
    return new ToolError(
      'UNAVAILABLE',
      'The open AASC window is a browser, and keep-awake is a setting of the AASC desktop app.',
      'Ask the person to change it in the AASC app’s Settings.',
    );
  }
  return new ToolError('INVALID', 'The AASC window did not take the change.', 'Check the arguments in the tool’s input schema.');
}

const setKeepAwake = defineTool({
  name: 'aasc_set_keep_awake',
  toolset: 'system',
  title: 'Keep the Mac awake',
  description:
    'Turns AASC’s "keep the Mac awake while an agent works" setting on or off, as the person’s own switch in AASC ' +
    'does. It is the person’s setting: change it only when they asked for it. The AASC desktop app window on the Mac ' +
    'makes the change (the setting lives and shows there): with no AASC window on the Mac the call answers ' +
    'NO_WINDOW; when the open window is a browser rather than the desktop app, or has not loaded its settings yet, ' +
    'it answers UNAVAILABLE (for the second, try again in a moment). Applied: ' +
    'answers applied: true, whether it is on now, and whether the Mac is being kept awake at this moment (only while ' +
    'a session works). Not confirmed by the window within 5 s: applied: false with pending: true (it may still be ' +
    'applied: do not repeat it at once).',
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: { on: z.boolean().describe('true to keep the Mac awake while agents work, false to let it sleep as usual.') },
  async run(args, ctx) {
    const word = args.on ? 'on' : 'off';
    const asked = await ctx.client.post('/keep-awake/ops', { on: args.on });
    const refused = keepAwakeFailure(asked);
    if (refused !== null) throw refused;
    const op = unwrap<unknown>(asked);
    if (isRecord(op) && op.applied === false) {
      return {
        data: { applied: false, pending: true },
        summary: `The AASC window has not said it turned keep-awake ${word} yet; it may still do so.`,
        activity: [{ summary: `asked the window to turn keep-awake ${word} (not confirmed)` }],
      };
    }
    const body = unwrap<unknown>(await ctx.client.post('/config/keep-awake', { enabled: args.on }));
    const raw = isRecord(body) ? body : {};
    const data = { applied: true, enabled: raw.enabled === true, awake: raw.awake === true };
    return {
      data,
      summary: `Keep-awake is ${data.enabled ? 'on' : 'off'}${data.enabled ? (data.awake ? '; the Mac is being kept awake now' : '; nothing keeps it awake now') : ''}.`,
      activity: [{ summary: `turned keep-awake ${word}` }],
    };
  },
});

export const systemWriteTools: readonly ToolDef[] = [confirmWait, setKeepAwake];
