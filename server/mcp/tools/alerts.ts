// tools/alerts.ts — the alert tools of the requests toolset (Nov 26 2026): a central puts "this needs you" in the
// person's bell (the header's 🔔 and its hint), beside the sessions that wait on a question, an approval or a proceed
// ask, instead of a push, a card remark and a notes file of its own.
//
//   alert_raise    about its own card (no `id`) or a session in its scope, never a hands-off one; `key` names the
//                  problem, and raising an open key again updates that alert (once per problem, however often a
//                  watchdog ticks). The level it asks for is capped by the session's own: the person decides how loud
//                  a card may be (src/lib/raisedAlerts.ts).
//   alert_list     its own open alerts, and those on sessions in its scope, the text fenced as untrusted (another
//                  central wrote it)
//   alert_dismiss  one of those, by its own key or by id
//
// The routes are server/alerts/alertsRouter.ts: POST /alerts takes the central from the call's client id, caps the
// text and counts the limits (10 open per central: 409; 30 raises a minute: 429, both BUDGET here).

import { z } from 'zod';
import { ALERT_LEVELS } from '../../../src/lib/attention.js';
import { RAISED_ALERT_KEY_RE } from '../../../src/lib/raisedAlerts.js';
import type { RaisedAlert } from '../../../src/types/alert.js';
import type { Session } from '../../../src/types/session.js';
import type { InternalResponse } from '../client.js';
import type { ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { defineTool, fence, isRecord, plain, refOf, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import { ownCard } from './settingChange.js';
import { ago } from './views.js';

const KEY = z
  .string()
  .regex(RAISED_ALERT_KEY_RE)
  .describe('Your short name for the problem, letters, digits and . _ : - (stuck:package). Raising it again while it is open updates that alert.');

/** A route's refusal for the limits, as BUDGET; anything else as `unwrap` reads it. */
function raised(r: InternalResponse<unknown>): { alertId: string; created: boolean; count: number } {
  if (r.status === 409 || r.status === 429) {
    throw new ToolError(
      'BUDGET',
      r.status === 409 ? 'The person already has 10 open alerts from you.' : 'You raised more than 30 alerts in a minute.',
      r.status === 409 ? 'Dismiss one you no longer need (alert_list, alert_dismiss).' : 'Raise it again on your next check.',
    );
  }
  const body = unwrap<{ created?: unknown; alert?: unknown }>(r);
  const alert = isRecord(body.alert) ? body.alert : {};
  return {
    alertId: typeof alert.id === 'string' ? alert.id : '',
    created: body.created === true,
    count: typeof alert.count === 'number' ? alert.count : 1,
  };
}

/** The session an alert is about, as this central knows it, or undefined when no session has that id now. */
function sessionOf(ctx: ToolContext, alert: RaisedAlert): Session | undefined {
  const current = ctx.resolveSessionId(alert.sessionId) ?? alert.sessionId;
  return ctx.sessions().find((s) => s.sessionId === current);
}

/** The open alerts this central may see: its own, and those on sessions in its scope. */
async function visibleAlerts(ctx: ToolContext): Promise<Array<{ alert: RaisedAlert; mine: boolean }>> {
  const body = unwrap<{ alerts?: unknown }>(await ctx.client.get('/alerts'));
  const all = Array.isArray(body.alerts) ? (body.alerts as RaisedAlert[]) : [];
  const out: Array<{ alert: RaisedAlert; mine: boolean }> = [];
  for (const alert of all) {
    const mine = alert.centralId === ctx.central.centralId;
    const session = sessionOf(ctx, alert);
    if (mine || (session !== undefined && ctx.inScope(session))) out.push({ alert, mine });
  }
  return out;
}

const alertRaise = defineTool({
  name: 'alert_raise',
  toolset: 'requests',
  title: 'Alert the person',
  description:
    'Puts an alert in the person’s bell in AASC (a short hint, a sound and a phone push as the session’s alert level ' +
    'allows): use it for something that needs them, such as a stuck step, a decision or a review. About your own ' +
    'card when you name no session, else a session in your scope (never a hands-off one). `key` is your name for the ' +
    'problem: raising it again while it is open updates that alert instead of adding one. The level you ask for is ' +
    'never louder than the session’s own (the person sets that). Plain text, one line, at most 200 characters.',
  risk: 'write',
  phase: 3,
  input: {
    id: SESSION_REF.optional().describe('The session it is about; leave it out for your own card.'),
    key: KEY,
    message: z.string().min(1).max(2000).describe('What needs the person, in one line (cut at 200 characters).'),
    level: z.enum(ALERT_LEVELS).optional().describe('quiet, normal, loud or urgent; capped by the session’s own level. Leave it out for the session’s level.'),
  },
  async run(args, ctx) {
    const own = ownCard(ctx);
    let target: Session;
    if (args.id === undefined) {
      if (!own) {
        throw new ToolError('INVALID', 'You have no live card of your own to raise it about.', 'Name the session it is about with `id`.');
      }
      target = own;
    } else {
      target = resolveTarget(ctx, args.id);
      if (target.sessionId !== own?.sessionId && target.handsOff === true) {
        throw new ToolError(
          'HANDS_OFF',
          'That session is hands-off: only the person acts on it.',
          'Raise it about your own card instead, naming the session in the message.',
        );
      }
    }
    const result = raised(
      await ctx.client.post('/alerts', {
        sessionId: target.sessionId,
        centralSessionId: own?.sessionId ?? null,
        key: args.key,
        message: args.message,
        ...(args.level === undefined ? {} : { level: args.level }),
      }),
    );
    const ref = refOf(ctx)(target.sessionId);
    const words = result.created ? `raised an alert about ${ref}` : `updated its open alert about ${ref} (raised ${result.count} times)`;
    return {
      data: { ...result, sessionId: target.sessionId, key: args.key },
      summary: `Alert ${plain(args.key)}: ${words}.`,
      activity: [{ summary: result.created ? 'raised an alert' : 'updated an alert', targetSessionId: target.sessionId }],
    };
  },
});

const alertList = defineTool({
  name: 'alert_list',
  toolset: 'requests',
  title: 'List open alerts',
  description:
    'Lists the open alerts in the person’s bell that you can see: yours, and those on sessions in your scope (another ' +
    'central’s text is fenced as untrusted). An alert closes when the person or a central dismisses it, or a day after ' +
    'it was last raised.',
  risk: 'read',
  phase: 3,
  input: {},
  async run(_args, ctx) {
    const rows = await visibleAlerts(ctx);
    if (rows.length === 0) return { data: { alerts: [] }, summary: 'No open alerts.' };
    const ref = refOf(ctx);
    const now = ctx.now();
    const alerts = rows.map(({ alert, mine }) => ({
      id: alert.id,
      key: alert.key,
      sessionId: alert.sessionId,
      mine,
      level: alert.level ?? null,
      count: alert.count,
      raisedAt: alert.raisedAt,
      updatedAt: alert.updatedAt,
      message: fence(mine ? 'you' : `central ${plain(alert.centralId)}`, 'alert', alert.message),
    }));
    const lines = alerts.map(
      (a) => `- ${a.id} · ${plain(a.key)} · ${ref(a.sessionId)} · ${a.mine ? 'yours' : 'another central’s'} · ${ago(now - a.updatedAt)} · ${a.message}`,
    );
    return { data: { alerts }, summary: `${alerts.length} open alert${alerts.length === 1 ? '' : 's'}:\n${lines.join('\n')}` };
  },
});

const alertDismiss = defineTool({
  name: 'alert_dismiss',
  toolset: 'requests',
  title: 'Dismiss an alert',
  description:
    'Closes an open alert: one of yours by its `key`, or by `id` (alert_list) yours or one on a session in your scope. ' +
    'Dismiss an alert once its problem is gone, so the person’s bell shows only what still needs them.',
  risk: 'write',
  phase: 3,
  idempotent: true,
  input: {
    key: KEY.optional().describe('The key you raised it with.'),
    id: z.string().min(1).max(200).optional().describe('An alert id from alert_list.'),
  },
  async run(args, ctx) {
    if ((args.key === undefined) === (args.id === undefined)) {
      throw new ToolError('INVALID', 'Name the alert by `key` or by `id`, not both.', 'Pass one of them.');
    }
    const rows = await visibleAlerts(ctx);
    const found =
      args.key !== undefined
        ? rows.find((r) => r.mine && r.alert.key === args.key)
        : rows.find((r) => r.alert.id === args.id);
    if (!found) {
      throw new ToolError('NOT_FOUND', 'No open alert you can see matches that.', 'Call alert_list for the open alerts.');
    }
    unwrap(await ctx.client.post(`/alerts/${seg(found.alert.id)}/dismiss`, {}));
    return {
      data: { alertId: found.alert.id, dismissed: true },
      summary: `Alert ${found.alert.id}: dismissed.`,
      activity: [{ summary: 'dismissed an alert', targetSessionId: found.alert.sessionId }],
    };
  },
});

export const alertTools: readonly ToolDef[] = [alertRaise, alertList, alertDismiss];
