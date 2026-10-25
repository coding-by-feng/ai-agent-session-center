// tools/queueWriteAutomation.ts — the queue toolset's P2 writes on a session's automation switches (the stored
// `automation` of its queue): pause, auto-send, the other switches, and the release of a hold a person's cancel put on
// the queue. These switches decide when the window's scheduler sends what is queued, so changing them steers the
// session like adding a prompt does, and they pass the same rails (`steerTarget`).
//
// What makes the window send by itself, or loosens how it does, is locked until P4 (unattended.ts): a switch turned on
// and resuming the queue (Ruling 42), a guard turned off, a new resume prompt and releasing a cancel's hold (Ruling 43)
// on the arguments alone, before anything is read; quiet hours taken away and more resume attempts (Ruling 53) on the
// stored record, inside the write.
//
// A switch is written into the whole record (queueOps.ts): what the record lacks is written as off, which is how the
// window reads it, never on (Ruling 52). With no record stored a central changes no switch: the window keeps its own.

import { z } from 'zod';
import { startPending } from '../../heardTerminals.js';
import { NOT_STARTED_ERROR, NOT_STARTED_HINT } from '../ledgerReroute.js';
import type { ToolDef } from '../registry.js';
import {
  MAX_WINDOWS,
  RESUME_PROMPT_MAX,
  RESUME_RETRIES_RANGE,
  setAutomation,
  setAutoSend,
  setPaused,
  type AutomationPatch,
} from '../queueOps.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { loosensAutomation, onlyAddsQuietHours, raisesResumeRetries, turnsOnUnattended, type UnattendedChange } from '../unattended.js';
import { defineTool, plural, resolveTarget, seg, SESSION_REF, unwrap } from './define.js';
import {
  assertMayQueueText,
  automationAnswer,
  lockUnattended,
  nameOf,
  OWN_WORKERS_ONLY,
  QUIET_WINDOW,
  RAILS,
  startTarget,
  steerTarget,
  type QueueWriteDeps,
  windowOpen,
  windowWords,
  writeOp,
} from './queueWriteKit.js';

/** What a tool says when no automation is stored for the queue (Ruling 52). */
const NEEDS_RECORD =
  'With no automation stored for the queue yet, pausing and turning auto-send off still work (they only stop things); every other change is refused (INVALID) until a person changes one queue switch in AASC.';

const setPausedTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_set_paused',
    toolset: 'queue',
    title: 'Pause or resume a session’s queue',
    description:
      'Pauses or resumes a session’s whole queue. While it is paused nothing in it is sent, ⚡ NOW included; the ' +
      'prompts and their timing stay as they are. Pausing is always allowed. Resuming lets AASC send the queue by ' +
      `itself again. ${OWN_WORKERS_ONLY} (A person’s cancel is a different hold: queue_resume_after_cancel.) ` +
      `${NEEDS_RECORD} ${RAILS}`,
    risk: 'write',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, paused: z.boolean().describe('true pauses the queue, false resumes it.') },
    async run(args, ctx) {
      // Resuming lets the window send by itself again (Ruling 43); pausing never does.
      const s = args.paused ? steerTarget(ctx, args.id) : startTarget(deps, ctx, args.id);
      const change = await writeOp(deps, ctx, s, (state) => setPaused(state, args.paused));
      return automationAnswer({
        ctx,
        session: s,
        change,
        said: `The queue of session ${nameOf(ctx, s)} is now ${args.paused ? 'paused' : 'running'}.`,
        note: { summary: args.paused ? 'Paused the queue' : 'Resumed the queue', targetSessionId: s.sessionId, detail: { paused: args.paused } },
      });
    },
  });

const setAutoSendTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_set_auto_send',
    toolset: 'queue',
    title: 'Turn a session’s auto-send on or off',
    description:
      'Turns a session’s auto-send on or off. Off is always allowed: only ⚡ NOW sends then. On lets the AASC window ' +
      'send queued prompts into the session on its own whenever it is ready, an unattended run. On is refused ' +
      '(UNAVAILABLE) for a session that has not reported that it started: it may be showing a question only the ' +
      `person answers. ${OWN_WORKERS_ONLY} ${NEEDS_RECORD} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF, autoSend: z.boolean().describe('true lets the queue send on its own, false stops that.') },
    async run(args, ctx) {
      // Auto-send on starts unattended runs (Ruling 42); off never does.
      const starts = turnsOnUnattended({ autoSend: args.autoSend });
      const s = starts ? startTarget(deps, ctx, args.id) : steerTarget(ctx, args.id);
      // The window's scheduler holds such a card too; this keeps a switch that would send into it from being stored.
      if (starts && startPending(s)) throw new ToolError('UNAVAILABLE', NOT_STARTED_ERROR, NOT_STARTED_HINT);
      const change = await writeOp(deps, ctx, s, (state) => setAutoSend(state, args.autoSend));
      return automationAnswer({
        ctx,
        session: s,
        change,
        said: `Auto-send of session ${nameOf(ctx, s)} is now ${args.autoSend ? 'on' : 'off'}.`,
        note: { summary: args.autoSend ? 'Turned auto-send on' : 'Turned auto-send off', targetSessionId: s.sessionId, detail: { autoSend: args.autoSend } },
      });
    },
  });

const setAutomationTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_set_automation',
    toolset: 'queue',
    title: 'Set a session’s other automation switches',
    description:
      'Sets the session’s other automation switches; only the fields you pass change. autoEnter: press Enter after ' +
      'typing. idleGuard: loops wait until the session is idle. skipWhenPrompting: hold while a prompt was just ' +
      'submitted. autoResume: the watchdog that continues a session after a 529 or rate limit. resumeMaxRetries: ' +
      `${RESUME_RETRIES_RANGE.min} to ${RESUME_RETRIES_RANGE.max} tries per 30 minutes. resumePrompt: what the ` +
      'watchdog types (text, shown back fenced as untrusted data; empty brings back the default). ' +
      'loopExcludeWindows: quiet hours for every loop in the session (local HH:MM; an empty list clears them). ' +
      'In a session this central opened itself (task_delegate, session_create) it may set all of these. In any other ' +
      'it may tighten them but not loosen them: turning autoEnter or autoResume on, idleGuard or skipWhenPrompting ' +
      'off, any resumePrompt, more resumeMaxRetries than are set, and loopExcludeWindows that leave out a window ' +
      'that is set are refused (DENIED), and the whole call changes nothing; only a person can make them, in AASC. ' +
      'Pause and auto-send have their own tools. ' +
      `${NEEDS_RECORD} ${RAILS}`,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: {
      id: SESSION_REF,
      autoEnter: z.boolean().optional().describe('Press a real Enter after typing a prompt.'),
      idleGuard: z.boolean().optional().describe('Loops and schedules wait until the session is idle.'),
      skipWhenPrompting: z.boolean().optional().describe('Hold sends while a prompt was only just submitted.'),
      autoResume: z.boolean().optional().describe('Continue the session by itself after a 529, rate limit or network error.'),
      resumeMaxRetries: z.number().int().min(RESUME_RETRIES_RANGE.min).max(RESUME_RETRIES_RANGE.max).optional().describe('Resume attempts per 30 minutes.'),
      resumePrompt: z.string().max(RESUME_PROMPT_MAX).optional().describe('What the watchdog types to continue; empty brings back the default wording.'),
      loopExcludeWindows: z.array(QUIET_WINDOW).max(MAX_WINDOWS).optional().describe('Quiet hours for every loop in the session; an empty list clears them.'),
    },
    async run(args, ctx) {
      // autoEnter or autoResume turned on starts unattended sends (Ruling 42); a guard turned off or a new resume prompt
      // loosens them (Ruling 43). Neither needs the stored record to say so.
      const why: UnattendedChange | null = turnsOnUnattended({ autoEnter: args.autoEnter, autoResume: args.autoResume })
        ? 'start'
        : loosensAutomation({ idleGuard: args.idleGuard, skipWhenPrompting: args.skipWhenPrompting, resumePrompt: args.resumePrompt })
          ? 'loosen'
          : null;
      // The order of startTarget, with the text check between the lock and the rails: the lock refuses a call that can
      // never work before anything is asked of AASC, and the rails are judged after the catalog read, not across it.
      const s = resolveTarget(ctx, args.id);
      if (why !== null) lockUnattended(deps, ctx, s, why);
      if (args.resumePrompt !== undefined) await assertMayQueueText(ctx, s, args.resumePrompt);
      ctx.mayDrive(s);
      const patch: AutomationPatch = {
        autoEnter: args.autoEnter,
        idleGuard: args.idleGuard,
        skipWhenPrompting: args.skipWhenPrompting,
        autoResume: args.autoResume,
        resumeMaxRetries: args.resumeMaxRetries,
        resumePrompt: args.resumePrompt,
        loopExcludeWindows: args.loopExcludeWindows,
      };
      const change = await writeOp(deps, ctx, s, (state) => {
        // Quiet hours taken away, or more resume attempts, loosen the record that is stored (Ruling 53).
        const windows = args.loopExcludeWindows;
        const retries = args.resumeMaxRetries;
        if (windows !== undefined && !onlyAddsQuietHours(state.automation, windows)) lockUnattended(deps, ctx, s, 'loosen');
        if (retries !== undefined && raisesResumeRetries(state.automation, retries)) lockUnattended(deps, ctx, s, 'loosen');
        return setAutomation(state, patch, ctx.now());
      });
      const { changed } = change.result;
      return automationAnswer({
        ctx,
        session: s,
        change,
        said: `Changed ${plural(changed.length, 'automation switch', 'automation switches')} of session ${nameOf(ctx, s)}: ${changed.join(', ')}.`,
        note: { summary: 'Changed the queue’s automation', targetSessionId: s.sessionId, detail: { fields: changed.join(',') } },
        showResumePrompt: changed.includes('resumePrompt'),
      });
    },
  });

const resumeTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_resume_after_cancel',
    toolset: 'queue',
    title: 'Release the hold a cancel put on a queue',
    description:
      'When a person presses Esc (or declines a tool) in a session, its queue stops sending until they act. This ' +
      'releases that hold, so queued prompts may send again, and says whether there was one. That lets AASC send by ' +
      'itself again. ' +
      `${OWN_WORKERS_ONLY} A person who pressed Esc stopped it on purpose. ` +
      RAILS,
    risk: 'steers',
    phase: 2,
    idempotent: true,
    input: { id: SESSION_REF },
    async run(args, ctx) {
      // Releasing the hold lets the window send by itself again (Ruling 43).
      const s = startTarget(deps, ctx, args.id);
      const body = unwrap<{ resumed?: unknown }>(await ctx.client.post(`/sessions/${seg(s.sessionId)}/queue/resume`));
      const resumed = body.resumed === true;
      const open = await windowOpen(ctx);
      const name = nameOf(ctx, s);
      const said = resumed
        ? `Released the hold on the queue of session ${name}: a person had cancelled a turn there, and its queued prompts may send again.`
        : `The queue of session ${name} was not held by a cancel: there was nothing to release.`;
      return {
        data: { id: s.sessionId, shortId: shortIdOf(s.sessionId), resumed, windowOpen: open },
        summary: `${said}${windowWords(open)}`,
        activity: [
          {
            summary: resumed ? 'Released the queue’s hold after a cancel' : 'Asked to release the queue’s hold; none was set',
            targetSessionId: s.sessionId,
          },
        ],
      };
    },
  });

/** The four automation tools over `deps` (the release of a hold calls a route, not the store). */
export const automationTools = (deps: QueueWriteDeps): ToolDef[] => [
  setPausedTool(deps),
  setAutoSendTool(deps),
  setAutomationTool(deps),
  resumeTool(deps),
];
